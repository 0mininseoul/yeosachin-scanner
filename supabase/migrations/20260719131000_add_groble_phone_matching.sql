-- Phase 1/5: add columns, unvalidated checks, the helper, and provenance/snapshot triggers.
-- Trigger creation is short schema work under the existing ALTER transaction; keep this lock phase short.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.users
    ADD COLUMN phone_number_normalized TEXT,
    ADD COLUMN phone_number_verification_source TEXT,
    ADD COLUMN phone_number_verified_at TIMESTAMP WITH TIME ZONE,
    ADD CONSTRAINT users_phone_number_normalized_check CHECK (
        phone_number_normalized IS NULL
        OR phone_number_normalized ~ '^\+8210[0-9]{8}$'
    ) NOT VALID,
    ADD CONSTRAINT users_phone_number_verification_source_check CHECK (
        phone_number_verification_source IS NULL
        OR phone_number_verification_source = 'kakao_rest_api'
    ) NOT VALID;

ALTER TABLE public.earlybird_orders
    ADD COLUMN expected_buyer_phone_number_normalized TEXT,
    ADD COLUMN buyer_match_policy TEXT DEFAULT 'legacy_email',
    ADD COLUMN expected_buyer_phone_verification_source TEXT,
    ADD COLUMN expected_buyer_phone_verified_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN groble_buyer_email TEXT,
    ADD COLUMN groble_buyer_phone_number TEXT,
    ADD COLUMN groble_buyer_display_name TEXT,
    ADD CONSTRAINT earlybird_orders_expected_buyer_phone_check CHECK (
        expected_buyer_phone_number_normalized IS NULL
        OR expected_buyer_phone_number_normalized ~ '^\+8210[0-9]{8}$'
    ) NOT VALID,
    ADD CONSTRAINT earlybird_orders_buyer_match_snapshot_check CHECK (
        buyer_match_policy IS NOT NULL
        AND (
            (
                buyer_match_policy = 'legacy_email'
                AND expected_buyer_phone_number_normalized IS NULL
                AND expected_buyer_phone_verification_source IS NULL
                AND expected_buyer_phone_verified_at IS NULL
            )
            OR (
                buyer_match_policy = 'verified_kakao_phone'
                AND expected_buyer_phone_number_normalized IS NOT NULL
                AND expected_buyer_phone_verification_source
                    IS NOT DISTINCT FROM 'kakao_rest_api'
                AND expected_buyer_phone_verified_at IS NOT NULL
            )
        )
    ) NOT VALID,
    ADD CONSTRAINT earlybird_orders_groble_buyer_email_check CHECK (
        groble_buyer_email IS NULL
        OR pg_catalog.char_length(groble_buyer_email) <= 320
    ) NOT VALID,
    ADD CONSTRAINT earlybird_orders_groble_buyer_phone_check CHECK (
        groble_buyer_phone_number IS NULL
        OR pg_catalog.char_length(groble_buyer_phone_number) <= 64
    ) NOT VALID,
    ADD CONSTRAINT earlybird_orders_groble_buyer_display_name_check CHECK (
        groble_buyer_display_name IS NULL
        OR pg_catalog.char_length(groble_buyer_display_name) <= 100
    ) NOT VALID;

-- The constant default classifies only rows that existed while this ALTER ran.
-- New rolling-deploy INSERTs receive NULL and must pass the verified snapshot trigger.
ALTER TABLE public.earlybird_orders
    ALTER COLUMN buyer_match_policy DROP DEFAULT;

ALTER TABLE public.earlybird_webhook_events
    ADD COLUMN groble_buyer_email TEXT,
    ADD COLUMN groble_buyer_phone_number TEXT,
    ADD COLUMN groble_buyer_display_name TEXT,
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_email_check CHECK (
        groble_buyer_email IS NULL
        OR pg_catalog.char_length(groble_buyer_email) <= 320
    ) NOT VALID,
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_phone_check CHECK (
        groble_buyer_phone_number IS NULL
        OR pg_catalog.char_length(groble_buyer_phone_number) <= 64
    ) NOT VALID,
    ADD CONSTRAINT earlybird_webhook_events_groble_buyer_display_name_check CHECK (
        groble_buyer_display_name IS NULL
        OR pg_catalog.char_length(groble_buyer_display_name) <= 100
    ) NOT VALID;

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

ALTER TABLE public.users
    ADD CONSTRAINT users_phone_number_provenance_check CHECK (
        (
            phone_number_normalized IS NULL
            AND phone_number_verification_source IS NULL
            AND phone_number_verified_at IS NULL
        )
        OR (
            provider = 'kakao'
            AND phone_number IS NOT NULL
            AND phone_number_normalized IS NOT NULL
            AND phone_number_verification_source
                IS NOT DISTINCT FROM 'kakao_rest_api'
            AND phone_number_verified_at IS NOT NULL
            AND public.normalize_kr_mobile_e164(phone_number)
                IS NOT DISTINCT FROM phone_number_normalized
        )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.enforce_user_phone_verification_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_identity_changed BOOLEAN := FALSE;
    v_verification_changed BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_identity_changed := NEW.provider IS DISTINCT FROM OLD.provider
            OR NEW.phone_number IS DISTINCT FROM OLD.phone_number
            OR NEW.phone_number_normalized IS DISTINCT FROM OLD.phone_number_normalized
            OR NEW.phone_number_verification_source
                IS DISTINCT FROM OLD.phone_number_verification_source;
        v_verification_changed := NEW.phone_number_verified_at
            IS DISTINCT FROM OLD.phone_number_verified_at;

        -- A rolling old writer changes raw/profile phone fields without presenting
        -- a new verification timestamp. Degrade the row instead of retaining stale trust.
        IF v_identity_changed
           AND NEW.phone_number_verified_at
                IS NOT DISTINCT FROM OLD.phone_number_verified_at THEN
            NEW.phone_number_normalized := NULL;
            NEW.phone_number_verification_source := NULL;
            NEW.phone_number_verified_at := NULL;
            RETURN NEW;
        END IF;
    END IF;

    IF (
           TG_OP = 'INSERT'
           OR v_identity_changed
           OR v_verification_changed
       )
       AND NEW.provider = 'kakao'
       AND NEW.phone_number IS NOT NULL
       AND NEW.phone_number_normalized IS NOT NULL
       AND NEW.phone_number_verification_source = 'kakao_rest_api'
       AND NEW.phone_number_verified_at IS NOT NULL
       AND public.normalize_kr_mobile_e164(NEW.phone_number)
            IS NOT DISTINCT FROM NEW.phone_number_normalized THEN
        NEW.phone_number_verified_at := pg_catalog.clock_timestamp();
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_user_phone_verification_provenance()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_user_phone_verification_provenance_before_write
BEFORE INSERT OR UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_phone_verification_provenance();

CREATE OR REPLACE FUNCTION public.set_earlybird_order_phone_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_phone_number_normalized TEXT;
    v_phone_verification_source TEXT;
    v_phone_verified_at TIMESTAMP WITH TIME ZONE;
BEGIN
    -- The same namespaced product fence is also taken by checkout and the rolling
    -- finalizer. Direct service-role INSERTs cannot create a verified-order phantom.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || NEW.expected_groble_product_id,
            0
        )
    );

    SELECT buyer.phone_number_normalized,
        buyer.phone_number_verification_source,
        buyer.phone_number_verified_at
    INTO v_phone_number_normalized,
        v_phone_verification_source,
        v_phone_verified_at
    FROM public.users AS buyer
    WHERE buyer.id = NEW.user_id
      AND buyer.provider = 'kakao'
      AND buyer.phone_number_verification_source = 'kakao_rest_api'
      AND buyer.phone_number_verified_at IS NOT NULL
      AND buyer.phone_number_verified_at
            >= pg_catalog.clock_timestamp() - INTERVAL '24 hours'
      AND buyer.phone_number_normalized IS NOT NULL
      AND public.normalize_kr_mobile_e164(buyer.phone_number)
            IS NOT DISTINCT FROM buyer.phone_number_normalized
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED';
    END IF;

    NEW.buyer_match_policy := 'verified_kakao_phone';
    NEW.expected_buyer_phone_number_normalized := v_phone_number_normalized;
    NEW.expected_buyer_phone_verification_source := v_phone_verification_source;
    NEW.expected_buyer_phone_verified_at := v_phone_verified_at;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_earlybird_order_phone_snapshot()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER set_earlybird_order_phone_snapshot_before_insert
BEFORE INSERT ON public.earlybird_orders
FOR EACH ROW
EXECUTE FUNCTION public.set_earlybird_order_phone_snapshot();

CREATE OR REPLACE FUNCTION public.protect_earlybird_order_buyer_match_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.buyer_match_policy IS DISTINCT FROM NEW.buyer_match_policy
       OR OLD.expected_buyer_phone_number_normalized
            IS DISTINCT FROM NEW.expected_buyer_phone_number_normalized
       OR OLD.expected_buyer_phone_verification_source
            IS DISTINCT FROM NEW.expected_buyer_phone_verification_source
       OR OLD.expected_buyer_phone_verified_at
            IS DISTINCT FROM NEW.expected_buyer_phone_verified_at THEN
        RAISE EXCEPTION 'EARLYBIRD_BUYER_MATCH_SNAPSHOT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_earlybird_order_buyer_match_snapshot()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update
BEFORE UPDATE OF buyer_match_policy,
    expected_buyer_phone_number_normalized,
    expected_buyer_phone_verification_source,
    expected_buyer_phone_verified_at
ON public.earlybird_orders
FOR EACH ROW
EXECUTE FUNCTION public.protect_earlybird_order_buyer_match_snapshot();

-- Establish product -> user ordering before Phase 2 replaces the checkout body.
-- The renamed body stays executable only by this SECURITY DEFINER bridge so a
-- transaction that entered during Phase 1 can finish after Phase 2 commits. Remove
-- it only in a separately reviewed post-drain migration.
ALTER FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) RENAME TO create_earlybird_checkout_before_product_fence;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout_before_product_fence(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

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
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || p_expected_product_id,
            0
        )
    );

    RETURN QUERY
    SELECT legacy_checkout.order_id, legacy_checkout.created
    FROM public.create_earlybird_checkout_before_product_fence(
        p_user_id,
        p_preflight_id,
        p_plan_id,
        p_expected_product_id,
        p_expected_amount_krw,
        p_pricing_version,
        p_disclosure_version,
        p_disclosure_text,
        p_disclosure_accepted_at
    ) AS legacy_checkout;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;
