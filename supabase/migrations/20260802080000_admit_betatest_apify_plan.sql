-- Atomic beta plan admission and immutable replay. The browser never calls
-- these functions; only the server-side beta admission boundary may execute
-- the two narrow public RPCs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Byte-identical mirror of BETATEST_APIFY_FROZEN_OPERATION_BUDGETS. General
-- Apify cost env overrides are runtime drift inputs, never policy mutations.
CREATE FUNCTION public.analysis_beta_plan_operation_budget_map(p_plan_id TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE p_plan_id
      WHEN 'basic' THEN '{"target-profile":0.0052,"relationship-followers":0.68,"relationship-following":0.68,"profile-fallback":0.782600000001,"profile-repair":0.81,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      WHEN 'standard' THEN '{"target-profile":0.0052,"relationship-followers":1.36,"relationship-following":1.36,"profile-fallback":1.5626,"profile-repair":1.62,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      WHEN 'plus' THEN '{"target-profile":0.0052,"relationship-followers":2.04,"relationship-following":2.04,"profile-fallback":2.3426,"profile-repair":2.43,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      ELSE NULL::JSONB
    END;
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_plan_operation_budget_map(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- Private integrity validator shared by the replay RPC, the active race branch,
-- and the successful fresh-admission branch. It returns identifiers only.
CREATE FUNCTION public.analysis_v2_betatest_plan_replay_internal(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_token UUID,
    p_admission_generation INTEGER,
    p_selected_plan_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_preflight public.analysis_preflights%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_activation JSONB;
    v_expected_input_hash TEXT;
    v_expected_scope JSONB;
    v_reservation_count INTEGER;
    v_reservation_drift BOOLEAN;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_token IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    PERFORM users.id
    FROM public.users AS users
    WHERE users.id = p_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.admission_token IS DISTINCT FROM p_admission_token
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        IF v_preflight.status = 'consumed'
           OR v_preflight.consumed_request_id IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
    END IF;

    IF v_allocation.lifecycle_state = 'preflight_held' THEN
        IF v_preflight.status = 'consumed'
           OR v_preflight.consumed_request_id IS NOT NULL
           OR v_allocation.request_id IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
    END IF;

    IF v_allocation.lifecycle_state NOT IN ('active', 'settled')
       OR v_allocation.user_id IS DISTINCT FROM p_user_id
       OR v_allocation.request_id IS NULL
       OR v_allocation.selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_allocation.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
       OR NOT public.analysis_beta_valid_operation_slot_map(v_allocation.operation_slot_map)
       OR v_allocation.operation_budget_map IS DISTINCT FROM
            public.analysis_beta_plan_operation_budget_map(p_selected_plan_id) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- The already-reviewed active validator checks the immutable allocation and
    -- provider-policy bind with stored maps. No caller-side replan is consulted.
    IF v_allocation.lifecycle_state = 'active' THEN
        v_activation := public.activate_analysis_beta_apify_request_credit(
            p_preflight_id,
            v_allocation.request_id,
            p_user_id,
            p_selected_plan_id,
            v_allocation.operation_slot_map,
            v_allocation.operation_budget_map,
            300
        );
        IF v_activation->>'lifecycleState' IS DISTINCT FROM 'active'
           OR (v_activation->>'requestId')::UUID
                IS DISTINCT FROM v_allocation.request_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = v_allocation.request_id
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_allocation.request_id
      AND job.job_key = v_initial_job_key
    FOR UPDATE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = v_allocation.request_id
    FOR UPDATE;

    v_expected_input_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-job-input-v1' || pg_catalog.chr(10)
                || pg_catalog.lower(v_allocation.request_id::TEXT)
                || pg_catalog.chr(10) || v_initial_job_key,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    v_expected_scope := pg_catalog.jsonb_build_object(
        'relationshipCapacity',
            v_preflight.plan_cards_snapshot->p_selected_plan_id
                ->'relationshipCapacity',
        'detailedMutualLimit',
            v_preflight.plan_cards_snapshot->p_selected_plan_id
                ->'detailedMutualLimit'
    );

    SELECT pg_catalog.count(*)::INTEGER,
           COALESCE(pg_catalog.bool_or(
               v_allocation.operation_slot_map->>reservation.operation_family
                    IS DISTINCT FROM reservation.credential_slot
               OR (v_allocation.operation_budget_map
                    ->>reservation.operation_family)::NUMERIC
                    IS DISTINCT FROM reservation.reserved_usd
               OR (
                    v_allocation.lifecycle_state = 'active'
                    AND reservation.lifecycle_state <> 'active'
               )
               OR (
                    v_allocation.lifecycle_state = 'settled'
                    AND reservation.lifecycle_state <> 'settled'
               )
           ), FALSE)
    INTO v_reservation_count, v_reservation_drift
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_allocation.id;

    IF v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_request.id IS NULL
       OR v_request.user_id IS DISTINCT FROM p_user_id
       OR v_request.preflight_id IS DISTINCT FROM p_preflight_id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'production'
       OR v_request.test_entitlement_jti_hash IS NOT NULL
       OR v_request.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_selected_plan_id
       OR v_request.target_instagram_id
            IS DISTINCT FROM v_preflight.target_instagram_id
       OR v_request.excluded_instagram_id
            IS DISTINCT FROM v_preflight.excluded_instagram_id
       OR v_request.exclusion_decision_snapshot
            IS DISTINCT FROM v_preflight.exclusion_decision
       OR v_request.capacity_required_plan_id_snapshot
            IS DISTINCT FROM v_preflight.capacity_required_plan_id
       OR v_request.required_plan_id_snapshot
            IS DISTINCT FROM v_preflight.required_plan_id
       OR v_request.plan_launch_status_snapshot
            IS DISTINCT FROM v_preflight.launch_status_snapshot
       OR v_request.plan_cards_snapshot
            IS DISTINCT FROM v_preflight.plan_cards_snapshot
       OR v_request.pricing_version_snapshot
            IS DISTINCT FROM v_preflight.pricing_version
       OR v_request.pricing_snapshot IS DISTINCT FROM v_preflight.pricing_snapshot
       OR v_request.policy_versions_snapshot
            IS DISTINCT FROM v_preflight.policy_versions_snapshot
       OR v_request.analysis_scope_snapshot IS DISTINCT FROM v_expected_scope
       OR v_request.idempotency_key IS DISTINCT FROM
            'betatest:' || pg_catalog.lower(p_preflight_id::TEXT)
       OR v_request.status NOT IN ('pending', 'processing', 'completed', 'failed')
       OR v_job.request_id IS NULL
       OR v_job.track IS DISTINCT FROM 'coordinator'
       OR v_job.kind IS DISTINCT FROM 'bootstrap'
       OR v_job.batch IS NOT NULL
       OR v_job.required_job_keys IS DISTINCT FROM '{}'::TEXT[]
       OR v_job.input_hash IS DISTINCT FROM v_expected_input_hash
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'betatest_free_pool'
       OR v_policy.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
       OR v_policy.entitlement_jti_hash IS NOT NULL
       OR v_policy.target_instagram_id
            IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_policy.operation_slot_map
            IS DISTINCT FROM v_allocation.operation_slot_map
       OR v_policy.policy_hash IS DISTINCT FROM
            public.analysis_beta_provider_policy_hash(
                pg_catalog.lower(v_request.target_instagram_id),
                v_allocation.operation_slot_map
            )
       OR v_reservation_count <> 8
       OR v_reservation_drift THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'initialJobKey', v_initial_job_key,
        'allocationId', v_allocation.id,
        'replayed', TRUE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_betatest_plan_replay_internal(
    UUID, UUID, UUID, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.load_analysis_v2_betatest_plan_replay(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_token UUID,
    p_admission_generation INTEGER,
    p_selected_plan_id TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_betatest_plan_replay_internal(
        p_preflight_id,
        p_user_id,
        p_admission_token,
        p_admission_generation,
        p_selected_plan_id
    );
$$;
REVOKE ALL ON FUNCTION public.load_analysis_v2_betatest_plan_replay(
    UUID, UUID, UUID, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_betatest_plan_replay(
    UUID, UUID, UUID, INTEGER, TEXT
) TO service_role;

CREATE FUNCTION public.admit_analysis_v2_betatest_plan(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_token UUID,
    p_admission_generation INTEGER,
    p_selected_plan_id TEXT,
    p_operation_slot_map JSONB,
    p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_preflight public.analysis_preflights%ROWTYPE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_request_id UUID;
    v_scope_snapshot JSONB;
    v_selected_card JSONB;
    v_input_hash TEXT;
    v_active_request_id UUID;
    v_activation JSONB;
    v_replay JSONB;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_token IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_max_snapshot_age_seconds IS NULL
       OR p_max_snapshot_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    -- FOR UPDATE is the explicit one-user start serializer. Recovery takes a
    -- KEY SHARE lock first and therefore cannot invert later row-lock order.
    PERFORM users.id
    FROM public.users AS users
    WHERE users.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.admission_token IS DISTINCT FROM p_admission_token
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_allocation.user_id IS DISTINCT FROM p_user_id
       OR v_allocation.policy_version IS DISTINCT FROM 'betatest-free-pool-v1' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    -- A concurrent winner is replayed from stored identity. Caller-proposed
    -- slot/budget maps are advisory only once the allocation is immutable.
    IF v_allocation.lifecycle_state IN ('active', 'settled') THEN
        RETURN public.analysis_v2_betatest_plan_replay_internal(
            p_preflight_id,
            p_user_id,
            p_admission_token,
            p_admission_generation,
            p_selected_plan_id
        );
    END IF;

    IF v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR NOT public.analysis_beta_valid_operation_slot_map(p_operation_slot_map)
       OR NOT public.analysis_beta_valid_operation_budget_map(p_operation_budget_map)
       OR p_operation_budget_map IS DISTINCT FROM
            public.analysis_beta_plan_operation_budget_map(p_selected_plan_id) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Preserve the established activation order: target hold before grant.
    SELECT reservation.* INTO v_target_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_allocation.id
      AND reservation.operation_family = 'target-profile'
    FOR UPDATE;
    IF NOT FOUND
       OR v_target_reservation.credential_slot
            IS DISTINCT FROM p_operation_slot_map->>'target-profile'
       OR v_target_reservation.reserved_usd IS DISTINCT FROM 0.005200000000
       OR v_target_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
    FOR UPDATE;

    -- Load-bearing TOCTOU fence: database time is sampled only after every
    -- authoritative first-admission identity/grant/hold row has been locked.
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (
            v_grant.expires_at IS NOT NULL
            AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at <= v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.expires_at <= v_now
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds'
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.capacity_required_plan_id IS NULL
       OR v_preflight.required_plan_id IS NULL
       OR v_preflight.plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR NOT public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
       )
       OR v_allocation.expires_at <= v_now
       OR v_allocation.request_id IS NOT NULL
       OR v_allocation.operation_slot_map IS NOT NULL
       OR v_allocation.operation_budget_map IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_selected_card := v_preflight.plan_cards_snapshot->p_selected_plan_id;
    IF v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' IS DISTINCT FROM 'production'
       OR v_selected_card->>'selectionState'
            NOT IN ('required', 'available_upgrade')
       OR v_preflight.target_followers_count >
            (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count >
            (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT request.id INTO v_active_request_id
    FROM public.analysis_requests AS request
    WHERE request.user_id = p_user_id
      AND request.status IN ('pending', 'processing')
    ORDER BY request.id
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_scope_snapshot := pg_catalog.jsonb_build_object(
        'relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit'
    );
    IF NOT public.analysis_v2_valid_scope_snapshot(v_scope_snapshot) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests (
        id,
        user_id,
        target_instagram_id,
        target_gender,
        status,
        progress,
        progress_step,
        current_step,
        step_data,
        gender_stats,
        plan_type,
        background_processing,
        idempotency_key,
        pipeline_version,
        preflight_id,
        excluded_instagram_id,
        exclusion_decision_snapshot,
        plan_access_mode_snapshot,
        capacity_required_plan_id_snapshot,
        required_plan_id_snapshot,
        selected_plan_id_snapshot,
        plan_launch_status_snapshot,
        plan_cards_snapshot,
        pricing_version_snapshot,
        pricing_snapshot,
        analysis_scope_snapshot,
        policy_versions_snapshot,
        analysis_entry_channel
    ) VALUES (
        v_request_id,
        p_user_id,
        v_preflight.target_instagram_id,
        'male',
        'pending',
        0,
        '분석 대기 중...',
        'pending',
        '{}'::JSONB,
        '{}'::JSONB,
        p_selected_plan_id,
        FALSE,
        'betatest:' || pg_catalog.lower(v_preflight.id::TEXT),
        'v2',
        v_preflight.id,
        v_preflight.excluded_instagram_id,
        v_preflight.exclusion_decision,
        'production',
        v_preflight.capacity_required_plan_id,
        v_preflight.required_plan_id,
        p_selected_plan_id,
        v_preflight.launch_status_snapshot,
        v_preflight.plan_cards_snapshot,
        v_preflight.pricing_version,
        v_preflight.pricing_snapshot,
        v_scope_snapshot,
        v_preflight.policy_versions_snapshot,
        'standard'
    );

    UPDATE public.analysis_preflights AS preflight
    SET status = 'consumed',
        consumed_at = v_now,
        consumed_request_id = v_request_id,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    v_input_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-job-input-v1' || pg_catalog.chr(10)
                || pg_catalog.lower(v_request_id::TEXT)
                || pg_catalog.chr(10) || v_initial_job_key,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    INSERT INTO public.analysis_pipeline_jobs (
        request_id,
        job_key,
        track,
        kind,
        batch,
        input_hash,
        required_job_keys
    ) VALUES (
        v_request_id,
        v_initial_job_key,
        'coordinator',
        'bootstrap',
        NULL,
        v_input_hash,
        '{}'::TEXT[]
    );

    -- The hardened primitive locks all six snapshots, repeats freshness and
    -- headroom, activates exactly eight reservations, and binds policy.
    v_activation := public.activate_analysis_beta_apify_request_credit(
        p_preflight_id,
        v_request_id,
        p_user_id,
        p_selected_plan_id,
        p_operation_slot_map,
        p_operation_budget_map,
        p_max_snapshot_age_seconds
    );
    IF v_activation->>'lifecycleState' IS DISTINCT FROM 'active'
       OR (v_activation->>'requestId')::UUID IS DISTINCT FROM v_request_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_replay := public.analysis_v2_betatest_plan_replay_internal(
        p_preflight_id,
        p_user_id,
        p_admission_token,
        p_admission_generation,
        p_selected_plan_id
    );
    IF v_replay IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_set(v_replay, '{replayed}', 'false'::JSONB, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_betatest_plan_replay(
    UUID, UUID, UUID, INTEGER, TEXT
) IS 'Validates and returns only the immutable beta request/job/allocation identity; no grant, credit refresh, map, balance, or provider identity is exposed.';
COMMENT ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) IS 'Atomically consumes one ready beta preflight, activates its frozen eight-family allocation and provider policy, and persists the recoverable bootstrap job.';
