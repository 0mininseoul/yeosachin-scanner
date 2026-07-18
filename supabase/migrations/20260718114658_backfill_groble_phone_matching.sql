-- Phase 3/5: backfill after checkout snapshotting is active for every new order.
-- Duplicate normalized phones abort this DML transaction before index creation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

UPDATE public.users
SET phone_number_normalized = COALESCE(
    public.normalize_kr_mobile_e164(phone_number),
    phone_number_normalized
)
WHERE phone_number IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.users
        WHERE phone_number_normalized IS NOT NULL
        GROUP BY phone_number_normalized
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW';
    END IF;
END;
$$;

UPDATE public.earlybird_orders AS unresolved_order
SET expected_buyer_phone_number_normalized = buyer.phone_number_normalized
FROM public.users AS buyer
WHERE unresolved_order.user_id = buyer.id
  AND unresolved_order.status IN ('payment_pending', 'cancelled')
  AND unresolved_order.payment_id IS NULL
  AND unresolved_order.expected_buyer_phone_number_normalized IS NULL
  AND buyer.phone_number_normalized IS NOT NULL;
