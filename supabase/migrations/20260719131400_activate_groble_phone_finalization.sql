-- Phase 5/5: activate Groble phone finalization after schema, checkout, data, and indexes.
-- This file is intentionally isolated so a failed RPC replacement rolls back alone.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
    v_lock_user_id UUID;
    v_email_user_count INTEGER;
    v_match_method TEXT;
BEGIN
    IF p_event_type IS DISTINCT FROM 'payment.completed'
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

    -- Lock every user that could gain or already own a matching snapshot. The order
    -- is stable across competing payments, preventing multi-user advisory deadlocks.
    FOR v_lock_user_id IN
        SELECT potential_user.user_id
        FROM (
            SELECT phone_order.user_id
            FROM public.earlybird_orders AS phone_order
            WHERE p_buyer_phone_normalized IS NOT NULL
              AND phone_order.status IN ('payment_pending', 'cancelled')
              AND phone_order.payment_id IS NULL
              AND phone_order.buyer_match_policy = 'verified_kakao_phone'
              AND phone_order.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND phone_order.expected_buyer_phone_verified_at IS NOT NULL
              AND phone_order.expected_groble_product_id = p_product_id
              AND phone_order.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized

            UNION

            SELECT buyer.id AS user_id
            FROM public.users AS buyer
            WHERE pg_catalog.lower(pg_catalog.btrim(buyer.email))
                = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
        ) AS potential_user
        ORDER BY potential_user.user_id::TEXT
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_lock_user_id::TEXT, 0)
        );
    END LOOP;

    -- Counts below are authoritative because checkout and payment finalization use
    -- the same per-user advisory locks acquired above.
    IF p_buyer_phone_normalized IS NOT NULL THEN
        SELECT pg_catalog.count(*)::INTEGER
        INTO v_candidate_count
        FROM public.earlybird_orders AS candidate
        WHERE candidate.status = 'payment_pending'
          AND candidate.buyer_match_policy = 'verified_kakao_phone'
          AND candidate.expected_buyer_phone_verification_source
                = 'kakao_rest_api'
          AND candidate.expected_buyer_phone_verified_at IS NOT NULL
          AND candidate.expected_groble_product_id = p_product_id
          AND candidate.expected_buyer_phone_number_normalized
                = p_buyer_phone_normalized;

        IF v_candidate_count > 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer'
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
              AND candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND candidate.expected_groble_product_id = p_product_id
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized;
            v_match_method := 'phone';
        ELSE
            SELECT pg_catalog.count(*)::INTEGER
            INTO v_candidate_count
            FROM public.earlybird_orders AS cancelled_candidate
            WHERE cancelled_candidate.status = 'cancelled'
              AND cancelled_candidate.payment_id IS NULL
              AND cancelled_candidate.buyer_match_policy = 'verified_kakao_phone'
              AND cancelled_candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND cancelled_candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND cancelled_candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized
              AND cancelled_candidate.expected_groble_product_id = p_product_id
              AND cancelled_candidate.expected_amount_krw = p_amount_krw;

            IF v_candidate_count > 1 THEN
                INSERT INTO public.earlybird_webhook_events (
                    event_id, idempotency_key, event_type, occurred_at,
                    payment_id, product_id, amount_krw, disposition
                ) VALUES (
                    p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                    p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer'
                );
                RETURN QUERY SELECT
                    'ambiguous_buyer'::TEXT,
                    NULL::UUID,
                    NULL::TEXT,
                    NULL::SMALLINT;
                RETURN;
            ELSIF v_candidate_count = 1 THEN
                SELECT cancelled_candidate.*
                INTO v_order
                FROM public.earlybird_orders AS cancelled_candidate
                WHERE cancelled_candidate.status = 'cancelled'
                  AND cancelled_candidate.payment_id IS NULL
                  AND cancelled_candidate.buyer_match_policy = 'verified_kakao_phone'
                  AND cancelled_candidate.expected_buyer_phone_verification_source
                        = 'kakao_rest_api'
                  AND cancelled_candidate.expected_buyer_phone_verified_at IS NOT NULL
                  AND cancelled_candidate.expected_buyer_phone_number_normalized
                        = p_buyer_phone_normalized
                  AND cancelled_candidate.expected_groble_product_id = p_product_id
                  AND cancelled_candidate.expected_amount_krw = p_amount_krw
                FOR UPDATE;

                IF NOT FOUND THEN
                    INSERT INTO public.earlybird_webhook_events (
                        event_id, idempotency_key, event_type, occurred_at,
                        payment_id, product_id, amount_krw, disposition
                    ) VALUES (
                        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                        p_payment_id, p_product_id, p_amount_krw, 'unmatched'
                    );
                    RETURN QUERY SELECT
                        'unmatched'::TEXT,
                        NULL::UUID,
                        NULL::TEXT,
                        NULL::SMALLINT;
                    RETURN;
                END IF;

                UPDATE public.earlybird_orders AS late_order
                SET status = 'refund_pending',
                    payment_id = p_payment_id,
                    actual_groble_product_id = p_product_id,
                    actual_amount_krw = p_amount_krw,
                    paid_at = p_paid_at,
                    updated_at = pg_catalog.clock_timestamp()
                WHERE late_order.id = v_order.id
                RETURNING late_order.* INTO v_order;

                INSERT INTO public.earlybird_webhook_events (
                    event_id, idempotency_key, event_type, occurred_at,
                    payment_id, product_id, amount_krw, disposition, order_id
                ) VALUES (
                    p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                    p_payment_id, p_product_id, p_amount_krw,
                    'late_cancelled_payment', v_order.id
                );
                RETURN QUERY SELECT
                    'late_cancelled_payment'::TEXT,
                    v_order.id,
                    v_order.status,
                    NULL::SMALLINT;
                RETURN;
            END IF;
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
          AND candidate.buyer_match_policy = 'legacy_email'
          AND candidate.expected_groble_product_id = p_product_id
          AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                = pg_catalog.lower(pg_catalog.btrim(p_buyer_email));

        IF v_candidate_count > 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer'
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
              AND candidate.buyer_match_policy = 'legacy_email'
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

    IF v_candidate_count = 0 THEN
        IF v_user_id IS NOT NULL THEN
            SELECT pg_catalog.count(*)::INTEGER
            INTO v_candidate_count
            FROM public.earlybird_orders AS cancelled_order
            WHERE cancelled_order.user_id = v_user_id
              AND cancelled_order.status = 'cancelled'
              AND cancelled_order.payment_id IS NULL
              AND cancelled_order.buyer_match_policy = 'legacy_email'
              AND cancelled_order.expected_groble_product_id = p_product_id
              AND cancelled_order.expected_amount_krw = p_amount_krw;

            IF v_candidate_count > 1 THEN
                INSERT INTO public.earlybird_webhook_events (
                    event_id, idempotency_key, event_type, occurred_at,
                    payment_id, product_id, amount_krw, disposition
                ) VALUES (
                    p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                    p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer'
                );
                RETURN QUERY SELECT
                    'ambiguous_buyer'::TEXT,
                    NULL::UUID,
                    NULL::TEXT,
                    NULL::SMALLINT;
                RETURN;
            ELSIF v_candidate_count = 1 THEN
                SELECT cancelled_order.*
                INTO v_order
                FROM public.earlybird_orders AS cancelled_order
                WHERE cancelled_order.user_id = v_user_id
                  AND cancelled_order.status = 'cancelled'
                  AND cancelled_order.payment_id IS NULL
                  AND cancelled_order.buyer_match_policy = 'legacy_email'
                  AND cancelled_order.expected_groble_product_id = p_product_id
                  AND cancelled_order.expected_amount_krw = p_amount_krw
                FOR UPDATE;

                IF NOT FOUND THEN
                    v_candidate_count := 0;
                ELSE
                    UPDATE public.earlybird_orders AS late_order
                    SET status = 'refund_pending',
                        payment_id = p_payment_id,
                        actual_groble_product_id = p_product_id,
                        actual_amount_krw = p_amount_krw,
                        paid_at = p_paid_at,
                        updated_at = pg_catalog.clock_timestamp()
                    WHERE late_order.id = v_order.id
                    RETURNING late_order.* INTO v_order;

                    INSERT INTO public.earlybird_webhook_events (
                        event_id, idempotency_key, event_type, occurred_at,
                        payment_id, product_id, amount_krw, disposition, order_id
                    ) VALUES (
                        p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                        p_payment_id, p_product_id, p_amount_krw,
                        'late_cancelled_payment', v_order.id
                    );
                    RETURN QUERY SELECT
                        'late_cancelled_payment'::TEXT,
                        v_order.id,
                        v_order.status,
                        NULL::SMALLINT;
                    RETURN;
                END IF;
            END IF;
        END IF;

        INSERT INTO public.earlybird_webhook_events (
            event_id, idempotency_key, event_type, occurred_at,
            payment_id, product_id, amount_krw, disposition
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'unmatched'
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
              AND candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized
          )
          OR (
              v_match_method = 'email'
              AND candidate.buyer_match_policy = 'legacy_email'
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
            payment_id, product_id, amount_krw, disposition
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw, 'unmatched'
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
            payment_id, product_id, amount_krw, disposition, order_id
        ) VALUES (
            p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
            p_payment_id, p_product_id, p_amount_krw,
            'cancel_before_payment', v_order.id
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

-- Keep the legacy overload through the rolling deploy. Remove it only in a later
-- post-drain migration after every caller uses the canonical matching signature.
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
    v_lock_user_id UUID;
    v_is_known_duplicate BOOLEAN;
BEGIN
    -- Validate before deriving any advisory-lock key so invalid rolling calls keep
    -- the canonical error contract and cannot consume unbounded lock namespaces.
    IF p_event_type IS DISTINCT FROM 'payment.completed'
       OR p_event_id IS NULL
          OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
          OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw <= 0
       OR p_buyer_email IS NULL OR pg_catalog.char_length(p_buyer_email) > 320
       OR p_occurred_at IS NULL OR p_paid_at IS NULL THEN
        RAISE EXCEPTION 'GROBLE_PAYMENT_EVIDENCE_INVALID';
    END IF;

    -- Global order: payment -> namespaced product -> sorted users. The canonical
    -- call below re-enters the payment and user locks held by this transaction.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_payment_id, 0)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || p_product_id,
            0
        )
    );

    -- The product lock prevents a new verified INSERT from appearing between the
    -- owner scan and the authoritative gate. Product owners, the existing payment
    -- owner, and the email candidate share one deterministic user-lock order.
    FOR v_lock_user_id IN
        SELECT potential_user.user_id
        FROM (
            SELECT verified_order.user_id
            FROM public.earlybird_orders AS verified_order
            WHERE verified_order.buyer_match_policy = 'verified_kakao_phone'
              AND verified_order.expected_groble_product_id = p_product_id
              AND (
                  verified_order.status = 'payment_pending'
                  OR (
                      verified_order.status = 'cancelled'
                      AND verified_order.payment_id IS NULL
                  )
              )

            UNION

            SELECT payment_order.user_id
            FROM public.earlybird_orders AS payment_order
            WHERE payment_order.payment_id = p_payment_id

            UNION

            SELECT buyer.id AS user_id
            FROM public.users AS buyer
            WHERE pg_catalog.lower(pg_catalog.btrim(buyer.email))
                = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
        ) AS potential_user
        ORDER BY potential_user.user_id::TEXT
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_lock_user_id::TEXT, 0)
        );
    END LOOP;

    -- Existing attribution is immutable. Read it only after the shared lock order
    -- so a same-payment canonical caller cannot race or deadlock this wrapper.
    SELECT
        EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS existing_event
            WHERE existing_event.event_id = p_event_id
               OR existing_event.idempotency_key = p_idempotency_key
        )
        OR EXISTS (
            SELECT 1
            FROM public.earlybird_orders AS existing_order
            WHERE existing_order.payment_id = p_payment_id
        )
    INTO v_is_known_duplicate;

    IF NOT v_is_known_duplicate THEN
        IF EXISTS (
            SELECT 1
            FROM public.earlybird_orders AS candidate
            WHERE candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_groble_product_id = p_product_id
              AND (
                  candidate.status = 'payment_pending'
                  OR (
                      candidate.status = 'cancelled'
                      AND candidate.payment_id IS NULL
                  )
              )
        ) THEN
            RAISE EXCEPTION 'GROBLE_CANONICAL_PHONE_REQUIRED';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.earlybird_orders AS candidate
            JOIN public.users AS buyer ON buyer.id = candidate.user_id
            WHERE candidate.buyer_match_policy = 'legacy_email'
              AND candidate.status IN ('payment_pending', 'cancelled')
              AND candidate.payment_id IS NULL
              AND candidate.expected_groble_product_id = p_product_id
              AND (
                  candidate.status = 'payment_pending'
                  OR candidate.expected_amount_krw = p_amount_krw
              )
              AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                    = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
        ) THEN
            RAISE EXCEPTION 'GROBLE_CANONICAL_PHONE_REQUIRED';
        END IF;
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.finalize_earlybird_groble_payment(
        p_event_id => p_event_id,
        p_idempotency_key => p_idempotency_key,
        p_event_type => p_event_type,
        p_occurred_at => p_occurred_at,
        p_payment_id => p_payment_id,
        p_buyer_email => p_buyer_email,
        p_buyer_phone_normalized => NULL::TEXT,
        p_buyer_phone_raw => NULL::TEXT,
        p_buyer_display_name => NULL::TEXT,
        p_product_id => p_product_id,
        p_amount_krw => p_amount_krw,
        p_paid_at => p_paid_at
    );
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
    v_user_id UUID;
    v_order public.earlybird_orders%ROWTYPE;
BEGIN
    SELECT earlybird_order.user_id
    INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EARLYBIRD_ORDER_NOT_FOUND';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_user_id::TEXT, 0)
    );

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

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_earlybird_refund_status(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_earlybird_refund_status(UUID, TEXT)
    TO service_role;
