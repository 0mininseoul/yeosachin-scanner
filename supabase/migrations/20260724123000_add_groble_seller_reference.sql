SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.earlybird_orders
    ADD COLUMN groble_seller_reference TEXT,
    ADD COLUMN seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.earlybird_orders
    ADD CONSTRAINT earlybird_orders_seller_reference_check
    CHECK (
        groble_seller_reference IS NULL
        OR groble_seller_reference ~ '^ord[.][a-f0-9]{32}$'
    ) NOT VALID;

CREATE UNIQUE INDEX earlybird_orders_seller_reference_unique
    ON public.earlybird_orders(groble_seller_reference)
    WHERE groble_seller_reference IS NOT NULL;

CREATE FUNCTION public.issue_earlybird_groble_seller_reference(
    p_order_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_reference TEXT;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;

    IF NOT FOUND OR v_order.status IS DISTINCT FROM 'payment_pending' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_order.groble_seller_reference IS NOT NULL THEN
        RETURN v_order.groble_seller_reference;
    END IF;

    v_reference := 'ord.' || pg_catalog.replace(
        extensions.gen_random_uuid()::TEXT,
        '-',
        ''
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET groble_seller_reference = v_reference,
        updated_at = pg_catalog.clock_timestamp()
    WHERE earlybird_order.id = p_order_id
      AND earlybird_order.groble_seller_reference IS NULL
    RETURNING earlybird_order.groble_seller_reference
    INTO v_reference;

    IF NOT FOUND THEN
        SELECT earlybird_order.groble_seller_reference
        INTO v_reference
        FROM public.earlybird_orders AS earlybird_order
        WHERE earlybird_order.id = p_order_id;
    END IF;
    IF v_reference !~ '^ord[.][a-f0-9]{32}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    RETURN v_reference;
END;
$$;

CREATE FUNCTION public.finalize_earlybird_groble_payment_by_reference(
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
    v_referenced_order_id UUID;
    v_result RECORD;
BEGIN
    IF p_seller_reference IS NULL
       OR p_seller_reference !~ '^ord[.][a-f0-9]{32}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.id
    INTO v_referenced_order_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.groble_seller_reference = p_seller_reference;

    IF v_referenced_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNMATCHED',
            ERRCODE = 'P0001';
    END IF;

    SELECT canonical_result.*
    INTO v_result
    FROM public.finalize_earlybird_groble_payment(
        p_event_id => p_event_id,
        p_idempotency_key => p_idempotency_key,
        p_event_type => p_event_type,
        p_occurred_at => p_occurred_at,
        p_payment_id => p_payment_id,
        p_buyer_email => p_buyer_email,
        p_buyer_phone_normalized => p_buyer_phone_normalized,
        p_buyer_phone_raw => p_buyer_phone_raw,
        p_buyer_display_name => p_buyer_display_name,
        p_product_id => p_product_id,
        p_amount_krw => p_amount_krw,
        p_paid_at => p_paid_at
    ) AS canonical_result;

    IF v_result.order_id IS NOT NULL
       AND v_result.order_id IS DISTINCT FROM v_referenced_order_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

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

    RETURN QUERY SELECT
        v_result.disposition::TEXT,
        v_result.order_id::UUID,
        v_result.status::TEXT,
        v_result.plan_sequence::SMALLINT;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_earlybird_groble_seller_reference(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.issue_earlybird_groble_seller_reference(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
