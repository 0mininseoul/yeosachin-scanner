-- A terminal V2 schema-stage failure has already been scrubbed and cannot be
-- safely resumed. Keep the original request/payment audit immutable and permit
-- one operator-triggered fresh preflight only for that precise failure receipt.
CREATE TABLE public.earlybird_schema_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (
        prior_attempt_count BETWEEN 0 AND 10
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.earlybird_schema_failure_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_schema_failure_recoveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_schema_failure_recoveries
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER prevent_earlybird_schema_failure_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_schema_failure_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.recover_earlybird_schema_failed_fulfillment(
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
    v_cards JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog_plan JSONB;
    v_launch_status TEXT;
    v_state TEXT;
    v_reason TEXT;
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
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot)
       OR v_preflight.plan_catalog_snapshot->v_order.plan_id->>'launchStatus' <> 'production' THEN
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

    v_capacity_rank := NULL;
    v_required_rank := NULL;
    v_cards := '{}'::JSONB;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
        IF v_catalog_plan->>'launchStatus' IS DISTINCT FROM v_launch_status THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_capacity_rank IS NULL
           AND v_order.target_followers_count <= (v_catalog_plan->'relationshipCapacity'->>'followers')::INTEGER
           AND v_order.target_following_count <= (v_catalog_plan->'relationshipCapacity'->>'following')::INTEGER THEN
            v_capacity_rank := v_plan_rank;
            v_capacity_plan := v_plan_id;
        END IF;
    END LOOP;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_required_rank IS NULL AND v_plan_rank >= v_capacity_rank
           AND v_preflight.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_required_rank := v_plan_rank;
            v_required_plan := v_plan_id;
        END IF;
    END LOOP;
    IF v_capacity_rank IS NULL OR v_required_rank IS NULL
       OR (CASE v_order.plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 END) < v_required_rank THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_capacity_rank THEN
            v_state := 'unavailable';
            v_reason := 'below_required_plan';
        ELSIF v_launch_status <> 'production' THEN
            v_state := 'unavailable';
            v_reason := 'launch_gate';
        ELSIF v_plan_id = v_required_plan THEN
            v_state := 'required';
            v_reason := NULL;
        ELSE
            v_state := 'available_upgrade';
            v_reason := NULL;
        END IF;
        v_cards := v_cards || pg_catalog.jsonb_build_object(v_plan_id, pg_catalog.jsonb_build_object(
            'launchStatus', v_launch_status,
            'relationshipCapacity', v_catalog_plan->'relationshipCapacity',
            'detailedMutualLimit', v_catalog_plan->'detailedMutualLimit',
            'selectionState', v_state,
            'unavailableReason', v_reason));
    END LOOP;
    IF NOT public.analysis_v2_valid_plan_cards_snapshot(v_cards) THEN
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
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot, v_cards,
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
