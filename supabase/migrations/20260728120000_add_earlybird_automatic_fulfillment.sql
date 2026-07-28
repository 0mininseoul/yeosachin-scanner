-- Automatic fulfillment is deliberately recovery-driven. The payment webhook
-- remains enqueue-only; this bounded, service-role-only sweep is the sole
-- automatic transition out of awaiting_operator.
CREATE FUNCTION public.auto_admit_eligible_earlybird_fulfillments(
    p_limit INTEGER DEFAULT 20
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
    v_candidate RECORD;
    v_admitted RECORD;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    FOR v_candidate IN
        SELECT fulfillment.order_id
        FROM public.earlybird_fulfillments AS fulfillment
        INNER JOIN public.earlybird_orders AS earlybird_order
            ON earlybird_order.id = fulfillment.order_id
        WHERE fulfillment.status = 'awaiting_operator'
          AND earlybird_order.status = 'paid'
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.actual_amount_krw IS NOT NULL
          AND earlybird_order.actual_amount_krw BETWEEN 0 AND earlybird_order.expected_amount_krw
          AND earlybird_order.actual_groble_product_id IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND earlybird_order.plan_id IN ('basic', 'standard')
        ORDER BY fulfillment.created_at, fulfillment.order_id
        LIMIT p_limit
        FOR UPDATE OF fulfillment, earlybird_order SKIP LOCKED
    LOOP
        BEGIN
            SELECT * INTO v_admitted
            FROM public.admit_earlybird_fulfillment(v_candidate.order_id);
        EXCEPTION
            WHEN SQLSTATE 'P0001' THEN
                -- Snapshot, state, or payment races remain waiting for the
                -- explicit operator path; one ambiguous row cannot poison a batch.
                IF SQLERRM IN (
                    'EARLYBIRD_FULFILLMENT_PAYMENT_INVALID',
                    'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
                    'EARLYBIRD_FULFILLMENT_STATE_INVALID',
                    'EARLYBIRD_FULFILLMENT_MANUAL_REVIEW'
                ) THEN
                    CONTINUE;
                END IF;
                RAISE;
        END;

        IF v_admitted.fulfillment_status = 'admission_pending' THEN
            RETURN QUERY SELECT
                v_admitted.order_id,
                v_admitted.fulfillment_status,
                v_admitted.preflight_id,
                v_admitted.user_id,
                v_admitted.plan_id,
                v_admitted.request_id;
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_admit_eligible_earlybird_fulfillments(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_admit_eligible_earlybird_fulfillments(INTEGER)
    TO service_role;
