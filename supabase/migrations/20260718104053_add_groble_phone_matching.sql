-- Phase 1/5: add only nullable columns, unvalidated checks, the helper, and insert trigger.
-- The trigger is short schema work under the existing ALTER transaction; keep this lock phase short.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.users
    ADD COLUMN phone_number_normalized TEXT,
    ADD CONSTRAINT users_phone_number_normalized_check CHECK (
        phone_number_normalized IS NULL
        OR phone_number_normalized ~ '^\+8210[0-9]{8}$'
    ) NOT VALID;

ALTER TABLE public.earlybird_orders
    ADD COLUMN expected_buyer_phone_number_normalized TEXT,
    ADD COLUMN groble_buyer_email TEXT,
    ADD COLUMN groble_buyer_phone_number TEXT,
    ADD COLUMN groble_buyer_display_name TEXT,
    ADD CONSTRAINT earlybird_orders_expected_buyer_phone_check CHECK (
        expected_buyer_phone_number_normalized IS NULL
        OR expected_buyer_phone_number_normalized ~ '^\+8210[0-9]{8}$'
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

CREATE OR REPLACE FUNCTION public.set_earlybird_order_phone_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_phone_number_normalized TEXT;
BEGIN
    IF NEW.expected_buyer_phone_number_normalized IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(
        public.normalize_kr_mobile_e164(buyer.phone_number),
        buyer.phone_number_normalized
    )
    INTO v_phone_number_normalized
    FROM public.users AS buyer
    WHERE buyer.id = NEW.user_id
      AND buyer.provider = 'kakao';

    IF FOUND THEN
        NEW.expected_buyer_phone_number_normalized := v_phone_number_normalized;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_earlybird_order_phone_snapshot()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER set_earlybird_order_phone_snapshot_before_insert
BEFORE INSERT ON public.earlybird_orders
FOR EACH ROW
WHEN (NEW.expected_buyer_phone_number_normalized IS NULL)
EXECUTE FUNCTION public.set_earlybird_order_phone_snapshot();
