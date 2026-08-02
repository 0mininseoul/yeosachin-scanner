-- Aggregate-only operational visibility for the betatest Apify credit pool.
-- No row identity, user/request/preflight ID, provider account identity, or
-- credential detail crosses this service-role boundary.
DO $migration_transaction_fence$
BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM pg_catalog.set_config('statement_timeout', '2min', true);
END;
$migration_transaction_fence$;

CREATE INDEX IF NOT EXISTS idx_analysis_beta_pool_allocations_observability
    ON public.analysis_beta_pool_allocations(lifecycle_state, updated_at)
    WHERE lifecycle_state IN ('preflight_held', 'active');

CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_pool_observability(
    p_max_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '5s'
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_result JSONB;
BEGIN
    IF p_max_age_seconds IS NULL
       OR p_max_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_OBSERVABILITY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH required_slots(credential_slot) AS (
        VALUES ('primary'::TEXT), ('tertiary'::TEXT),
               ('quaternary'::TEXT), ('quinary'::TEXT),
               ('senary'::TEXT), ('septenary'::TEXT)
    ), capacity AS (
        SELECT effective.credential_slot,
               effective.effective_capacity_usd
        FROM public.analysis_beta_pool_effective_capacity_snapshot() AS effective
    ), snapshot_health AS (
        SELECT pg_catalog.count(*) FILTER (
            WHERE snapshot.credential_slot IS NULL
               OR snapshot.health_state IS DISTINCT FROM 'healthy'
               OR snapshot.monthly_limit_usd IS NULL
               OR snapshot.monthly_usage_usd IS NULL
               OR snapshot.observed_at IS NULL
               OR snapshot.billing_cycle_start_at IS NULL
               OR snapshot.billing_cycle_end_at IS NULL
               OR snapshot.observed_at < v_now - pg_catalog.make_interval(
                    secs => p_max_age_seconds
                  )
               OR snapshot.observed_at > v_now + INTERVAL '1 minute'
               OR snapshot.billing_cycle_start_at > v_now
               OR snapshot.billing_cycle_end_at <= v_now
        )::INTEGER AS stale_snapshot_count
        FROM required_slots
        LEFT JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = required_slots.credential_slot
    ), capacity_health AS (
        SELECT COALESCE(pg_catalog.sum(
                   GREATEST(COALESCE(capacity.effective_capacity_usd, 0), 0)
               ), 0::NUMERIC) AS total_effective_headroom_usd,
               pg_catalog.count(*) FILTER (
                   WHERE capacity.effective_capacity_usd < 0
               )::INTEGER AS overcommitted_slot_count
        FROM required_slots
        LEFT JOIN capacity
          ON capacity.credential_slot = required_slots.credential_slot
    ), allocation_health AS (
        SELECT pg_catalog.count(*) FILTER (
            WHERE allocation.lifecycle_state IN ('preflight_held', 'active')
        )::INTEGER AS active_allocation_count
        FROM public.analysis_beta_pool_allocations AS allocation
    ), terminal_unsettled AS (
        SELECT COALESCE(request.completed_at, allocation.updated_at) AS terminal_at
        FROM public.analysis_beta_pool_allocations AS allocation
        JOIN public.analysis_requests AS request
          ON request.id = allocation.request_id
        WHERE allocation.lifecycle_state = 'active'
          AND request.status IN ('completed', 'failed')
        UNION ALL
        SELECT COALESCE(
                   preflight.blocked_at,
                   CASE WHEN preflight.expires_at <= v_now
                        THEN preflight.expires_at END,
                   preflight.updated_at,
                   allocation.updated_at
               ) AS terminal_at
        FROM public.analysis_beta_pool_allocations AS allocation
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = allocation.preflight_id
        WHERE allocation.lifecycle_state = 'preflight_held'
          AND (
              preflight.status IN ('blocked', 'expired')
              OR preflight.expires_at <= v_now
          )
    ), settlement_health AS (
        SELECT COALESCE(
            pg_catalog.floor(LEAST(
                GREATEST(
                    EXTRACT(
                        EPOCH FROM (v_now - pg_catalog.min(terminal_at))
                    )
                        * 1000,
                    0
                ),
                31536000000
            )
            ), 0
        )::BIGINT AS settlement_lag_ms
        FROM terminal_unsettled
    )
    SELECT pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'observedAt', v_now,
        'runtimeEnabled', COALESCE((
            SELECT gate_row.enabled
            FROM public.analysis_beta_runtime_gate AS gate_row
            WHERE gate_row.singleton = TRUE
        ), FALSE),
        'totalEffectiveHeadroomUsd', capacity_health.total_effective_headroom_usd,
        'staleSnapshotCount', snapshot_health.stale_snapshot_count,
        'activeAllocationCount', allocation_health.active_allocation_count,
        'settlementLagMs', settlement_health.settlement_lag_ms,
        'overcommittedSlotCount', capacity_health.overcommitted_slot_count
    )
    INTO v_result
    FROM snapshot_health
    CROSS JOIN capacity_health
    CROSS JOIN allocation_health
    CROSS JOIN settlement_health;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_pool_observability(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_pool_observability(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_beta_apify_pool_observability(INTEGER) IS
    'Service-only aggregate betatest pool health. Returns no row, user, provider-account, or credential identity.';
