-- The order-scoped slot check is evaluated by the caller-owned anonymous
-- preflight INSERT. The validator is immutable and only compares a bounded
-- allowlist, so exposing EXECUTE does not grant table access.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    TO anon, authenticated;

COMMIT;
