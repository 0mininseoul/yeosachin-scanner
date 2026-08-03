-- Groble can deliver a signed full refund before its payment.completed
-- envelope. Keep the existing attribution logic, but make its committed
-- outcome terminally refunded when that immutable refund evidence is already
-- present. The payment advisory lock is shared with the refund finalizer.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.finalize_earlybird_groble_payment_refund_aware(
    p_referenced_order_id UUID,
    p_require_legacy_email_only BOOLEAN,
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_buyer_phone_normalized TEXT,
    p_buyer_phone_raw TEXT,
    p_buyer_display_name TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    disposition TEXT,
    order_id UUID,
    status TEXT,
    plan_sequence SMALLINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result RECORD;
    v_order public.earlybird_orders%ROWTYPE;
BEGIN
    -- The delegated finalizer validates evidence and acquires this same lock
    -- before it can attribute a payment. It remains held through this wrapper.
    SELECT finalized.*
    INTO v_result
    FROM public.finalize_earlybird_groble_payment_reconciliation_aware(
        p_referenced_order_id,
        p_require_legacy_email_only,
        p_event_id,
        p_idempotency_key,
        p_event_type,
        p_occurred_at,
        p_payment_id,
        p_buyer_email,
        p_buyer_phone_normalized,
        p_buyer_phone_raw,
        p_buyer_display_name,
        p_product_id,
        p_amount_krw,
        p_paid_at
    ) AS finalized;

    IF v_result.order_id IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS refund_event
            WHERE refund_event.event_type = 'payment.refunded'
              AND refund_event.payment_id = p_payment_id
              AND refund_event.product_id = p_product_id
              AND refund_event.amount_krw = p_amount_krw
              AND refund_event.refund_amount_krw = p_amount_krw
              AND refund_event.partial_refund IS FALSE
       ) THEN
        RETURN QUERY SELECT
            v_result.disposition::TEXT,
            v_result.order_id::UUID,
            v_result.status::TEXT,
            v_result.plan_sequence::SMALLINT;
        RETURN;
    END IF;

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_result.order_id
      AND earlybird_order.expected_groble_product_id = p_product_id
      AND earlybird_order.actual_groble_product_id = p_product_id
      AND earlybird_order.actual_amount_krw = p_amount_krw
    FOR UPDATE;

    IF NOT FOUND OR v_order.status NOT IN (
        'paid', 'refund_pending', 'analysis_in_progress', 'completed', 'refunded'
    ) THEN
        RETURN QUERY SELECT
            v_result.disposition::TEXT,
            v_result.order_id::UUID,
            v_result.status::TEXT,
            v_result.plan_sequence::SMALLINT;
        RETURN;
    END IF;

    IF v_order.status <> 'refunded' THEN
        UPDATE public.earlybird_orders AS earlybird_order
        SET status = 'refunded',
            updated_at = pg_catalog.clock_timestamp()
        WHERE earlybird_order.id = v_order.id
        RETURNING earlybird_order.* INTO v_order;
    END IF;

    -- Attach the previously unmatched, full-refund evidence to the now
    -- attributed order. Partial refunds are deliberately excluded above.
    UPDATE public.earlybird_webhook_events AS refund_event
    SET disposition = 'refunded',
        order_id = v_order.id
    WHERE refund_event.event_type = 'payment.refunded'
      AND refund_event.payment_id = p_payment_id
      AND refund_event.product_id = p_product_id
      AND refund_event.amount_krw = p_amount_krw
      AND refund_event.refund_amount_krw = p_amount_krw
      AND refund_event.partial_refund IS FALSE
      AND refund_event.disposition = 'refund_unmatched';

    RETURN QUERY SELECT
        'refunded'::TEXT,
        v_order.id,
        v_order.status,
        v_order.plan_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_refund_aware(
    UUID, BOOLEAN, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

-- Recreate every public completion overload so it reaches the refund-aware
-- boundary before exposing an attributed order.
CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_buyer_phone_normalized TEXT,
    p_buyer_phone_raw TEXT,
    p_buyer_display_name TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY SELECT *
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        NULL::UUID, FALSE, p_event_id, p_idempotency_key, p_event_type,
        p_occurred_at, p_payment_id, p_buyer_email, p_buyer_phone_normalized,
        p_buyer_phone_raw, p_buyer_display_name, p_product_id, p_amount_krw,
        p_paid_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    p_seller_reference TEXT,
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_buyer_phone_normalized TEXT,
    p_buyer_phone_raw TEXT,
    p_buyer_display_name TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_referenced_order_id UUID;
    v_result RECORD;
BEGIN
    IF p_seller_reference IS NULL
       OR p_seller_reference !~ '^ord[.][a-f0-9]{32}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.id INTO v_referenced_order_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.groble_seller_reference = p_seller_reference;
    IF v_referenced_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNMATCHED',
            ERRCODE = 'P0001';
    END IF;

    SELECT finalized.* INTO v_result
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        v_referenced_order_id, FALSE, p_event_id, p_idempotency_key,
        p_event_type, p_occurred_at, p_payment_id, p_buyer_email,
        p_buyer_phone_normalized, p_buyer_phone_raw, p_buyer_display_name,
        p_product_id, p_amount_krw, p_paid_at
    ) AS finalized;

    IF v_result.order_id = v_referenced_order_id
       AND v_result.status IN ('paid', 'analysis_in_progress', 'completed') THEN
        UPDATE public.earlybird_orders AS earlybird_order
        SET seller_reference_confirmed_at = COALESCE(
                earlybird_order.seller_reference_confirmed_at,
                pg_catalog.clock_timestamp()
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE earlybird_order.id = v_referenced_order_id;
    END IF;

    RETURN QUERY SELECT v_result.disposition::TEXT, v_result.order_id::UUID,
        v_result.status::TEXT, v_result.plan_sequence::SMALLINT;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY SELECT *
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        NULL::UUID, TRUE, p_event_id, p_idempotency_key, p_event_type,
        p_occurred_at, p_payment_id, p_buyer_email, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, p_product_id, p_amount_krw, p_paid_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
