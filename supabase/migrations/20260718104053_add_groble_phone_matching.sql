-- Phase 1/4: add only nullable columns, unvalidated checks, and the backfill helper.
-- Supabase CLI executes this file as one transaction, so keep this lock phase short.

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
