-- A Groble dashboard check is an operator-only, point-in-time closure signal.
-- It never creates payment evidence and is intentionally not invoked by any
-- checkout, webhook, fulfillment, or recovery path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_checkout_reconciliations (
    order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    prior_status TEXT NOT NULL
        CHECK (prior_status IN ('payment_pending', 'cancelled')),
    terminal_status TEXT NOT NULL DEFAULT 'payment_failed'
        CHECK (terminal_status = 'payment_failed'),
    reason TEXT NOT NULL
        CHECK (reason = 'provider_dashboard_no_sale'),
    provider_checked_at TIMESTAMP WITH TIME ZONE NOT NULL,
    reconciled_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_checkout_reconciliations_temporal_check
        CHECK (provider_checked_at <= reconciled_at)
);

ALTER TABLE public.earlybird_checkout_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_checkout_reconciliations
    FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.earlybird_checkout_reconciliations
    TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_earlybird_checkout_no_sale(
    p_order_id UUID,
    p_provider_checked_at TIMESTAMP WITH TIME ZONE,
    p_reason TEXT,
    p_confirm_provider_dashboard_no_sale BOOLEAN
)
RETURNS TABLE(disposition TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_existing public.earlybird_checkout_reconciliations%ROWTYPE;
    v_user_id UUID;
    v_now TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_order_id IS NULL
       OR p_reason IS DISTINCT FROM 'provider_dashboard_no_sale'
       OR p_confirm_provider_dashboard_no_sale IS NOT TRUE
       OR p_provider_checked_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECONCILIATION_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id
    INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECONCILIATION_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_user_id::TEXT, 0)
    );

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;

    SELECT reconciliation.*
    INTO v_existing
    FROM public.earlybird_checkout_reconciliations AS reconciliation
    WHERE reconciliation.order_id = p_order_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_order.status = v_existing.terminal_status
           AND v_existing.reason = p_reason
           AND v_existing.provider_checked_at = p_provider_checked_at THEN
            RETURN QUERY SELECT 'already_reconciled'::TEXT, v_order.status::TEXT;
            RETURN;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    IF p_provider_checked_at > v_now
       OR p_provider_checked_at < v_now - INTERVAL '24 hours'
       OR p_provider_checked_at < v_order.created_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECONCILIATION_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status NOT IN ('payment_pending', 'cancelled')
       OR v_order.payment_id IS NOT NULL
       OR v_order.actual_amount_krw IS NOT NULL
       OR v_order.paid_at IS NOT NULL
       OR v_order.seller_reference_confirmed_at IS NOT NULL
       OR v_order.result_request_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECONCILIATION_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'payment_failed',
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;

    INSERT INTO public.earlybird_checkout_reconciliations (
        order_id,
        prior_status,
        terminal_status,
        reason,
        provider_checked_at,
        reconciled_at
    ) VALUES (
        v_order.id,
        v_order.status,
        'payment_failed',
        p_reason,
        p_provider_checked_at,
        v_now
    );

    RETURN QUERY SELECT 'reconciled'::TEXT, 'payment_failed'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_earlybird_checkout_no_sale(
    UUID, TIMESTAMP WITH TIME ZONE, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_earlybird_checkout_no_sale(
    UUID, TIMESTAMP WITH TIME ZONE, TEXT, BOOLEAN
) TO service_role;
