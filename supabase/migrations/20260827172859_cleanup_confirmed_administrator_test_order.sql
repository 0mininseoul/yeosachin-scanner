-- One-shot fail-closed cleanup for the confirmed administrator test blocker.
-- Keep the ledger row as an auditable cancelled test order; never delete the
-- account, preflight, or any external-user order. Supabase runs this DO block
-- inside one transaction, so every precondition failure rolls back the update.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, auth;

DO $$
DECLARE
    v_admin_id UUID;
    v_admin_count INTEGER;
    v_candidate_count INTEGER;
    v_order_id UUID;
    v_updated_count INTEGER;
BEGIN
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_admin_count
    FROM auth.users AS auth_user
    JOIN public.users AS app_user
      ON app_user.id = auth_user.id
    WHERE pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = 'ym1113@kakao.com'
      AND pg_catalog.lower(pg_catalog.btrim(app_user.email)) = 'ym1113@kakao.com';

    IF v_admin_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ADMIN_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;

    SELECT auth_user.id
    INTO v_admin_id
    FROM auth.users AS auth_user
    JOIN public.users AS app_user
      ON app_user.id = auth_user.id
    WHERE pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = 'ym1113@kakao.com'
      AND pg_catalog.lower(pg_catalog.btrim(app_user.email)) = 'ym1113@kakao.com'
    FOR UPDATE OF auth_user;

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_candidate_count
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.user_id = v_admin_id
      AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.status = 'payment_pending'
      AND earlybird_order.payment_id IS NULL
      AND earlybird_order.paid_at IS NULL
      AND earlybird_order.actual_amount_krw IS NULL
      AND earlybird_order.seller_reference_confirmed_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = earlybird_order.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = earlybird_order.result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = earlybird_order.id
      );

    IF v_candidate_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ORDER_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.id
    INTO v_order_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.user_id = v_admin_id
      AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.status = 'payment_pending'
      AND earlybird_order.payment_id IS NULL
      AND earlybird_order.paid_at IS NULL
      AND earlybird_order.actual_amount_krw IS NULL
      AND earlybird_order.seller_reference_confirmed_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = earlybird_order.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = earlybird_order.result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = earlybird_order.id
      )
    FOR UPDATE;

    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ORDER_LOCK_FAILED',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_orders
    SET status = 'cancelled',
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_order_id
      AND user_id = v_admin_id
      AND pg_catalog.lower(target_instagram_id) = '0_min._.00'
      AND plan_id = 'standard'
      AND status = 'payment_pending'
      AND payment_id IS NULL
      AND paid_at IS NULL
      AND actual_amount_krw IS NULL
      AND seller_reference_confirmed_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = v_order_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = v_order_id
      );

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_UPDATE_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;
END;
$$;
