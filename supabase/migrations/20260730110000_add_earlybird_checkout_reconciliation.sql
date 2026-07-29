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
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.earlybird_checkout_reconciliations
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

CREATE FUNCTION public.reject_earlybird_checkout_reconciliation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_RECONCILIATION_AUDIT_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER earlybird_checkout_reconciliations_immutable
BEFORE UPDATE OR DELETE ON public.earlybird_checkout_reconciliations
FOR EACH ROW
EXECUTE FUNCTION public.reject_earlybird_checkout_reconciliation_mutation();

REVOKE ALL ON FUNCTION public.reject_earlybird_checkout_reconciliation_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the last canonical implementation behind a private boundary. The
-- replacement below handles reconciled lineages before it can see a newer
-- payment_pending order for the same buyer and product.
ALTER FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) RENAME TO finalize_earlybird_groble_payment_pre_reconciliation;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_pre_reconciliation(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finalize_earlybird_groble_payment_reconciliation_aware(
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
    v_event public.earlybird_webhook_events%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_reference_order public.earlybird_orders%ROWTYPE;
    v_result RECORD;
    v_candidate_order_id UUID;
    v_lock_user_id UUID;
    v_reconciliation_history_count INTEGER := 0;
    v_reconciled_count INTEGER := 0;
    v_live_count INTEGER := 0;
    v_reference_is_reconciled BOOLEAN := FALSE;
    v_reference_matches BOOLEAN := FALSE;
BEGIN
    IF p_event_type IS DISTINCT FROM 'payment.completed'
       OR p_event_id IS NULL
          OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
          OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
          OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL OR p_amount_krw < 0
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
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || p_product_id,
            0
        )
    );

    -- Keep every entry point on the same payment -> product -> sorted-users
    -- lock order. Include owners from both candidate lineage and immutable
    -- duplicate attribution before any duplicate path can return.
    FOR v_lock_user_id IN
        SELECT potential_user.user_id
        FROM (
            SELECT candidate.user_id
            FROM public.earlybird_orders AS candidate
            WHERE candidate.expected_groble_product_id = p_product_id
              AND (
                  candidate.status IN ('payment_pending', 'cancelled')
                  OR EXISTS (
                      SELECT 1
                      FROM public.earlybird_checkout_reconciliations AS reconciliation
                      WHERE reconciliation.order_id = candidate.id
                  )
              )

            UNION

            SELECT referenced.user_id
            FROM public.earlybird_orders AS referenced
            WHERE referenced.id = p_referenced_order_id

            UNION

            SELECT payment_order.user_id
            FROM public.earlybird_orders AS payment_order
            WHERE payment_order.payment_id = p_payment_id

            UNION

            SELECT attributed_order.user_id
            FROM public.earlybird_webhook_events AS attributed_event
            JOIN public.earlybird_orders AS attributed_order
              ON attributed_order.id = attributed_event.order_id
            WHERE attributed_event.event_id = p_event_id
               OR attributed_event.idempotency_key = p_idempotency_key
               OR (
                   attributed_event.payment_id = p_payment_id
                   AND attributed_event.event_type = 'payment.completed'
               )

            UNION

            SELECT buyer.id
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

    SELECT webhook_event.*
    INTO v_event
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.payment_id = p_payment_id
      AND webhook_event.event_type = 'payment.completed'
    ORDER BY webhook_event.processed_at
    LIMIT 1;
    IF FOUND THEN
        IF v_event.order_id IS NOT NULL THEN
            SELECT existing_order.*
            INTO v_order
            FROM public.earlybird_orders AS existing_order
            WHERE existing_order.id = v_event.order_id;
            RETURN QUERY SELECT
                'duplicate_payment'::TEXT,
                v_order.id,
                v_order.status,
                v_order.plan_sequence;
        ELSE
            RETURN QUERY SELECT
                'duplicate_payment'::TEXT,
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
        RETURN QUERY SELECT
            'duplicate_payment'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_reconciliation_history_count
    FROM public.earlybird_orders AS candidate
    JOIN public.earlybird_checkout_reconciliations AS reconciliation
      ON reconciliation.order_id = candidate.id
    WHERE candidate.expected_groble_product_id = p_product_id
      AND (
          (
              candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND (
                  (
                      p_buyer_phone_normalized IS NOT NULL
                      AND candidate.expected_buyer_phone_number_normalized
                            = p_buyer_phone_normalized
                  )
                  OR (
                      p_require_legacy_email_only IS TRUE
                      AND p_buyer_phone_normalized IS NULL
                  )
              )
          )
          OR (
              candidate.buyer_match_policy = 'legacy_email'
              AND EXISTS (
                  SELECT 1
                  FROM public.users AS buyer
                  WHERE buyer.id = candidate.user_id
                    AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                        = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
              )
          )
      );

    SELECT pg_catalog.count(*)::INTEGER, pg_catalog.min(candidate.id::TEXT)::UUID
    INTO v_reconciled_count, v_candidate_order_id
    FROM public.earlybird_orders AS candidate
    JOIN public.earlybird_checkout_reconciliations AS reconciliation
      ON reconciliation.order_id = candidate.id
    WHERE candidate.status = 'payment_failed'
      AND candidate.payment_id IS NULL
      AND candidate.actual_amount_krw IS NULL
      AND candidate.paid_at IS NULL
      AND candidate.seller_reference_confirmed_at IS NULL
      AND candidate.result_request_id IS NULL
      AND candidate.expected_groble_product_id = p_product_id
      AND (
          (
              p_buyer_phone_normalized IS NOT NULL
              AND candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized
          )
          OR (
              candidate.buyer_match_policy = 'legacy_email'
              AND EXISTS (
                  SELECT 1
                  FROM public.users AS buyer
                  WHERE buyer.id = candidate.user_id
                    AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                        = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
              )
          )
      );

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_live_count
    FROM public.earlybird_orders AS candidate
    WHERE candidate.status IN ('payment_pending', 'cancelled')
      AND candidate.payment_id IS NULL
      AND candidate.expected_groble_product_id = p_product_id
      AND (
          (
              p_buyer_phone_normalized IS NOT NULL
              AND candidate.buyer_match_policy = 'verified_kakao_phone'
              AND candidate.expected_buyer_phone_verification_source
                    = 'kakao_rest_api'
              AND candidate.expected_buyer_phone_verified_at IS NOT NULL
              AND candidate.expected_buyer_phone_number_normalized
                    = p_buyer_phone_normalized
          )
          OR (
              candidate.buyer_match_policy = 'legacy_email'
              AND EXISTS (
                  SELECT 1
                  FROM public.users AS buyer
                  WHERE buyer.id = candidate.user_id
                    AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                        = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
              )
          )
      );

    IF p_referenced_order_id IS NULL
       AND p_require_legacy_email_only IS TRUE
       AND v_reconciliation_history_count = 0 THEN
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
                  OR (
                      candidate.expected_amount_krw >= p_amount_krw
                      AND p_amount_krw >= 0
                  )
              )
              AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                    = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
        ) THEN
            RAISE EXCEPTION 'GROBLE_CANONICAL_PHONE_REQUIRED';
        END IF;
    END IF;

    IF p_referenced_order_id IS NOT NULL THEN
        SELECT referenced.*
        INTO v_reference_order
        FROM public.earlybird_orders AS referenced
        WHERE referenced.id = p_referenced_order_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNMATCHED',
                ERRCODE = 'P0001';
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM public.earlybird_checkout_reconciliations AS reconciliation
            WHERE reconciliation.order_id = p_referenced_order_id
        ) INTO v_reference_is_reconciled;

        v_reference_matches := (
            v_reference_order.expected_groble_product_id = p_product_id
            AND (
                (
                    p_buyer_phone_normalized IS NOT NULL
                    AND v_reference_order.buyer_match_policy
                        = 'verified_kakao_phone'
                    AND v_reference_order.expected_buyer_phone_verification_source
                        = 'kakao_rest_api'
                    AND v_reference_order.expected_buyer_phone_verified_at IS NOT NULL
                    AND v_reference_order.expected_buyer_phone_number_normalized
                        = p_buyer_phone_normalized
                )
                OR (
                    v_reference_order.buyer_match_policy = 'legacy_email'
                    AND EXISTS (
                        SELECT 1
                        FROM public.users AS buyer
                        WHERE buyer.id = v_reference_order.user_id
                          AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                            = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
                    )
                )
            )
        );

        IF v_reference_is_reconciled THEN
            IF v_reference_order.status = 'payment_failed'
               AND v_reference_order.payment_id IS NULL
               AND v_reference_order.actual_amount_krw IS NULL
               AND v_reference_order.paid_at IS NULL
               AND v_reference_order.seller_reference_confirmed_at IS NULL
               AND v_reference_order.result_request_id IS NULL
               AND v_reference_matches IS TRUE THEN
                UPDATE public.earlybird_orders AS reconciled_order
                SET status = 'refund_pending',
                    payment_id = p_payment_id,
                    actual_groble_product_id = p_product_id,
                    actual_amount_krw = p_amount_krw,
                    paid_at = p_paid_at,
                    updated_at = pg_catalog.clock_timestamp()
                WHERE reconciled_order.id = v_reference_order.id
                RETURNING reconciled_order.* INTO v_order;

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

            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_referenced_order_id
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                v_reference_order.id,
                v_reference_order.status,
                NULL::SMALLINT;
            RETURN;
        END IF;

        IF v_reference_matches IS NOT TRUE
           OR v_reference_order.status NOT IN ('payment_pending', 'cancelled')
           OR v_reference_order.payment_id IS NOT NULL
           OR v_live_count <> 1 THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_referenced_order_id
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                v_reference_order.id,
                v_reference_order.status,
                NULL::SMALLINT;
            RETURN;
        END IF;
    ELSE
        IF v_reconciliation_history_count > 1
           OR (
               v_reconciliation_history_count > 0
               AND v_live_count > 0
           )
           OR (
               v_reconciliation_history_count > 0
               AND v_reconciled_count <> 1
           ) THEN
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
        ELSIF v_reconciled_count = 1 THEN
            SELECT candidate.*
            INTO v_order
            FROM public.earlybird_orders AS candidate
            JOIN public.earlybird_checkout_reconciliations AS reconciliation
              ON reconciliation.order_id = candidate.id
            WHERE candidate.id = v_candidate_order_id
              AND candidate.status = 'payment_failed'
              AND candidate.payment_id IS NULL
              AND candidate.actual_amount_krw IS NULL
              AND candidate.paid_at IS NULL
              AND candidate.seller_reference_confirmed_at IS NULL
              AND candidate.result_request_id IS NULL
            FOR UPDATE OF candidate;

            IF NOT FOUND THEN
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
            END IF;

            UPDATE public.earlybird_orders AS reconciled_order
            SET status = 'refund_pending',
                payment_id = p_payment_id,
                actual_groble_product_id = p_product_id,
                actual_amount_krw = p_amount_krw,
                paid_at = p_paid_at,
                updated_at = pg_catalog.clock_timestamp()
            WHERE reconciled_order.id = v_order.id
            RETURNING reconciled_order.* INTO v_order;

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

    BEGIN
        SELECT canonical_result.*
        INTO v_result
        FROM public.finalize_earlybird_groble_payment_pre_reconciliation(
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

        IF p_referenced_order_id IS NOT NULL
           AND v_result.order_id IS NOT NULL
           AND v_result.order_id IS DISTINCT FROM p_referenced_order_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
                ERRCODE = 'ZX001';
        END IF;
    EXCEPTION
        WHEN SQLSTATE 'ZX001' THEN
            INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                p_event_id, p_idempotency_key, p_event_type, p_occurred_at,
                p_payment_id, p_product_id, p_amount_krw, 'ambiguous_buyer',
                p_referenced_order_id
            );
            RETURN QUERY SELECT
                'ambiguous_buyer'::TEXT,
                v_reference_order.id,
                v_reference_order.status,
                NULL::SMALLINT;
            RETURN;
    END;

    RETURN QUERY SELECT
        v_result.disposition::TEXT,
        v_result.order_id::UUID,
        v_result.status::TEXT,
        v_result.plan_sequence::SMALLINT;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_reconciliation_aware(
    UUID, BOOLEAN, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

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
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.finalize_earlybird_groble_payment_reconciliation_aware(
        NULL::UUID,
        FALSE,
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
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;

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

    SELECT reconciliation_result.*
    INTO v_result
    FROM public.finalize_earlybird_groble_payment_reconciliation_aware(
        v_referenced_order_id,
        FALSE,
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
    ) AS reconciliation_result;

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

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;

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
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.finalize_earlybird_groble_payment_reconciliation_aware(
        NULL::UUID,
        TRUE,
        p_event_id,
        p_idempotency_key,
        p_event_type,
        p_occurred_at,
        p_payment_id,
        p_buyer_email,
        NULL::TEXT,
        NULL::TEXT,
        NULL::TEXT,
        p_product_id,
        p_amount_krw,
        p_paid_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
