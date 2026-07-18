-- Failed V2 requests intentionally replace request/preflight usernames with deterministic
-- tombstones. Authorize the one-off repair canary from the immutable, pre-dispatch test policy
-- and its reciprocal entitlement lineage instead of retaining or restoring scrubbed PII.

DROP FUNCTION public.load_analysis_v2_profile_repair_canary_source(UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    p_source_request_id UUID,
    p_owner_id UUID,
    p_owner_email TEXT,
    p_credential_slot TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_owner_email TEXT;
    v_authorized_target_instagram_id TEXT := '0_min._.00';
    v_runs JSONB;
BEGIN
    IF p_source_request_id IS NULL
       OR p_owner_id IS NULL
       OR p_owner_email IS NULL
       OR pg_catalog.btrim(p_owner_email) = ''
       OR pg_catalog.char_length(p_owner_email) > 255
       OR p_credential_slot NOT IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    JOIN public.users AS owner
      ON owner.id = analysis_request.user_id
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = analysis_request.id
    JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption
      ON entitlement_consumption.request_id = analysis_request.id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = entitlement_consumption.preflight_id
    WHERE analysis_request.id = p_source_request_id
      AND analysis_request.user_id = p_owner_id
      AND pg_catalog.lower(owner.email) = pg_catalog.lower(p_owner_email)
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'failed'
      AND analysis_request.plan_access_mode_snapshot = 'test_entitlement'
      AND analysis_request.selected_plan_id_snapshot =
            entitlement_consumption.selected_plan_id
      AND analysis_request.preflight_id = preflight.id
      AND analysis_request.test_entitlement_jti_hash =
            execution_policy.entitlement_jti_hash
      AND analysis_request.test_entitlement_jti_hash =
            entitlement_consumption.entitlement_jti_hash
      AND analysis_request.target_instagram_id =
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20
            )
      AND execution_policy.mode = 'test_operation_split'
      AND execution_policy.policy_version = 'authorized-free-e2e-v1'
      AND execution_policy.target_instagram_id = '0_min._.00'
      AND execution_policy.operation_slot_map->>'profile-fallback' = p_credential_slot
      AND entitlement_consumption.user_id = analysis_request.user_id
      AND entitlement_consumption.selected_plan_id = 'standard'
      AND preflight.user_id = analysis_request.user_id
      AND preflight.consumed_request_id = analysis_request.id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id =
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
            )
      AND NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = analysis_request.id
              AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$'
              AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
              AND provider_run.credential_slot IS DISTINCT FROM p_credential_slot
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT owner.email
    INTO v_owner_email
    FROM public.users AS owner
    WHERE owner.id = v_request.user_id;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'jobKey', provider_run.job_key,
                'operationKey', provider_run.operation_key,
                'status', provider_run.status,
                'runId', provider_run.run_id,
                'actorId', provider_run.actor_id,
                'credentialSlot', provider_run.credential_slot,
                'maxChargeUsd', provider_run.max_charge_usd
            ) ORDER BY provider_run.job_key
        ),
        '[]'::JSONB
    )
    INTO v_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_source_request_id
      AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$'
      AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
      AND provider_run.credential_slot = p_credential_slot;

    RETURN pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'sourceRequestId', v_request.id,
            'userId', v_request.user_id,
            'ownerEmail', v_owner_email,
            'targetInstagramId', v_authorized_target_instagram_id,
            'pipelineVersion', v_request.pipeline_version,
            'status', v_request.status
        ),
        'runs', v_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    UUID, UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_credential_slot TEXT,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.analysis_requests%ROWTYPE;
    v_previous public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_credential_slot NOT IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'
       )
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_source
    FROM public.analysis_requests AS analysis_request
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = analysis_request.id
    JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption
      ON entitlement_consumption.request_id = analysis_request.id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = entitlement_consumption.preflight_id
    WHERE analysis_request.id = p_source_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'failed'
      AND analysis_request.plan_access_mode_snapshot = 'test_entitlement'
      AND analysis_request.selected_plan_id_snapshot =
            entitlement_consumption.selected_plan_id
      AND analysis_request.preflight_id = preflight.id
      AND analysis_request.test_entitlement_jti_hash =
            execution_policy.entitlement_jti_hash
      AND analysis_request.test_entitlement_jti_hash =
            entitlement_consumption.entitlement_jti_hash
      AND analysis_request.target_instagram_id =
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20
            )
      AND execution_policy.mode = 'test_operation_split'
      AND execution_policy.policy_version = 'authorized-free-e2e-v1'
      AND execution_policy.target_instagram_id = '0_min._.00'
      AND execution_policy.operation_slot_map->>'profile-fallback' = p_credential_slot
      AND entitlement_consumption.user_id = analysis_request.user_id
      AND entitlement_consumption.selected_plan_id = 'standard'
      AND preflight.user_id = analysis_request.user_id
      AND preflight.consumed_request_id = analysis_request.id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id =
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
            )
      AND NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = analysis_request.id
              AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$'
              AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
              AND provider_run.credential_slot IS DISTINCT FROM p_credential_slot
      )
    FOR UPDATE OF analysis_request;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF p_repetition = 2 THEN
        SELECT canary_run.*
        INTO v_previous
        FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-repair-canary-v1'
          AND canary_run.repetition = 1
        FOR UPDATE;
        IF NOT FOUND
           OR v_previous.state IS DISTINCT FROM 'succeeded'
           OR v_previous.gate_passed IS DISTINCT FROM TRUE
           OR v_previous.cost_status IS DISTINCT FROM 'actual'
           OR v_previous.actual_usage_usd IS NULL
           OR v_previous.actual_usage_usd > 0.050000000000 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT canary_run.*
    INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF FOUND THEN
        IF v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
           OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_run.requested_count IS DISTINCT FROM 15
           OR v_run.max_charge_usd IS DISTINCT FROM 0.050000000000 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'run', public.analysis_v2_profile_repair_canary_run_json(v_run)
        );
    END IF;

    INSERT INTO public.analysis_v2_profile_repair_canary_runs (
        source_request_id,
        repetition,
        credential_slot,
        reservation_token
    ) VALUES (
        p_source_request_id,
        p_repetition,
        p_credential_slot,
        p_reservation_token
    )
    RETURNING * INTO v_run;

    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'run', public.analysis_v2_profile_repair_canary_run_json(v_run)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) TO service_role;
