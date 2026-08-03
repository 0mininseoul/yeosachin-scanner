-- UUID-only replay reader for a completed, scrubbed betatest free-pool run.
-- Allocation rows are intentionally not evidence here: terminal settlement may
-- archive and remove them. The immutable execution-policy row survives that
-- cleanup and remains the durable exact slot-map proof.
CREATE FUNCTION public.read_analysis_v2_betatest_free_pool_replay_source(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_runs JSONB;
    v_preflight_runs JSONB;
    v_provider_run_count INTEGER;
    v_preflight_run_count INTEGER;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = request.preflight_id
    JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = request.id
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = request.id
    WHERE request.id = p_request_id
      AND request.status = 'completed'
      AND request.completed_at IS NOT NULL
      AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard'
      AND request.plan_access_mode_snapshot = 'production'
      AND request.test_entitlement_jti_hash IS NULL
      AND request.analysis_entry_channel = 'betatest'
      AND request.policy_versions_snapshot =
          '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.10","scheduler":"ai-scheduler-v1"}'::JSONB
      AND preflight.user_id = request.user_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'production'
      AND preflight.analysis_entry_channel = 'betatest'
      AND preflight.beta_entry_provenance = 'betatest_service_v1'
      AND preflight.consumed_request_id = request.id
      AND preflight.policy_versions_snapshot = request.policy_versions_snapshot
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
          pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      )
      AND preflight.target_full_name IS NULL
      AND preflight.target_bio IS NULL
      AND preflight.target_profile_image_url IS NULL
      AND preflight.exclusion_decision = 'skip'
      AND preflight.excluded_instagram_id IS NULL
      AND result_summary.plan_id = 'standard'
      AND result_summary.score_policy_version = 'risk-policy-v2.5'
      AND execution_policy.mode = 'betatest_free_pool'
      AND execution_policy.policy_version = 'betatest-free-pool-v1'
      AND execution_policy.entitlement_jti_hash IS NULL
      AND public.analysis_beta_valid_operation_slot_map(execution_policy.operation_slot_map)
      AND execution_policy.operation_slot_map ?& ARRAY[
          'target-profile', 'relationship-followers', 'relationship-following',
          'profile-fallback', 'profile-repair', 'target-likers',
          'target-comments', 'candidate-likers'
      ]
      AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_each_text(execution_policy.operation_slot_map)
          AS slot_map(operation_family, credential_slot)
          WHERE credential_slot = 'secondary'
      )
      -- Completed request targets are intentionally scrubbed to `retained.*`.
      -- Do not recover or compare the execution-policy target here; its exact
      -- persisted beta-free mode/version/map is the surviving replay evidence.
      ;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight WHERE preflight.id = v_request.preflight_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*) INTO v_provider_run_count
    FROM public.analysis_v2_provider_runs AS provider_run WHERE provider_run.request_id = v_request.id;
    SELECT pg_catalog.count(*) INTO v_preflight_run_count
    FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = v_preflight.id;
    IF v_provider_run_count NOT BETWEEN 1 AND 128
       OR v_preflight_run_count NOT BETWEEN 1 AND 4
       OR EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS provider_run
          JOIN public.analysis_v2_provider_execution_policies AS execution_policy
            ON execution_policy.request_id = provider_run.request_id
          WHERE provider_run.request_id = v_request.id
            AND (provider_run.logical_provider <> 'apify'
              OR provider_run.status <> 'succeeded'
              OR provider_run.run_id IS NULL
              OR provider_run.terminalized_at IS NULL
              OR provider_run.actual_usage_usd IS NULL
              OR provider_run.usage_reconciled_at IS NULL
              OR provider_run.credential_slot = 'secondary'
              OR provider_run.credential_slot IS DISTINCT FROM execution_policy.operation_slot_map ->> pg_catalog.split_part(provider_run.operation_key, ':', 1))
       )
       OR EXISTS (
          SELECT 1
          FROM public.analysis_preflight_provider_runs AS provider_run
          JOIN public.analysis_v2_provider_execution_policies AS execution_policy
            ON execution_policy.request_id = v_request.id
          WHERE provider_run.preflight_id = v_preflight.id
            AND (provider_run.logical_provider <> 'apify'
              OR provider_run.status <> 'succeeded'
              OR provider_run.run_id IS NULL
              OR provider_run.terminalized_at IS NULL
              OR provider_run.actual_usage_usd IS NULL
              OR provider_run.usage_reconciled_at IS NULL
              OR provider_run.credential_slot = 'secondary'
              OR provider_run.credential_slot IS DISTINCT FROM execution_policy.operation_slot_map ->> 'target-profile')
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL_PROVIDER_LEDGER_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.job_key, run.operation_key) INTO v_provider_runs
    FROM public.analysis_v2_provider_runs AS run WHERE run.request_id = v_request.id;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.operation_key) INTO v_preflight_runs
    FROM public.analysis_preflight_provider_runs AS run WHERE run.preflight_id = v_preflight.id;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'preflightId', v_preflight.id,
        'targetUsername', 'replay_' || pg_catalog.substr(pg_catalog.md5(v_request.id::TEXT || ':' || v_preflight.id::TEXT), 1, 23),
        'selectedPlanId', 'standard',
        'policyVersions', v_request.policy_versions_snapshot,
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_v2_betatest_free_pool_replay_source(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_betatest_free_pool_replay_source(UUID)
    TO service_role;

COMMENT ON FUNCTION public.read_analysis_v2_betatest_free_pool_replay_source(UUID) IS
    'Read-only exact completed betatest free-pool replay source; accepts durable execution-policy evidence after terminal allocation cleanup and returns only opaque target and bounded reconciled Apify run descriptors.';
