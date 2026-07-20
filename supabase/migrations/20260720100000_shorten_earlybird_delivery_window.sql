-- 얼리버드 판독 결과 제공 기한을 48시간에서 24시간으로 단축한다(사용자 확정).
--
-- 1) 기존 CHECK 제약을 먼저 DROP 한다. 48시간 제약이 걸린 채로 due_at 을
--    paid_at + 24시간으로 UPDATE 하면 그 자체가 (아직 살아있는) 48시간 제약을
--    위반해 UPDATE 문이 즉시 실패한다 — 실제로 첫 배포 시도에서 이 순서 버그로
--    프로덕션 push 가 실패했다(문장 단위 원자성 덕분에 부분 반영 없이 롤백됨).
-- 2) 이미 결제 완료되어 48시간 기준으로 due_at 이 저장된 기존 주문(예: 수동 정산된
--    64115d4d-ae82-48ed-9a0d-0480c100a6c2)도 24시간 기준으로 재계산한다(사용자 확정 —
--    과거 주문을 원래 48시간 약속대로 유지하지 않고 전부 24시간으로 앞당긴다).
-- 3) 24시간 기준 CHECK 제약을 다시 추가한다. 위 백필이 먼저 끝났으므로 이 시점에는
--    모든 행이 이미 새 규칙을 만족해 ADD CONSTRAINT 가 안전하게 통과한다.
-- 4) create_earlybird_checkout / finalize_earlybird_groble_payment 는 시그니처를
--    바꾸지 않으므로 CREATE OR REPLACE 가 기존 REVOKE ALL / GRANT EXECUTE TO
--    service_role ACL 을 그대로 유지한다(finalize 는 20260719180000 과 동일한 패턴).
--    disclosure 버전 식별자도 이름 자체를 earlybird-24h-v1 로 바꾼다(사용자 확정 —
--    "48h" 라는 이름이 실제 24시간 동작과 불일치하지 않도록).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.earlybird_orders
    DROP CONSTRAINT earlybird_orders_due_check;

UPDATE public.earlybird_orders
SET due_at = paid_at + INTERVAL '24 hours'
WHERE due_at IS NOT NULL;

ALTER TABLE public.earlybird_orders
    ADD CONSTRAINT earlybird_orders_due_check CHECK (
        due_at IS NULL OR (paid_at IS NOT NULL AND due_at = paid_at + INTERVAL '24 hours')
    );

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
    v_user_phone_number TEXT;
    v_user_phone_number_normalized TEXT;
    v_user_phone_number_verification_source TEXT;
    v_user_phone_number_verified_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION 'EARLYBIRD_PAID_PLAN_REQUIRED';
    END IF;
    IF p_pricing_version <> 'earlybird-2026-07-v1'
       OR p_disclosure_version <> 'earlybird-24h-v1'
       OR p_disclosure_text <> '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.'
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

    -- Product precedes user everywhere an order can be inserted. The INSERT
    -- trigger re-enters this transaction-scoped lock before snapshotting.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || p_expected_product_id,
            0
        )
    );

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_user_id::TEXT, 0)
    );

    SELECT buyer.provider, buyer.phone_number, buyer.phone_number_normalized,
        buyer.phone_number_verification_source,
        buyer.phone_number_verified_at
    INTO v_user_provider, v_user_phone_number, v_user_phone_number_normalized,
        v_user_phone_number_verification_source,
        v_user_phone_number_verified_at
    FROM public.users AS buyer
    WHERE buyer.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PREFLIGHT_NOT_VALID';
    END IF;

    IF v_user_provider <> 'kakao'
       OR v_user_phone_number_verification_source
            IS DISTINCT FROM 'kakao_rest_api'
       OR v_user_phone_number_verified_at IS NULL
       OR v_user_phone_number_verified_at
            < pg_catalog.clock_timestamp() - INTERVAL '24 hours'
       OR v_user_phone_number_normalized IS NULL
       OR public.normalize_kr_mobile_e164(v_user_phone_number)
            IS DISTINCT FROM v_user_phone_number_normalized THEN
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
           OR v_existing.buyer_match_policy <> 'verified_kakao_phone'
           OR v_existing.expected_buyer_phone_number_normalized
                IS DISTINCT FROM v_user_phone_number_normalized
           OR v_existing.expected_buyer_phone_verification_source
                IS DISTINCT FROM v_user_phone_number_verification_source
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
        buyer_match_policy,
        expected_buyer_phone_number_normalized,
        expected_buyer_phone_verification_source,
        expected_buyer_phone_verified_at,
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
        'verified_kakao_phone',
        v_user_phone_number_normalized,
        v_user_phone_number_verification_source,
        v_user_phone_number_verified_at,
        p_disclosure_version,
        p_disclosure_text,
        p_disclosure_accepted_at
    )
    RETURNING id INTO v_order_id;

    RETURN QUERY SELECT v_order_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;

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

    -- 0 <= 실결제액 <= 정가 는 전부 정상 결제로 인정한다(할인 쿠폰 포함).
    -- 정가를 초과하는 금액만 여전히 mismatch 로 남긴다.
    IF v_order.expected_groble_product_id <> p_product_id
       OR p_amount_krw > v_order.expected_amount_krw THEN
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
       OR p_amount_krw IS NULL OR p_amount_krw < 0
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
