-- Groble earlybird presale records are deliberately isolated from the automatic analysis
-- pipeline. Browser clients can read their own safe order rows, while all writes go through
-- service-role-only functions.

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    target_instagram_id VARCHAR(30) NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id VARCHAR(30),
    plan_id TEXT NOT NULL,
    pricing_version VARCHAR(64) NOT NULL,
    expected_amount_krw INTEGER NOT NULL,
    expected_groble_product_id VARCHAR(128) NOT NULL,
    disclosure_version VARCHAR(64) NOT NULL,
    disclosure_text TEXT NOT NULL,
    disclosure_accepted_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT NOT NULL DEFAULT 'payment_pending',
    payment_id VARCHAR(256) UNIQUE,
    actual_groble_product_id VARCHAR(128),
    actual_amount_krw INTEGER,
    paid_at TIMESTAMP WITH TIME ZONE,
    due_at TIMESTAMP WITH TIME ZONE,
    plan_sequence SMALLINT,
    result_request_id UUID REFERENCES public.analysis_requests(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_orders_target_check CHECK (
        target_instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT earlybird_orders_counts_check CHECK (
        target_followers_count BETWEEN 0 AND 10000000
        AND target_following_count BETWEEN 0 AND 10000000
    ),
    CONSTRAINT earlybird_orders_exclusion_check CHECK (
        (exclusion_decision = 'skip' AND excluded_instagram_id IS NULL)
        OR (
            exclusion_decision = 'exclude'
            AND excluded_instagram_id ~ '^[a-z0-9._]{1,30}$'
            AND excluded_instagram_id <> target_instagram_id
        )
    ),
    CONSTRAINT earlybird_orders_plan_check CHECK (plan_id IN ('basic', 'standard')),
    CONSTRAINT earlybird_orders_expected_amount_check CHECK (expected_amount_krw > 0),
    CONSTRAINT earlybird_orders_status_check CHECK (status IN (
        'payment_pending',
        'payment_failed',
        'paid',
        'analysis_in_progress',
        'completed',
        'overflow_refund_required',
        'cancelled',
        'refund_pending',
        'refunded'
    )),
    CONSTRAINT earlybird_orders_payment_shape_check CHECK (
        (status = 'payment_pending' AND payment_id IS NULL AND paid_at IS NULL)
        OR status <> 'payment_pending'
    ),
    CONSTRAINT earlybird_orders_sequence_check CHECK (
        plan_sequence IS NULL OR plan_sequence BETWEEN 1 AND 10
    ),
    CONSTRAINT earlybird_orders_due_check CHECK (
        due_at IS NULL OR (paid_at IS NOT NULL AND due_at = paid_at + INTERVAL '48 hours')
    )
);

CREATE UNIQUE INDEX earlybird_orders_plan_sequence_unique
    ON public.earlybird_orders(plan_id, plan_sequence)
    WHERE plan_sequence IS NOT NULL;
CREATE UNIQUE INDEX earlybird_orders_one_pending_per_user
    ON public.earlybird_orders(user_id)
    WHERE status = 'payment_pending';
CREATE INDEX earlybird_orders_owner_created_idx
    ON public.earlybird_orders(user_id, created_at DESC);
CREATE INDEX earlybird_orders_pending_product_idx
    ON public.earlybird_orders(status, expected_groble_product_id, created_at DESC)
    WHERE status = 'payment_pending';
CREATE INDEX earlybird_orders_result_request_idx
    ON public.earlybird_orders(result_request_id)
    WHERE result_request_id IS NOT NULL;

CREATE TABLE public.earlybird_plan_inventory (
    plan_id TEXT PRIMARY KEY,
    sale_limit SMALLINT NOT NULL DEFAULT 10,
    sold_count SMALLINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_plan_inventory_plan_check CHECK (plan_id IN ('basic', 'standard')),
    CONSTRAINT earlybird_plan_inventory_limit_check CHECK (sale_limit = 10),
    CONSTRAINT earlybird_plan_inventory_count_check CHECK (
        sold_count BETWEEN 0 AND sale_limit
    )
);

INSERT INTO public.earlybird_plan_inventory (plan_id, sale_limit, sold_count)
VALUES ('basic', 10, 0), ('standard', 10, 0);

CREATE TABLE public.earlybird_webhook_events (
    event_id VARCHAR(256) PRIMARY KEY,
    idempotency_key VARCHAR(256) NOT NULL UNIQUE,
    event_type VARCHAR(64) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    payment_id VARCHAR(256) NOT NULL,
    product_id VARCHAR(128) NOT NULL,
    amount_krw INTEGER NOT NULL,
    disposition TEXT NOT NULL,
    order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL,
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_webhook_events_type_check CHECK (
        event_type IN ('payment.completed', 'payment.cancel_requested')
    ),
    CONSTRAINT earlybird_webhook_events_amount_check CHECK (amount_krw > 0),
    CONSTRAINT earlybird_webhook_events_disposition_check CHECK (disposition IN (
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
        'cancel_mismatch'
    ))
);

CREATE INDEX earlybird_webhook_events_payment_idx
    ON public.earlybird_webhook_events(payment_id, processed_at DESC);
CREATE INDEX earlybird_webhook_events_order_idx
    ON public.earlybird_webhook_events(order_id)
    WHERE order_id IS NOT NULL;

CREATE TABLE public.earlybird_waitlist (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    target_instagram_id VARCHAR(30) NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id VARCHAR(30),
    plan_id TEXT NOT NULL DEFAULT 'plus',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_waitlist_plan_check CHECK (plan_id = 'plus'),
    CONSTRAINT earlybird_waitlist_target_check CHECK (
        target_instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT earlybird_waitlist_counts_check CHECK (
        target_followers_count BETWEEN 0 AND 10000000
        AND target_following_count BETWEEN 0 AND 10000000
    ),
    CONSTRAINT earlybird_waitlist_exclusion_check CHECK (
        (exclusion_decision = 'skip' AND excluded_instagram_id IS NULL)
        OR (
            exclusion_decision = 'exclude'
            AND excluded_instagram_id ~ '^[a-z0-9._]{1,30}$'
            AND excluded_instagram_id <> target_instagram_id
        )
    )
);

CREATE INDEX earlybird_waitlist_owner_created_idx
    ON public.earlybird_waitlist(user_id, created_at DESC);

ALTER TABLE public.earlybird_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_plan_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY earlybird_orders_owner_select
    ON public.earlybird_orders
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY earlybird_waitlist_owner_select
    ON public.earlybird_waitlist
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.earlybird_orders FROM anon, authenticated;
REVOKE ALL ON TABLE public.earlybird_plan_inventory FROM anon, authenticated;
REVOKE ALL ON TABLE public.earlybird_webhook_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.earlybird_waitlist FROM anon, authenticated;
GRANT SELECT (
    id,
    user_id,
    target_instagram_id,
    plan_id,
    actual_amount_krw,
    status,
    paid_at,
    due_at,
    plan_sequence,
    result_request_id,
    created_at
) ON public.earlybird_orders TO authenticated;
GRANT SELECT ON TABLE public.earlybird_waitlist TO authenticated;
GRANT ALL ON TABLE public.earlybird_orders TO service_role;
GRANT ALL ON TABLE public.earlybird_plan_inventory TO service_role;
GRANT ALL ON TABLE public.earlybird_webhook_events TO service_role;
GRANT ALL ON TABLE public.earlybird_waitlist TO service_role;

CREATE OR REPLACE FUNCTION public.create_earlybird_checkout(
    p_user_id UUID,
    p_preflight_id UUID,
    p_plan_id TEXT,
    p_expected_product_id TEXT,
    p_expected_amount_krw INTEGER,
    p_pricing_version TEXT,
    p_disclosure_version TEXT,
    p_disclosure_text TEXT,
    p_disclosure_accepted_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(order_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_orders%ROWTYPE;
    v_order_id UUID;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_snapshot_amount TEXT;
BEGIN
    IF p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION 'EARLYBIRD_PAID_PLAN_REQUIRED';
    END IF;
    IF p_pricing_version <> 'earlybird-2026-07-v1'
       OR p_disclosure_version <> 'earlybird-48h-v1'
       OR p_disclosure_text <> '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 48시간 이내 판독 결과를 제공합니다.'
       OR p_disclosure_accepted_at IS NULL THEN
        RAISE EXCEPTION 'EARLYBIRD_CONSENT_INVALID';
    END IF;
    IF p_expected_product_id IS NULL
       OR p_expected_product_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'EARLYBIRD_PRODUCT_INVALID';
    END IF;
    IF (p_plan_id = 'basic' AND p_expected_amount_krw <> 14900)
       OR (p_plan_id = 'standard' AND p_expected_amount_krw <> 19900) THEN
        RAISE EXCEPTION 'EARLYBIRD_PRICE_INVALID';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_user_id::TEXT, 0)
    );

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_preflight.status <> 'ready'
       OR v_preflight.expires_at <= pg_catalog.clock_timestamp()
       OR v_preflight.exclusion_decision NOT IN ('skip', 'exclude')
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.required_plan_id IS NULL THEN
        RAISE EXCEPTION 'PREFLIGHT_NOT_VALID';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS newer
        WHERE newer.user_id = p_user_id
          AND newer.status = 'ready'
          AND newer.expires_at > pg_catalog.clock_timestamp()
          AND newer.exclusion_decision IN ('skip', 'exclude')
          AND (
              newer.created_at > v_preflight.created_at
              OR (
                  newer.created_at = v_preflight.created_at
                  AND newer.id::TEXT > v_preflight.id::TEXT
              )
          )
    ) THEN
        RAISE EXCEPTION 'PREFLIGHT_NOT_LATEST';
    END IF;

    IF v_preflight.pricing_version <> p_pricing_version
       OR v_preflight.pricing_snapshot->p_plan_id->>'status' <> 'quoted'
       OR v_preflight.pricing_snapshot->p_plan_id->>'currency' <> 'KRW'
       OR v_preflight.pricing_snapshot->p_plan_id->>'amountKrw' !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'EARLYBIRD_PRICE_SNAPSHOT_INVALID';
    END IF;
    v_snapshot_amount := v_preflight.pricing_snapshot->p_plan_id->>'amountKrw';
    IF v_snapshot_amount::INTEGER <> p_expected_amount_krw THEN
        RAISE EXCEPTION 'EARLYBIRD_PRICE_SNAPSHOT_INVALID';
    END IF;
    v_required_rank := CASE v_preflight.required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE 99 END;
    v_selected_rank := CASE p_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 99 END;
    IF v_selected_rank < v_required_rank THEN
        RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED';
    END IF;
    IF v_required_rank = 3 THEN
        RAISE EXCEPTION 'EARLYBIRD_WAITLIST_REQUIRED';
    END IF;
    IF v_preflight.plan_cards_snapshot->p_plan_id->>'selectionState' IS NULL
       OR v_preflight.plan_cards_snapshot->p_plan_id->>'selectionState' = 'unavailable' THEN
        RAISE EXCEPTION 'PLAN_SELECTION_UNAVAILABLE';
    END IF;

    SELECT existing_order.*
    INTO v_existing
    FROM public.earlybird_orders AS existing_order
    WHERE existing_order.preflight_id = p_preflight_id;
    IF FOUND THEN
        IF v_existing.user_id <> p_user_id
           OR v_existing.plan_id <> p_plan_id
           OR v_existing.expected_amount_krw <> p_expected_amount_krw
           OR v_existing.expected_groble_product_id <> p_expected_product_id THEN
            RAISE EXCEPTION 'EARLYBIRD_ORDER_CONFLICT';
        END IF;
        RETURN QUERY SELECT v_existing.id, FALSE;
        RETURN;
    END IF;

    SELECT pending_order.*
    INTO v_existing
    FROM public.earlybird_orders AS pending_order
    WHERE pending_order.user_id = p_user_id
      AND pending_order.status = 'payment_pending'
    FOR UPDATE;
    IF FOUND THEN
        UPDATE public.earlybird_orders AS superseded_order
        SET preflight_id = p_preflight_id,
            target_instagram_id = v_preflight.target_instagram_id,
            target_followers_count = v_preflight.target_followers_count,
            target_following_count = v_preflight.target_following_count,
            exclusion_decision = v_preflight.exclusion_decision,
            excluded_instagram_id = v_preflight.excluded_instagram_id,
            plan_id = p_plan_id,
            pricing_version = p_pricing_version,
            expected_amount_krw = p_expected_amount_krw,
            expected_groble_product_id = p_expected_product_id,
            disclosure_version = p_disclosure_version,
            disclosure_text = p_disclosure_text,
            disclosure_accepted_at = p_disclosure_accepted_at,
            updated_at = pg_catalog.clock_timestamp()
        WHERE superseded_order.id = v_existing.id
        RETURNING superseded_order.id INTO v_order_id;

        RETURN QUERY SELECT v_order_id, FALSE;
        RETURN;
    END IF;

    INSERT INTO public.earlybird_orders (
        user_id,
        preflight_id,
        target_instagram_id,
        target_followers_count,
        target_following_count,
        exclusion_decision,
        excluded_instagram_id,
        plan_id,
        pricing_version,
        expected_amount_krw,
        expected_groble_product_id,
        disclosure_version,
        disclosure_text,
        disclosure_accepted_at
    ) VALUES (
        p_user_id,
        p_preflight_id,
        v_preflight.target_instagram_id,
        v_preflight.target_followers_count,
        v_preflight.target_following_count,
        v_preflight.exclusion_decision,
        v_preflight.excluded_instagram_id,
        p_plan_id,
        p_pricing_version,
        p_expected_amount_krw,
        p_expected_product_id,
        p_disclosure_version,
        p_disclosure_text,
        p_disclosure_accepted_at
    )
    RETURNING id INTO v_order_id;

    RETURN QUERY SELECT v_order_id, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_earlybird_waitlist(
    p_user_id UUID,
    p_preflight_id UUID
)
RETURNS TABLE(waitlist_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_waitlist%ROWTYPE;
    v_waitlist_id UUID;
BEGIN
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_preflight.status <> 'ready'
       OR v_preflight.expires_at <= pg_catalog.clock_timestamp()
       OR v_preflight.exclusion_decision NOT IN ('skip', 'exclude')
       OR v_preflight.required_plan_id <> 'plus'
       OR v_preflight.plan_cards_snapshot->'plus'->>'selectionState' = 'unavailable' THEN
        RAISE EXCEPTION 'EARLYBIRD_WAITLIST_NOT_ELIGIBLE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS newer
        WHERE newer.user_id = p_user_id
          AND newer.status = 'ready'
          AND newer.expires_at > pg_catalog.clock_timestamp()
          AND newer.exclusion_decision IN ('skip', 'exclude')
          AND (
              newer.created_at > v_preflight.created_at
              OR (
                  newer.created_at = v_preflight.created_at
                  AND newer.id::TEXT > v_preflight.id::TEXT
              )
          )
    ) THEN
        RAISE EXCEPTION 'PREFLIGHT_NOT_LATEST';
    END IF;

    SELECT waitlist.*
    INTO v_existing
    FROM public.earlybird_waitlist AS waitlist
    WHERE waitlist.preflight_id = p_preflight_id;
    IF FOUND THEN
        RETURN QUERY SELECT v_existing.id, FALSE;
        RETURN;
    END IF;

    INSERT INTO public.earlybird_waitlist (
        user_id,
        preflight_id,
        target_instagram_id,
        target_followers_count,
        target_following_count,
        exclusion_decision,
        excluded_instagram_id
    ) VALUES (
        p_user_id,
        p_preflight_id,
        v_preflight.target_instagram_id,
        v_preflight.target_followers_count,
        v_preflight.target_following_count,
        v_preflight.exclusion_decision,
        v_preflight.excluded_instagram_id
    )
    RETURNING id INTO v_waitlist_id;

    RETURN QUERY SELECT v_waitlist_id, TRUE;
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
DECLARE
    v_event public.earlybird_webhook_events%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_candidate_count INTEGER;
    v_sequence SMALLINT;
BEGIN
    IF p_event_type <> 'payment.completed'
       OR p_event_id IS NULL OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw <= 0
       OR p_buyer_email IS NULL OR pg_catalog.char_length(p_buyer_email) > 320
       OR p_occurred_at IS NULL OR p_paid_at IS NULL THEN
        RAISE EXCEPTION 'GROBLE_PAYMENT_EVIDENCE_INVALID';
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
            SELECT existing_order.*
            INTO v_order
            FROM public.earlybird_orders AS existing_order
            WHERE existing_order.id = v_event.order_id;
            RETURN QUERY SELECT
                'duplicate_event'::TEXT,
                v_order.id,
                v_order.status,
                v_order.plan_sequence;
        ELSE
            RETURN QUERY SELECT
                'duplicate_event'::TEXT,
                NULL::UUID,
                NULL::TEXT,
                NULL::SMALLINT;
        END IF;
        RETURN;
    END IF;

    SELECT existing_order.*
    INTO v_order
    FROM public.earlybird_orders AS existing_order
    WHERE existing_order.payment_id = p_payment_id;
    IF FOUND THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'duplicate_payment', v_order.id
        );
        RETURN QUERY SELECT
            'duplicate_payment'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_candidate_count
    FROM public.earlybird_orders AS candidate
    JOIN public.users AS buyer ON buyer.id = candidate.user_id
    WHERE candidate.status = 'payment_pending'
      AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
          = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));

    IF v_candidate_count <> 1 THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            CASE WHEN v_candidate_count = 0 THEN 'unmatched' ELSE 'ambiguous_buyer' END
        );
        RETURN QUERY SELECT
            CASE WHEN v_candidate_count = 0 THEN 'unmatched' ELSE 'ambiguous_buyer' END,
            NULL::UUID,
            NULL::TEXT,
            NULL::SMALLINT;
        RETURN;
    END IF;

    SELECT candidate.*
    INTO v_order
    FROM public.earlybird_orders AS candidate
    JOIN public.users AS buyer ON buyer.id = candidate.user_id
    WHERE candidate.status = 'payment_pending'
      AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
          = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
    FOR UPDATE OF candidate;

    IF v_order.expected_groble_product_id <> p_product_id
       OR v_order.expected_amount_krw <> p_amount_krw THEN
        UPDATE public.earlybird_orders AS mismatch_order
        SET status = 'payment_failed',
            payment_id = p_payment_id,
            actual_groble_product_id = p_product_id,
            actual_amount_krw = p_amount_krw,
            paid_at = p_paid_at,
            updated_at = pg_catalog.clock_timestamp()
        WHERE mismatch_order.id = v_order.id
        RETURNING mismatch_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'mismatch', v_order.id
        );
        RETURN QUERY SELECT 'mismatch'::TEXT, v_order.id, v_order.status, NULL::SMALLINT;
        RETURN;
    END IF;

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
        due_at = p_paid_at + INTERVAL '48 hours',
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
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_cancel_request(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_requested_at TIMESTAMP WITH TIME ZONE
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
    IF p_event_type <> 'payment.cancel_requested'
       OR p_event_id IS NULL OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw <= 0
       OR p_occurred_at IS NULL OR p_requested_at IS NULL THEN
        RAISE EXCEPTION 'GROBLE_CANCEL_EVIDENCE_INVALID';
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
            SELECT existing_order.*
            INTO v_order
            FROM public.earlybird_orders AS existing_order
            WHERE existing_order.id = v_event.order_id;
        END IF;
        RETURN QUERY SELECT
            'cancel_duplicate_event'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT paid_order.*
    INTO v_order
    FROM public.earlybird_orders AS paid_order
    WHERE paid_order.payment_id = p_payment_id
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'cancel_unmatched'
        );
        RETURN QUERY SELECT
            'cancel_unmatched'::TEXT,
            NULL::UUID,
            NULL::TEXT,
            NULL::SMALLINT;
        RETURN;
    END IF;

    IF v_order.actual_groble_product_id <> p_product_id
       OR v_order.actual_amount_krw <> p_amount_krw THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'cancel_mismatch', v_order.id
        );
        RETURN QUERY SELECT
            'cancel_mismatch'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    IF v_order.status IN ('paid', 'analysis_in_progress', 'completed') THEN
        UPDATE public.earlybird_orders AS cancelled_order
        SET status = 'refund_pending',
            updated_at = pg_catalog.clock_timestamp()
        WHERE cancelled_order.id = v_order.id
        RETURNING cancelled_order.* INTO v_order;
    END IF;

    INSERT INTO public.earlybird_webhook_events (
        event_id, idempotency_key, event_type, occurred_at,
        payment_id, product_id, amount_krw, disposition, order_id
    ) VALUES (
        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
        p_payment_id, p_product_id, p_amount_krw, 'cancel_requested', v_order.id
    );

    RETURN QUERY SELECT
        'cancel_requested'::TEXT,
        v_order.id,
        v_order.status,
        v_order.plan_sequence;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_earlybird_refund_status(
    p_order_id UUID,
    p_next_status TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
BEGIN
    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EARLYBIRD_ORDER_NOT_FOUND';
    END IF;

    IF p_next_status = 'cancelled' AND v_order.status = 'payment_pending' THEN
        NULL;
    ELSIF p_next_status = 'refund_pending'
       AND v_order.status IN (
           'paid', 'analysis_in_progress', 'completed',
           'payment_failed', 'overflow_refund_required'
       ) THEN
        NULL;
    ELSIF p_next_status = 'refunded'
       AND v_order.status IN (
           'refund_pending', 'payment_failed', 'overflow_refund_required'
       ) THEN
        NULL;
    ELSE
        RAISE EXCEPTION 'EARLYBIRD_REFUND_TRANSITION_INVALID';
    END IF;

    UPDATE public.earlybird_orders AS transitioned_order
    SET status = p_next_status,
        updated_at = pg_catalog.clock_timestamp()
    WHERE transitioned_order.id = p_order_id;

    RETURN p_next_status;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.join_earlybird_waitlist(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_cancel_request(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_earlybird_refund_status(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_earlybird_waitlist(UUID, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_cancel_request(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_earlybird_refund_status(UUID, TEXT)
    TO service_role;
