-- Initial profile lookup and checkout-time admission are separate billable operations.
-- Existing worker RPC signatures remain unchanged; fresh admission uses generation-scoped RPCs.

ALTER TABLE public.analysis_preflight_provider_runs
    DROP CONSTRAINT analysis_preflight_provider_run_operation_check;
ALTER TABLE public.analysis_preflight_provider_runs
    DROP CONSTRAINT analysis_preflight_provider_runs_pkey;
ALTER TABLE public.analysis_preflight_provider_runs
    ADD CONSTRAINT analysis_preflight_provider_run_operation_check CHECK (
        operation_key = 'target-profile-fallback'
        OR operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
    );
ALTER TABLE public.analysis_preflight_provider_runs
    ADD CONSTRAINT analysis_preflight_provider_runs_pkey
    PRIMARY KEY (preflight_id, operation_key);

COMMENT ON TABLE public.analysis_preflight_provider_runs IS
    'RPC-only, PII-free intent and cost ledger with one initial profile fallback and at most one fallback per fresh-admission generation.';

CREATE OR REPLACE FUNCTION public.adopt_legacy_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_admission_requested_at TIMESTAMP WITH TIME ZONE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_preflight_id IS NULL
       OR p_operation_key !~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
       OR p_admission_requested_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- During a migration-first rollout, an older fresh-admission worker can reserve the
    -- legacy operation after this generation was requested. Move only that new row; an
    -- initial-preflight snapshot predates the request and must never be adopted.
    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET operation_key = p_operation_key,
        updated_at = pg_catalog.clock_timestamp()
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
      AND provider_run.reserved_at >= p_admission_requested_at
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_preflight_provider_runs AS current_generation
          WHERE current_generation.preflight_id = p_preflight_id
            AND current_generation.operation_key = p_operation_key
      );
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_legacy_fresh_admission_provider_run(
    UUID, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_legacy_fresh_admission_provider_run_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF NEW.operation_key <> 'target-profile-fallback' THEN
        RETURN NEW;
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = NEW.preflight_id;
    IF FOUND
       AND v_preflight.status = 'ready'
       AND v_preflight.admission_status = 'processing'
       AND v_preflight.admission_generation BETWEEN 1 AND 100
       AND v_preflight.admission_requested_at IS NOT NULL
       AND NEW.reserved_at >= v_preflight.admission_requested_at
       AND EXISTS (
           SELECT 1
           FROM public.analysis_preflight_provider_runs AS current_generation
           WHERE current_generation.preflight_id = NEW.preflight_id
             AND current_generation.operation_key =
                'target-profile-fresh-admission:g'
                    || v_preflight.admission_generation::TEXT
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_LEGACY_FRESH_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_legacy_fresh_admission_provider_run_insert()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_legacy_fresh_admission_provider_run_insert
BEFORE INSERT ON public.analysis_preflight_provider_runs
FOR EACH ROW
EXECUTE FUNCTION public.guard_legacy_fresh_admission_provider_run_insert();

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_operation_key TEXT;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_operation_key := 'target-profile-fresh-admission:g' || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    PERFORM public.adopt_legacy_fresh_admission_provider_run(
        p_preflight_id, v_operation_key, v_preflight.admission_requested_at
    );

    SELECT provider_run.*
    INTO v_existing
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM 'apify'
           OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'run', public.analysis_preflight_provider_run_json(v_existing)
        );
    END IF;

    INSERT INTO public.analysis_preflight_provider_runs (
        preflight_id,
        operation_key,
        input_hash,
        credential_slot,
        max_charge_usd
    ) VALUES (
        p_preflight_id,
        v_operation_key,
        p_input_hash,
        p_credential_slot,
        p_max_charge_usd
    )
    RETURNING * INTO v_existing;

    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'run', public.analysis_preflight_provider_run_json(v_existing)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_operation_key TEXT;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_operation_key := 'target-profile-fresh-admission:g' || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    PERFORM public.adopt_legacy_fresh_admission_provider_run(
        p_preflight_id, v_operation_key, v_preflight.admission_requested_at
    );

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_started(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_run_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_operation_key TEXT;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_operation_key := 'target-profile-fresh-admission:g' || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    PERFORM public.adopt_legacy_fresh_admission_provider_run(
        p_preflight_id, v_operation_key, v_preflight.admission_requested_at
    );

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.status <> 'starting' THEN
        IF v_run.run_id IS DISTINCT FROM p_run_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RUN_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = 'running',
        run_id = p_run_id,
        run_started_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_terminal(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_run_id TEXT,
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
    v_operation_key TEXT;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (
            p_actual_usage_usd IS NOT NULL
            AND (
                p_actual_usage_usd NOT BETWEEN 0 AND 100000
                OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
                OR p_actual_usage_usd > p_max_charge_usd + 0.000000001
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_operation_key := 'target-profile-fresh-admission:g' || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    PERFORM public.adopt_legacy_fresh_admission_provider_run(
        p_preflight_id, v_operation_key, v_preflight.admission_requested_at
    );

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id OR v_run.status = 'starting' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RUN_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status
           OR (
                p_actual_usage_usd IS NOT NULL
                AND v_run.actual_usage_usd IS NOT NULL
                AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_TERMINAL_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_preflight_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now,
                updated_at = v_now
            WHERE provider_run.preflight_id = p_preflight_id
              AND provider_run.operation_key = v_operation_key
            RETURNING provider_run.* INTO v_run;
        END IF;
        IF v_run.actual_usage_usd IS NOT NULL THEN
            PERFORM public.record_analysis_preflight_provider_cost_event(
                v_run.run_id,
                v_run.logical_provider,
                v_run.actor_id,
                v_run.credential_slot,
                v_run.status,
                v_run.max_charge_usd,
                v_run.actual_usage_usd,
                (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
            );
        END IF;
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;
    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL
            ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    RETURNING provider_run.* INTO v_run;
    IF v_run.actual_usage_usd IS NOT NULL THEN
        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id,
            v_run.logical_provider,
            v_run.actor_id,
            v_run.credential_slot,
            v_run.status,
            v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
        );
    END IF;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_started(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_terminal(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_started(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_fresh_admission_provider_run_terminal(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 17
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
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH candidate_keys AS MATERIALIZED (
        SELECT provider_run.preflight_id, provider_run.operation_key
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND (
              (
                  provider_run.status = 'running'
                  AND provider_run.run_started_at <= v_now - INTERVAL '30 seconds'
              )
              OR (
                  provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                  AND provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'
              )
          )
          AND (
              provider_run.usage_reconciliation_attempted_at IS NULL
              OR provider_run.usage_reconciliation_attempted_at <= v_now - INTERVAL '30 seconds'
          )
        ORDER BY
            provider_run.usage_reconciliation_attempted_at NULLS FIRST,
            COALESCE(provider_run.terminalized_at, provider_run.run_started_at),
            provider_run.preflight_id,
            provider_run.operation_key
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), attempted AS (
        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET usage_reconciliation_attempt_count = LEAST(
                provider_run.usage_reconciliation_attempt_count + 1,
                100000
            ),
            usage_reconciliation_attempted_at = v_now,
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE provider_run.preflight_id = candidate.preflight_id
          AND provider_run.operation_key = candidate.operation_key
        RETURNING provider_run.*
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_preflight_provider_run_json(candidate)
            ORDER BY COALESCE(candidate.terminalized_at, candidate.run_started_at),
                candidate.preflight_id,
                candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM attempted AS candidate;
    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    p_preflight_id UUID,
    p_input_hash TEXT,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_status TEXT,
    p_actual_usage_usd NUMERIC,
    p_provider_finished_at TIMESTAMP WITH TIME ZONE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.statement_timestamp();
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd NOT BETWEEN 0 AND 100000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       OR p_actual_usage_usd > p_max_charge_usd + 0.000000001
       OR p_provider_finished_at IS NULL
       OR p_provider_finished_at > v_now - INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.input_hash = p_input_hash
      AND provider_run.run_id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.status NOT IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')
       OR v_run.run_started_at IS NULL
       OR p_provider_finished_at < v_run.reserved_at
       OR p_provider_finished_at < v_run.run_started_at
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'running' THEN
        IF v_run.run_started_at > v_now - INTERVAL '30 seconds' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_NOT_READY',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET status = p_status,
            actual_usage_usd = p_actual_usage_usd,
            terminalized_at = p_provider_finished_at,
            usage_reconciled_at = v_now,
            updated_at = v_now
        WHERE provider_run.preflight_id = v_run.preflight_id
          AND provider_run.operation_key = v_run.operation_key
        RETURNING provider_run.* INTO v_run;
        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id, v_run.logical_provider, v_run.actor_id,
            v_run.credential_slot, v_run.status, v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    IF v_run.status IS DISTINCT FROM p_status OR v_run.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.terminalized_at > v_now - INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id, v_run.logical_provider, v_run.actor_id,
            v_run.credential_slot, v_run.status, v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET actual_usage_usd = p_actual_usage_usd,
        terminalized_at = p_provider_finished_at,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = v_run.preflight_id
      AND provider_run.operation_key = v_run.operation_key
    RETURNING provider_run.* INTO v_run;
    PERFORM public.record_analysis_preflight_provider_cost_event(
        v_run.run_id, v_run.logical_provider, v_run.actor_id,
        v_run.credential_slot, v_run.status, v_run.max_charge_usd,
        v_run.actual_usage_usd,
        (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
    );
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_preflight_manual_no_run_cost_event_for_operation(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_evidence_reference_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_resolution_date DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_billing_identity_hash TEXT;
    v_event public.analysis_preflight_acquisition_cost_events%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_operation_key !~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_resolution_date IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_billing_identity_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                'manual_no_run:' || p_preflight_id::TEXT || ':'
                    || p_operation_key || ':' || p_evidence_reference_hash,
                'UTF8'
            )
        ),
        'hex'
    );

    INSERT INTO public.analysis_preflight_acquisition_cost_events (
        billing_identity_hash, event_kind, logical_provider, actor_id,
        credential_slot, terminal_status, max_charge_usd, actual_usage_usd,
        evidence_reference_hash, event_date
    ) VALUES (
        v_billing_identity_hash, 'manual_no_run', p_logical_provider, p_actor_id,
        p_credential_slot, 'resolved_no_run', 0, 0,
        p_evidence_reference_hash, p_resolution_date
    )
    ON CONFLICT (billing_identity_hash) DO NOTHING
    RETURNING * INTO v_event;
    IF FOUND THEN
        RETURN;
    END IF;

    SELECT event.*
    INTO v_event
    FROM public.analysis_preflight_acquisition_cost_events AS event
    WHERE event.billing_identity_hash = v_billing_identity_hash
    FOR UPDATE;
    IF NOT FOUND
       OR v_event.event_kind IS DISTINCT FROM 'manual_no_run'
       OR v_event.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_event.actor_id IS DISTINCT FROM p_actor_id
       OR v_event.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_event.terminal_status IS DISTINCT FROM 'resolved_no_run'
       OR v_event.max_charge_usd IS DISTINCT FROM 0
       OR v_event.actual_usage_usd IS DISTINCT FROM 0
       OR v_event.evidence_reference_hash IS DISTINCT FROM p_evidence_reference_hash
       OR v_event.event_date IS DISTINCT FROM p_resolution_date THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_preflight_manual_no_run_cost_event_for_operation(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reserved_at TIMESTAMP WITH TIME ZONE,
    p_evidence_reference_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR NOT (
            p_operation_key = 'target-profile-fallback'
            OR p_operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
       )
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_reserved_at IS NULL
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.reserved_at IS DISTINCT FROM p_reserved_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'resolved_no_run' THEN
        IF v_run.run_id IS NOT NULL
           OR v_run.actual_usage_usd IS DISTINCT FROM 0
           OR v_run.manual_resolution_evidence_hash IS DISTINCT FROM p_evidence_reference_hash
           OR v_run.manual_resolved_at IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_RESOLUTION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        IF v_run.status IS DISTINCT FROM 'starting'
           OR v_run.run_id IS NOT NULL
           OR v_run.run_started_at IS NOT NULL
           OR v_run.terminalized_at IS NOT NULL
           OR v_run.actual_usage_usd IS NOT NULL
           OR v_run.usage_reconciled_at IS NOT NULL
           OR v_run.manual_resolution_evidence_hash IS NOT NULL
           OR v_run.manual_resolved_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_STATE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_run.reserved_at > v_now - INTERVAL '30 minutes'
           OR v_run.updated_at > v_now - INTERVAL '30 minutes'
           OR v_preflight.expires_at > v_now
           OR (v_preflight.lease_expires_at IS NOT NULL AND v_preflight.lease_expires_at > v_now)
           OR (
                v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_NOT_READY',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET status = 'resolved_no_run',
            actual_usage_usd = 0,
            terminalized_at = v_now,
            usage_reconciled_at = v_now,
            manual_resolution_evidence_hash = p_evidence_reference_hash,
            manual_resolved_at = v_now,
            updated_at = v_now
        WHERE provider_run.preflight_id = p_preflight_id
          AND provider_run.operation_key = p_operation_key
        RETURNING provider_run.* INTO v_run;
    END IF;

    IF v_run.operation_key = 'target-profile-fallback' THEN
        PERFORM public.record_analysis_preflight_manual_no_run_cost_event(
            v_run.preflight_id, v_run.manual_resolution_evidence_hash,
            v_run.logical_provider, v_run.actor_id, v_run.credential_slot,
            (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
        );
    ELSE
        PERFORM public.record_analysis_preflight_manual_no_run_cost_event_for_operation(
            v_run.preflight_id, v_run.operation_key,
            v_run.manual_resolution_evidence_hash, v_run.logical_provider,
            v_run.actor_id, v_run.credential_slot,
            (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
        );
    END IF;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(
    p_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_candidates JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_INVALID',
            ERRCODE = 'P0001';
    END IF;
    WITH candidates AS (
        SELECT provider_run.*
        FROM public.analysis_preflight_provider_runs AS provider_run
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = provider_run.preflight_id
        WHERE provider_run.status = 'starting'
          AND provider_run.run_id IS NULL
          AND provider_run.reserved_at <= v_now - INTERVAL '30 minutes'
          AND provider_run.updated_at <= v_now - INTERVAL '30 minutes'
          AND preflight.expires_at <= v_now
          AND (preflight.lease_expires_at IS NULL OR preflight.lease_expires_at <= v_now)
          AND (
              preflight.admission_lease_expires_at IS NULL
              OR preflight.admission_lease_expires_at <= v_now
          )
        ORDER BY provider_run.reserved_at,
            provider_run.preflight_id,
            provider_run.operation_key
        LIMIT p_limit
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'preflightId', candidate.preflight_id,
                'operationKey', candidate.operation_key,
                'inputHash', candidate.input_hash,
                'logicalProvider', candidate.logical_provider,
                'actorId', candidate.actor_id,
                'credentialSlot', candidate.credential_slot,
                'maxChargeUsd', candidate.max_charge_usd,
                'reservedAt', candidate.reserved_at
            ) ORDER BY candidate.reserved_at,
                candidate.preflight_id,
                candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_candidates
    FROM candidates AS candidate;
    RETURN v_candidates;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER)
    TO service_role;
