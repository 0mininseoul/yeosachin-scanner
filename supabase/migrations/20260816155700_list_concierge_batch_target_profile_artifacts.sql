-- Keep the concierge runner on the provider ledger's RPC-only boundary. The
-- returned fields are the bounded, PII-free identity needed to reuse a
-- succeeded target-profile dataset; no raw dataset or target handle leaves
-- the database.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.list_concierge_batch_target_profile_artifacts(
    p_preflight_id UUID
)
RETURNS TABLE(
    operation_key TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    run_id TEXT,
    status TEXT
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT provider_run.operation_key::TEXT,
        provider_run.actor_id::TEXT,
        provider_run.credential_slot::TEXT,
        provider_run.run_id::TEXT,
        provider_run.status::TEXT
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.status = 'succeeded'
      AND provider_run.operation_key LIKE 'target-profile%'
    ORDER BY provider_run.operation_key DESC
    LIMIT 8;
$$;

REVOKE ALL ON FUNCTION public.list_concierge_batch_target_profile_artifacts(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_concierge_batch_target_profile_artifacts(UUID)
    TO service_role;

COMMENT ON FUNCTION public.list_concierge_batch_target_profile_artifacts(UUID) IS
    'Service-role-only bounded target-profile provider identity lookup for the concierge runner; raw ledger tables remain RPC-only.';

COMMIT;
