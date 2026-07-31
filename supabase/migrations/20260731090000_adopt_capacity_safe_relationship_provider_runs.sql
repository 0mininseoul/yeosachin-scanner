-- Keep the destination request's provider identity immutable while allowing the
-- one count drift already admitted by 03000 to reuse the same order-bound paid
-- relationship Dataset. Source lookup remains inside the recorded failed-request
-- lineage; this is never a global cache.
ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions
    ADD COLUMN source_operation_key VARCHAR(87),
    ADD COLUMN destination_input_hash VARCHAR(64);

ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions
    DISABLE TRIGGER prevent_analysis_v2_provider_run_adoption_mutation;
UPDATE public.analysis_v2_recovery_provider_run_adoptions AS adoption
SET source_operation_key = adoption.operation_key,
    destination_input_hash = source_run.input_hash
FROM public.analysis_v2_provider_runs AS source_run
WHERE source_run.request_id = adoption.source_request_id
  AND source_run.job_key = adoption.source_job_key
  AND source_run.operation_key = adoption.operation_key
  AND source_run.run_id = adoption.source_run_id;
ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions
    ENABLE TRIGGER prevent_analysis_v2_provider_run_adoption_mutation;

DO $migration$
DECLARE
    v_missing BIGINT;
    v_constraint_name TEXT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_missing
    FROM public.analysis_v2_recovery_provider_run_adoptions
    WHERE source_operation_key IS NULL OR destination_input_hash IS NULL;
    IF v_missing <> 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_CROSS_IDENTITY_BACKFILL_FAILED';
    END IF;

    SELECT constraint_name INTO v_constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'analysis_v2_recovery_provider_run_adoptions'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name IN (
          SELECT constraint_name
          FROM information_schema.constraint_column_usage
          WHERE table_schema = 'public'
            AND table_name = 'analysis_v2_provider_runs'
      )
    ORDER BY constraint_name
    LIMIT 1;
    IF v_constraint_name IS NULL THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_CROSS_IDENTITY_SOURCE_FK_MISSING';
    END IF;
    EXECUTE pg_catalog.format(
        'ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions DROP CONSTRAINT %I',
        v_constraint_name
    );
END;
$migration$;

ALTER TABLE public.analysis_v2_provider_runs
    ADD CONSTRAINT analysis_v2_provider_runs_adoption_source_run_unique
    UNIQUE (request_id, job_key, operation_key, run_id);

ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions
    ALTER COLUMN source_operation_key SET NOT NULL,
    ALTER COLUMN destination_input_hash SET NOT NULL,
    ADD CONSTRAINT analysis_v2_recovery_adoptions_exact_source_fkey
        FOREIGN KEY (
            source_request_id, source_job_key, source_operation_key, source_run_id
        )
        REFERENCES public.analysis_v2_provider_runs(
            request_id, job_key, operation_key, run_id
        )
        ON DELETE RESTRICT,
    ADD CONSTRAINT analysis_v2_recovery_adoptions_destination_input_hash_check
        CHECK (destination_input_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION public.analysis_v2_fill_exact_adoption_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source_input_hash TEXT;
BEGIN
    IF NEW.source_operation_key IS NULL THEN
        NEW.source_operation_key := NEW.operation_key;
    END IF;
    IF NEW.destination_input_hash IS NULL THEN
        SELECT source_run.input_hash INTO v_source_input_hash
        FROM public.analysis_v2_provider_runs AS source_run
        WHERE source_run.request_id = NEW.source_request_id
          AND source_run.job_key = NEW.source_job_key
          AND source_run.operation_key = NEW.source_operation_key
          AND source_run.run_id = NEW.source_run_id;
        NEW.destination_input_hash := v_source_input_hash;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER fill_exact_adoption_identity
BEFORE INSERT ON public.analysis_v2_recovery_provider_run_adoptions
FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_fill_exact_adoption_identity();

CREATE FUNCTION public.analysis_v2_relationship_provider_identity(
    p_side TEXT,
    p_target_username TEXT,
    p_declared_count INTEGER,
    p_plan_id TEXT,
    p_replacement BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(operation_key TEXT, input_hash TEXT)
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_kind TEXT;
    v_canonical TEXT;
BEGIN
    IF p_side NOT IN ('followers', 'following')
       OR p_target_username !~ '^[a-z0-9._]{1,30}$'
       OR p_declared_count NOT BETWEEN 1 AND 1200
       OR p_plan_id NOT IN ('basic', 'standard', 'plus') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_PROVIDER_IDENTITY_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_kind := 'relationship-' || p_side;
    v_canonical :=
        pg_catalog.octet_length('relationship-v2')::TEXT || ':relationship-v2'
        || pg_catalog.chr(10)
        || pg_catalog.octet_length(p_side)::TEXT || ':' || p_side
        || pg_catalog.chr(10)
        || pg_catalog.octet_length(p_target_username)::TEXT || ':' || p_target_username
        || pg_catalog.chr(10)
        || pg_catalog.octet_length(p_declared_count::TEXT)::TEXT || ':' || p_declared_count::TEXT
        || pg_catalog.chr(10)
        || pg_catalog.octet_length(p_plan_id)::TEXT || ':' || p_plan_id
        || pg_catalog.chr(10)
        || pg_catalog.octet_length('apify-no-cookie')::TEXT || ':apify-no-cookie';
    IF p_replacement THEN
        v_canonical :=
            pg_catalog.octet_length('relationship-incomplete-replacement-v1')::TEXT
            || ':relationship-incomplete-replacement-v1'
            || pg_catalog.chr(10)
            || pg_catalog.octet_length(v_canonical)::TEXT || ':' || v_canonical;
    END IF;
    RETURN QUERY SELECT
        v_kind || ':' || pg_catalog.encode(extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-provider-operation-v1' || pg_catalog.chr(10)
                || v_kind || pg_catalog.chr(10) || v_canonical,
                'UTF8'
            ), 'sha256'
        ), 'hex'),
        pg_catalog.encode(extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-provider-input-v1' || pg_catalog.chr(10)
                || v_canonical,
                'UTF8'
            ), 'sha256'
        ), 'hex');
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_relationship_provider_identity(
    TEXT, TEXT, INTEGER, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the reviewed exact-identity implementation byte-for-byte. The wrapper
-- below may enter cross-identity logic only after this function has validated all
-- order, payment, failure-receipt, preflight, job-claim, and lineage fences.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_exact_recovery_provider_run;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_exact JSONB;
    v_exact_source_unavailable BOOLEAN := FALSE;
    v_order public.earlybird_orders%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_failed_request public.analysis_requests%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_current public.analysis_preflights%ROWTYPE;
    v_recovery_preflight public.analysis_preflights%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_source public.analysis_v2_provider_runs%ROWTYPE;
    v_existing public.analysis_v2_recovery_provider_run_adoptions%ROWTYPE;
    v_side TEXT;
    v_current_count INTEGER;
    v_source_count INTEGER;
    v_replacement BOOLEAN;
    v_current_operation TEXT;
    v_current_input TEXT;
    v_source_operation TEXT;
    v_source_input TEXT;
    v_initial_source_operation TEXT;
    v_initial_source_input TEXT;
BEGIN
    BEGIN
        v_exact := public.resolve_analysis_v2_exact_recovery_provider_run(
            p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
            p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd
        );
        RETURN v_exact;
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM <> 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE' THEN
                RAISE;
            END IF;
            v_exact_source_unavailable := TRUE;
    END;

    IF NOT v_exact_source_unavailable
       OR p_job_key <> 'track:relationships:collect'
       OR p_logical_provider <> 'apify'
       OR p_actor_id <>
            'scraping_solutions/instagram-scraper-followers-following-no-cookies' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    -- The exact resolver's failed subtransaction released its row lock. Re-lock
    -- and revalidate the live claim before any cross-identity mutation.
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
    FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.result_request_id = p_request_id
    FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = v_order.id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    SELECT preflight.* INTO v_current
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT preflight.* INTO v_recovery_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_recovery.recovery_preflight_id
    FOR UPDATE;
    SELECT request.* INTO v_failed_request
    FROM public.analysis_requests AS request
    WHERE request.id = v_recovery.failed_request_id
    FOR UPDATE;

    -- Repeat every mutable lineage fence after reacquiring canonical row locks;
    -- the caught exact-resolver subtransaction intentionally released its locks.
    IF v_request.pipeline_version <> 'v2'
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_request.preflight_id IS DISTINCT FROM v_current.id
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_fulfillment.request_id IS DISTINCT FROM p_request_id
       OR v_order.status NOT IN ('analysis_in_progress', 'result_ready')
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_failed_request.user_id IS DISTINCT FROM v_order.user_id
       OR (
            pg_catalog.lower(pg_catalog.btrim(v_failed_request.target_instagram_id))
                IS DISTINCT FROM
                pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            AND v_failed_request.target_instagram_id IS DISTINCT FROM (
                'retained.' || pg_catalog.substr(
                    pg_catalog.replace(v_failed_request.id::TEXT, '-', ''), 1, 20
                )
            )
       )
       OR v_failed_request.status <> 'failed'
       OR v_failed_request.pipeline_version <> 'v2'
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_failed_request.id
              AND receipt.error_code = v_failed_request.error_message
       )
       OR v_current.user_id IS DISTINCT FROM v_order.user_id
       OR v_current.access_mode <> 'production'
       OR v_current.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_current.idempotency_key !~ (
            '^earlybird[.]fulfillment[.]'
            || pg_catalog.replace(v_order.id::TEXT, '-', '')
            || '([.]r[1-9])?$'
       )
       OR v_current.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_current.exclusion_decision IS DISTINCT FROM v_order.exclusion_decision
       OR v_current.excluded_instagram_id IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_current.launch_status_snapshot
            IS DISTINCT FROM v_recovery_preflight.launch_status_snapshot
       OR v_current.plan_catalog_snapshot
            IS DISTINCT FROM v_recovery_preflight.plan_catalog_snapshot
       OR v_current.pricing_version IS DISTINCT FROM v_recovery_preflight.pricing_version
       OR v_current.pricing_snapshot IS DISTINCT FROM v_recovery_preflight.pricing_snapshot
       OR v_current.policy_versions_snapshot
            IS DISTINCT FROM v_recovery_preflight.policy_versions_snapshot
       OR v_recovery_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_recovery_preflight.access_mode <> 'production'
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order, v_recovery_preflight, v_current
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    FOR v_side, v_replacement IN
        SELECT candidate.side, candidate.replacement
        FROM (VALUES
            ('followers'::TEXT, FALSE), ('followers'::TEXT, TRUE),
            ('following'::TEXT, FALSE), ('following'::TEXT, TRUE)
        ) AS candidate(side, replacement)
    LOOP
        v_current_count := CASE v_side
            WHEN 'followers' THEN v_current.target_followers_count
            ELSE v_current.target_following_count
        END;
        SELECT identity.operation_key, identity.input_hash
        INTO v_current_operation, v_current_input
        FROM public.analysis_v2_relationship_provider_identity(
            v_side, v_order.target_instagram_id, v_current_count,
            v_order.plan_id, v_replacement
        ) AS identity;
        EXIT WHEN v_current_operation = p_operation_key
              AND v_current_input = p_input_hash;
        v_side := NULL;
    END LOOP;
    IF v_side IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    -- The paid order freezes the old/source counts. 03000 admits a later,
    -- capacity-safe fresh count on the current preflight without mutating them.
    v_source_count := CASE v_side
        WHEN 'followers' THEN v_order.target_followers_count
        ELSE v_order.target_following_count
    END;
    IF v_source_count = v_current_count THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    SELECT identity.operation_key, identity.input_hash
    INTO v_source_operation, v_source_input
    FROM public.analysis_v2_relationship_provider_identity(
        v_side, v_order.target_instagram_id, v_source_count,
        v_order.plan_id, v_replacement
    ) AS identity;
    SELECT source_run.* INTO STRICT v_source
    FROM public.analysis_v2_provider_runs AS source_run
    WHERE source_run.request_id = v_recovery.failed_request_id
      AND source_run.job_key = p_job_key
      AND source_run.operation_key = v_source_operation
      AND source_run.input_hash = v_source_input
      AND source_run.status = 'succeeded'
      AND source_run.run_id IS NOT NULL
      AND source_run.actual_usage_usd IS NOT NULL
      AND source_run.usage_reconciled_at IS NOT NULL
      AND source_run.logical_provider = p_logical_provider
      AND source_run.actor_id = p_actor_id
      AND source_run.credential_slot = p_credential_slot;

    IF v_replacement THEN
        SELECT identity.operation_key, identity.input_hash
        INTO v_initial_source_operation, v_initial_source_input
        FROM public.analysis_v2_relationship_provider_identity(
            v_side, v_order.target_instagram_id, v_source_count,
            v_order.plan_id, FALSE
        ) AS identity;
        IF NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS initial_run
            WHERE initial_run.request_id = v_recovery.failed_request_id
              AND initial_run.job_key = p_job_key
              AND initial_run.operation_key = v_initial_source_operation
              AND initial_run.input_hash = v_initial_source_input
              AND initial_run.status = 'succeeded'
              AND initial_run.run_id IS NOT NULL
              AND initial_run.actual_usage_usd IS NOT NULL
              AND initial_run.usage_reconciled_at IS NOT NULL
              AND initial_run.logical_provider = p_logical_provider
              AND initial_run.actor_id = p_actor_id
              AND initial_run.credential_slot = p_credential_slot
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT adoption.* INTO v_existing
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    WHERE adoption.request_id = p_request_id
      AND adoption.job_key = p_job_key
      AND adoption.operation_key = p_operation_key;
    IF FOUND AND (
        v_existing.destination_input_hash IS DISTINCT FROM p_input_hash
        OR v_existing.source_request_id IS DISTINCT FROM v_source.request_id
        OR v_existing.source_job_key IS DISTINCT FROM v_source.job_key
        OR v_existing.source_operation_key IS DISTINCT FROM v_source.operation_key
        OR v_existing.source_run_id IS DISTINCT FROM v_source.run_id
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF NOT FOUND THEN
        INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
            request_id, job_key, operation_key, destination_input_hash,
            source_request_id, source_job_key, source_operation_key, source_run_id
        ) VALUES (
            p_request_id, p_job_key, p_operation_key, p_input_hash,
            v_source.request_id, v_source.job_key, v_source.operation_key, v_source.run_id
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', v_source.request_id,
        'sourceJobKey', v_source.job_key,
        'operationKey', p_operation_key,
        'inputHash', p_input_hash,
        'logicalProvider', v_source.logical_provider,
        'actorId', v_source.actor_id,
        'credentialSlot', v_source.credential_slot,
        'maxChargeUsd', v_source.max_charge_usd,
        'runId', v_source.run_id,
        'actualUsageUsd', v_source.actual_usage_usd,
        'usageReconciledAt', v_source.usage_reconciled_at
    );
EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_evidence_source(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_provider TEXT,
    p_run_id TEXT,
    p_credential_slot TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_operation_key
          AND provider_run.job_claim_token = p_claim_token
          AND provider_run.input_hash = p_input_hash
          AND provider_run.logical_provider = p_provider
          AND provider_run.run_id = p_run_id
          AND provider_run.status = 'succeeded'
          AND (p_credential_slot IS NULL OR provider_run.credential_slot = p_credential_slot)
        UNION ALL
        SELECT 1
        FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
        JOIN public.analysis_v2_provider_runs AS provider_run
          ON provider_run.request_id = adoption.source_request_id
         AND provider_run.job_key = adoption.source_job_key
         AND provider_run.operation_key = adoption.source_operation_key
         AND provider_run.run_id = adoption.source_run_id
        JOIN public.analysis_pipeline_jobs AS job
          ON job.request_id = adoption.request_id AND job.job_key = adoption.job_key
        WHERE adoption.request_id = p_request_id
          AND adoption.job_key = p_job_key
          AND adoption.operation_key = p_operation_key
          AND adoption.destination_input_hash = p_input_hash
          AND job.status = 'processing'
          AND job.lease_token = p_claim_token
          AND job.lease_expires_at > pg_catalog.clock_timestamp()
          AND provider_run.logical_provider = p_provider
          AND provider_run.run_id = p_run_id
          AND provider_run.status = 'succeeded'
          AND provider_run.actual_usage_usd IS NOT NULL
          AND provider_run.usage_reconciled_at IS NOT NULL
          AND (p_credential_slot IS NULL OR provider_run.credential_slot = p_credential_slot)
    );
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_provider_evidence_source(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
