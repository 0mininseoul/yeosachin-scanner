-- Phase 4/5: validate phase-1 checks, then build lookup indexes over phase-3 data.
-- This phase depends on a successful duplicate guard and is safe to retry as a unit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.users
    VALIDATE CONSTRAINT users_phone_number_normalized_check,
    VALIDATE CONSTRAINT users_phone_number_verification_source_check,
    VALIDATE CONSTRAINT users_phone_number_provenance_check;
ALTER TABLE public.earlybird_orders
    VALIDATE CONSTRAINT earlybird_orders_expected_buyer_phone_check,
    VALIDATE CONSTRAINT earlybird_orders_buyer_match_snapshot_check,
    VALIDATE CONSTRAINT earlybird_orders_groble_buyer_email_check,
    VALIDATE CONSTRAINT earlybird_orders_groble_buyer_phone_check,
    VALIDATE CONSTRAINT earlybird_orders_groble_buyer_display_name_check;
ALTER TABLE public.earlybird_webhook_events
    VALIDATE CONSTRAINT earlybird_webhook_events_groble_buyer_email_check,
    VALIDATE CONSTRAINT earlybird_webhook_events_groble_buyer_phone_check,
    VALIDATE CONSTRAINT earlybird_webhook_events_groble_buyer_display_name_check;

-- Before push, re-check the documented row-count for each indexed table and use a
-- maintenance window if production volume has materially increased.
CREATE UNIQUE INDEX users_phone_number_normalized_unique
    ON public.users(phone_number_normalized)
    WHERE phone_number_normalized IS NOT NULL;

CREATE INDEX earlybird_orders_pending_phone_product_idx
    ON public.earlybird_orders(
        expected_buyer_phone_number_normalized, expected_groble_product_id
    )
    WHERE status = 'payment_pending'
      AND expected_buyer_phone_number_normalized IS NOT NULL;

CREATE INDEX earlybird_orders_cancelled_phone_product_amount_idx
    ON public.earlybird_orders(
        expected_buyer_phone_number_normalized,
        expected_groble_product_id,
        expected_amount_krw
    )
    WHERE status = 'cancelled'
      AND payment_id IS NULL
      AND expected_buyer_phone_number_normalized IS NOT NULL;
