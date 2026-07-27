-- A separate, UUID-only source for the approved historical official E2E.
-- The legacy target-based production reader remains unchanged.
CREATE FUNCTION public.read_analysis_v2_historical_official_e2e_replay_source(
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
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption
      ON entitlement_consumption.request_id = request.id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = entitlement_consumption.preflight_id
    WHERE request.id = p_request_id
      AND request.status = 'completed'
      AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard'
      AND request.plan_access_mode_snapshot = 'test_entitlement'
      AND request.preflight_id = preflight.id
      AND request.completed_at IS NOT NULL
      AND request.test_entitlement_jti_hash = entitlement_consumption.entitlement_jti_hash
      AND entitlement_consumption.user_id = request.user_id
      AND entitlement_consumption.selected_plan_id = 'standard'
      AND preflight.user_id = request.user_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.consumed_request_id = request.id
      AND preflight.target_is_private IS FALSE
      AND request.policy_versions_snapshot = '{"pipeline":"v2","risk":"risk-policy-v2.3","aiStage":"ai-stage-policy-v2.7"}'::JSONB
      AND preflight.policy_versions_snapshot = request.policy_versions_snapshot;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.consumed_request_id = v_request.id
      AND preflight.user_id = v_request.user_id
      AND preflight.target_is_private IS FALSE
      AND preflight.policy_versions_snapshot = v_request.policy_versions_snapshot;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.job_key, run.operation_key), '[]'::JSONB) INTO v_provider_runs
    FROM (
        SELECT provider_run.* FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = v_request.id
          AND provider_run.logical_provider = 'apify'
          AND provider_run.status = 'succeeded' AND provider_run.run_id IS NOT NULL
        ORDER BY provider_run.job_key, provider_run.operation_key LIMIT 128
    ) AS run;

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.operation_key), '[]'::JSONB) INTO v_preflight_runs
    FROM (
        SELECT provider_run.* FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = v_preflight.id
          AND provider_run.logical_provider = 'apify'
          AND provider_run.status = 'succeeded' AND provider_run.run_id IS NOT NULL
        ORDER BY provider_run.operation_key LIMIT 4
    ) AS run;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'preflightId', v_preflight.id,
        'targetUsername', 'replay_' || pg_catalog.substr(pg_catalog.md5(
            v_request.id::TEXT || ':' || v_preflight.id::TEXT
        ), 1, 23),
        'selectedPlanId', 'standard',
        'policyVersions', v_request.policy_versions_snapshot,
        'target', pg_catalog.jsonb_build_object(
            'fullName', v_preflight.target_full_name, 'bio', v_preflight.target_bio,
            'profileImageUrl', v_preflight.target_profile_image_url,
            'followersCount', v_preflight.target_followers_count,
            'followingCount', v_preflight.target_following_count
        ),
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_v2_historical_official_e2e_replay_source(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_historical_official_e2e_replay_source(UUID)
    TO service_role;

COMMENT ON FUNCTION public.read_analysis_v2_historical_official_e2e_replay_source(UUID) IS
    'Read-only, UUID-only historical official E2E source; entitlement lineage and opaque replay target are verified without reading scrubbed target identifiers.';
