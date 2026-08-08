-- A paid order can enter manual review before request creation when the
-- selected fresh-profile provider is unavailable for all three bounded
-- admission attempts. After an operator has corrected the provider routing,
-- rearm only that exact, request-free incident and reuse the shared paid
-- preflight rebind primitive to create a clean admission generation.
CREATE FUNCTION public.recover_earlybird_fresh_admission_provider_failure(
    p_order_id UUID
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    user_id UUID,
    plan_id TEXT,
    request_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_user_id_hint UUID;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_rebound_preflight public.analysis_preflights%ROWTYPE;
    v_rebound_preflight_id UUID;
    v_payment_valid BOOLEAN;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Match the established user -> order -> fulfillment -> preflight lock
    -- order used by paid-preflight rebinding and checkout creation.
    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_user_id_hint THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_payment_valid := v_order.status = 'paid'
        AND v_order.seller_reference_confirmed_at IS NOT NULL
        AND v_order.payment_id IS NOT NULL
        AND v_order.actual_amount_krw IS NOT NULL
        AND v_order.actual_amount_krw BETWEEN 0 AND v_order.expected_amount_krw
        AND v_order.actual_groble_product_id IS NOT DISTINCT FROM v_order.expected_groble_product_id;
    IF NOT v_payment_valid THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_PAYMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- A response lost after commit is safe to replay. Once the replacement is
    -- already advancing, return its opaque identity without mutating it again.
    IF v_fulfillment.status IN ('analysis_in_progress', 'completed') THEN
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_order.preflight_id,
            v_order.user_id, v_order.plan_id, v_fulfillment.request_id;
        RETURN;
    END IF;
    IF v_fulfillment.status = 'retryable_failure'
       AND v_fulfillment.last_error_code = 'FRESH_ADMISSION_PROVIDER_RECOVERY'
       AND v_fulfillment.request_id IS NULL
       AND v_preflight.admission_status = 'idle' THEN
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_order.preflight_id,
            v_order.user_id, v_order.plan_id, NULL::UUID;
        RETURN;
    END IF;

    IF NOT (
        v_fulfillment.status = 'manual_review'
        AND v_fulfillment.last_error_code = 'TARGET_UNAVAILABLE'
        AND v_fulfillment.request_id IS NULL
        AND v_fulfillment.manual_review_at IS NOT NULL
        AND v_preflight.user_id IS NOT DISTINCT FROM v_order.user_id
        AND v_preflight.access_mode = 'production'
        AND v_preflight.consumed_request_id IS NULL
        AND v_preflight.status IN ('ready', 'expired')
        AND v_preflight.expires_at <= v_now
        AND v_preflight.admission_status = 'blocked'
        AND v_preflight.admission_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        AND v_preflight.admission_last_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        AND v_preflight.admission_failure_count = 3
        AND v_preflight.admission_selected_plan_id IS NOT DISTINCT FROM v_order.plan_id
        AND v_preflight.admission_refreshed_at IS NOT NULL
        AND v_order.plan_id IN ('basic', 'standard')
        AND public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
        AND public.analysis_v2_valid_plan_catalog_snapshot(v_preflight.plan_catalog_snapshot)
        AND public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
        AND public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot)
        AND v_preflight.plan_catalog_snapshot->v_order.plan_id->>'launchStatus' = 'production'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'retryable_failure',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        last_error_code = 'FRESH_ADMISSION_PROVIDER_RECOVERY',
        last_error_at = v_now,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id
      AND fulfillment.status = 'manual_review'
      AND fulfillment.last_error_code = 'TARGET_UNAVAILABLE'
      AND fulfillment.request_id IS NULL
    RETURNING fulfillment.* INTO v_fulfillment;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_rebound_preflight_id := public.rebind_expired_paid_earlybird_preflight(p_order_id);
    IF v_rebound_preflight_id IS NULL
       OR v_rebound_preflight_id IS NOT DISTINCT FROM v_preflight.id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_REBIND_FAILED',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_rebound_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_rebound_preflight_id;
    IF NOT FOUND
       OR v_rebound_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_rebound_preflight.access_mode <> 'production'
       OR v_rebound_preflight.status <> 'ready'
       OR v_rebound_preflight.admission_status <> 'idle'
       OR v_rebound_preflight.consumed_request_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_REBIND_FAILED',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        v_order.id,
        v_fulfillment.status,
        v_rebound_preflight_id,
        v_order.user_id,
        v_order.plan_id,
        NULL::UUID;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_earlybird_fresh_admission_provider_failure(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_fresh_admission_provider_failure(UUID)
    TO service_role;

COMMENT ON FUNCTION public.recover_earlybird_fresh_admission_provider_failure(UUID) IS
    'Operator-only rearm for a paid, request-free fresh-profile provider outage after provider routing has been corrected.';
