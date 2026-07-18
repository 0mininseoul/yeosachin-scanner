-- Phase 3/5: invalidate unproven normalized identities without promoting legacy raw phones.
-- Duplicate verified phones abort this DML transaction before index creation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

UPDATE public.users
SET phone_number_normalized = NULL,
    phone_number_verification_source = NULL,
    phone_number_verified_at = NULL
WHERE (
        phone_number_normalized IS NOT NULL
        OR phone_number_verification_source IS NOT NULL
        OR phone_number_verified_at IS NOT NULL
    )
  AND NOT (
      provider = 'kakao'
      AND phone_number IS NOT NULL
      AND phone_number_normalized IS NOT NULL
      AND phone_number_verification_source
            IS NOT DISTINCT FROM 'kakao_rest_api'
      AND phone_number_verified_at IS NOT NULL
      AND public.normalize_kr_mobile_e164(phone_number)
            IS NOT DISTINCT FROM phone_number_normalized
  );

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
