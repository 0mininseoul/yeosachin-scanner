-- MIGRATION_PREDECESSOR=20260815190000
-- Preserve the provider-run ledger's RPC-only boundary while exposing the
-- bounded fields needed to reconcile the already-selected first15 canaries.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815190000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_PROVIDER_READ_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

CREATE FUNCTION public.list_earlybird_first15_canary_provider_runs(
    p_request_ids UUID[]
)
RETURNS TABLE(
    request_id UUID,
    job_key TEXT,
    operation_key TEXT,
    input_hash TEXT,
    reservation_token UUID,
    logical_provider TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    max_charge_usd NUMERIC,
    status TEXT,
    run_id TEXT,
    actual_usage_usd NUMERIC,
    reserved_at TIMESTAMP WITH TIME ZONE,
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request_count INTEGER;
BEGIN
    v_request_count := pg_catalog.cardinality(p_request_ids);
    IF p_request_ids IS NULL
       OR v_request_count NOT BETWEEN 1 AND 3
       OR EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(p_request_ids) AS requested(request_id)
           WHERE requested.request_id IS NULL
       )
       OR (
           SELECT pg_catalog.count(DISTINCT requested.request_id)
           FROM pg_catalog.unnest(p_request_ids) AS requested(request_id)
       ) <> v_request_count
       OR (
           SELECT pg_catalog.count(*)
           FROM public.list_earlybird_first15_canary_provider_recovery_candidates() AS candidate
           WHERE candidate.request_id = ANY (p_request_ids)
       ) <> v_request_count
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_PROVIDER_READ_SCOPE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT provider_run.request_id,
        provider_run.job_key::TEXT,
        provider_run.operation_key::TEXT,
        provider_run.input_hash::TEXT,
        provider_run.reservation_token,
        provider_run.logical_provider::TEXT,
        provider_run.actor_id::TEXT,
        provider_run.credential_slot::TEXT,
        provider_run.max_charge_usd,
        provider_run.status::TEXT,
        provider_run.run_id::TEXT,
        provider_run.actual_usage_usd,
        provider_run.reserved_at,
        provider_run.run_started_at,
        provider_run.terminalized_at,
        provider_run.usage_reconciled_at
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = ANY (p_request_ids)
    ORDER BY provider_run.request_id, provider_run.job_key, provider_run.operation_key
    LIMIT 64;
END;
$$;

REVOKE ALL ON FUNCTION public.list_earlybird_first15_canary_provider_runs(UUID[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_earlybird_first15_canary_provider_runs(UUID[])
    TO service_role;

COMMIT;
