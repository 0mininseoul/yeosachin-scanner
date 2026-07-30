-- A terminal V2 failure runs `analysis_v2_scrub_terminal_request_pii`, which
-- overwrites `analysis_requests.target_instagram_id` with the deterministic
-- token 'retained.' || substr(replace(id::TEXT, '-', ''), 1, 20). The recovery
-- target guard therefore could never pass for exactly the scrubbed rows it
-- exists to rebind. Recovery now also admits a failed request whose stored
-- handle is EXACTLY its own canonical scrub token: the token is derived from
-- the request id alone, so it proves the row was scrubbed rather than pointed
-- at a different account. A scrub-shaped token belonging to any other request,
-- and every other target mismatch, is still rejected exactly as before. No
-- payment, lifecycle, snapshot, or entitlement fence changes.
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
    v_order_target TEXT;
    v_failed_request_target TEXT;
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

    v_order_target := pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id));
    v_failed_request_target := pg_catalog.lower(
        pg_catalog.btrim(v_failed_request.target_instagram_id)
    );
    IF v_order_target IS NULL
       OR v_failed_request_target IS NULL
       OR v_order.target_instagram_id IS DISTINCT FROM v_order_target
       OR v_order_target !~ '^[a-z0-9._]{1,30}$'
       OR v_failed_request_target !~ '^@?[a-z0-9._]{1,30}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_INELIGIBLE', ERRCODE = 'P0001';
    END IF;
    v_order_target := pg_catalog.regexp_replace(v_order_target, '^@', '');
    v_failed_request_target := pg_catalog.regexp_replace(
        v_failed_request_target, '^@', ''
    );
    IF v_failed_request_target IS DISTINCT FROM v_order_target
       AND v_failed_request.target_instagram_id IS DISTINCT FROM 'retained.'
            || pg_catalog.substr(
                pg_catalog.replace(v_failed_request.id::TEXT, '-', ''), 1, 20
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
