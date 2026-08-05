-- Standard inventory is managed by Groble. Keep the legacy Basic allocation
-- counter for compatibility, but do not reject a paid Standard confirmation
-- when the stale server-side counter reaches its old ten-item ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_definition TEXT;
    v_old CONSTANT TEXT := $old$
    UPDATE public.earlybird_plan_inventory AS inventory
    SET sold_count = inventory.sold_count + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE inventory.plan_id = v_order.plan_id
      AND inventory.sold_count < inventory.sale_limit
    RETURNING inventory.sold_count INTO v_sequence;

    IF v_sequence IS NULL THEN
        UPDATE public.earlybird_orders AS overflow_order
        SET status = 'overflow_refund_required',
            payment_id = p_payment_id,
            actual_groble_product_id = p_product_id,
            actual_amount_krw = p_amount_krw,
            paid_at = p_paid_at,
            updated_at = pg_catalog.clock_timestamp()
        WHERE overflow_order.id = v_order.id
        RETURNING overflow_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            'overflow_refund_required', v_order.id
        );
        RETURN QUERY SELECT
            'overflow_refund_required'::TEXT,
            v_order.id,
            v_order.status,
            NULL::SMALLINT;
        RETURN;
    END IF;

    UPDATE public.earlybird_orders AS accepted_order
    SET status = 'paid',
        payment_id = p_payment_id,
        actual_groble_product_id = p_product_id,
        actual_amount_krw = p_amount_krw,
        paid_at = p_paid_at,
        due_at = p_paid_at + INTERVAL '24 hours',
        plan_sequence = v_sequence,
        updated_at = pg_catalog.clock_timestamp()
    WHERE accepted_order.id = v_order.id
    RETURNING accepted_order.* INTO v_order;

    INSERT INTO public.earlybird_webhook_events (
        event_id, idempotency_key, event_type, occurred_at,
        payment_id, product_id, amount_krw, disposition, order_id
    ) VALUES (
        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
        p_payment_id, p_product_id, p_amount_krw, 'accepted', v_order.id
    );

    RETURN QUERY SELECT 'accepted'::TEXT, v_order.id, v_order.status, v_order.plan_sequence;
$old$;
    v_new CONSTANT TEXT := $new$
    IF v_order.plan_id = 'standard' THEN
        -- Groble is the inventory source of truth for Standard. Do not touch
        -- the legacy server counter or allocate its ten-item sequence.
        v_sequence := NULL;
    ELSE
        UPDATE public.earlybird_plan_inventory AS inventory
        SET sold_count = inventory.sold_count + 1,
            updated_at = pg_catalog.clock_timestamp()
        WHERE inventory.plan_id = v_order.plan_id
          AND inventory.sold_count < inventory.sale_limit
        RETURNING inventory.sold_count INTO v_sequence;

        IF v_sequence IS NULL THEN
            UPDATE public.earlybird_orders AS overflow_order
            SET status = 'overflow_refund_required',
                payment_id = p_payment_id,
                actual_groble_product_id = p_product_id,
                actual_amount_krw = p_amount_krw,
                paid_at = p_paid_at,
                updated_at = pg_catalog.clock_timestamp()
            WHERE overflow_order.id = v_order.id
            RETURNING overflow_order.* INTO v_order;

            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw,
                'overflow_refund_required', v_order.id
            );
            RETURN QUERY SELECT
                'overflow_refund_required'::TEXT,
                v_order.id,
                v_order.status,
                NULL::SMALLINT;
            RETURN;
        END IF;
    END IF;

    UPDATE public.earlybird_orders AS accepted_order
    SET status = 'paid',
        payment_id = p_payment_id,
        actual_groble_product_id = p_product_id,
        actual_amount_krw = p_amount_krw,
        paid_at = p_paid_at,
        due_at = p_paid_at + INTERVAL '24 hours',
        plan_sequence = v_sequence,
        updated_at = pg_catalog.clock_timestamp()
    WHERE accepted_order.id = v_order.id
    RETURNING accepted_order.* INTO v_order;

    INSERT INTO public.earlybird_webhook_events (
        event_id, idempotency_key, event_type, occurred_at,
        payment_id, product_id, amount_krw, disposition, order_id
    ) VALUES (
        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
        p_payment_id, p_product_id, p_amount_krw, 'accepted', v_order.id
    );

    RETURN QUERY SELECT 'accepted'::TEXT, v_order.id, v_order.status, v_order.plan_sequence;
$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.finalize_earlybird_groble_payment_pre_reconciliation(
            text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone
        )'::pg_catalog.regprocedure
    )
    INTO v_definition;

    IF pg_catalog.strpos(v_definition, 'IF v_order.plan_id = ''standard'' THEN') > 0 THEN
        RETURN;
    END IF;

    IF v_definition IS NULL OR pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_STANDARD_INVENTORY_FUNCTION_SHAPE_UNEXPECTED',
            ERRCODE = 'P0001';
    END IF;

    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;
