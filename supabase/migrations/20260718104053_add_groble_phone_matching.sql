-- Match Groble payments against an immutable checkout phone snapshot while keeping
-- all buyer evidence behind the existing service-role database boundary.

ALTER TABLE public.users
    ADD COLUMN phone_number_normalized TEXT,
    ADD CONSTRAINT users_phone_number_normalized_check CHECK (
        phone_number_normalized IS NULL
        OR phone_number_normalized ~ '^\+8210[0-9]{8}$'
    );

CREATE OR REPLACE FUNCTION public.normalize_kr_mobile_e164(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    WITH normalized AS (
        SELECT pg_catalog.regexp_replace(p_value, '[^0-9]', '', 'g') AS digits
    )
    SELECT CASE
        WHEN digits ~ '^010[0-9]{8}$'
            THEN '+82' || pg_catalog.substr(digits, 2)
        WHEN digits ~ '^8210[0-9]{8}$'
            THEN '+' || digits
        ELSE NULL
    END
    FROM normalized
$$;

REVOKE ALL ON FUNCTION public.normalize_kr_mobile_e164(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.users
SET phone_number_normalized = public.normalize_kr_mobile_e164(phone_number)
WHERE phone_number IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.users
        WHERE phone_number_normalized IS NOT NULL
        GROUP BY phone_number_normalized
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW';
    END IF;
END;
$$;

CREATE UNIQUE INDEX users_phone_number_normalized_unique
    ON public.users(phone_number_normalized)
    WHERE phone_number_normalized IS NOT NULL;

ALTER TABLE public.earlybird_orders
    ADD COLUMN expected_buyer_phone_number_normalized TEXT,
    ADD COLUMN groble_buyer_email TEXT,
    ADD COLUMN groble_buyer_phone_number TEXT,
    ADD COLUMN groble_buyer_display_name TEXT,
    ADD CONSTRAINT earlybird_orders_expected_buyer_phone_check CHECK (
        expected_buyer_phone_number_normalized IS NULL
        OR expected_buyer_phone_number_normalized ~ '^\+8210[0-9]{8}$'
    ),
    ADD CONSTRAINT earlybird_orders_groble_buyer_email_check CHECK (
        groble_buyer_email IS NULL
        OR pg_catalog.char_length(groble_buyer_email) <= 320
    ),
    ADD CONSTRAINT earlybird_orders_groble_buyer_phone_check CHECK (
        groble_buyer_phone_number IS NULL
        OR pg_catalog.char_length(groble_buyer_phone_number) <= 64
    ),
    ADD CONSTRAINT earlybird_orders_groble_buyer_display_name_check CHECK (
        groble_buyer_display_name IS NULL
        OR pg_catalog.char_length(groble_buyer_display_name) <= 100
    );

ALTER TABLE public.earlybird_webhook_events
    ADD COLUMN groble_buyer_email TEXT,
    ADD COLUMN groble_buyer_phone_number TEXT,
    ADD COLUMN groble_buyer_display_name TEXT,
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_email_check CHECK (
        groble_buyer_email IS NULL
        OR pg_catalog.char_length(groble_buyer_email) <= 320
    ),
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_phone_check CHECK (
        groble_buyer_phone_number IS NULL
        OR pg_catalog.char_length(groble_buyer_phone_number) <= 64
    ),
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_display_name_check CHECK (
        groble_buyer_display_name IS NULL
        OR pg_catalog.char_length(groble_buyer_display_name) <= 100
    );

UPDATE public.earlybird_orders AS pending_order
SET expected_buyer_phone_number_normalized = buyer.phone_number_normalized
FROM public.users AS buyer
WHERE pending_order.user_id = buyer.id
  AND pending_order.status = 'payment_pending'
  AND pending_order.expected_buyer_phone_number_normalized IS NULL
  AND buyer.phone_number_normalized IS NOT NULL;

CREATE INDEX earlybird_orders_pending_phone_product_idx
    ON public.earlybird_orders(
        expected_buyer_phone_number_normalized, expected_groble_product_id
    )
    WHERE status = 'payment_pending'
      AND expected_buyer_phone_number_normalized IS NOT NULL;

-- Restate the browser boundary explicitly: none of the new snapshot or buyer evidence
-- columns are part of the authenticated projection.
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
    v_user_provider TEXT;
    v_user_phone_number_normalized TEXT;
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

    SELECT buyer.provider, buyer.phone_number_normalized
    INTO v_user_provider, v_user_phone_number_normalized
    FROM public.users AS buyer
    WHERE buyer.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PREFLIGHT_NOT_VALID';
    END IF;
    IF v_user_provider = 'kakao' AND v_user_phone_number_normalized IS NULL THEN
        RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED';
    END IF;

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
           OR v_existing.expected_groble_product_id <> p_expected_product_id
           OR v_existing.expected_buyer_phone_number_normalized
                IS DISTINCT FROM v_user_phone_number_normalized
           OR v_existing.status <> 'payment_pending' THEN
            RAISE EXCEPTION 'EARLYBIRD_ORDER_CONFLICT';
        END IF;
        RETURN QUERY SELECT v_existing.id, FALSE;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS unresolved_order
        WHERE unresolved_order.user_id = p_user_id
          AND unresolved_order.expected_groble_product_id = p_expected_product_id
          AND unresolved_order.status = 'cancelled'
          AND unresolved_order.payment_id IS NULL
    ) THEN
        RAISE EXCEPTION 'EARLYBIRD_CHECKOUT_ALREADY_PENDING';
    END IF;

    SELECT pending_order.*
    INTO v_existing
    FROM public.earlybird_orders AS pending_order
    WHERE pending_order.user_id = p_user_id
      AND pending_order.status = 'payment_pending'
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.expected_groble_product_id = p_expected_product_id THEN
            RAISE EXCEPTION 'EARLYBIRD_CHECKOUT_ALREADY_PENDING';
        END IF;
        UPDATE public.earlybird_orders AS superseded_order
        SET status = 'cancelled',
            updated_at = pg_catalog.clock_timestamp()
        WHERE superseded_order.id = v_existing.id;
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
        expected_buyer_phone_number_normalized,
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
        v_user_phone_number_normalized,
        p_disclosure_version,
        p_disclosure_text,
        p_disclosure_accepted_at
    )
    RETURNING id INTO v_order_id;

    RETURN QUERY SELECT v_order_id, TRUE;
END;
$$;

DROP FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
);

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
DECLARE
    v_event public.earlybird_webhook_events%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_candidate_count INTEGER := 0;
    v_candidate_order_id UUID;
    v_sequence SMALLINT;
    v_user_id UUID;
    v_revalidated_user_id UUID;
    v_email_user_count INTEGER;
    v_match_method TEXT;
BEGIN
    IF p_event_type <> 'payment.completed'
       OR p_event_id IS NULL
          OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
          OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw <= 0
       OR p_buyer_email IS NULL OR pg_catalog.char_length(p_buyer_email) > 320
       OR (
           p_buyer_phone_normalized IS NOT NULL
           AND p_buyer_phone_normalized !~ '^\+8210[0-9]{8}$'
       )
       OR (
           p_buyer_phone_raw IS NOT NULL
           AND pg_catalog.char_length(p_buyer_phone_raw) NOT BETWEEN 1 AND 64
       )
       OR (
           p_buyer_display_name IS NOT NULL
           AND pg_catalog.char_length(p_buyer_display_name) NOT BETWEEN 1 AND 100
       )
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
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_order.user_id::TEXT, 0)
        );
        SELECT existing_order.*
        INTO v_order
        FROM public.earlybird_orders AS existing_order
        WHERE existing_order.id = v_order.id
        FOR UPDATE;

        UPDATE public.earlybird_orders AS duplicate_order
        SET groble_buyer_email = p_buyer_email,
            groble_buyer_phone_number = p_buyer_phone_raw,
            groble_buyer_display_name = p_buyer_display_name,
            updated_at = pg_catalog.clock_timestamp()
        WHERE duplicate_order.id = v_order.id
        RETURNING duplicate_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'duplicate_payment', v_order.id,
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
        );
        RETURN QUERY SELECT
            'duplicate_payment'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    IF p_buyer_phone_normalized IS NOT NULL THEN
        SELECT pg_catalog.count(*)::INTEGER
        INTO v_candidate_count
        FROM public.earlybird_orders AS candidate
        WHERE candidate.status = 'payment_pending'
          AND candidate.expected_groble_product_id = p_product_id
          AND candidate.expected_buyer_phone_number_normalized
                = p_buyer_phone_normalized;

        IF v_candidate_count > 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition,
                groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                NULL::UUID,
                NULL::TEXT,
                NULL::SMALLINT;
            RETURN;
        ELSIF v_candidate_count = 1 THEN
            SELECT candidate.id, candidate.user_id
            INTO v_candidate_order_id, v_user_id
            FROM public.earlybird_orders AS candidate
            WHERE candidate.status = 'payment_pending'
              AND candidate.expected_groble_product_id = p_product_id
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized;
            v_match_method := 'phone';
        END IF;
    END IF;

    IF p_buyer_phone_normalized IS NULL OR v_candidate_count = 0 THEN
        v_match_method := 'email';
        v_candidate_order_id := NULL;
        v_user_id := NULL;

        SELECT pg_catalog.count(*)::INTEGER
        INTO v_candidate_count
        FROM public.earlybird_orders AS candidate
        JOIN public.users AS buyer ON buyer.id = candidate.user_id
        WHERE candidate.status = 'payment_pending'
          AND candidate.expected_groble_product_id = p_product_id
          AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));

        IF v_candidate_count > 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition,
                groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                NULL::UUID,
                NULL::TEXT,
                NULL::SMALLINT;
            RETURN;
        ELSIF v_candidate_count = 1 THEN
            SELECT candidate.id, candidate.user_id
            INTO v_candidate_order_id, v_user_id
            FROM public.earlybird_orders AS candidate
            JOIN public.users AS buyer ON buyer.id = candidate.user_id
            WHERE candidate.status = 'payment_pending'
              AND candidate.expected_groble_product_id = p_product_id
              AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                    = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));
        ELSE
            SELECT pg_catalog.count(*)::INTEGER
            INTO v_email_user_count
            FROM public.users AS buyer
            WHERE pg_catalog.lower(pg_catalog.btrim(buyer.email))
                = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));
            IF v_email_user_count = 1 THEN
                SELECT buyer.id
                INTO v_user_id
                FROM public.users AS buyer
                WHERE pg_catalog.lower(pg_catalog.btrim(buyer.email))
                    = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));
            END IF;
        END IF;
    END IF;

    IF v_user_id IS NOT NULL THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_user_id::TEXT, 0)
        );
    END IF;

    IF v_candidate_count = 1 THEN
        IF v_match_method = 'phone' THEN
            SELECT pg_catalog.count(*)::INTEGER
            INTO v_candidate_count
            FROM public.earlybird_orders AS candidate
            WHERE candidate.status = 'payment_pending'
              AND candidate.expected_groble_product_id = p_product_id
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized;
        ELSE
            SELECT pg_catalog.count(*)::INTEGER
            INTO v_candidate_count
            FROM public.earlybird_orders AS candidate
            JOIN public.users AS buyer ON buyer.id = candidate.user_id
            WHERE candidate.status = 'payment_pending'
              AND candidate.expected_groble_product_id = p_product_id
              AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                    = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));
        END IF;

        IF v_candidate_count > 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition,
                groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                NULL::UUID,
                NULL::TEXT,
                NULL::SMALLINT;
            RETURN;
        ELSIF v_candidate_count = 1 THEN
            IF v_match_method = 'phone' THEN
                SELECT candidate.id, candidate.user_id
                INTO v_candidate_order_id, v_revalidated_user_id
                FROM public.earlybird_orders AS candidate
                WHERE candidate.status = 'payment_pending'
                  AND candidate.expected_groble_product_id = p_product_id
                  AND candidate.expected_buyer_phone_number_normalized
                        = p_buyer_phone_normalized;
            ELSE
                SELECT candidate.id, candidate.user_id
                INTO v_candidate_order_id, v_revalidated_user_id
                FROM public.earlybird_orders AS candidate
                JOIN public.users AS buyer ON buyer.id = candidate.user_id
                WHERE candidate.status = 'payment_pending'
                  AND candidate.expected_groble_product_id = p_product_id
                  AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                        = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));
            END IF;
            IF v_revalidated_user_id <> v_user_id THEN
                v_candidate_count := 0;
                v_candidate_order_id := NULL;
            END IF;
        END IF;
    END IF;

    IF v_candidate_count = 0 THEN
        IF v_user_id IS NOT NULL THEN
            SELECT cancelled_order.*
            INTO v_order
            FROM public.earlybird_orders AS cancelled_order
            WHERE cancelled_order.user_id = v_user_id
              AND cancelled_order.status = 'cancelled'
              AND cancelled_order.payment_id IS NULL
              AND cancelled_order.expected_groble_product_id = p_product_id
              AND cancelled_order.expected_amount_krw = p_amount_krw
            ORDER BY cancelled_order.updated_at DESC
            LIMIT 1
            FOR UPDATE;
            IF FOUND THEN
                UPDATE public.earlybird_orders AS late_order
                SET status = 'refund_pending',
                    payment_id = p_payment_id,
                    actual_groble_product_id = p_product_id,
                    actual_amount_krw = p_amount_krw,
                    paid_at = p_paid_at,
                    groble_buyer_email = p_buyer_email,
                    groble_buyer_phone_number = p_buyer_phone_raw,
                    groble_buyer_display_name = p_buyer_display_name,
                    updated_at = pg_catalog.clock_timestamp()
                WHERE late_order.id = v_order.id
                RETURNING late_order.* INTO v_order;

                INSERT INTO public.earlybird_webhook_events (
                    event_id, idempotency_key, event_type, occurred_at,
                    payment_id, product_id, amount_krw, disposition, order_id,
                    groble_buyer_email, groble_buyer_phone_number,
                    groble_buyer_display_name
                ) VALUES (
                    p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                    p_payment_id, p_product_id, p_amount_krw,
                    'late_cancelled_payment', v_order.id,
                    p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
                );
                RETURN QUERY SELECT
                    'late_cancelled_payment'::TEXT,
                    v_order.id,
                    v_order.status,
                    NULL::SMALLINT;
                RETURN;
            END IF;
        END IF;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'unmatched',
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
        );
        RETURN QUERY SELECT
            'unmatched'::TEXT,
            NULL::UUID,
            NULL::TEXT,
            NULL::SMALLINT;
        RETURN;
    END IF;

    SELECT candidate.*
    INTO v_order
    FROM public.earlybird_orders AS candidate
    WHERE candidate.id = v_candidate_order_id
      AND candidate.user_id = v_user_id
      AND candidate.status = 'payment_pending'
      AND candidate.expected_groble_product_id = p_product_id
      AND (
          (
              v_match_method = 'phone'
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized
          )
          OR (
              v_match_method = 'email'
              AND EXISTS (
                  SELECT 1
                  FROM public.users AS buyer
                  WHERE buyer.id = candidate.user_id
                    AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                        = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
              )
          )
      )
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'unmatched',
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
        );
        RETURN QUERY SELECT
            'unmatched'::TEXT,
            NULL::UUID,
            NULL::TEXT,
            NULL::SMALLINT;
        RETURN;
    END IF;

    IF v_order.expected_groble_product_id <> p_product_id
       OR v_order.expected_amount_krw <> p_amount_krw THEN
        UPDATE public.earlybird_orders AS mismatch_order
        SET status = 'payment_failed',
            payment_id = p_payment_id,
            actual_groble_product_id = p_product_id,
            actual_amount_krw = p_amount_krw,
            paid_at = p_paid_at,
            groble_buyer_email = p_buyer_email,
            groble_buyer_phone_number = p_buyer_phone_raw,
            groble_buyer_display_name = p_buyer_display_name,
            updated_at = pg_catalog.clock_timestamp()
        WHERE mismatch_order.id = v_order.id
        RETURNING mismatch_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'mismatch', v_order.id,
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
        );
        RETURN QUERY SELECT 'mismatch'::TEXT, v_order.id, v_order.status, NULL::SMALLINT;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.earlybird_webhook_events AS prior_cancellation
        WHERE prior_cancellation.payment_id = p_payment_id
          AND prior_cancellation.event_type = 'payment.cancel_requested'
    ) THEN
        UPDATE public.earlybird_orders AS cancelled_before_confirmation
        SET status = 'refund_pending',
            payment_id = p_payment_id,
            actual_groble_product_id = p_product_id,
            actual_amount_krw = p_amount_krw,
            paid_at = p_paid_at,
            groble_buyer_email = p_buyer_email,
            groble_buyer_phone_number = p_buyer_phone_raw,
            groble_buyer_display_name = p_buyer_display_name,
            updated_at = pg_catalog.clock_timestamp()
        WHERE cancelled_before_confirmation.id = v_order.id
        RETURNING cancelled_before_confirmation.* INTO v_order;

        UPDATE public.earlybird_webhook_events AS prior_cancellation
        SET disposition = 'cancel_requested',
            order_id = v_order.id
        WHERE prior_cancellation.payment_id = p_payment_id
          AND prior_cancellation.event_type = 'payment.cancel_requested';

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            'cancel_before_payment', v_order.id,
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
        );
        RETURN QUERY SELECT
            'cancel_before_payment'::TEXT,
            v_order.id,
            v_order.status,
            NULL::SMALLINT;
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
            groble_buyer_email = p_buyer_email,
            groble_buyer_phone_number = p_buyer_phone_raw,
            groble_buyer_display_name = p_buyer_display_name,
            updated_at = pg_catalog.clock_timestamp()
        WHERE overflow_order.id = v_order.id
        RETURNING overflow_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition, order_id,
            groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            'overflow_refund_required', v_order.id,
            p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
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
        groble_buyer_email = p_buyer_email,
        groble_buyer_phone_number = p_buyer_phone_raw,
        groble_buyer_display_name = p_buyer_display_name,
        updated_at = pg_catalog.clock_timestamp()
    WHERE accepted_order.id = v_order.id
    RETURNING accepted_order.* INTO v_order;

    INSERT INTO public.earlybird_webhook_events (
        event_id, idempotency_key, event_type, occurred_at,
        payment_id, product_id, amount_krw, disposition, order_id,
        groble_buyer_email, groble_buyer_phone_number, groble_buyer_display_name
    ) VALUES (
        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
        p_payment_id, p_product_id, p_amount_krw, 'accepted', v_order.id,
        p_buyer_email, p_buyer_phone_raw, p_buyer_display_name
    );

    RETURN QUERY SELECT 'accepted'::TEXT, v_order.id, v_order.status, v_order.plan_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
