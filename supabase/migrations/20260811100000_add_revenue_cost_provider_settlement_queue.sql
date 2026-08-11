-- A provider row can become usage-authoritative before its exact revenue child
-- is settled (for example, an invocation dies after the provider checkpoint).
-- Reuse the existing provider reconciliation claim queue so ordinary production
-- rows remain absent while the trusted test cohort receives a durable retry.
CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    WITH candidate_keys AS MATERIALIZED (
        SELECT
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key,
            revenue_child.revenue_cost_settlement_required
        FROM public.analysis_v2_provider_runs AS provider_run
        CROSS JOIN LATERAL (
            SELECT EXISTS (
                SELECT 1
                FROM public.analysis_revenue_cost_operations AS cost_operation
                INNER JOIN public.analysis_revenue_run_ledgers AS revenue_ledger
                    ON revenue_ledger.request_id = cost_operation.request_id
                WHERE cost_operation.request_id = provider_run.request_id
                  AND cost_operation.owner_kind = 'provider_run'
                  AND cost_operation.source_job_key = provider_run.job_key
                  AND cost_operation.source_operation_key_hash = pg_catalog.encode(
                      extensions.digest(
                          pg_catalog.convert_to(provider_run.operation_key, 'UTF8'),
                          'sha256'
                      ),
                      'hex'
                  )
                  AND cost_operation.source_attempt = 0
                  AND cost_operation.status IN ('reserved', 'started', 'ambiguous')
                  AND revenue_ledger.access_mode = 'test_entitlement'
                  AND revenue_ledger.plan_id IN ('basic', 'standard')
                  AND revenue_ledger.status IN ('running', 'manual_review')
            ) AS revenue_cost_settlement_required
        ) AS revenue_child
        WHERE provider_run.status IN (
                'rejected', 'succeeded', 'failed', 'aborted', 'timed_out'
            )
          AND provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'
          AND (
              (
                  provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                  AND provider_run.actual_usage_usd IS NULL
                  AND provider_run.usage_reconciled_at IS NULL
              )
              OR (
                  revenue_child.revenue_cost_settlement_required
                  AND provider_run.actual_usage_usd IS NOT NULL
                  AND provider_run.usage_reconciled_at IS NOT NULL
              )
          )
          AND (
              provider_run.usage_reconciliation_attempted_at IS NULL
              OR provider_run.usage_reconciliation_attempted_at <= v_now
                  - pg_catalog.make_interval(
                      secs => LEAST(
                          3600,
                          30 * (1 << LEAST(
                              provider_run.usage_reconciliation_attempt_count,
                              7
                          ))
                      )::DOUBLE PRECISION
                  )
          )
        ORDER BY
            provider_run.usage_reconciliation_attempted_at NULLS FIRST,
            provider_run.terminalized_at,
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        FOR UPDATE OF provider_run SKIP LOCKED
        LIMIT p_limit
    ), attempted AS (
        UPDATE public.analysis_v2_provider_runs AS provider_run
        SET usage_reconciliation_attempt_count = LEAST(
                provider_run.usage_reconciliation_attempt_count + 1,
                100000
            ),
            usage_reconciliation_attempted_at = v_now,
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE provider_run.request_id = candidate.request_id
          AND provider_run.job_key = candidate.job_key
          AND provider_run.operation_key = candidate.operation_key
        RETURNING provider_run.*
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'requestId', attempted.request_id,
                'jobKey', attempted.job_key,
                'operationKey', attempted.operation_key,
                'inputHash', attempted.input_hash,
                'reservationToken', attempted.reservation_token,
                'logicalProvider', attempted.logical_provider,
                'actorId', attempted.actor_id,
                'credentialSlot', attempted.credential_slot,
                'maxChargeUsd', attempted.max_charge_usd,
                'status', attempted.status,
                'runId', attempted.run_id,
                'actualUsageUsd', attempted.actual_usage_usd,
                'reservedAt', attempted.reserved_at,
                'runStartedAt', attempted.run_started_at,
                'terminalizedAt', attempted.terminalized_at,
                'usageReconciledAt', attempted.usage_reconciled_at,
                'revenueCostSettlementRequired',
                    candidate.revenue_cost_settlement_required
            )
            ORDER BY attempted.terminalized_at, attempted.request_id,
                attempted.job_key, attempted.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM attempted
    INNER JOIN candidate_keys AS candidate
        ON candidate.request_id = attempted.request_id
       AND candidate.job_key = attempted.job_key
       AND candidate.operation_key = attempted.operation_key;

    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER) IS
    'Claims a bounded PII-free provider-usage page and retries only exact active Basic/Standard test-entitlement revenue children after authoritative usage.';
