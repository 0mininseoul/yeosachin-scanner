-- A recovery resumes a paid entitlement that was already admitted. Do not
-- recompute its plan from later launch/catalog state: validate and carry the
-- immutable approved preflight card instead.
CREATE OR REPLACE FUNCTION public.recover_earlybird_schema_failed_fulfillment(
    p_order_id UUID
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_failed_request public.analysis_requests%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_new_preflight_id UUID;
    v_capacity_plan TEXT;
    v_required_plan TEXT;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_card JSONB;
    v_card_followers INTEGER;
    v_card_following INTEGER;
    v_required_card_count INTEGER := 0;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = v_order.id
    FOR UPDATE;
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = v_order.id;
        IF NOT FOUND
           OR v_order.preflight_id IS DISTINCT FROM v_recovery.recovery_preflight_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id,
            v_fulfillment.status,
            v_recovery.recovery_preflight_id;
        RETURN;
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_order.status <> 'analysis_in_progress'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.request_id IS NULL
       OR v_order.result_request_id IS DISTINCT FROM v_fulfillment.request_id
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_fulfillment.request_id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR NOT public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_preflight.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(v_preflight.plan_cards_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot)
       OR v_preflight.plan_cards_snapshot->v_order.plan_id->>'launchStatus' IS DISTINCT FROM 'production'
       OR COALESCE(
            v_preflight.plan_cards_snapshot->v_order.plan_id->>'selectionState', ''
       ) NOT IN ('required', 'available_upgrade') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_failed_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_fulfillment.request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_failed_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_failed_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_failed_request.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_failed_request.pipeline_version <> 'v2'
       OR v_failed_request.status <> 'failed'
       OR v_failed_request.error_message <> 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_failed_request.id
              AND receipt.error_code = 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.user_id = v_order.user_id
          AND analysis_request.status IN ('pending', 'processing')
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.user_id = v_order.user_id
          AND preflight.status IN ('pending', 'processing', 'ready')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_ACTIVE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_capacity_plan := v_preflight.capacity_required_plan_id;
    v_required_plan := v_preflight.required_plan_id;
    v_capacity_rank := CASE v_capacity_plan
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_required_rank := CASE v_required_plan
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_selected_rank := CASE v_order.plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE NULL END;
    IF v_capacity_rank IS NULL
       OR v_required_rank IS NULL
       OR v_selected_rank IS NULL
       OR v_required_rank < v_capacity_rank
       OR v_selected_rank < v_required_rank
       OR v_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id
            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_card := v_preflight.plan_cards_snapshot->v_plan_id;
        IF COALESCE(v_card->'relationshipCapacity'->>'followers', '') !~ '^[0-9]+$'
           OR COALESCE(v_card->'relationshipCapacity'->>'following', '') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_card_followers := (v_card->'relationshipCapacity'->>'followers')::INTEGER;
        v_card_following := (v_card->'relationshipCapacity'->>'following')::INTEGER;
        IF v_plan_rank < v_capacity_rank
           AND v_order.target_followers_count <= v_card_followers
           AND v_order.target_following_count <= v_card_following THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_plan_rank >= v_capacity_rank
           AND (
                v_order.target_followers_count > v_card_followers
                OR v_order.target_following_count > v_card_following
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_card->>'selectionState' = 'required' THEN
            v_required_card_count := v_required_card_count + 1;
        END IF;
    END LOOP;
    IF v_required_card_count <> 1
       OR v_preflight.plan_cards_snapshot->v_required_plan->>'selectionState'
            IS DISTINCT FROM 'required'
       OR v_preflight.plan_cards_snapshot->v_required_plan->>'launchStatus'
            IS DISTINCT FROM 'production' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id,
        'earlybird.schema-recovery.' || pg_catalog.replace(v_order.id::TEXT, '-', ''),
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot,
        v_preflight.pricing_version, v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_order.target_followers_count, v_order.target_following_count, FALSE,
        v_capacity_plan, v_required_plan, v_now, v_now,
        v_now + INTERVAL '30 minutes', v_now
    );

    INSERT INTO public.earlybird_schema_failure_recoveries(
        order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
    ) VALUES (
        v_order.id, v_failed_request.id, v_new_preflight_id, v_fulfillment.attempt_count
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET preflight_id = v_new_preflight_id,
        status = 'paid',
        result_request_id = NULL,
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending',
        attempt_count = 0,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        request_id = NULL,
        operator_admitted_at = v_now,
        last_error_code = NULL,
        last_error_at = NULL,
        completed_at = NULL,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT v_order.id, 'admission_pending'::TEXT, v_new_preflight_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_earlybird_schema_failed_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_schema_failed_fulfillment(UUID)
    TO service_role;

-- Fresh admission normally recomputes the required plan from the catalog. A
-- paid schema-failure recovery is the narrow exception: it must carry the
-- immutable entitlement that was already admitted, without widening any
-- non-recovery admission path.
ALTER FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) RENAME TO complete_analysis_v2_preflight_admission_core_20260730140000;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_admission_core_20260730140000(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_target_instagram_id TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN
)
RETURNS TABLE(admission_status TEXT, admission_error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_card JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_card_followers INTEGER;
    v_card_following INTEGER;
    v_required_card_count INTEGER;
    v_plan_id TEXT;
    v_status TEXT := 'ready';
    v_error_code TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_target_followers_count IS NULL
       OR p_target_followers_count NOT BETWEEN 0 AND 10000000
       OR p_target_following_count IS NULL
       OR p_target_following_count NOT BETWEEN 0 AND 10000000
       OR p_target_is_private IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token
    FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        WHERE recovery.recovery_preflight_id = p_preflight_id
    ) THEN
        RETURN QUERY SELECT *
        FROM public.complete_analysis_v2_preflight_admission_core_20260730140000(
            p_preflight_id, p_admission_generation, p_claim_token,
            p_target_instagram_id, p_target_followers_count,
            p_target_following_count, p_target_is_private
        );
        RETURN;
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_schema_failure_recoveries AS recovery
    INNER JOIN public.earlybird_orders AS earlybird_order
        ON earlybird_order.id = recovery.order_id
    WHERE recovery.recovery_preflight_id = v_preflight.id
      AND earlybird_order.preflight_id = v_preflight.id
    FOR UPDATE OF earlybird_order;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    IF NOT FOUND
       OR v_order.user_id IS DISTINCT FROM v_preflight.user_id
       OR v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_fulfillment.status <> 'admission_pending'
       OR v_preflight.target_instagram_id IS DISTINCT FROM p_target_instagram_id
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(v_preflight.plan_cards_snapshot)
       OR v_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_capacity_rank := CASE v_preflight.capacity_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_required_rank := CASE v_preflight.required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_selected_rank := CASE v_order.plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE NULL END;
    v_required_card_count := 0;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_card := v_preflight.plan_cards_snapshot->v_plan_id;
        IF v_card->>'selectionState' = 'required' THEN
            v_required_card_count := v_required_card_count + 1;
        END IF;
    END LOOP;
    v_card := v_preflight.plan_cards_snapshot->v_order.plan_id;
    IF v_capacity_rank IS NULL
       OR v_required_rank IS NULL
       OR v_selected_rank IS NULL
       OR v_required_rank < v_capacity_rank
       OR v_selected_rank < v_required_rank
       OR v_required_card_count <> 1
       OR v_preflight.plan_cards_snapshot
            ->v_preflight.required_plan_id->>'selectionState' IS DISTINCT FROM 'required'
       OR v_preflight.plan_cards_snapshot
            ->v_preflight.required_plan_id->>'launchStatus' IS DISTINCT FROM 'production'
       OR v_card->>'launchStatus' IS DISTINCT FROM 'production'
       OR COALESCE(v_card->>'selectionState', '') NOT IN ('required', 'available_upgrade')
       OR COALESCE(v_card->'relationshipCapacity'->>'followers', '') !~ '^[0-9]+$'
       OR COALESCE(v_card->'relationshipCapacity'->>'following', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;
    v_card_followers := (v_card->'relationshipCapacity'->>'followers')::INTEGER;
    v_card_following := (v_card->'relationshipCapacity'->>'following')::INTEGER;
    IF p_target_followers_count > v_card_followers
       OR p_target_following_count > v_card_following THEN
        v_status := 'blocked';
        v_error_code := 'ANALYSIS_V2_PLAN_NOT_ALLOWED';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET target_followers_count = CASE WHEN v_status = 'ready'
            THEN p_target_followers_count ELSE preflight.target_followers_count END,
        target_following_count = CASE WHEN v_status = 'ready'
            THEN p_target_following_count ELSE preflight.target_following_count END,
        target_is_private = CASE WHEN v_status = 'ready'
            THEN FALSE ELSE preflight.target_is_private END,
        admission_status = v_status,
        admission_refreshed_at = v_now,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_error_code = v_error_code,
        admission_target_followers_count = p_target_followers_count,
        admission_target_following_count = p_target_following_count,
        admission_capacity_required_plan_id = v_preflight.capacity_required_plan_id,
        admission_required_plan_id = v_preflight.required_plan_id,
        admission_plan_cards_snapshot = v_preflight.plan_cards_snapshot,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT v_status, v_error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) TO service_role;
