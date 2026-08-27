-- A fully coupon-discounted completion is a valid order fulfillment event,
-- but it is not paid-ever evidence. Keep the evidence ledger positive-only
-- while allowing the completion wrapper to finish without rolling back.
CREATE OR REPLACE FUNCTION public.record_external_paid_ever(
    p_order_id UUID,
    p_event_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_state TEXT;
    v_account_id UUID;
    v_evidence RECORD;
    v_existing public.account_paid_evidence%ROWTYPE;
    v_counts_as_external BOOLEAN;
BEGIN
    SELECT paid_order.user_id
    INTO v_account_id
    FROM public.earlybird_orders AS paid_order
    WHERE paid_order.id = p_order_id;

    IF FOUND THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_account_id::TEXT, 0)
        );
    END IF;

    SELECT rollout.paid_ever_state
    INTO v_state
    FROM public.account_ledger_rollout_state AS rollout
    WHERE rollout.singleton IS TRUE
    FOR SHARE;
    IF v_state IS DISTINCT FROM 'active' THEN
        RETURN FALSE;
    END IF;

    SELECT paid_order.id AS order_id,
        webhook_event.event_id,
        paid_order.user_id AS account_id,
        paid_order.payment_id,
        paid_order.paid_at,
        paid_order.actual_amount_krw AS amount_krw,
        paid_order.status AS order_status,
        account.traffic_class,
        account.classification_version
    INTO v_evidence
    FROM public.earlybird_orders AS paid_order
    JOIN public.earlybird_webhook_events AS webhook_event
      ON webhook_event.order_id = paid_order.id
    JOIN public.users AS account
      ON account.id = paid_order.user_id
    WHERE paid_order.id = p_order_id
      AND webhook_event.event_id = p_event_id
      AND webhook_event.event_type = 'payment.completed'
      AND webhook_event.disposition = 'accepted'
      AND webhook_event.payment_id = paid_order.payment_id
      AND webhook_event.product_id = paid_order.actual_groble_product_id
      AND webhook_event.amount_krw = paid_order.actual_amount_krw
      AND paid_order.payment_id IS NOT NULL
      AND paid_order.paid_at IS NOT NULL
      AND paid_order.actual_amount_krw >= 0
    FOR SHARE OF paid_order, account;

    IF NOT FOUND OR v_evidence.classification_version IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Zero-amount coupon completions are valid for fulfillment, but must not
    -- create positive-amount account_paid_evidence or paid-ever flags.
    IF v_evidence.amount_krw = 0 THEN
        RETURN FALSE;
    END IF;

    IF v_evidence.order_status NOT IN (
        'paid',
        'analysis_in_progress',
        'completed',
        'overflow_refund_required',
        'refund_pending',
        'refunded'
    ) THEN
        RETURN FALSE;
    END IF;

    v_counts_as_external := v_evidence.traffic_class = 'external';

    INSERT INTO public.account_paid_evidence (
        order_id, event_id, account_id, payment_id, paid_at, amount_krw,
        counts_as_external
    ) VALUES (
        v_evidence.order_id,
        v_evidence.event_id,
        v_evidence.account_id,
        v_evidence.payment_id,
        v_evidence.paid_at,
        v_evidence.amount_krw,
        v_counts_as_external
    )
    ON CONFLICT (order_id) DO NOTHING;

    SELECT evidence.*
    INTO v_existing
    FROM public.account_paid_evidence AS evidence
    WHERE evidence.order_id = v_evidence.order_id;

    IF v_existing.event_id IS DISTINCT FROM v_evidence.event_id
       OR v_existing.account_id IS DISTINCT FROM v_evidence.account_id
       OR v_existing.payment_id IS DISTINCT FROM v_evidence.payment_id
       OR v_existing.paid_at IS DISTINCT FROM v_evidence.paid_at
       OR v_existing.amount_krw IS DISTINCT FROM v_evidence.amount_krw
       OR v_existing.counts_as_external
            IS DISTINCT FROM v_counts_as_external THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVIDENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_counts_as_external THEN
        UPDATE public.users AS account
        SET is_paid_user = TRUE,
            first_paid_at = CASE
                WHEN account.first_paid_at IS NULL
                    THEN v_evidence.paid_at
                ELSE LEAST(
                    account.first_paid_at, v_evidence.paid_at
                )
            END
        WHERE account.id = v_evidence.account_id;
    END IF;

    RETURN v_counts_as_external;
END;
$$;

REVOKE ALL ON FUNCTION public.record_external_paid_ever(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.record_external_paid_ever(UUID, TEXT)
    TO service_role;
