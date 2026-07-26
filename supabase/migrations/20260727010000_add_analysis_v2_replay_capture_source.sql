-- Service-only, read-only source for an offline replay capture. This does not expose raw
-- provider input or user data beyond the exact target/preflight snapshot needed by the operator.
CREATE OR REPLACE FUNCTION public.read_analysis_v2_replay_capture_source(
    p_target_username TEXT,
    p_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target TEXT;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_runs JSONB;
    v_preflight_runs JSONB;
BEGIN
    v_target := pg_catalog.lower(pg_catalog.btrim(p_target_username));
    IF v_target IS NULL OR v_target !~ '^[a-z0-9._]{1,30}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.*
    INTO v_request
    FROM public.analysis_requests AS request
    WHERE pg_catalog.lower(request.target_instagram_id) = v_target
      AND (p_request_id IS NULL OR request.id = p_request_id)
      AND request.status = 'completed'
      AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard'
      AND request.plan_access_mode_snapshot = 'production'
      AND request.preflight_id IS NOT NULL
      AND request.completed_at IS NOT NULL
      AND request.policy_versions_snapshot->>'pipeline' = 'v2'
      AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.7'
      AND request.policy_versions_snapshot->>'risk'
            IN ('risk-policy-v2.3', 'risk-policy-v2.4')
    ORDER BY request.completed_at DESC, request.id DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'production'
      AND preflight.consumed_request_id = v_request.id
      AND preflight.target_instagram_id = v_target
      AND preflight.target_is_private IS FALSE
      AND preflight.policy_versions_snapshot = v_request.policy_versions_snapshot;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_SOURCE_PREFLIGHT_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'actorId', run.actor_id,
                'credentialSlot', run.credential_slot,
                'runId', run.run_id,
                'status', run.status,
                'operationKey', run.operation_key
            )
            ORDER BY run.job_key, run.operation_key
        ),
        '[]'::JSONB
    )
    INTO v_provider_runs
    FROM (
        SELECT provider_run.*
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = v_request.id
          AND provider_run.logical_provider = 'apify'
          AND provider_run.status = 'succeeded'
          AND provider_run.run_id IS NOT NULL
        ORDER BY provider_run.job_key, provider_run.operation_key
        LIMIT 128
    ) AS run;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'actorId', run.actor_id,
                'credentialSlot', run.credential_slot,
                'runId', run.run_id,
                'status', run.status,
                'operationKey', run.operation_key
            )
            ORDER BY run.operation_key
        ),
        '[]'::JSONB
    )
    INTO v_preflight_runs
    FROM (
        SELECT provider_run.*
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = v_preflight.id
          AND provider_run.logical_provider = 'apify'
          AND provider_run.status = 'succeeded'
          AND provider_run.run_id IS NOT NULL
        ORDER BY provider_run.operation_key
        LIMIT 4
    ) AS run;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'preflightId', v_preflight.id,
        'targetUsername', v_target,
        'policyVersions', v_request.policy_versions_snapshot,
        'target', pg_catalog.jsonb_build_object(
            'fullName', v_preflight.target_full_name,
            'bio', v_preflight.target_bio,
            'profileImageUrl', v_preflight.target_profile_image_url,
            'followersCount', v_preflight.target_followers_count,
            'followingCount', v_preflight.target_following_count
        ),
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_v2_replay_capture_source(TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_replay_capture_source(TEXT, UUID)
    TO service_role;

COMMENT ON FUNCTION public.read_analysis_v2_replay_capture_source(TEXT, UUID) IS
    'Read-only, bounded provider-ledger identity source for an operator-initiated offline replay capture.';
