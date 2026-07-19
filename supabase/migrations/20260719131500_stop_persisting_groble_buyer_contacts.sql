-- Groble seller terms prohibit separately retaining buyer contact fields. Keep the
-- nullable compatibility columns during the rolling deploy, but make nullness a
-- database invariant for both old and new application instances.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.clear_groble_buyer_contacts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    NEW.groble_buyer_email := NULL;
    NEW.groble_buyer_phone_number := NULL;
    NEW.groble_buyer_display_name := NULL;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_groble_buyer_contacts()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER clear_groble_contacts_on_orders
BEFORE INSERT OR UPDATE ON public.earlybird_orders
FOR EACH ROW
EXECUTE FUNCTION public.clear_groble_buyer_contacts();

CREATE TRIGGER clear_groble_contacts_on_webhook_events
BEFORE INSERT OR UPDATE ON public.earlybird_webhook_events
FOR EACH ROW
EXECUTE FUNCTION public.clear_groble_buyer_contacts();

-- Purge any values written before the compatibility fence became active. These
-- updates also pass through the trigger, so a concurrent old writer cannot restore
-- contact values after its row is touched.
UPDATE public.earlybird_orders
SET groble_buyer_email = NULL,
    groble_buyer_phone_number = NULL,
    groble_buyer_display_name = NULL
WHERE groble_buyer_email IS NOT NULL
   OR groble_buyer_phone_number IS NOT NULL
   OR groble_buyer_display_name IS NOT NULL;

UPDATE public.earlybird_webhook_events
SET groble_buyer_email = NULL,
    groble_buyer_phone_number = NULL,
    groble_buyer_display_name = NULL
WHERE groble_buyer_email IS NOT NULL
   OR groble_buyer_phone_number IS NOT NULL
   OR groble_buyer_display_name IS NOT NULL;

COMMENT ON COLUMN public.earlybird_orders.groble_buyer_email IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
COMMENT ON COLUMN public.earlybird_orders.groble_buyer_phone_number IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
COMMENT ON COLUMN public.earlybird_orders.groble_buyer_display_name IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
COMMENT ON COLUMN public.earlybird_webhook_events.groble_buyer_email IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
COMMENT ON COLUMN public.earlybird_webhook_events.groble_buyer_phone_number IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
COMMENT ON COLUMN public.earlybird_webhook_events.groble_buyer_display_name IS
    'Deprecated compatibility column. A BEFORE trigger enforces NULL.';
