-- Phase 2/5: require a fresh Kakao REST verification for every checkout snapshot.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
