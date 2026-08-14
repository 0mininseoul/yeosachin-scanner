-- MIGRATION_PREDECESSOR=20260813233100
-- Keep the completion precheck RPC-only for the two intentionally unexposed
-- ledgers.  The service-role script must never use REST table reads here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260813233100'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_PRECHECK_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    p_order_id UUID,
    p_preflight_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE,
    p_expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_recovery public.earlybird_concierge_snapshot_conflict_recoveries%ROWTYPE;
    v_order_preflight_id UUID;
    v_provider_runs JSONB;
    v_active_request_count INTEGER;
    v_active_job_count INTEGER;
BEGIN
    IF p_order_id IS NULL
       OR p_preflight_id IS NULL
       OR p_expected_manual_review_at IS NULL
       OR p_expected_admission_refreshed_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_PRECHECK_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.preflight_id
    INTO v_order_preflight_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id;
    SELECT fulfillment.*
    INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id;
    SELECT recovery.*
    INTO v_recovery
    FROM public.earlybird_concierge_snapshot_conflict_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
      AND recovery.preflight_id = p_preflight_id;
    IF v_order_preflight_id IS NULL
       OR v_order_preflight_id IS DISTINCT FROM p_preflight_id
       OR v_preflight.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR (
            v_recovery.order_id IS NOT NULL
            AND (
                v_recovery.expected_manual_review_at
                    IS DISTINCT FROM p_expected_manual_review_at
                OR v_recovery.expected_admission_refreshed_at
                    IS DISTINCT FROM p_expected_admission_refreshed_at
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_PRECHECK_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'operation_key', provider_run.operation_key,
            'input_hash', provider_run.input_hash,
            'logical_provider', provider_run.logical_provider,
            'actor_id', provider_run.actor_id,
            'credential_slot', provider_run.credential_slot,
            'status', provider_run.status,
            'run_id', provider_run.run_id,
            'terminalized_at', provider_run.terminalized_at,
            'actual_usage_usd', provider_run.actual_usage_usd,
            'usage_reconciled_at', provider_run.usage_reconciled_at,
            'reusable_profile_schema_version', 1
        ) ORDER BY provider_run.operation_key
    )
    INTO v_provider_runs
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key IN (
          'target-profile-fresh-admission:g1',
          'target-profile-fresh-admission:g2',
          'target-profile-fresh-admission:g3'
      );

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_request_count
    FROM public.analysis_requests AS request
    WHERE request.preflight_id = p_preflight_id
      AND request.status IN ('pending', 'processing')
      AND (p_request_id IS NULL OR request.id IS DISTINCT FROM p_request_id)
      AND EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS local_order
          WHERE local_order.id = p_order_id
            AND local_order.preflight_id = request.preflight_id
      );

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_active_job_count
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS request
      ON request.id = job.request_id
    WHERE request.preflight_id = p_preflight_id
      AND job.status IN ('pending', 'processing')
      AND (p_request_id IS NULL OR request.id IS DISTINCT FROM p_request_id)
      AND EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS local_order
          WHERE local_order.id = p_order_id
            AND local_order.preflight_id = request.preflight_id
      );

    RETURN pg_catalog.jsonb_build_object(
        'fulfillment', pg_catalog.jsonb_build_object(
            'status', v_fulfillment.status,
            'request_id', v_fulfillment.request_id,
            'lease_token', v_fulfillment.lease_token,
            'lease_expires_at', v_fulfillment.lease_expires_at,
            'manual_review_at', v_fulfillment.manual_review_at,
            'last_error_code', v_fulfillment.last_error_code,
            'attempt_count', v_fulfillment.attempt_count
        ),
        'provider_runs', COALESCE(v_provider_runs, '[]'::JSONB),
        'active_request_count', v_active_request_count,
        'active_job_count', v_active_job_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, UUID
) TO service_role;

COMMENT ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, UUID
) IS 'Service-role-only RPC snapshot for the exact concierge completion precheck; restricted ledgers remain RPC-only.';

DO $completion_precheck_acl$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.inspect_earlybird_concierge_snapshot_conflict_precheck(uuid,uuid,timestamp with time zone,timestamp with time zone,uuid)';
    v_definition TEXT;
    v_security_definer BOOLEAN;
BEGIN
    SELECT proc.prosecdef, pg_catalog.pg_get_functiondef(proc.oid)
    INTO v_security_definer, v_definition
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;
    IF NOT COALESCE(v_security_definer, FALSE)
       OR pg_catalog.strpos(COALESCE(v_definition, ''), 'SET search_path TO ''''') = 0
       OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR pg_catalog.has_table_privilege(
            'service_role', 'public.earlybird_fulfillments', 'SELECT'
       )
       OR pg_catalog.has_table_privilege(
            'service_role', 'public.analysis_preflight_provider_runs', 'SELECT'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_PRECHECK_RPC_ACL_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$completion_precheck_acl$;

COMMIT;
