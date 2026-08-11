-- MIGRATION_PREDECESSOR=20260808160000
-- The first paid request reached profile_ai before the worker admitted the
-- ai-stage-policy-v2.11 lease version. Its exact one-generation rearm is
-- immutable, but the generic fulfillment request creator only recognizes the
-- older schema-recovery lineage. Bridge that one audited incident and permit
-- its six settled runs to be adopted while the one settled aborted run falls
-- back to a fresh provider call.
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
                WHERE version = '20260808160000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = recovery.failed_request_id
        JOIN public.analysis_preflights AS recovery_preflight
          ON recovery_preflight.id = recovery.recovery_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = earlybird_order.preflight_id
        WHERE recovery.order_id = p_order_id
          AND recovery.failed_request_id = p_failed_request_id
          AND (
              current_preflight.id = p_recovery_preflight_id
              OR recovery.recovery_preflight_id = p_recovery_preflight_id
          )
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.error_code = failed_request.error_message
          )
          AND (
              (
                  current_preflight.id = recovery.recovery_preflight_id
                  AND current_preflight.idempotency_key =
                      'earlybird.schema-recovery.'
                      || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              )
              OR current_preflight.idempotency_key ~ (
                  '^earlybird[.]fulfillment[.]'
                  || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
                  || '([.]r[1-9])?$'
              )
          )
          AND public.analysis_v2_valid_recovery_adoption_preflights(
              earlybird_order, recovery_preflight, current_preflight
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND (
                    source_run.status NOT IN ('succeeded', 'aborted')
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                    OR (
                        source_run.status = 'aborted'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM public.earlybird_v211_lease_policy_failure_rearms
                                AS incident
                            WHERE incident.order_id = recovery.order_id
                              AND incident.failed_request_id = failed_request.id
                              AND incident.source_preflight_id =
                                  failed_request.preflight_id
                              AND incident.rearmed_preflight_id =
                                  recovery.recovery_preflight_id
                              AND incident.rearmed_preflight_id =
                                  current_preflight.id
                              AND incident.expected_fulfillment_attempt_count = 1
                              AND recovery.prior_attempt_count =
                                  incident.expected_fulfillment_attempt_count
                              AND earlybird_order.plan_id = 'basic'
                              AND earlybird_order.expected_amount_krw = 990
                              AND earlybird_order.actual_amount_krw = 990
                              AND earlybird_order.payment_id IS NOT NULL
                              AND earlybird_order.seller_reference_confirmed_at
                                  IS NOT NULL
                              AND earlybird_order.actual_groble_product_id
                                  IS NOT DISTINCT FROM
                                  earlybird_order.expected_groble_product_id
                              AND failed_request.error_message =
                                  'ANALYSIS_V2_JOB_HANDLER_FAILED'
                              AND failed_request.policy_versions_snapshot =
                                  pg_catalog.jsonb_build_object(
                                      'pipeline', 'v2',
                                      'risk', 'risk-policy-v2.5',
                                      'aiStage', 'ai-stage-policy-v2.11',
                                      'scheduler', 'ai-scheduler-v1'
                                  )
                              AND current_preflight.idempotency_key =
                                  'earlybird.fulfillment.'
                                  || pg_catalog.replace(
                                      earlybird_order.id::TEXT, '-', ''
                                  ) || '.r4'
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM public.analysis_v2_ai_attempts AS attempt
                                  WHERE attempt.request_id = failed_request.id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM public.analysis_v2_ai_result_checkpoints
                                      AS checkpoint
                                  WHERE checkpoint.request_id = failed_request.id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM public.analysis_v2_gemini_leases AS lease
                                  WHERE lease.request_id = failed_request.id
                              )
                              AND 7 = (
                                  SELECT pg_catalog.count(*)
                                  FROM public.analysis_v2_provider_runs AS provider_run
                                  WHERE provider_run.request_id = failed_request.id
                              )
                              AND 6 = (
                                  SELECT pg_catalog.count(*)
                                  FROM public.analysis_v2_provider_runs AS provider_run
                                  WHERE provider_run.request_id = failed_request.id
                                    AND provider_run.status = 'succeeded'
                                    AND provider_run.run_id IS NOT NULL
                                    AND provider_run.actual_usage_usd IS NOT NULL
                                    AND provider_run.usage_reconciled_at IS NOT NULL
                              )
                              AND 1 = (
                                  SELECT pg_catalog.count(*)
                                  FROM public.analysis_v2_provider_runs AS provider_run
                                  WHERE provider_run.request_id = failed_request.id
                                    AND provider_run.status = 'aborted'
                                    AND provider_run.run_id IS NOT NULL
                                    AND provider_run.actual_usage_usd IS NOT NULL
                                    AND provider_run.usage_reconciled_at IS NOT NULL
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM public.analysis_v2_provider_cleanup_intents
                                      AS cleanup
                                  WHERE cleanup.request_id = failed_request.id
                                    AND cleanup.completed_at IS NULL
                              )
                        )
                    )
                )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.bridge_earlybird_v211_lease_rearm_admission(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_expected_request_conflict_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    failed_request_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_user_id_hint UUID;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_incident public.earlybird_v211_lease_policy_failure_rearms%ROWTYPE;
    v_failed_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_base_request_key TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_failed_request_id IS NULL
       OR p_expected_request_conflict_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT incident.* INTO v_incident
    FROM public.earlybird_v211_lease_policy_failure_rearms AS incident
    WHERE incident.order_id = p_order_id;
    SELECT failed_request.* INTO v_failed_request
    FROM public.analysis_requests AS failed_request
    WHERE failed_request.id = p_expected_failed_request_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
    FOR UPDATE;

    v_base_request_key := 'earlybird:' || pg_catalog.lower(v_order.id::TEXT);

    IF v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM v_user_id_hint
       OR v_fulfillment.order_id IS NULL
       OR v_incident.order_id IS NULL
       OR v_failed_request.id IS NULL
       OR v_preflight.id IS NULL
       OR v_incident.failed_request_id
            IS DISTINCT FROM p_expected_failed_request_id
       OR v_incident.source_preflight_id
            IS DISTINCT FROM v_failed_request.preflight_id
       OR v_incident.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_incident.expected_fulfillment_attempt_count <> 1
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_failed_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_failed_request.pipeline_version <> 'v2'
       OR v_failed_request.status <> 'failed'
       OR v_failed_request.error_message <>
            'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_failed_request.policy_versions_snapshot <>
            pg_catalog.jsonb_build_object(
                'pipeline', 'v2',
                'risk', 'risk-policy-v2.5',
                'aiStage', 'ai-stage-policy-v2.11',
                'scheduler', 'ai-scheduler-v1'
            )
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.target_instagram_id
            IS DISTINCT FROM v_order.target_instagram_id
       OR v_preflight.idempotency_key <>
            'earlybird.fulfillment.'
            || pg_catalog.replace(v_order.id::TEXT, '-', '') || '.r4'
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_preflight.admission_target_followers_count
            IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count
            IS DISTINCT FROM v_preflight.target_following_count
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order, v_preflight, v_preflight
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_failed_request.id
              AND receipt.failed_job_key = 'track:profile-ai:batch:0'
              AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_failed_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
            WHERE checkpoint.request_id = v_failed_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.request_id = v_failed_request.id
       )
       OR 7 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_failed_request.id
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_failed_request.id
              AND provider_run.status = 'succeeded'
              AND provider_run.run_id IS NOT NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_failed_request.id
              AND provider_run.status = 'aborted'
              AND provider_run.run_id IS NOT NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_cleanup_intents AS cleanup
            WHERE cleanup.request_id = v_failed_request.id
              AND cleanup.completed_at IS NULL
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_requests AS successor
            WHERE successor.user_id = v_order.user_id
              AND successor.idempotency_key ~ (
                  '^' || v_base_request_key || '[.]r[0-9]{1,3}$'
              )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    IF v_recovery.order_id IS NULL THEN
        IF v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.status <> 'manual_review'
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.last_error_code <> 'REQUEST_CONFLICT'
           OR v_fulfillment.last_error_at
                IS DISTINCT FROM p_expected_request_conflict_at
           OR v_fulfillment.manual_review_at
                IS DISTINCT FROM p_expected_request_conflict_at
           OR v_fulfillment.lease_token IS NOT NULL
           OR v_fulfillment.lease_expires_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.earlybird_schema_failure_recoveries(
            order_id, failed_request_id, recovery_preflight_id,
            prior_attempt_count
        ) VALUES (
            v_order.id, v_incident.failed_request_id,
            v_incident.rearmed_preflight_id,
            v_incident.expected_fulfillment_attempt_count
        );
    ELSE
        IF v_recovery.failed_request_id
                IS DISTINCT FROM v_incident.failed_request_id
           OR v_recovery.recovery_preflight_id
                IS DISTINCT FROM v_incident.rearmed_preflight_id
           OR v_recovery.prior_attempt_count
                IS DISTINCT FROM v_incident.expected_fulfillment_attempt_count THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_ADMISSION_BRIDGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', attempt_count = 0,
        lease_token = NULL, lease_expires_at = NULL,
        next_attempt_at = v_now, operator_admitted_at = v_now,
        last_error_code = NULL, last_error_at = NULL,
        manual_review_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT
        v_order.id, 'admission_pending'::TEXT,
        v_preflight.id, v_failed_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_earlybird_v211_lease_rearm_admission(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bridge_earlybird_v211_lease_rearm_admission(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.bridge_earlybird_v211_lease_rearm_admission(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) IS
    'Operator-only admission bridge for the audited zero-Gemini v2.11 lease-policy incident.';
