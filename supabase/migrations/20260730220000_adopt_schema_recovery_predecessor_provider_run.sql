-- Cross-request adoption of an already-paid Apify run.
--
-- When a V2 analysis fails AFTER its paid scraping succeeded, the retry runs under a new
-- analysis_request. Its operation keys are byte-identical to the predecessor's because they
-- are derived only from the frozen operation identity, so the retry would buy the same Apify
-- run a second time.
--
-- The ledger invariant we must not weaken is: every real Apify invocation is owned by exactly
-- one row. This migration therefore does NOT relax `UNIQUE (run_id)` globally. It introduces an
-- explicitly marked, cost-neutral "adopted" row:
--   * non-adopted rows keep the original one-run-one-row guarantee via a partial unique index;
--   * adopted rows are forced terminal and zero-cost by CHECK, so no cost aggregate can ever
--     count the same real spend twice.
--
-- Adoption always requires an explicit recorded lineage edge. See the comment on
-- public.analysis_request_retry_lineage for why a "same target -> reuse any prior run" cache is
-- deliberately NOT built.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- ---------------------------------------------------------------------------
-- 1. General retry lineage
-- ---------------------------------------------------------------------------

CREATE TABLE public.analysis_request_retry_lineage (
    successor_preflight_id UUID PRIMARY KEY
        REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    predecessor_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    reason TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_request_retry_lineage_reason_check CHECK (
        reason ~ '^[a-z][a-z0-9_]{2,63}$'
    )
);

CREATE INDEX idx_analysis_request_retry_lineage_predecessor
    ON public.analysis_request_retry_lineage(predecessor_request_id);

ALTER TABLE public.analysis_request_retry_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_request_retry_lineage FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_request_retry_lineage
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_request_retry_lineage IS
    'Explicit "this preflight is a retry of that request" edge. It is the ONLY thing that authorizes '
    'reusing a predecessor''s already-paid provider run. A global "same target -> reuse any prior run" '
    'cache is deliberately NOT built: matching operation keys alone would silently serve stale scrapes '
    'and could mix data across users, so an operator- or recovery-recorded edge is always required.';
COMMENT ON COLUMN public.analysis_request_retry_lineage.successor_preflight_id IS
    'The retry preflight. PRIMARY KEY, so a retry has at most one predecessor.';
COMMENT ON COLUMN public.analysis_request_retry_lineage.predecessor_request_id IS
    'The failed request whose paid provider runs the retry may adopt.';
COMMENT ON COLUMN public.analysis_request_retry_lineage.reason IS
    'PII-free lineage origin, e.g. earlybird_schema_failure_recovery.';

-- Keep the existing earlybird schema-failure recovery working without changing that RPC's
-- behaviour: the lineage row is written as a pure side effect of the immutable receipt insert.
CREATE FUNCTION public.record_earlybird_schema_recovery_retry_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.analysis_request_retry_lineage(
        successor_preflight_id, predecessor_request_id, reason
    ) VALUES (
        NEW.recovery_preflight_id,
        NEW.failed_request_id,
        'earlybird_schema_failure_recovery'
    )
    ON CONFLICT (successor_preflight_id) DO NOTHING;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_earlybird_schema_recovery_retry_lineage()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER record_earlybird_schema_recovery_retry_lineage
AFTER INSERT ON public.earlybird_schema_failure_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.record_earlybird_schema_recovery_retry_lineage();

INSERT INTO public.analysis_request_retry_lineage(
    successor_preflight_id, predecessor_request_id, reason
)
SELECT
    recovery.recovery_preflight_id,
    recovery.failed_request_id,
    'earlybird_schema_failure_recovery'
FROM public.earlybird_schema_failure_recoveries AS recovery
ON CONFLICT (successor_preflight_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Cost-neutral adopted provider run rows
-- ---------------------------------------------------------------------------

ALTER TABLE public.analysis_v2_provider_runs
    ADD COLUMN adopted_from_request_id UUID
        REFERENCES public.analysis_requests(id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- The original protection survives untouched for every row that owns a real Actor start.
ALTER TABLE public.analysis_v2_provider_runs
    DROP CONSTRAINT analysis_v2_provider_runs_run_id_key;

CREATE UNIQUE INDEX analysis_v2_provider_runs_unadopted_run_id_key
    ON public.analysis_v2_provider_runs(run_id)
    WHERE adopted_from_request_id IS NULL;

CREATE INDEX idx_analysis_v2_provider_runs_adopted_from
    ON public.analysis_v2_provider_runs(adopted_from_request_id)
    WHERE adopted_from_request_id IS NOT NULL;

-- An adopted row can never introduce spend and is always terminal. Combined with
-- analysis_v2_provider_run_state_check this pins it to exactly one shape:
-- succeeded + run_id + run_started_at + terminalized_at + actual_usage_usd = 0 + reconciled.
ALTER TABLE public.analysis_v2_provider_runs
    ADD CONSTRAINT analysis_v2_provider_run_adoption_check CHECK (
        adopted_from_request_id IS NULL
        OR (
            status = 'succeeded'
            AND run_id IS NOT NULL
            AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL
        )
    );

COMMENT ON COLUMN public.analysis_v2_provider_runs.adopted_from_request_id IS
    'Non-NULL only for a cost-neutral row that reuses a run another request already paid for. '
    'It names the request that actually paid, so provider spend sums stay correct: adopted rows '
    'always contribute actual_usage_usd = 0 and are excluded from usage reconciliation.';

-- ---------------------------------------------------------------------------
-- 3. Adoption RPC
-- ---------------------------------------------------------------------------

-- Returns the adopted row, or NULL when adoption is not authorized. Adoption is opportunistic:
-- a NULL result simply means the caller reserves and starts a fresh paid run as before.
CREATE FUNCTION public.adopt_analysis_v2_predecessor_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_provider_runs%ROWTYPE;
    v_predecessor public.analysis_requests%ROWTYPE;
    v_predecessor_run public.analysis_v2_provider_runs%ROWTYPE;
    v_lineage public.analysis_request_retry_lineage%ROWTYPE;
    v_adopted public.analysis_v2_provider_runs%ROWTYPE;
    v_payer_request_id UUID;
    v_successor_target TEXT;
    v_predecessor_target TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Cheap unlocked gate: the overwhelming majority of operations have no lineage edge and
    -- must not pay for the reservation lock order below.
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_request_retry_lineage AS lineage
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = lineage.successor_preflight_id
        WHERE preflight.consumed_request_id = p_request_id
    ) THEN
        RETURN NULL;
    END IF;

    -- Same preflight -> request -> job lock order as reserve_analysis_v2_provider_run.
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.user_id IS DISTINCT FROM v_preflight.user_id THEN
        RETURN NULL;
    END IF;

    -- The (request_id, job_key) foreign key means the job row must already exist, so adoption
    -- can only happen while this worker holds a live claim on the job that would have paid.
    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RETURN NULL;
    END IF;

    -- At most one adoption per (request_id, job_key, operation_key); a replay returns the row.
    SELECT provider_run.*
    INTO v_existing
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.adopted_from_request_id IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_existing)
            || pg_catalog.jsonb_build_object(
                'adoptedFromRequestId', v_existing.adopted_from_request_id
            );
    END IF;

    SELECT lineage.*
    INTO v_lineage
    FROM public.analysis_request_retry_lineage AS lineage
    WHERE lineage.successor_preflight_id = v_preflight.id;
    IF NOT FOUND OR v_lineage.predecessor_request_id = p_request_id THEN
        RETURN NULL;
    END IF;

    SELECT analysis_request.*
    INTO v_predecessor
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_lineage.predecessor_request_id;
    IF NOT FOUND
       OR v_predecessor.pipeline_version IS DISTINCT FROM 'v2'
       OR v_predecessor.user_id IS DISTINCT FROM v_request.user_id THEN
        RETURN NULL;
    END IF;

    -- Same Instagram target. The predecessor may already be PII-scrubbed; that exact token is
    -- accepted because the lineage edge plus the owner and preflight fences above already pin
    -- identity, but any other mismatch is refused.
    v_successor_target := pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.btrim(v_request.target_instagram_id)), '^@', ''
    );
    v_predecessor_target := pg_catalog.lower(
        pg_catalog.btrim(v_predecessor.target_instagram_id)
    );
    IF v_successor_target !~ '^[a-z0-9._]{1,30}$'
       OR v_successor_target IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id) THEN
        RETURN NULL;
    END IF;
    IF v_predecessor_target = 'retained.' || pg_catalog.substr(
           pg_catalog.replace(v_predecessor.id::TEXT, '-', ''), 1, 20
       ) THEN
        NULL;
    ELSIF pg_catalog.regexp_replace(v_predecessor_target, '^@', '')
          IS DISTINCT FROM v_successor_target THEN
        RETURN NULL;
    END IF;

    -- Exact provider identity. Nothing but a byte-identical operation may be adopted.
    SELECT provider_run.*
    INTO v_predecessor_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = v_predecessor.id
      AND provider_run.operation_key = p_operation_key
      AND provider_run.input_hash = p_input_hash
      AND provider_run.logical_provider = p_logical_provider
      AND provider_run.actor_id = p_actor_id
      AND provider_run.credential_slot = p_credential_slot
      AND provider_run.status = 'succeeded'
      AND provider_run.run_id IS NOT NULL
    ORDER BY provider_run.terminalized_at DESC, provider_run.job_key
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Always name the request that actually paid, even across a chain of retries, so the
    -- zero-cost marker stays auditable back to the single real charge.
    v_payer_request_id := COALESCE(
        v_predecessor_run.adopted_from_request_id,
        v_predecessor_run.request_id
    );

    INSERT INTO public.analysis_v2_provider_runs (
        request_id,
        job_key,
        operation_key,
        input_hash,
        job_claim_token,
        reservation_token,
        logical_provider,
        actor_id,
        credential_slot,
        max_charge_usd,
        status,
        run_id,
        actual_usage_usd,
        reserved_at,
        run_started_at,
        terminalized_at,
        usage_reconciled_at,
        updated_at,
        adopted_from_request_id
    ) VALUES (
        p_request_id,
        p_job_key,
        p_operation_key,
        p_input_hash,
        p_claim_token,
        p_reservation_token,
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        p_max_charge_usd,
        'succeeded',
        v_predecessor_run.run_id,
        0,
        v_now,
        v_now,
        v_now,
        v_now,
        v_now,
        v_payer_request_id
    )
    RETURNING * INTO v_adopted;

    RETURN public.analysis_v2_provider_run_json(v_adopted)
        || pg_catalog.jsonb_build_object('adoptedFromRequestId', v_payer_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_analysis_v2_predecessor_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.adopt_analysis_v2_predecessor_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) TO service_role;

COMMENT ON FUNCTION public.adopt_analysis_v2_predecessor_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) IS
    'Creates one cost-neutral ledger row reusing a predecessor request''s succeeded Apify run. '
    'Requires a recorded retry lineage edge, the same owner and Instagram target, a live job claim, '
    'and byte-identical operation_key, input_hash, logical_provider, actor_id and credential_slot. '
    'Returns NULL instead of raising when adoption is not authorized so the caller simply buys a run.';

-- ---------------------------------------------------------------------------
-- 4. Keep usage reconciliation away from adopted rows
-- ---------------------------------------------------------------------------

-- Adopted rows already carry actual_usage_usd = 0 and usage_reconciled_at, so they never matched
-- the unreconciled predicate. The exclusion is now explicit so a future relaxation of that
-- predicate cannot start charging an adopted row against Apify.
CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    WITH candidate_keys AS MATERIALIZED (
        SELECT
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
          AND provider_run.adopted_from_request_id IS NULL
          AND provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'
          AND (
              provider_run.usage_reconciliation_attempted_at IS NULL
              OR provider_run.usage_reconciliation_attempted_at <= v_now
                  - pg_catalog.make_interval(
                      secs => LEAST(
                          3600,
                          30 * (1 << LEAST(
                              provider_run.usage_reconciliation_attempt_count,
                              7
                          ))
                      )::DOUBLE PRECISION
                  )
          )
        ORDER BY
            provider_run.usage_reconciliation_attempted_at NULLS FIRST,
            provider_run.terminalized_at,
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), attempted AS (
        UPDATE public.analysis_v2_provider_runs AS provider_run
        SET usage_reconciliation_attempt_count = LEAST(
                provider_run.usage_reconciliation_attempt_count + 1,
                100000
            ),
            usage_reconciliation_attempted_at = v_now,
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE provider_run.request_id = candidate.request_id
          AND provider_run.job_key = candidate.job_key
          AND provider_run.operation_key = candidate.operation_key
        RETURNING provider_run.*
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_v2_provider_run_json(candidate)
            ORDER BY candidate.terminalized_at, candidate.request_id,
                candidate.job_key, candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM attempted AS candidate;

    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER) IS
    'Claims a bounded PII-free, backoff-eligible, least-recently-attempted page of terminal provider usage rows. Adopted zero-cost rows are never claimed.';

CREATE OR REPLACE FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    p_reservation_token UUID,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_status TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd NOT BETWEEN 0 AND 100000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    -- An adopted row owns no Apify invocation, so its usage is never read back from Apify.
    IF v_run.adopted_from_request_id IS NOT NULL
       OR v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.status IS DISTINCT FROM p_status
       OR v_run.status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR v_run.terminalized_at IS NULL
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.terminalized_at > (v_now - INTERVAL '30 seconds') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET actual_usage_usd = p_actual_usage_usd,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = v_run.request_id
      AND provider_run.job_key = v_run.job_key
      AND provider_run.operation_key = v_run.operation_key
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;
