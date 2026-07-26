-- Groble product prices are mutable in the provider dashboard. A checkout
-- snapshot is not. Bind every pricing version to a distinct provider product
-- and payment address, retire untouched v1 intents, and create replacements
-- only through a service-owned, idempotent v2 refresh.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_groble_product_versions (
    plan_id TEXT NOT NULL,
    pricing_version VARCHAR(64) NOT NULL,
    product_id VARCHAR(128) NOT NULL,
    payment_address VARCHAR(128) NOT NULL,
    expected_amount_krw INTEGER NOT NULL,
    checkout_active BOOLEAN NOT NULL,
    configured_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (plan_id, pricing_version),
    UNIQUE (product_id),
    UNIQUE (payment_address),
    UNIQUE (plan_id, pricing_version),
    CONSTRAINT earlybird_groble_product_versions_plan_check
        CHECK (plan_id IN ('basic', 'standard')),
    CONSTRAINT earlybird_groble_product_versions_version_check
        CHECK (pricing_version IN (
            'earlybird-2026-07-v1',
            'earlybird-2026-07-v2'
        )),
    CONSTRAINT earlybird_groble_product_versions_product_check
        CHECK (product_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    CONSTRAINT earlybird_groble_product_versions_address_check
        CHECK (payment_address ~ '^[A-Za-z0-9_-]{1,128}$'),
    CONSTRAINT earlybird_groble_product_versions_amount_check CHECK (
        (
            pricing_version = 'earlybird-2026-07-v1'
            AND (
                (plan_id = 'basic' AND expected_amount_krw = 14900)
                OR (plan_id = 'standard' AND expected_amount_krw = 19900)
            )
        )
        OR (
            pricing_version = 'earlybird-2026-07-v2'
            AND (
                (plan_id = 'basic' AND expected_amount_krw = 6900)
                OR (plan_id = 'standard' AND expected_amount_krw = 9900)
            )
        )
    ),
    CONSTRAINT earlybird_groble_product_versions_active_check CHECK (
        NOT checkout_active OR pricing_version = 'earlybird-2026-07-v2'
    )
);

CREATE TABLE public.earlybird_checkout_retirements (
    legacy_order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    retired_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_checkout_retirements_reason_check CHECK (
        reason = 'pricing_v2_product_separation'
    )
);

CREATE TABLE public.earlybird_checkout_refreshes (
    legacy_order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_checkout_retirements(legacy_order_id)
        ON DELETE RESTRICT,
    replacement_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    replacement_order_id UUID NOT NULL UNIQUE
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_groble_product_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_checkout_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_checkout_refreshes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.earlybird_groble_product_versions
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.earlybird_checkout_retirements
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.earlybird_checkout_refreshes
    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.earlybird_groble_product_versions TO service_role;
GRANT SELECT ON TABLE public.earlybird_checkout_retirements TO service_role;
GRANT SELECT ON TABLE public.earlybird_checkout_refreshes TO service_role;

CREATE FUNCTION public.reject_earlybird_checkout_lineage_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_AUDIT_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER earlybird_checkout_retirements_immutable
BEFORE UPDATE OR DELETE ON public.earlybird_checkout_retirements
FOR EACH ROW EXECUTE FUNCTION public.reject_earlybird_checkout_lineage_mutation();

CREATE TRIGGER earlybird_checkout_refreshes_immutable
BEFORE UPDATE OR DELETE ON public.earlybird_checkout_refreshes
FOR EACH ROW EXECUTE FUNCTION public.reject_earlybird_checkout_lineage_mutation();

REVOKE ALL ON FUNCTION public.reject_earlybird_checkout_lineage_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.configure_earlybird_groble_product_lineage(
    p_legacy_basic_product_id TEXT,
    p_legacy_basic_payment_address TEXT,
    p_legacy_standard_product_id TEXT,
    p_legacy_standard_payment_address TEXT,
    p_v2_basic_product_id TEXT,
    p_v2_basic_payment_address TEXT,
    p_v2_standard_product_id TEXT,
    p_v2_standard_payment_address TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.earlybird_groble_product_versions%ROWTYPE;
    v_desired RECORD;
    v_changed BOOLEAN := FALSE;
    v_is_first_configuration BOOLEAN;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
            p_legacy_basic_product_id,
            p_legacy_basic_payment_address,
            p_legacy_standard_product_id,
            p_legacy_standard_payment_address,
            p_v2_basic_product_id,
            p_v2_basic_payment_address,
            p_v2_standard_product_id,
            p_v2_standard_payment_address
        ]) AS identifier(value)
        WHERE identifier.value IS NULL
           OR identifier.value !~ '^[A-Za-z0-9_-]{1,128}$'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_LINEAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF (
        SELECT pg_catalog.count(DISTINCT identifier.value)
        FROM pg_catalog.unnest(ARRAY[
            p_legacy_basic_product_id,
            p_legacy_basic_payment_address,
            p_legacy_standard_product_id,
            p_legacy_standard_payment_address,
            p_v2_basic_product_id,
            p_v2_basic_payment_address,
            p_v2_standard_product_id,
            p_v2_standard_payment_address
        ]) AS identifier(value)
    ) <> 8 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'GROBLE_IDENTIFIERS_MUST_BE_GLOBALLY_DISTINCT',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:configuration',
            0
        )
    );

    SELECT NOT EXISTS (
        SELECT 1
        FROM public.earlybird_groble_product_versions
    ) INTO v_is_first_configuration;

    IF v_is_first_configuration AND EXISTS (
        WITH product_plan_evidence AS (
            SELECT
                historical_order.expected_groble_product_id AS product_id,
                historical_order.plan_id
            FROM public.earlybird_orders AS historical_order

            UNION ALL

            SELECT
                webhook_event.product_id,
                referenced_order.plan_id
            FROM public.earlybird_webhook_events AS webhook_event
            JOIN public.earlybird_orders AS referenced_order
              ON referenced_order.id = webhook_event.order_id
        )
        SELECT 1
        FROM product_plan_evidence
        GROUP BY product_id
        HAVING pg_catalog.count(DISTINCT plan_id) > 1
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_AMBIGUOUS',
            ERRCODE = 'P0001';
    END IF;

    IF v_is_first_configuration AND (
        EXISTS (
            SELECT 1
            FROM public.earlybird_orders AS historical_order
            WHERE (
                historical_order.plan_id = 'basic'
                AND historical_order.expected_groble_product_id
                    <> p_legacy_basic_product_id
            )
            OR (
                historical_order.plan_id = 'standard'
                AND historical_order.expected_groble_product_id
                    <> p_legacy_standard_product_id
            )
        )
        OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS webhook_event
            JOIN public.earlybird_orders AS referenced_order
              ON referenced_order.id = webhook_event.order_id
            WHERE (
                referenced_order.plan_id = 'basic'
                AND webhook_event.product_id <> p_legacy_basic_product_id
            )
            OR (
                referenced_order.plan_id = 'standard'
                AND webhook_event.product_id <> p_legacy_standard_product_id
            )
        )
        OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS webhook_event
            WHERE webhook_event.order_id IS NULL
              AND webhook_event.product_id NOT IN (
                  p_legacy_basic_product_id,
                  p_legacy_standard_product_id
              )
        )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    FOR v_desired IN
        SELECT *
        FROM (
            VALUES
                (
                    'basic'::TEXT,
                    'earlybird-2026-07-v1'::VARCHAR(64),
                    p_legacy_basic_product_id,
                    p_legacy_basic_payment_address,
                    14900,
                    FALSE
                ),
                (
                    'standard'::TEXT,
                    'earlybird-2026-07-v1'::VARCHAR(64),
                    p_legacy_standard_product_id,
                    p_legacy_standard_payment_address,
                    19900,
                    FALSE
                ),
                (
                    'basic'::TEXT,
                    'earlybird-2026-07-v2'::VARCHAR(64),
                    p_v2_basic_product_id,
                    p_v2_basic_payment_address,
                    6900,
                    TRUE
                ),
                (
                    'standard'::TEXT,
                    'earlybird-2026-07-v2'::VARCHAR(64),
                    p_v2_standard_product_id,
                    p_v2_standard_payment_address,
                    9900,
                    TRUE
                )
        ) AS desired(
            plan_id,
            pricing_version,
            product_id,
            payment_address,
            expected_amount_krw,
            checkout_active
        )
    LOOP
        SELECT binding.*
        INTO v_existing
        FROM public.earlybird_groble_product_versions AS binding
        WHERE binding.plan_id = v_desired.plan_id
          AND binding.pricing_version = v_desired.pricing_version;

        IF NOT FOUND THEN
            v_changed := TRUE;
            CONTINUE;
        END IF;
        IF v_existing.product_id = v_desired.product_id
           AND v_existing.payment_address = v_desired.payment_address
           AND v_existing.expected_amount_krw = v_desired.expected_amount_krw
           AND v_existing.checkout_active = v_desired.checkout_active THEN
            CONTINUE;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM public.earlybird_orders AS evidence
            WHERE evidence.expected_groble_product_id = v_existing.product_id
        )
        OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS evidence
            WHERE evidence.product_id = v_existing.product_id
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PRODUCT_LINEAGE_FROZEN',
                ERRCODE = 'P0001';
        END IF;
        v_changed := TRUE;
    END LOOP;

    IF NOT v_changed THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.earlybird_groble_product_versions AS existing
    WHERE NOT EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('basic'::TEXT, 'earlybird-2026-07-v1'::VARCHAR(64),
                 p_legacy_basic_product_id, p_legacy_basic_payment_address),
                ('standard'::TEXT, 'earlybird-2026-07-v1'::VARCHAR(64),
                 p_legacy_standard_product_id, p_legacy_standard_payment_address),
                ('basic'::TEXT, 'earlybird-2026-07-v2'::VARCHAR(64),
                 p_v2_basic_product_id, p_v2_basic_payment_address),
                ('standard'::TEXT, 'earlybird-2026-07-v2'::VARCHAR(64),
                 p_v2_standard_product_id, p_v2_standard_payment_address)
        ) AS desired(plan_id, pricing_version, product_id, payment_address)
        WHERE desired.plan_id = existing.plan_id
          AND desired.pricing_version = existing.pricing_version
          AND desired.product_id = existing.product_id
          AND desired.payment_address = existing.payment_address
    );

    INSERT INTO public.earlybird_groble_product_versions AS binding (
        plan_id,
        pricing_version,
        product_id,
        payment_address,
        expected_amount_krw,
        checkout_active
    ) VALUES
        (
            'basic', 'earlybird-2026-07-v1',
            p_legacy_basic_product_id, p_legacy_basic_payment_address,
            14900, FALSE
        ),
        (
            'standard', 'earlybird-2026-07-v1',
            p_legacy_standard_product_id, p_legacy_standard_payment_address,
            19900, FALSE
        ),
        (
            'basic', 'earlybird-2026-07-v2',
            p_v2_basic_product_id, p_v2_basic_payment_address,
            6900, TRUE
        ),
        (
            'standard', 'earlybird-2026-07-v2',
            p_v2_standard_product_id, p_v2_standard_payment_address,
            9900, TRUE
        )
    ON CONFLICT (plan_id, pricing_version) DO UPDATE
    SET product_id = EXCLUDED.product_id,
        payment_address = EXCLUDED.payment_address,
        expected_amount_krw = EXCLUDED.expected_amount_krw,
        checkout_active = EXCLUDED.checkout_active,
        configured_at = pg_catalog.clock_timestamp();
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_earlybird_groble_product_lineage(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_earlybird_groble_product_lineage(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- The phone-aware canonical finalizer previously acquired payment and user
-- locks without the namespaced product fence. Rename it and expose a wrapper
-- that establishes payment -> product -> sorted users before re-entering it.
ALTER FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) RENAME TO finalize_earlybird_groble_payment_before_product_fence;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_before_product_fence(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finalize_earlybird_groble_payment(
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
    v_lock_user_id UUID;
    v_binding public.earlybird_groble_product_versions%ROWTYPE;
    v_legacy_reference TEXT;
    v_legacy_match_count INTEGER;
BEGIN
    IF p_event_type IS DISTINCT FROM 'payment.completed'
       OR p_event_id IS NULL
       OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
       OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
       OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL
       OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL
       OR p_amount_krw < 0
       OR p_buyer_email IS NULL
       OR pg_catalog.char_length(p_buyer_email) > 320
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
       OR p_occurred_at IS NULL
       OR p_paid_at IS NULL THEN
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

    SELECT configured.*
    INTO v_binding
    FROM public.earlybird_groble_product_versions AS configured
    WHERE configured.product_id = p_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
            ERRCODE = 'P0001';
    END IF;
    IF v_binding.checkout_active THEN
        RAISE EXCEPTION USING
            MESSAGE = 'GROBLE_SELLER_REFERENCE_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    FOR v_lock_user_id IN
        SELECT potential_user.user_id
        FROM (
            SELECT candidate.user_id
            FROM public.earlybird_orders AS candidate
            WHERE candidate.expected_groble_product_id = p_product_id
              AND (
                  candidate.status = 'payment_pending'
                  OR (
                      candidate.status = 'cancelled'
                      AND candidate.payment_id IS NULL
                  )
                  OR candidate.payment_id = p_payment_id
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

    SELECT
        pg_catalog.min(candidate.groble_seller_reference),
        pg_catalog.count(*)::INTEGER
    INTO v_legacy_reference, v_legacy_match_count
    FROM public.earlybird_orders AS candidate
    JOIN public.users AS buyer ON buyer.id = candidate.user_id
    WHERE candidate.expected_groble_product_id = p_product_id
      AND candidate.status = 'cancelled'
      AND candidate.payment_id IS NULL
      AND candidate.groble_seller_reference IS NOT NULL
      AND (
          (
              candidate.buyer_match_policy = 'legacy_email'
              AND pg_catalog.lower(pg_catalog.btrim(buyer.email))
                  = pg_catalog.lower(pg_catalog.btrim(p_buyer_email))
          )
          OR (
              candidate.buyer_match_policy = 'verified_kakao_phone'
              AND p_buyer_phone_normalized IS NOT NULL
              AND candidate.expected_buyer_phone_number_normalized
                  = p_buyer_phone_normalized
          )
      );
    IF v_legacy_match_count = 1 THEN
        RETURN QUERY
        SELECT *
        FROM public.finalize_earlybird_groble_payment_by_reference(
            v_legacy_reference,
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
        RETURN;
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.finalize_earlybird_groble_payment_before_product_fence(
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
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $retire_legacy$
DECLARE
    v_product_id TEXT;
    v_user_id UUID;
BEGIN
    FOR v_product_id IN
        SELECT DISTINCT legacy_order.expected_groble_product_id
        FROM public.earlybird_orders AS legacy_order
        LEFT JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = legacy_order.id
        WHERE legacy_order.status = 'payment_pending'
          AND (
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v1'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 14900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 19900)
                  )
              )
              OR
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v2'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 6900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 9900)
                  )
              )
          )
          AND legacy_order.payment_id IS NULL
          AND legacy_order.actual_groble_product_id IS NULL
          AND legacy_order.actual_amount_krw IS NULL
          AND legacy_order.paid_at IS NULL
          AND legacy_order.result_request_id IS NULL
          AND legacy_order.seller_reference_confirmed_at IS NULL
          AND fulfillment.order_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_webhook_events AS webhook_event
              WHERE webhook_event.order_id = legacy_order.id
                 OR (
                      webhook_event.order_id IS NULL
                      AND webhook_event.event_type = 'payment.completed'
                      AND webhook_event.product_id
                          = legacy_order.expected_groble_product_id
                      AND webhook_event.amount_krw
                          <= legacy_order.expected_amount_krw
                 )
          )
        ORDER BY legacy_order.expected_groble_product_id
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'earlybird:groble:product:' || v_product_id,
                0
            )
        );
    END LOOP;

    FOR v_user_id IN
        SELECT DISTINCT legacy_order.user_id
        FROM public.earlybird_orders AS legacy_order
        LEFT JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = legacy_order.id
        WHERE legacy_order.status = 'payment_pending'
          AND (
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v1'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 14900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 19900)
                  )
              )
              OR
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v2'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 6900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 9900)
                  )
              )
          )
          AND legacy_order.payment_id IS NULL
          AND legacy_order.actual_groble_product_id IS NULL
          AND legacy_order.actual_amount_krw IS NULL
          AND legacy_order.paid_at IS NULL
          AND legacy_order.result_request_id IS NULL
          AND legacy_order.seller_reference_confirmed_at IS NULL
          AND fulfillment.order_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_webhook_events AS webhook_event
              WHERE webhook_event.order_id = legacy_order.id
                 OR (
                      webhook_event.order_id IS NULL
                      AND webhook_event.event_type = 'payment.completed'
                      AND webhook_event.product_id
                          = legacy_order.expected_groble_product_id
                      AND webhook_event.amount_krw
                          <= legacy_order.expected_amount_krw
                 )
          )
        ORDER BY legacy_order.user_id
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_user_id::TEXT, 0)
        );
    END LOOP;

    WITH eligible AS MATERIALIZED (
        SELECT legacy_order.id
        FROM public.earlybird_orders AS legacy_order
        LEFT JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = legacy_order.id
        WHERE legacy_order.status = 'payment_pending'
          AND (
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v1'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 14900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 19900)
                  )
              )
              OR
              (
                  legacy_order.pricing_version = 'earlybird-2026-07-v2'
                  AND (
                      (legacy_order.plan_id = 'basic'
                       AND legacy_order.expected_amount_krw = 6900)
                      OR
                      (legacy_order.plan_id = 'standard'
                       AND legacy_order.expected_amount_krw = 9900)
                  )
              )
          )
          AND legacy_order.payment_id IS NULL
          AND legacy_order.actual_groble_product_id IS NULL
          AND legacy_order.actual_amount_krw IS NULL
          AND legacy_order.paid_at IS NULL
          AND legacy_order.result_request_id IS NULL
          AND legacy_order.seller_reference_confirmed_at IS NULL
          AND fulfillment.order_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_webhook_events AS webhook_event
              WHERE webhook_event.order_id = legacy_order.id
                 OR (
                      webhook_event.order_id IS NULL
                      AND webhook_event.event_type = 'payment.completed'
                      AND webhook_event.product_id
                          = legacy_order.expected_groble_product_id
                      AND webhook_event.amount_krw
                          <= legacy_order.expected_amount_krw
                 )
          )
        FOR UPDATE OF legacy_order
    ),
    audit_insert AS (
        INSERT INTO public.earlybird_checkout_retirements (
            legacy_order_id,
            reason
        )
        SELECT
            eligible.id,
            'pricing_v2_product_separation'
        FROM eligible
        RETURNING legacy_order_id
    )
    UPDATE public.earlybird_orders AS retired_order
    SET status = 'cancelled',
        updated_at = pg_catalog.clock_timestamp()
    FROM audit_insert
    WHERE retired_order.id = audit_insert.legacy_order_id
      AND retired_order.status = 'payment_pending'
      AND retired_order.payment_id IS NULL
      AND retired_order.actual_groble_product_id IS NULL
      AND retired_order.actual_amount_krw IS NULL
      AND retired_order.paid_at IS NULL;
END;
$retire_legacy$;

CREATE FUNCTION public.create_earlybird_checkout_v2(
    p_user_id UUID,
    p_preflight_id UUID,
    p_plan_id TEXT,
    p_expected_product_id TEXT,
    p_payment_address TEXT,
    p_expected_amount_krw INTEGER,
    p_pricing_version TEXT,
    p_disclosure_version TEXT,
    p_disclosure_text TEXT,
    p_disclosure_accepted_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(order_id UUID, created BOOLEAN, seller_reference TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    binding public.earlybird_groble_product_versions%ROWTYPE;
BEGIN
    SELECT configured.*
    INTO binding
    FROM public.earlybird_groble_product_versions AS configured
    WHERE configured.plan_id = p_plan_id
      AND configured.pricing_version = p_pricing_version;

    IF NOT FOUND
       OR p_pricing_version IS DISTINCT FROM 'earlybird-2026-07-v2'
       OR binding.product_id <> p_expected_product_id
       OR binding.payment_address <> p_payment_address
       OR binding.expected_amount_krw <> p_expected_amount_krw
       OR NOT binding.checkout_active THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    WITH checkout AS MATERIALIZED (
        SELECT created_checkout.order_id, created_checkout.created
        FROM public.create_earlybird_checkout(
            p_user_id,
            p_preflight_id,
            p_plan_id,
            p_expected_product_id,
            p_expected_amount_krw,
            p_pricing_version,
            p_disclosure_version,
            p_disclosure_text,
            p_disclosure_accepted_at
        ) AS created_checkout
    )
    SELECT
        checkout.order_id,
        checkout.created,
        public.issue_earlybird_groble_seller_reference(checkout.order_id)
    FROM checkout;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_earlybird_checkout_v2(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout_v2(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT,
    TIMESTAMP WITH TIME ZONE
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
    v_reference_snapshot public.earlybird_orders%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_event public.earlybird_webhook_events%ROWTYPE;
    v_payment_order public.earlybird_orders%ROWTYPE;
    v_binding public.earlybird_groble_product_versions%ROWTYPE;
    v_product_lock TEXT;
    v_sequence SMALLINT;
BEGIN
    IF p_seller_reference IS NULL
       OR p_seller_reference !~ '^ord[.][a-f0-9]{32}$'
       OR p_event_type IS DISTINCT FROM 'payment.completed'
       OR p_event_id IS NULL
       OR pg_catalog.char_length(p_event_id) NOT BETWEEN 1 AND 256
       OR p_idempotency_key IS NULL
       OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 256
       OR p_payment_id IS NULL
       OR pg_catalog.char_length(p_payment_id) NOT BETWEEN 1 AND 256
       OR p_product_id IS NULL
       OR p_product_id !~ '^[A-Za-z0-9_-]{1,128}$'
       OR p_amount_krw IS NULL
       OR p_amount_krw < 0
       OR p_buyer_email IS NULL
       OR pg_catalog.char_length(p_buyer_email) > 320
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
       OR p_occurred_at IS NULL
       OR p_paid_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT referenced_order.*
    INTO v_reference_snapshot
    FROM public.earlybird_orders AS referenced_order
    WHERE referenced_order.groble_seller_reference = p_seller_reference;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNMATCHED',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_payment_id, 0)
    );
    FOR v_product_lock IN
        SELECT candidate.product_id
        FROM (
            VALUES
                (v_reference_snapshot.expected_groble_product_id),
                (p_product_id)
        ) AS candidate(product_id)
        ORDER BY candidate.product_id
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'earlybird:groble:product:' || v_product_lock,
                0
            )
        );
    END LOOP;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_reference_snapshot.user_id::TEXT, 0)
    );

    SELECT referenced_order.*
    INTO v_order
    FROM public.earlybird_orders AS referenced_order
    WHERE referenced_order.groble_seller_reference = p_seller_reference
    FOR UPDATE;
    IF NOT FOUND
       OR v_order.id <> v_reference_snapshot.id
       OR v_order.user_id <> v_reference_snapshot.user_id
       OR v_order.expected_groble_product_id
            <> v_reference_snapshot.expected_groble_product_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT webhook_event.*
    INTO v_event
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.event_id = p_event_id
       OR webhook_event.idempotency_key = p_idempotency_key
    ORDER BY webhook_event.processed_at
    LIMIT 1;
    IF FOUND THEN
        IF v_event.event_id IS DISTINCT FROM p_event_id
           OR v_event.idempotency_key IS DISTINCT FROM p_idempotency_key
           OR v_event.event_type IS DISTINCT FROM p_event_type
           OR v_event.payment_id IS DISTINCT FROM p_payment_id
           OR v_event.product_id IS DISTINCT FROM p_product_id
           OR v_event.amount_krw IS DISTINCT FROM p_amount_krw
           OR v_event.order_id IS DISTINCT FROM v_order.id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            'duplicate_event'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT existing_order.*
    INTO v_payment_order
    FROM public.earlybird_orders AS existing_order
    WHERE existing_order.payment_id = p_payment_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_payment_order.id <> v_order.id
           OR v_payment_order.groble_seller_reference
                IS DISTINCT FROM p_seller_reference
           OR v_payment_order.actual_groble_product_id
                IS DISTINCT FROM p_product_id
           OR v_payment_order.actual_amount_krw
                IS DISTINCT FROM p_amount_krw THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        INSERT INTO public.earlybird_webhook_events (
            event_id,
            idempotency_key,
            event_type,
            occurred_at,
            payment_id,
            product_id,
            amount_krw,
            disposition,
            order_id
        ) VALUES (
            p_event_id,
            p_idempotency_key,
            p_event_type,
            p_occurred_at,
            p_payment_id,
            p_product_id,
            p_amount_krw,
            'duplicate_payment',
            v_order.id
        );
        RETURN QUERY SELECT
            'duplicate_payment'::TEXT,
            v_order.id,
            v_order.status,
            v_order.plan_sequence;
        RETURN;
    END IF;

    SELECT configured.*
    INTO v_binding
    FROM public.earlybird_groble_product_versions AS configured
    WHERE configured.product_id = v_order.expected_groble_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
            ERRCODE = 'P0001';
    END IF;
    IF v_order.expected_groble_product_id <> p_product_id
       OR (
            v_binding.checkout_active
            AND (
                v_order.pricing_version <> v_binding.pricing_version
                OR v_order.plan_id <> v_binding.plan_id
                OR v_order.expected_amount_krw <> v_binding.expected_amount_krw
                OR p_amount_krw <> v_binding.expected_amount_krw
            )
       )
       OR (
            NOT v_binding.checkout_active
            AND p_amount_krw > v_order.expected_amount_krw
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PAYMENT_AMOUNT_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status = 'cancelled' THEN
        UPDATE public.earlybird_orders AS late_order
        SET status = 'refund_pending',
            payment_id = p_payment_id,
            actual_groble_product_id = p_product_id,
            actual_amount_krw = p_amount_krw,
            paid_at = p_paid_at,
            seller_reference_confirmed_at = COALESCE(
                late_order.seller_reference_confirmed_at,
                pg_catalog.clock_timestamp()
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE late_order.id = v_order.id
          AND late_order.status = 'cancelled'
          AND late_order.payment_id IS NULL
        RETURNING late_order.* INTO v_order;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.earlybird_webhook_events (
            event_id,
            idempotency_key,
            event_type,
            occurred_at,
            payment_id,
            product_id,
            amount_krw,
            disposition,
            order_id
        ) VALUES (
            p_event_id,
            p_idempotency_key,
            p_event_type,
            p_occurred_at,
            p_payment_id,
            p_product_id,
            p_amount_krw,
            'late_cancelled_payment',
            v_order.id
        );
        RETURN QUERY SELECT
            'late_cancelled_payment'::TEXT,
            v_order.id,
            v_order.status,
            NULL::SMALLINT;
        RETURN;
    END IF;

    IF v_order.status <> 'payment_pending'
       OR v_order.payment_id IS NOT NULL
       OR v_order.paid_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',
            ERRCODE = 'P0001';
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
            seller_reference_confirmed_at = COALESCE(
                cancelled_before_confirmation.seller_reference_confirmed_at,
                pg_catalog.clock_timestamp()
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE cancelled_before_confirmation.id = v_order.id
        RETURNING cancelled_before_confirmation.* INTO v_order;

        UPDATE public.earlybird_webhook_events AS prior_cancellation
        SET disposition = 'cancel_requested',
            order_id = v_order.id
        WHERE prior_cancellation.payment_id = p_payment_id
          AND prior_cancellation.event_type = 'payment.cancel_requested';

        INSERT INTO public.earlybird_webhook_events (
            event_id,
            idempotency_key,
            event_type,
            occurred_at,
            payment_id,
            product_id,
            amount_krw,
            disposition,
            order_id
        ) VALUES (
            p_event_id,
            p_idempotency_key,
            p_event_type,
            p_occurred_at,
            p_payment_id,
            p_product_id,
            p_amount_krw,
            'cancel_before_payment',
            v_order.id
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
            seller_reference_confirmed_at = COALESCE(
                overflow_order.seller_reference_confirmed_at,
                pg_catalog.clock_timestamp()
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE overflow_order.id = v_order.id
        RETURNING overflow_order.* INTO v_order;

        INSERT INTO public.earlybird_webhook_events (
            event_id,
            idempotency_key,
            event_type,
            occurred_at,
            payment_id,
            product_id,
            amount_krw,
            disposition,
            order_id
        ) VALUES (
            p_event_id,
            p_idempotency_key,
            p_event_type,
            p_occurred_at,
            p_payment_id,
            p_product_id,
            p_amount_krw,
            'overflow_refund_required',
            v_order.id
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
        seller_reference_confirmed_at = COALESCE(
            accepted_order.seller_reference_confirmed_at,
            pg_catalog.clock_timestamp()
        ),
        updated_at = pg_catalog.clock_timestamp()
    WHERE accepted_order.id = v_order.id
    RETURNING accepted_order.* INTO v_order;

    INSERT INTO public.earlybird_webhook_events (
        event_id,
        idempotency_key,
        event_type,
        occurred_at,
        payment_id,
        product_id,
        amount_krw,
        disposition,
        order_id
    ) VALUES (
        p_event_id,
        p_idempotency_key,
        p_event_type,
        p_occurred_at,
        p_payment_id,
        p_product_id,
        p_amount_krw,
        'accepted',
        v_order.id
    );
    RETURN QUERY SELECT
        'accepted'::TEXT,
        v_order.id,
        v_order.status,
        v_order.plan_sequence;
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

CREATE FUNCTION public.refresh_legacy_earlybird_checkout(
    p_user_id UUID,
    p_legacy_order_id UUID,
    p_disclosure_version TEXT,
    p_disclosure_text TEXT,
    p_disclosure_accepted_at TIMESTAMP WITH TIME ZONE,
    p_launch_status_snapshot JSONB,
    p_plan_catalog_snapshot JSONB,
    p_pricing_snapshot JSONB
)
RETURNS TABLE(
    order_id UUID,
    preflight_id UUID,
    created BOOLEAN,
    seller_reference TEXT,
    plan_id TEXT,
    payment_address TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_legacy public.earlybird_orders%ROWTYPE;
    v_old_preflight public.analysis_preflights%ROWTYPE;
    v_current_user public.users%ROWTYPE;
    v_refresh public.earlybird_checkout_refreshes%ROWTYPE;
    v_replacement public.earlybird_orders%ROWTYPE;
    v_new_preflight_id UUID;
    v_checkout RECORD;
    v_inventory public.earlybird_plan_inventory%ROWTYPE;
    v_binding public.earlybird_groble_product_versions%ROWTYPE;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_required_rank INTEGER;
    v_capacity_required_plan_id TEXT;
    v_required_plan_id TEXT;
    v_plan_cards_snapshot JSONB := '{}'::JSONB;
    v_selection_state TEXT;
    v_unavailable_reason TEXT;
    v_legacy_product_id TEXT;
    v_lock_product_id TEXT;
BEGIN
    IF p_user_id IS NULL
       OR p_legacy_order_id IS NULL
       OR p_disclosure_version IS DISTINCT FROM 'earlybird-24h-v1'
       OR p_disclosure_text IS DISTINCT FROM
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.'
       OR p_disclosure_accepted_at IS NULL
       OR NOT public.analysis_v2_valid_launch_snapshot(
            p_launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            p_plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            p_pricing_snapshot
       )
       OR p_pricing_snapshot->'basic'->>'status' <> 'quoted'
       OR p_pricing_snapshot->'basic'->>'currency' <> 'KRW'
       OR p_pricing_snapshot->'basic'->>'amountKrw' <> '6900'
       OR p_pricing_snapshot->'standard'->>'status' <> 'quoted'
       OR p_pricing_snapshot->'standard'->>'currency' <> 'KRW'
       OR p_pricing_snapshot->'standard'->>'amountKrw' <> '9900'
       OR p_pricing_snapshot->'plus'->>'status' <> 'deferred'
       OR p_pricing_snapshot->'plus'->>'currency' <> 'KRW'
       OR p_pricing_snapshot->'plus'->'amountKrw' <> 'null'::JSONB THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT
        legacy_order.expected_groble_product_id,
        legacy_order.plan_id
    INTO v_legacy_product_id, v_plan_id
    FROM public.earlybird_orders AS legacy_order
    WHERE legacy_order.id = p_legacy_order_id
      AND legacy_order.user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT configured.*
    INTO v_binding
    FROM public.earlybird_groble_product_versions AS configured
    WHERE configured.plan_id = v_plan_id
      AND configured.pricing_version = 'earlybird-2026-07-v2'
      AND configured.checkout_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    FOR v_lock_product_id IN
        SELECT candidate.product_id
        FROM (
            VALUES (v_legacy_product_id), (v_binding.product_id)
        ) AS candidate(product_id)
        WHERE candidate.product_id IS NOT NULL
        ORDER BY candidate.product_id
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'earlybird:groble:product:' || v_lock_product_id,
                0
            )
        );
    END LOOP;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_user_id::TEXT, 0)
    );

    SELECT legacy_order.*
    INTO v_legacy
    FROM public.earlybird_orders AS legacy_order
    WHERE legacy_order.id = p_legacy_order_id
      AND legacy_order.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_legacy.status <> 'cancelled'
       OR NOT (
            (
                v_legacy.pricing_version = 'earlybird-2026-07-v1'
                AND (
                    (v_legacy.plan_id = 'basic'
                     AND v_legacy.expected_amount_krw = 14900)
                    OR
                    (v_legacy.plan_id = 'standard'
                     AND v_legacy.expected_amount_krw = 19900)
                )
            )
            OR
            (
                v_legacy.pricing_version = 'earlybird-2026-07-v2'
                AND (
                    (v_legacy.plan_id = 'basic'
                     AND v_legacy.expected_amount_krw = 6900)
                    OR
                    (v_legacy.plan_id = 'standard'
                     AND v_legacy.expected_amount_krw = 9900)
                )
            )
       )
       OR v_legacy.payment_id IS NOT NULL
       OR v_legacy.actual_groble_product_id IS NOT NULL
       OR v_legacy.actual_amount_krw IS NOT NULL
       OR v_legacy.paid_at IS NOT NULL
       OR v_legacy.result_request_id IS NOT NULL
       OR NOT EXISTS (
            SELECT 1
            FROM public.earlybird_checkout_retirements AS retirement
            WHERE retirement.legacy_order_id = v_legacy.id
              AND retirement.reason = 'pricing_v2_product_separation'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT buyer.*
    INTO v_current_user
    FROM public.users AS buyer
    WHERE buyer.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_current_user.provider <> 'kakao'
       OR v_current_user.phone_number_verification_source
            IS DISTINCT FROM 'kakao_rest_api'
       OR v_current_user.phone_number_verified_at IS NULL
       OR v_current_user.phone_number_verified_at < v_now - INTERVAL '24 hours'
       OR v_current_user.phone_number_normalized IS NULL
       OR public.normalize_kr_mobile_e164(v_current_user.phone_number)
            IS DISTINCT FROM v_current_user.phone_number_normalized
       OR v_legacy.buyer_match_policy <> 'verified_kakao_phone'
       OR v_legacy.expected_buyer_phone_number_normalized
            IS DISTINCT FROM v_current_user.phone_number_normalized
       OR v_legacy.expected_buyer_phone_verification_source
            IS DISTINCT FROM 'kakao_rest_api' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CHECKOUT_PHONE_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    SELECT refresh.*
    INTO v_refresh
    FROM public.earlybird_checkout_refreshes AS refresh
    WHERE refresh.legacy_order_id = v_legacy.id;
    IF FOUND THEN
        SELECT replacement.*
        INTO v_replacement
        FROM public.earlybird_orders AS replacement
        WHERE replacement.id = v_refresh.replacement_order_id
          AND replacement.user_id = p_user_id
        FOR UPDATE;
        IF NOT FOUND
           OR v_replacement.preflight_id
                <> v_refresh.replacement_preflight_id
           OR v_replacement.plan_id <> v_legacy.plan_id
           OR v_replacement.pricing_version <> v_binding.pricing_version
           OR v_replacement.expected_groble_product_id
                <> v_binding.product_id
           OR v_replacement.expected_amount_krw
                <> v_binding.expected_amount_krw
           OR v_replacement.status <> 'payment_pending'
           OR v_replacement.payment_id IS NOT NULL
           OR v_replacement.actual_amount_krw IS NOT NULL
           OR v_replacement.paid_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_replacement.id::UUID,
            v_replacement.preflight_id::UUID,
            FALSE,
            v_replacement.groble_seller_reference::TEXT,
            v_replacement.plan_id::TEXT,
            v_binding.payment_address::TEXT;
        RETURN;
    END IF;

    IF v_binding.plan_id <> v_legacy.plan_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    SELECT old_preflight.*
    INTO v_old_preflight
    FROM public.analysis_preflights AS old_preflight
    WHERE old_preflight.id = v_legacy.preflight_id
      AND old_preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_old_preflight.target_followers_count IS NULL
       OR v_old_preflight.target_following_count IS NULL
       OR v_old_preflight.target_is_private IS DISTINCT FROM FALSE
       OR v_old_preflight.exclusion_decision NOT IN ('skip', 'exclude')
       OR v_old_preflight.target_instagram_id
            IS DISTINCT FROM v_legacy.target_instagram_id
       OR v_old_preflight.exclusion_decision
            IS DISTINCT FROM v_legacy.exclusion_decision
       OR v_old_preflight.excluded_instagram_id
            IS DISTINCT FROM v_legacy.excluded_instagram_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT inventory.*
    INTO v_inventory
    FROM public.earlybird_plan_inventory AS inventory
    WHERE inventory.plan_id = v_legacy.plan_id
    FOR UPDATE;
    IF NOT FOUND OR v_inventory.sold_count >= v_inventory.sale_limit THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SOLD_OUT',
            ERRCODE = 'P0001';
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        IF p_plan_catalog_snapshot->v_plan_id->>'launchStatus'
            IS DISTINCT FROM p_launch_status_snapshot->>v_plan_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_LEGACY_REFRESH_INVALID',
                ERRCODE = 'P0001';
        END IF;
        v_plan_rank := CASE v_plan_id
            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_capacity_required_plan_id IS NULL
           AND p_launch_status_snapshot->>v_plan_id = 'production'
           AND v_old_preflight.target_followers_count
                <= (p_plan_catalog_snapshot->v_plan_id
                    ->'relationshipCapacity'->>'followers')::INTEGER
           AND v_old_preflight.target_following_count
                <= (p_plan_catalog_snapshot->v_plan_id
                    ->'relationshipCapacity'->>'following')::INTEGER THEN
            v_capacity_required_plan_id := v_plan_id;
            v_required_rank := v_plan_rank;
        END IF;
    END LOOP;

    IF v_capacity_required_plan_id IS NULL
       OR v_capacity_required_plan_id = 'plus'
       OR (
            CASE v_legacy.plan_id
                WHEN 'basic' THEN 1
                WHEN 'standard' THEN 2
                ELSE 3
            END
       ) < v_required_rank THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PLAN_UPGRADE_REQUIRED',
            ERRCODE = 'P0001';
    END IF;
    v_required_plan_id := v_capacity_required_plan_id;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id
            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF p_launch_status_snapshot->>v_plan_id <> 'production' THEN
            v_selection_state := 'unavailable';
            v_unavailable_reason := 'launch_gate';
        ELSIF v_plan_rank < v_required_rank THEN
            v_selection_state := 'unavailable';
            v_unavailable_reason := 'below_required_plan';
        ELSIF v_plan_rank = v_required_rank THEN
            v_selection_state := 'required';
            v_unavailable_reason := NULL;
        ELSE
            v_selection_state := 'available_upgrade';
            v_unavailable_reason := NULL;
        END IF;

        v_plan_cards_snapshot := v_plan_cards_snapshot
            || pg_catalog.jsonb_build_object(
                v_plan_id,
                pg_catalog.jsonb_build_object(
                    'launchStatus',
                    p_launch_status_snapshot->>v_plan_id,
                    'relationshipCapacity',
                    p_plan_catalog_snapshot->v_plan_id
                        ->'relationshipCapacity',
                    'detailedMutualLimit',
                    p_plan_catalog_snapshot->v_plan_id
                        ->'detailedMutualLimit',
                    'selectionState',
                    v_selection_state,
                    'unavailableReason',
                    pg_catalog.to_jsonb(v_unavailable_reason)
                )
            );
    END LOOP;

    IF NOT public.analysis_v2_valid_plan_cards_snapshot(
        v_plan_cards_snapshot
    )
       OR v_plan_cards_snapshot->v_legacy.plan_id->>'selectionState'
            = 'unavailable' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PLAN_SELECTION_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights (
        id,
        user_id,
        idempotency_key,
        target_instagram_id,
        status,
        exclusion_decision,
        excluded_instagram_id,
        access_mode,
        launch_status_snapshot,
        plan_catalog_snapshot,
        plan_cards_snapshot,
        pricing_version,
        pricing_snapshot,
        policy_versions_snapshot,
        target_full_name,
        target_bio,
        target_profile_image_url,
        target_followers_count,
        target_following_count,
        target_is_private,
        capacity_required_plan_id,
        required_plan_id,
        created_at,
        updated_at,
        expires_at,
        ready_at,
        exclusion_decided_at
    ) VALUES (
        v_new_preflight_id,
        p_user_id,
        'earlybird-refresh:'
            || pg_catalog.replace(v_legacy.id::TEXT, '-', ''),
        v_legacy.target_instagram_id,
        'ready',
        v_legacy.exclusion_decision,
        v_legacy.excluded_instagram_id,
        'production',
        p_launch_status_snapshot,
        p_plan_catalog_snapshot,
        v_plan_cards_snapshot,
        v_binding.pricing_version,
        p_pricing_snapshot,
        v_old_preflight.policy_versions_snapshot,
        v_old_preflight.target_full_name,
        v_old_preflight.target_bio,
        v_old_preflight.target_profile_image_url,
        v_old_preflight.target_followers_count,
        v_old_preflight.target_following_count,
        FALSE,
        v_capacity_required_plan_id,
        v_required_plan_id,
        v_now,
        v_now,
        v_now + INTERVAL '30 minutes',
        v_now,
        v_now
    );

    SELECT checkout.*
    INTO v_checkout
    FROM public.create_earlybird_checkout_v2(
        p_user_id,
        v_new_preflight_id,
        v_legacy.plan_id,
        v_binding.product_id,
        v_binding.payment_address,
        v_binding.expected_amount_krw,
        v_binding.pricing_version,
        p_disclosure_version,
        p_disclosure_text,
        p_disclosure_accepted_at
    ) AS checkout;

    INSERT INTO public.earlybird_checkout_refreshes (
        legacy_order_id,
        replacement_preflight_id,
        replacement_order_id
    ) VALUES (
        v_legacy.id,
        v_new_preflight_id,
        v_checkout.order_id
    );

    RETURN QUERY SELECT
        v_checkout.order_id::UUID,
        v_new_preflight_id,
        TRUE,
        v_checkout.seller_reference::TEXT,
        v_legacy.plan_id::TEXT,
        v_binding.payment_address::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_legacy_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_legacy_earlybird_checkout(
    UUID, UUID, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, JSONB, JSONB, JSONB
) TO service_role;
