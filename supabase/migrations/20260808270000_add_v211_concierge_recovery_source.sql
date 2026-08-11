-- MIGRATION_PREDECESSOR=20260808260000
-- Read-only, service-role-only source for the first paid v2.11 concierge
-- recovery. The response deliberately excludes the owner UUID and retained
-- Instagram target; the target can only be recovered from the fenced Apify
-- provider ledger inside the private worker runtime.
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
                WHERE version = '20260808260000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.read_earlybird_v211_concierge_recovery_source()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_replay public.earlybird_v211_apify_transient_replays%ROWTYPE;
    v_current_request public.analysis_requests%ROWTYPE;
    v_preflight_runs JSONB;
    v_provider_runs JSONB;
    v_scheduler_operations JSONB;
BEGIN
    IF 1 <> (
        SELECT pg_catalog.count(*)
        FROM public.earlybird_v211_apify_transient_replays
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_NOT_EXACT',
            ERRCODE = 'P0001';
    END IF;

    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_apify_transient_replays AS replay
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = replay.order_id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = replay.order_id
    JOIN public.analysis_requests AS current_request
      ON current_request.id = fulfillment.request_id
    WHERE earlybird_order.plan_id = 'basic'
      AND earlybird_order.expected_amount_krw = 990
      AND earlybird_order.actual_amount_krw = 990
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_groble_product_id
            IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = current_request.id
      AND fulfillment.status = 'manual_review'
      AND fulfillment.request_id = current_request.id
      AND fulfillment.last_error_code = 'ANALYSIS_FAILED'
      AND current_request.pipeline_version = 'v2'
      AND current_request.status = 'failed'
      AND current_request.current_step = 'failed'
      AND NOT current_request.background_processing
      AND current_request.error_message = 'SCRAPING_INCOMPLETE_ERROR'
      AND current_request.policy_versions_snapshot = pg_catalog.jsonb_build_object(
            'pipeline', 'v2',
            'risk', 'risk-policy-v2.5',
            'aiStage', 'ai-stage-policy-v2.11',
            'scheduler', 'ai-scheduler-v1'
      )
      AND 1 = (
          SELECT pg_catalog.count(*)
          FROM public.analysis_v2_failure_receipts AS receipt
          WHERE receipt.request_id = current_request.id
            AND receipt.failed_job_key = 'track:relationships:collect'
            AND receipt.error_code = 'SCRAPING_INCOMPLETE_ERROR'
      )
      AND 1 = (
          SELECT pg_catalog.count(*)
          FROM public.analysis_v2_failure_receipts AS receipt
          WHERE receipt.request_id = current_request.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_result_summaries AS summary
          WHERE summary.request_id IN (
              replay.original_failed_request_id,
              replay.policy_identity_failed_request_id,
              replay.transient_failed_request_id,
              current_request.id
          )
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT current_request.* INTO v_current_request
    FROM public.earlybird_fulfillments AS fulfillment
    JOIN public.analysis_requests AS current_request
      ON current_request.id = fulfillment.request_id
    WHERE fulfillment.order_id = v_replay.order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    WITH incident_requests(request_id, source_label, source_ordinal) AS (
        VALUES
            (v_replay.original_failed_request_id, 'original'::TEXT, 1),
            (v_replay.policy_identity_failed_request_id, 'policy'::TEXT, 2),
            (v_replay.transient_failed_request_id, 'transient'::TEXT, 3),
            (v_current_request.id, 'last'::TEXT, 4)
    ), incident_preflights AS (
        SELECT incident.source_label, incident.source_ordinal,
               request.preflight_id
        FROM incident_requests AS incident
        JOIN public.analysis_requests AS request
          ON request.id = incident.request_id
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'sourceLabel', incident.source_label,
        'actorId', run.actor_id,
        'credentialSlot', run.credential_slot,
        'runId', run.run_id,
        'ledgerStatus', run.status,
        'operationKey', run.operation_key
    ) ORDER BY incident.source_ordinal, run.operation_key)
    INTO v_preflight_runs
    FROM incident_preflights AS incident
    JOIN public.analysis_preflight_provider_runs AS run
      ON run.preflight_id = incident.preflight_id
    WHERE run.logical_provider = 'apify'
      AND run.run_id IS NOT NULL
      AND run.actual_usage_usd IS NOT NULL
      AND run.usage_reconciled_at IS NOT NULL;

    WITH incident_requests(request_id, source_label, source_ordinal) AS (
        VALUES
            (v_replay.original_failed_request_id, 'original'::TEXT, 1),
            (v_replay.policy_identity_failed_request_id, 'policy'::TEXT, 2),
            (v_replay.transient_failed_request_id, 'transient'::TEXT, 3),
            (v_current_request.id, 'last'::TEXT, 4)
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'sourceLabel', incident.source_label,
        'jobKey', run.job_key,
        'actorId', run.actor_id,
        'credentialSlot', run.credential_slot,
        'runId', run.run_id,
        'ledgerStatus', run.status,
        'operationKey', run.operation_key
    ) ORDER BY incident.source_ordinal, run.job_key, run.operation_key)
    INTO v_provider_runs
    FROM incident_requests AS incident
    JOIN public.analysis_v2_provider_runs AS run
      ON run.request_id = incident.request_id
    WHERE run.logical_provider = 'apify'
      AND run.run_id IS NOT NULL
      AND run.actual_usage_usd IS NOT NULL
      AND run.usage_reconciled_at IS NOT NULL;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'jobKey', operation.job_key,
        'operationKey', operation.operation_key,
        'stage', operation.stage,
        'status', operation.status,
        'result', operation.result_json
    ) ORDER BY operation.stage, operation.job_key, operation.operation_key)
    INTO v_scheduler_operations
    FROM public.analysis_v2_scheduler_operations AS operation
    WHERE operation.request_id = v_replay.transient_failed_request_id
      AND operation.status = 'ready'
      AND operation.result_json IS NOT NULL
      AND operation.completed_at IS NOT NULL;

    IF pg_catalog.jsonb_array_length(COALESCE(v_preflight_runs, '[]'::JSONB)) < 1
       OR pg_catalog.jsonb_array_length(COALESCE(v_provider_runs, '[]'::JSONB)) < 1
       OR pg_catalog.jsonb_array_length(
            COALESCE(v_scheduler_operations, '[]'::JSONB)
          ) <> 22 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs,
        'schedulerOperations', v_scheduler_operations
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_recovery_source()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_recovery_source()
    TO service_role;

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.read_earlybird_v211_concierge_recovery_source()';
BEGIN
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_CONCIERGE_SOURCE_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
