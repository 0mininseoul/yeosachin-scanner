-- Add one same-named credential identity to the general Analysis V2 worker.
-- The separate profile-repair microcanary retains its historical five-slot policy.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The terminal-safety RPC predated the shared validator and retained a five-slot
-- literal. Recreate it against the helper so a failed senary-backed E2E can use
-- the same durable, service-only cleanup path without broadening any canary RPC.
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (p_actual_usage_usd IS NOT NULL AND (
            p_actual_usage_usd NOT BETWEEN 0 AND 100000
            OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = v_run.request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status
           OR (p_actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now, updated_at = v_now
            WHERE provider_run.reservation_token = p_reservation_token
            RETURNING provider_run.* INTO v_run;
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;
    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.reservation_token = p_reservation_token
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT) IS
    'Exact same-named credential identities supported by the general Analysis V2 worker; no token pooling or aliases.';

-- Return authoritative, bounded evidence before a deploy intentionally removes
-- non-primary Secret Manager references. Official profile-provider canary runs
-- use primary, but cleanup of their eight retained source runs uses each source
-- run's stored credential slot. Both canary journals must therefore be drained.
CREATE OR REPLACE FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(
    p_drop_slots TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_drop_slots TEXT[];
    v_active_request_runs BIGINT;
    v_unreconciled_request_runs BIGINT;
    v_active_preflight_runs BIGINT;
    v_unreconciled_preflight_runs BIGINT;
    v_active_profile_repair_canary_runs BIGINT;
    v_unreconciled_profile_repair_canary_runs BIGINT;
    v_active_requests BIGINT;
    v_active_preflights BIGINT;
    v_active_drop_slot_policies BIGINT;
    v_incomplete_profile_provider_canary_cleanups BIGINT;
BEGIN
    SELECT pg_catalog.array_agg(slot ORDER BY slot)
    INTO v_drop_slots
    FROM pg_catalog.unnest(p_drop_slots) AS requested(slot);

    IF p_drop_slots IS NULL
       OR pg_catalog.cardinality(p_drop_slots) NOT BETWEEN 1 AND 5
       OR pg_catalog.cardinality(v_drop_slots) <> (
            SELECT pg_catalog.count(DISTINCT slot)
            FROM pg_catalog.unnest(p_drop_slots) AS requested(slot)
       )
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(p_drop_slots) AS requested(slot)
            WHERE slot IS NULL
               OR slot = 'primary'
               OR NOT public.analysis_v2_valid_apify_credential_slot(slot)
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_SLOTS_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_active_request_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('starting', 'running');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_request_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND provider_run.usage_reconciled_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_active_preflight_runs
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('starting', 'running');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_preflight_runs
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND provider_run.usage_reconciled_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_active_profile_repair_canary_runs
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.credential_slot = ANY(v_drop_slots)
      AND canary_run.state IN ('starting', 'running', 'ambiguous');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_profile_repair_canary_runs
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.credential_slot = ANY(v_drop_slots)
      AND canary_run.state IN ('succeeded', 'failed')
      AND canary_run.usage_reconciled_at IS NULL;

    -- A provider reservation can still be created before any provider ledger
    -- row exists. Reserve is fenced by an active request, while target-profile
    -- acquisition is fenced by an active preflight. Requiring global quiet
    -- state prevents an old drained worker invocation from materializing a
    -- drop-slot run after this point-in-time audit.
    SELECT pg_catalog.count(*)
    INTO v_active_requests
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.status IN ('pending', 'processing');

    SELECT pg_catalog.count(*)
    INTO v_active_preflights
    FROM public.analysis_preflights AS preflight
    WHERE preflight.status IN ('pending', 'processing');

    -- Keep the policy-specific count as diagnostic evidence. Terminal requests
    -- retain immutable policies but can no longer reserve provider runs.
    SELECT pg_catalog.count(*)
    INTO v_active_drop_slot_policies
    FROM public.analysis_v2_provider_execution_policies AS policy
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = policy.request_id
    WHERE analysis_request.status IN ('pending', 'processing')
      AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_each_text(
              policy.operation_slot_map
          ) AS operation_slot(operation_kind, credential_slot)
          WHERE operation_slot.credential_slot = ANY(v_drop_slots)
      );

    SELECT pg_catalog.count(*)
    INTO v_incomplete_profile_provider_canary_cleanups
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE (
        experiment.source_kvs_cleanup_state IS DISTINCT FROM 'verified_absent'
        OR experiment.source_dataset_cleanup_state IS DISTINCT FROM 'verified_absent'
        OR experiment.source_request_queue_cleanup_state
            IS DISTINCT FROM 'verified_absent'
    )
      AND EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS source_run
          JOIN public.analysis_v2_provider_execution_policies AS execution_policy
            ON execution_policy.request_id = source_run.request_id
          WHERE source_run.request_id = experiment.source_request_id
            AND source_run.status = 'succeeded'
            AND source_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
            AND source_run.actor_id = 'apify/instagram-profile-scraper'
            AND source_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
            AND source_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
            AND execution_policy.mode = 'test_operation_split'
            AND execution_policy.policy_version = 'authorized-free-e2e-v1'
            AND execution_policy.operation_slot_map->>'profile-fallback'
                = source_run.credential_slot
            AND source_run.credential_slot = ANY(v_drop_slots)
      );

    RETURN pg_catalog.jsonb_build_object(
        'ready',
            v_active_request_runs = 0
            AND v_unreconciled_request_runs = 0
            AND v_active_preflight_runs = 0
            AND v_unreconciled_preflight_runs = 0
            AND v_active_profile_repair_canary_runs = 0
            AND v_unreconciled_profile_repair_canary_runs = 0
            AND v_active_requests = 0
            AND v_active_preflights = 0
            AND v_active_drop_slot_policies = 0
            AND v_incomplete_profile_provider_canary_cleanups = 0,
        'dropSlots', pg_catalog.to_jsonb(v_drop_slots),
        'activeRequestRuns', v_active_request_runs,
        'unreconciledRequestRuns', v_unreconciled_request_runs,
        'activePreflightRuns', v_active_preflight_runs,
        'unreconciledPreflightRuns', v_unreconciled_preflight_runs,
        'activeProfileRepairCanaryRuns', v_active_profile_repair_canary_runs,
        'unreconciledProfileRepairCanaryRuns',
            v_unreconciled_profile_repair_canary_runs,
        'activeRequests', v_active_requests,
        'activePreflights', v_active_preflights,
        'activeDropSlotPolicies', v_active_drop_slot_policies,
        'incompleteProfileProviderCanaryCleanups',
            v_incomplete_profile_provider_canary_cleanups
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(TEXT[])
    TO service_role;

COMMENT ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(TEXT[]) IS
    'Service-only global quiet-work, drop-slot ledger, policy, and source-cleanup evidence before a primary-only Cloud Run promotion.';
