-- Atomic beta plan admission.  The browser never calls this function: its only
-- caller is the worker-side service boundary after a ready beta preflight.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- This DB-owned catalog is deliberately exact. A privileged caller cannot
-- downgrade one family to a structurally-valid but underreserved amount.
CREATE FUNCTION public.analysis_beta_plan_operation_budget_map(p_plan_id TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT CASE p_plan_id
      WHEN 'basic' THEN '{"target-profile":0.0052,"relationship-followers":0.68,"relationship-following":0.68,"profile-fallback":0.782600000001,"profile-repair":0.81,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      WHEN 'standard' THEN '{"target-profile":0.0052,"relationship-followers":1.36,"relationship-following":1.36,"profile-fallback":1.562600000001,"profile-repair":1.62,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      WHEN 'plus' THEN '{"target-profile":0.0052,"relationship-followers":2.04,"relationship-following":2.04,"profile-fallback":2.342600000001,"profile-repair":2.43,"target-likers":0.93,"target-comments":0.234,"candidate-likers":1.55}'::JSONB
      ELSE NULL::JSONB END;
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_plan_operation_budget_map(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_preflight public.analysis_preflights%ROWTYPE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request_id UUID;
    v_scope_snapshot JSONB;
    v_selected_card JSONB;
    v_input_hash TEXT;
    v_active_request_id UUID;
    v_activation JSONB;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_token IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR NOT public.analysis_beta_valid_operation_slot_map(p_operation_slot_map)
       OR NOT public.analysis_beta_valid_operation_budget_map(p_operation_budget_map)
       OR p_operation_budget_map IS DISTINCT FROM public.analysis_beta_plan_operation_budget_map(p_selected_plan_id)
       OR (p_operation_budget_map->>'target-profile')::NUMERIC IS DISTINCT FROM 0.005200000000
       OR p_max_snapshot_age_seconds IS NULL
       OR p_max_snapshot_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Every beta admission begins user -> preflight -> allocation. The user
    -- update lock serializes starts for one user before an active-request check.
    PERFORM users.id FROM public.users AS users
    WHERE users.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
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
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_allocation.user_id IS DISTINCT FROM p_user_id
       OR v_allocation.policy_version IS DISTINCT FROM 'betatest-free-pool-v1' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT reservation.* INTO v_target_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_allocation.id
      AND reservation.operation_family = 'target-profile'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id FOR UPDATE;
    IF NOT FOUND OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND v_grant.expires_at <= v_now) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    -- A replay must prove the entire frozen request identity. It intentionally
    -- returns before snapshots are read or any slot can rotate.
    IF v_allocation.lifecycle_state = 'active' THEN
        SELECT request.* INTO v_request FROM public.analysis_requests AS request
        WHERE request.id = v_allocation.request_id FOR UPDATE;
        SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = v_allocation.request_id AND job.job_key = v_initial_job_key
        FOR UPDATE;
        IF NOT FOUND
           OR v_request.user_id IS DISTINCT FROM p_user_id
           OR v_request.preflight_id IS DISTINCT FROM p_preflight_id
           OR v_request.analysis_entry_channel IS DISTINCT FROM 'betatest'
           OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_selected_plan_id
           OR v_allocation.operation_slot_map IS DISTINCT FROM p_operation_slot_map
           OR v_allocation.operation_budget_map IS DISTINCT FROM p_operation_budget_map
           OR v_job.track IS DISTINCT FROM 'coordinator'
           OR v_job.kind IS DISTINCT FROM 'bootstrap' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'requestId', v_request.id, 'initialJobKey', v_initial_job_key,
            'allocationId', v_allocation.id, 'replayed', TRUE
        );
    END IF;

    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.expires_at <= v_now
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_token IS DISTINCT FROM p_admission_token
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.capacity_required_plan_id IS NULL
       OR v_preflight.required_plan_id IS NULL
       OR v_preflight.plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(v_preflight.plan_cards_snapshot)
       OR NOT public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot)
       OR v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_allocation.expires_at <= v_now
       OR v_allocation.request_id IS NOT NULL
       OR v_allocation.operation_slot_map IS NOT NULL
       OR v_allocation.operation_budget_map IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_selected_card := v_preflight.plan_cards_snapshot->p_selected_plan_id;
    IF v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' IS DISTINCT FROM 'production'
       OR v_selected_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR v_preflight.target_followers_count > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT request.id INTO v_active_request_id FROM public.analysis_requests AS request
    WHERE request.user_id = p_user_id AND request.status IN ('pending', 'processing')
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    -- The hold is an exact immutable preflight reservation. No caller-proposed
    -- plan may silently replace its target slot or target budget.
    IF v_target_reservation.credential_slot IS DISTINCT FROM p_operation_slot_map->>'target-profile'
       OR v_target_reservation.reserved_usd IS DISTINCT FROM 0.005200000000
       OR v_target_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_scope_snapshot := pg_catalog.jsonb_build_object(
        'relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit'
    );
    IF NOT public.analysis_v2_valid_scope_snapshot(v_scope_snapshot) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests (
        id, user_id, target_instagram_id, target_gender, status, progress,
        progress_step, current_step, step_data, gender_stats, plan_type,
        background_processing, idempotency_key, pipeline_version, preflight_id,
        excluded_instagram_id, exclusion_decision_snapshot, plan_access_mode_snapshot,
        capacity_required_plan_id_snapshot, required_plan_id_snapshot,
        selected_plan_id_snapshot, plan_launch_status_snapshot, plan_cards_snapshot,
        pricing_version_snapshot, pricing_snapshot, analysis_scope_snapshot,
        policy_versions_snapshot, analysis_entry_channel
    ) VALUES (
        v_request_id, p_user_id, v_preflight.target_instagram_id, 'male', 'pending', 0,
        '분석 대기 중...', 'pending', '{}'::JSONB, '{}'::JSONB, p_selected_plan_id,
        FALSE, 'betatest:' || pg_catalog.lower(v_preflight.id::TEXT), 'v2', v_preflight.id,
        v_preflight.excluded_instagram_id, v_preflight.exclusion_decision, 'production',
        v_preflight.capacity_required_plan_id, v_preflight.required_plan_id,
        p_selected_plan_id, v_preflight.launch_status_snapshot, v_preflight.plan_cards_snapshot,
        v_preflight.pricing_version, v_preflight.pricing_snapshot, v_scope_snapshot,
        v_preflight.policy_versions_snapshot, 'standard'
    );

    UPDATE public.analysis_preflights AS preflight
    SET status = 'consumed', consumed_at = v_now, consumed_request_id = v_request_id,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    v_input_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to('analysis-v2-job-input-v1' || pg_catalog.chr(10)
            || pg_catalog.lower(v_request_id::TEXT) || pg_catalog.chr(10)
            || v_initial_job_key, 'UTF8'), 'sha256'
    ), 'hex');
    INSERT INTO public.analysis_pipeline_jobs (
        request_id, job_key, track, kind, batch, input_hash, required_job_keys
    ) VALUES (
        v_request_id, v_initial_job_key, 'coordinator', 'bootstrap', NULL,
        v_input_hash, '{}'::TEXT[]
    ) ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_request_id AND job.job_key = v_initial_job_key FOR UPDATE;
    IF NOT FOUND OR v_job.track IS DISTINCT FROM 'coordinator'
       OR v_job.kind IS DISTINCT FROM 'bootstrap'
       OR v_job.input_hash IS DISTINCT FROM v_input_hash
       OR v_job.status IS DISTINCT FROM 'pending'
       OR v_job.dispatch_state IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- The hardened primitive locks all six snapshots, repeats the freshness and
    -- headroom fence, changes the channel to betatest, and atomically binds the
    -- immutable provider policy before this transaction can commit.
    v_activation := public.activate_analysis_beta_apify_request_credit(
        p_preflight_id, v_request_id, p_user_id, p_selected_plan_id,
        p_operation_slot_map, p_operation_budget_map, p_max_snapshot_age_seconds
    );
    IF v_activation->>'lifecycleState' IS DISTINCT FROM 'active'
       OR (v_activation->>'requestId')::UUID IS DISTINCT FROM v_request_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request_id, 'initialJobKey', v_initial_job_key,
        'allocationId', v_allocation.id, 'replayed', FALSE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) IS 'Atomically consumes one ready beta preflight, activates its frozen eight-family credit allocation, binds policy, and persists the initial recoverable V2 job.';
