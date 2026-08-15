-- MIGRATION_PREDECESSOR=20260815180000
-- Read-only recovery lineage boundary. The table itself deliberately remains
-- inaccessible to service_role; this bounded function exposes only the fields
-- required to resume an already-recorded first15 canary fallback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815180000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_REARM_READ_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

CREATE FUNCTION public.list_earlybird_first15_canary_provider_rearms()
RETURNS TABLE(
    order_id UUID,
    rearmed_preflight_id UUID,
    rearm_generation SMALLINT,
    source_failure_code TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT rearm.order_id,
        rearm.rearmed_preflight_id,
        rearm.rearm_generation,
        rearm.source_failure_code
    FROM public.earlybird_first15_canary_provider_rearms AS rearm
    ORDER BY rearm.created_at, rearm.order_id, rearm.rearm_generation
    LIMIT 13;
$$;

REVOKE ALL ON FUNCTION public.list_earlybird_first15_canary_provider_rearms()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_earlybird_first15_canary_provider_rearms()
    TO service_role;

COMMIT;
