BEGIN;

/*
 * A cleanup intent belongs to the failed job's provider reservation set.  The
 * previous request-wide gate made an already-terminal profile run freeze every
 * unrelated provider job until the cleanup worker happened to finish. Keep the
 * request lock and immutable provider identity checks, but scope admission and
 * reconciliation to the intent's exact failed job.
 */

ALTER FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) RENAME TO reserve_analysis_v2_provider_run_unscoped_cleanup;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run_unscoped_cleanup(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run(
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
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_existing public.analysis_v2_provider_runs%ROWTYPE;
    v_operation_kind TEXT;
    v_operation_family TEXT;
    v_spent NUMERIC;
BEGIN
    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    PERFORM 1
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id
          AND intent.failed_job_key = p_job_key
          AND intent.failed_job_input_hash = p_input_hash
          AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;

    IF v_request.analysis_entry_channel = 'betatest' THEN
        v_operation_family := pg_catalog.split_part(p_operation_key, ':', 1);
        IF NOT public.analysis_beta_valid_operation_slot_map(v_policy.operation_slot_map)
           OR v_policy.mode IS DISTINCT FROM 'betatest_free_pool'
           OR v_policy.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
           OR v_policy.entitlement_jti_hash IS NOT NULL
           OR v_operation_family NOT IN (
                'target-profile', 'relationship-followers', 'relationship-following',
                'profile-fallback', 'profile-repair', 'target-likers',
                'target-comments', 'candidate-likers'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_OPERATION_INVALID', ERRCODE = 'P0001';
        END IF;
        SELECT allocation.* INTO v_allocation
        FROM public.analysis_beta_pool_allocations AS allocation
        WHERE allocation.request_id = p_request_id
          AND allocation.lifecycle_state = 'active'
        FOR UPDATE;
        SELECT reservation.* INTO v_reservation
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_allocation.id
          AND reservation.operation_family = v_operation_family
        FOR UPDATE;
        IF NOT FOUND
           OR v_allocation.operation_slot_map IS DISTINCT FROM v_policy.operation_slot_map
           OR v_reservation.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_policy.operation_slot_map->>v_operation_family IS DISTINCT FROM p_credential_slot
           OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001';
        END IF;
        SELECT provider_run.* INTO v_existing
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_operation_key
        FOR UPDATE;
        IF FOUND AND (
            v_existing.input_hash IS DISTINCT FROM p_input_hash
            OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
            OR v_existing.actor_id IS DISTINCT FROM p_actor_id
            OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
            OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd), 0::NUMERIC)
        INTO v_spent
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND pg_catalog.split_part(provider_run.operation_key, ':', 1) = v_operation_family
          AND (
              provider_run.job_key IS DISTINCT FROM p_job_key
              OR provider_run.operation_key IS DISTINCT FROM p_operation_key
          );
        IF v_spent + p_max_charge_usd > v_reservation.reserved_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE = 'P0001';
        END IF;
    ELSIF v_policy.request_id IS NOT NULL THEN
        v_operation_kind := pg_catalog.split_part(p_operation_key, ':', 1);
        IF v_policy.mode = 'test_operation_split'
           AND v_operation_kind = 'profile-repair' THEN
            v_operation_kind := 'profile-fallback';
        END IF;
        IF v_policy.operation_slot_map->>v_operation_kind IS DISTINCT FROM p_credential_slot THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH', ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN public.analysis_v2_reserve_provider_run_internal(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd,
        p_reservation_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) TO service_role;

ALTER FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) RENAME TO list_analysis_v2_active_provider_runs_for_cleanup_unscoped;

REVOKE ALL ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup_unscoped(
    UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    p_request_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_starting_count INTEGER;
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    IF p_request_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id
          AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_starting_count
    FROM public.analysis_v2_provider_runs AS provider_run
    JOIN public.analysis_v2_provider_cleanup_intents AS intent
     ON intent.request_id = provider_run.request_id
     AND intent.failed_job_key = provider_run.job_key
     AND intent.failed_job_input_hash = provider_run.input_hash
     AND intent.completed_at IS NULL
    LEFT JOIN public.analysis_v2_unconfirmed_start_resolutions AS resolution
      ON resolution.reservation_token = provider_run.reservation_token
    WHERE provider_run.status = 'starting'
      AND resolution.reservation_token IS NULL
      AND (p_request_id IS NULL OR provider_run.request_id = p_request_id);

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_v2_provider_run_json(candidate)
            ORDER BY candidate.reserved_at, candidate.request_id,
                candidate.job_key, candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM (
        SELECT provider_run.*
        FROM public.analysis_v2_provider_runs AS provider_run
        JOIN public.analysis_v2_provider_cleanup_intents AS intent
         ON intent.request_id = provider_run.request_id
         AND intent.failed_job_key = provider_run.job_key
         AND intent.failed_job_input_hash = provider_run.input_hash
         AND intent.completed_at IS NULL
        WHERE provider_run.status = 'running'
          AND (p_request_id IS NULL OR provider_run.request_id = p_request_id)
        ORDER BY provider_run.reserved_at, provider_run.request_id,
            provider_run.job_key, provider_run.operation_key
        LIMIT p_limit
    ) AS candidate;

    RETURN pg_catalog.jsonb_build_object(
        'startingCount', v_starting_count,
        'runs', v_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) TO service_role;

ALTER FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) RENAME TO settle_analysis_v2_provider_run_for_cleanup_unscoped;

REVOKE ALL ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup_unscoped(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
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
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR SHARE;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = v_run.request_id
          AND intent.failed_job_key = v_run.job_key
          AND intent.failed_job_input_hash = v_run.input_hash
          AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;
    RETURN public.settle_analysis_v2_provider_run_for_cleanup_unscoped(
        p_reservation_token, p_run_id, p_logical_provider, p_actor_id,
        p_credential_slot, p_max_charge_usd, p_status, p_actual_usage_usd
    );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;

/* The request-level reader remains for cleanup workers; workers processing a
 * different job need an exact job/input admission read instead. */
CREATE OR REPLACE FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE WHEN intent.request_id IS NULL THEN NULL ELSE
        pg_catalog.jsonb_build_object(
            'requestId', intent.request_id,
            'jobKey', intent.failed_job_key,
            'jobInputHash', intent.failed_job_input_hash,
            'errorCode', intent.error_code
        )
    END
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id
      AND intent.failed_job_key = p_job_key
      AND intent.failed_job_input_hash = p_job_input_hash
      AND intent.completed_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) IS 'Returns a cleanup intent only for its exact failed job and input fence; unrelated request jobs are not blocked.';

COMMIT;
