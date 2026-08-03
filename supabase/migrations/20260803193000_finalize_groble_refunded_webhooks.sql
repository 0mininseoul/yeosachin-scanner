-- A signed payment.refunded is Groble's terminal signal for a one-time refund.
-- Match it only to the already-attributed merchant UID; it carries no seller
-- reference and must never select a new order by buyer or product alone.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.earlybird_webhook_events
    ADD COLUMN refund_amount_krw INTEGER,
    ADD COLUMN partial_refund BOOLEAN,
    ADD COLUMN refunded_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.earlybird_webhook_events
    ADD CONSTRAINT earlybird_webhook_events_refund_evidence_check CHECK (
        (
            event_type = 'payment.refunded'
            AND refund_amount_krw IS NOT NULL
            AND refund_amount_krw >= 0
            AND partial_refund IS NOT NULL
            AND refunded_at IS NOT NULL
        )
        OR (
            event_type <> 'payment.refunded'
            AND refund_amount_krw IS NULL
            AND partial_refund IS NULL
            AND refunded_at IS NULL
        )
    );

ALTER TABLE public.earlybird_webhook_events
    DROP CONSTRAINT earlybird_webhook_events_type_check;
ALTER TABLE public.earlybird_webhook_events
    ADD CONSTRAINT earlybird_webhook_events_type_check CHECK (
        event_type IN (
            'payment.completed',
            'payment.cancel_requested',
            'payment.refunded'
        )
    );

ALTER TABLE public.earlybird_webhook_events
    DROP CONSTRAINT earlybird_webhook_events_disposition_check;
ALTER TABLE public.earlybird_webhook_events
    ADD CONSTRAINT earlybird_webhook_events_disposition_check CHECK (disposition IN (
        'accepted',
        'duplicate_event',
        'duplicate_payment',
        'unmatched',
        'ambiguous_buyer',
        'mismatch',
        'overflow_refund_required',
        'cancel_requested',
        'cancel_duplicate_event',
        'cancel_unmatched',
        'cancel_mismatch',
        'cancel_before_payment',
        'late_cancelled_payment',
        'refunded',
        'refund_duplicate_event',
        'refund_unmatched',
        'refund_mismatch',
        'partial_refund_recorded'
    ));

CREATE FUNCTION public.finalize_earlybird_groble_refund(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_refund_amount_krw INTEGER,
    p_partial_refund BOOLEAN,
    p_refunded_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_event public.earlybird_webhook_events%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
BEGIN
    IF p_event_type IS DISTINCT FROM 'payment.refunded'
       OR p_event_id IS NULL
          OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
          OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw < 0
       OR p_refund_amount_krw IS NULL OR p_refund_amount_krw < 0
       OR p_partial_refund IS NULL
       OR p_occurred_at IS NULL OR p_refunded_at IS NULL THEN
        RAISE EXCEPTION 'GROBLE_REFUND_EVIDENCE_INVALID';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_payment_id, 0)
    );

    SELECT webhook_event.*
    INTO v_event
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.event_id = p_event_id
       OR webhook_event.idempotency_key = p_idempotency_key
    ORDER BY webhook_event.processed_at
    LIMIT 1;
    IF FOUND THEN
        IF v_event.order_id IS NOT NULL THEN
            SELECT earlybird_order.*
            INTO v_order
            FROM public.earlybird_orders AS earlybird_order
            WHERE earlybird_order.id = v_event.order_id;
        END IF;
        RETURN QUERY SELECT
            'refund_duplicate_event'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.payment_id = p_payment_id
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw,
            refund_amount_krw, partial_refund, refunded_at,
            disposition
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            p_refund_amount_krw, p_partial_refund, p_refunded_at,
            'refund_unmatched'
        );
        RETURN QUERY SELECT
            'refund_unmatched'::TEXT,
            NULL::UUID,
            NULL::TEXT,
            NULL::SMALLINT;
        RETURN;
    END IF;

    IF v_order.expected_groble_product_id IS DISTINCT FROM p_product_id
       OR v_order.actual_groble_product_id IS DISTINCT FROM p_product_id
       OR v_order.actual_amount_krw IS DISTINCT FROM p_amount_krw
       OR p_refund_amount_krw > p_amount_krw
       OR (p_partial_refund IS FALSE AND p_refund_amount_krw <> p_amount_krw) THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw,
            refund_amount_krw, partial_refund, refunded_at,
            disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            p_refund_amount_krw, p_partial_refund, p_refunded_at,
            'refund_mismatch', v_order.id
        );
        RETURN QUERY SELECT
            'refund_mismatch'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    IF p_partial_refund THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw,
            refund_amount_krw, partial_refund, refunded_at,
            disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            p_refund_amount_krw, p_partial_refund, p_refunded_at,
            'partial_refund_recorded', v_order.id
        );
        RETURN QUERY SELECT
            'partial_refund_recorded'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    IF v_order.status IN ('paid', 'refund_pending', 'analysis_in_progress', 'completed') THEN
        UPDATE public.earlybird_orders AS earlybird_order
        SET status = 'refunded',
            updated_at = pg_catalog.clock_timestamp()
        WHERE earlybird_order.id = v_order.id
        RETURNING earlybird_order.* INTO v_order;
    ELSIF v_order.status <> 'refunded' THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw,
            refund_amount_krw, partial_refund, refunded_at,
            disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            p_refund_amount_krw, p_partial_refund, p_refunded_at,
            'refund_mismatch', v_order.id
        );
        RETURN QUERY SELECT
            'refund_mismatch'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    INSERT INTO public.earlybird_webhook_events (
        event_id, idempotency_key, event_type, occurred_at,
        payment_id, product_id, amount_krw,
        refund_amount_krw, partial_refund, refunded_at,
        disposition, order_id
    ) VALUES (
        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
        p_payment_id, p_product_id, p_amount_krw,
        p_refund_amount_krw, p_partial_refund, p_refunded_at,
        'refunded', v_order.id
    );
    RETURN QUERY SELECT
        'refunded'::TEXT,
        v_order.id,
        v_order.status,
        v_order.plan_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_refund(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, INTEGER, INTEGER,
    BOOLEAN, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_refund(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, INTEGER, INTEGER,
    BOOLEAN, TIMESTAMP WITH TIME ZONE
) TO service_role;
