-- MIGRATION_PREDECESSOR=20260813233100
-- Keep the completion precheck RPC-only for the two intentionally unexposed
-- ledgers.  The service-role script must never use REST table reads here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    p_order_id UUID,
    p_preflight_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE,
    p_expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE
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
       OR v_recovery.order_id IS NULL
       OR v_recovery.expected_manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_recovery.expected_admission_refreshed_at
            IS DISTINCT FROM p_expected_admission_refreshed_at THEN
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
        'provider_runs', COALESCE(v_provider_runs, '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.inspect_earlybird_concierge_snapshot_conflict_precheck(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) IS 'Service-role-only RPC snapshot for the exact concierge completion precheck; restricted ledgers remain RPC-only.';

COMMIT;
