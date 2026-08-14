-- is_paid_user is the current active entitlement flag.  first_paid_at remains
-- the immutable earliest-payment timestamp and is protected below.
CREATE OR REPLACE FUNCTION public.enforce_account_paid_ever_monotonic()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.first_paid_at IS NOT NULL
       AND (
            NEW.first_paid_at IS NULL
            OR NEW.first_paid_at > OLD.first_paid_at
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_FIRST_PAID_AT_REGRESSION',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

-- Preserve the existing privilege boundary; only service_role (or an
-- already-authorized database administrator) can reach the users table.
REVOKE ALL ON FUNCTION public.enforce_account_paid_ever_monotonic()
    FROM PUBLIC, anon, authenticated, service_role;
