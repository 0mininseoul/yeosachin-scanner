-- MIGRATION_PREDECESSOR=20260808180000
-- The first v2.11 successor was admitted with fresh counts, but the exact
-- provider-run resolver still required the recorded fulfillment preflight to
-- have the older fully-expired tombstone shape. It therefore failed before
-- any provider adoption, new provider run, or AI call. Preserve that terminal
-- request and admit one audited r5 preflight while narrowly extending the
-- resolver/readiness fences for this single paid incident.
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
                WHERE version = '20260808180000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_relationship_lineage_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    relationship_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    source_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_v211_relationship_lineage_failure_rearms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_relationship_lineage_failure_rearms
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_relationship_lineage_failure_rearms
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_relationship_lineage_rearm_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_v211_relationship_lineage_failure_rearms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.earlybird_v211_relationship_lineage_rearm_ready(
    p_order_id UUID,
    p_original_failed_request_id UUID,
    p_source_preflight_id UUID,
    p_current_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_v211_relationship_lineage_failure_rearms AS rearm
        JOIN public.earlybird_v211_lease_policy_failure_rearms AS incident
          ON incident.order_id = rearm.order_id
         AND incident.failed_request_id = rearm.original_failed_request_id
         AND incident.rearmed_preflight_id = rearm.source_preflight_id
        JOIN public.earlybird_schema_failure_recoveries AS recovery
          ON recovery.order_id = rearm.order_id
         AND recovery.failed_request_id = rearm.original_failed_request_id
         AND recovery.recovery_preflight_id = rearm.source_preflight_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = rearm.order_id
        JOIN public.analysis_requests AS original_request
          ON original_request.id = rearm.original_failed_request_id
        JOIN public.analysis_requests AS relationship_request
          ON relationship_request.id = rearm.relationship_failed_request_id
        JOIN public.analysis_preflights AS source_preflight
          ON source_preflight.id = rearm.source_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = rearm.rearmed_preflight_id
        WHERE rearm.order_id = p_order_id
          AND rearm.original_failed_request_id = p_original_failed_request_id
          AND rearm.source_preflight_id = p_source_preflight_id
          AND rearm.rearmed_preflight_id = p_current_preflight_id
          AND rearm.expected_fulfillment_attempt_count = 1
          AND recovery.prior_attempt_count = 1
          AND earlybird_order.preflight_id = current_preflight.id
          AND earlybird_order.user_id = current_preflight.user_id
          AND earlybird_order.plan_id = 'basic'
          AND earlybird_order.expected_amount_krw = 990
          AND earlybird_order.actual_amount_krw = 990
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.actual_groble_product_id
                IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND original_request.user_id = earlybird_order.user_id
          AND original_request.preflight_id = incident.source_preflight_id
          AND original_request.pipeline_version = 'v2'
          AND original_request.status = 'failed'
          AND original_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND original_request.policy_versions_snapshot =
                pg_catalog.jsonb_build_object(
                    'pipeline', 'v2',
                    'risk', 'risk-policy-v2.5',
                    'aiStage', 'ai-stage-policy-v2.11',
                    'scheduler', 'ai-scheduler-v1'
                )
          AND relationship_request.user_id = earlybird_order.user_id
          AND relationship_request.preflight_id = source_preflight.id
          AND relationship_request.pipeline_version = 'v2'
          AND relationship_request.status = 'failed'
          AND relationship_request.error_message =
                'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND relationship_request.idempotency_key =
                'earlybird:' || pg_catalog.lower(earlybird_order.id::TEXT) || '.r1'
          AND source_preflight.user_id = earlybird_order.user_id
          AND source_preflight.status = 'consumed'
          AND source_preflight.consumed_request_id = relationship_request.id
          AND source_preflight.pii_scrubbed_at IS NOT NULL
          AND source_preflight.target_instagram_id =
                'retained.' || pg_catalog.substr(
                    pg_catalog.replace(source_preflight.id::TEXT, '-', ''), 1, 20
                )
          AND source_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r4'
          AND source_preflight.admission_status = 'ready'
          AND source_preflight.admission_selected_plan_id = 'basic'
          AND current_preflight.user_id = earlybird_order.user_id
          AND current_preflight.access_mode = 'production'
          AND current_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r5'
          AND current_preflight.status IN ('ready', 'consumed')
          AND current_preflight.admission_status = 'ready'
          AND current_preflight.admission_selected_plan_id = 'basic'
          AND current_preflight.target_instagram_id =
                earlybird_order.target_instagram_id
          AND current_preflight.launch_status_snapshot =
                source_preflight.launch_status_snapshot
          AND current_preflight.plan_catalog_snapshot =
                source_preflight.plan_catalog_snapshot
          AND current_preflight.pricing_version = source_preflight.pricing_version
          AND current_preflight.pricing_snapshot = source_preflight.pricing_snapshot
          AND current_preflight.policy_versions_snapshot =
                source_preflight.policy_versions_snapshot
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = relationship_request.id
                AND receipt.failed_job_key = 'track:relationships:collect'
                AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND 3 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = relationship_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = relationship_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
              WHERE adoption.request_id = relationship_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_provider_cost_ledger AS cost
              WHERE cost.request_id = relationship_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = relationship_request.id
          )
          AND 7 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = original_request.id
          )
          AND 6 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = original_request.id
                AND provider_run.status = 'succeeded'
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = original_request.id
                AND provider_run.status = 'aborted'
                AND provider_run.job_key = 'track:profiles:batch:4'
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = original_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
              WHERE checkpoint.request_id = original_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_gemini_leases AS lease
              WHERE lease.request_id = original_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = original_request.id
                AND cleanup.completed_at IS NULL
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_v211_relationship_lineage_rearm_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

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
                              AND (
                                  (
                                      incident.rearmed_preflight_id =
                                          current_preflight.id
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r4'
                                  )
                                  OR (
                                      public.earlybird_v211_relationship_lineage_rearm_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r5'
                                  )
                              )
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

DO $resolver_patch$
DECLARE
    v_signature TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_security_definer BOOLEAN;
    v_safe_search_path BOOLEAN;
    v_expected_old_hash CONSTANT TEXT := '22148370781f6479115b20564ee3d0cb';
    v_old TEXT := $old$            )
            AND (
                v_recovery_preflight.status <> 'expired'$old$;
    v_new TEXT := $new$            )
            AND NOT public.earlybird_v211_relationship_lineage_rearm_ready(
                v_order.id, v_recovery.failed_request_id,
                v_recovery_preflight.id, v_current_preflight.id
            )
            AND (
                v_recovery_preflight.status <> 'expired'$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(proc.oid), proc.prosecdef,
        COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
    INTO v_definition, v_security_definer, v_safe_search_path
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;

    IF NOT COALESCE(v_security_definer, FALSE)
       OR NOT COALESCE(v_safe_search_path, FALSE)
       OR pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            v_definition,
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'public.analysis_v2_valid_recovery_adoption_preflights'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_source.status <> ''succeeded'''
       ) = 0 THEN
        RAISE EXCEPTION
            'ANALYSIS_V2_V211_RELATIONSHIP_EXACT_RESOLVER_OLD_SHAPE_MISMATCH';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_v211_relationship_lineage_rearm_ready('
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'public.analysis_v2_valid_recovery_adoption_preflights'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'v_source.status <> ''succeeded'''
       ) = 0 THEN
        RAISE EXCEPTION
            'ANALYSIS_V2_V211_RELATIONSHIP_EXACT_RESOLVER_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$resolver_patch$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rearm_earlybird_v211_relationship_lineage_failure(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
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
    v_request public.analysis_requests%ROWTYPE;
    v_original_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_source_preflight public.analysis_preflights%ROWTYPE;
    v_normalized_preflight public.analysis_preflights%ROWTYPE;
    v_incident public.earlybird_v211_lease_policy_failure_rearms%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_existing public.earlybird_v211_relationship_lineage_failure_rearms%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT audit.* INTO v_existing
    FROM public.earlybird_v211_relationship_lineage_failure_rearms AS audit
    WHERE audit.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id
        FOR UPDATE;
        IF v_existing.relationship_failed_request_id
                IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at
           OR v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status NOT IN ('paid', 'analysis_in_progress', 'completed')
           OR v_order.payment_id IS NULL
           OR v_order.seller_reference_confirmed_at IS NULL
           OR v_order.actual_amount_krw <> 990
           OR v_fulfillment.status NOT IN (
                'admission_pending', 'retryable_failure',
                'analysis_in_progress', 'completed', 'manual_review'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_existing.rearmed_preflight_id,
            v_existing.relationship_failed_request_id;
        RETURN;
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT incident.* INTO v_incident
    FROM public.earlybird_v211_lease_policy_failure_rearms AS incident
    WHERE incident.order_id = p_order_id
    FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
    FOR UPDATE;
    SELECT request.* INTO v_original_request
    FROM public.analysis_requests AS request
    WHERE request.id = v_recovery.failed_request_id
    FOR UPDATE;
    SELECT preflight.* INTO v_source_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_original_request.preflight_id
    FOR UPDATE;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_normalized_preflight := v_preflight;
    v_normalized_preflight.target_instagram_id := v_order.target_instagram_id;
    v_normalized_preflight.exclusion_decision := v_order.exclusion_decision;
    v_normalized_preflight.excluded_instagram_id := v_order.excluded_instagram_id;

    IF v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM v_user_id_hint
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.order_id IS NULL
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.attempt_count <> 1
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.operator_admitted_at IS NULL
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_incident.order_id IS NULL
       OR v_incident.failed_request_id IS DISTINCT FROM v_original_request.id
       OR v_incident.source_preflight_id IS DISTINCT FROM v_source_preflight.id
       OR v_incident.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_incident.expected_fulfillment_attempt_count <> 1
       OR v_recovery.order_id IS NULL
       OR v_recovery.failed_request_id IS DISTINCT FROM v_original_request.id
       OR v_recovery.recovery_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_recovery.prior_attempt_count <> 1
       OR v_original_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_original_request.pipeline_version <> 'v2'
       OR v_original_request.status <> 'failed'
       OR v_original_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_original_request.policy_versions_snapshot <>
            pg_catalog.jsonb_build_object(
                'pipeline', 'v2',
                'risk', 'risk-policy-v2.5',
                'aiStage', 'ai-stage-policy-v2.11',
                'scheduler', 'ai-scheduler-v1'
            )
       OR v_request.id IS NULL
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.background_processing
       OR v_request.current_step <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_request.completed_at IS NULL
       OR v_request.idempotency_key IS DISTINCT FROM
            ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r1')
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.id IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.idempotency_key IS DISTINCT FROM
            (v_base_preflight_key || '.r4')
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_is_private IS DISTINCT FROM FALSE
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_preflight.admission_target_followers_count
            IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count
            IS DISTINCT FROM v_preflight.target_following_count
       OR v_preflight.capacity_required_plan_id IS DISTINCT FROM 'basic'
       OR v_preflight.required_plan_id IS DISTINCT FROM 'basic'
       OR v_preflight.exclusion_decision
            IS DISTINCT FROM v_order.exclusion_decision
       OR v_preflight.excluded_instagram_id
            IS DISTINCT FROM v_order.excluded_instagram_id
       OR NOT public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            v_preflight.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
       )
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order, v_preflight, v_normalized_preflight
       )
       OR NOT public.analysis_v2_valid_source_adoption_preflights(
            v_order, v_preflight, v_source_preflight,
            v_normalized_preflight, v_original_request.id, v_request.id
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.failed_job_key = 'track:relationships:collect'
              AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
       )
       OR 3 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'coordinator:bootstrap'
              AND job.track = 'coordinator'
              AND job.kind = 'bootstrap'
              AND job.status = 'completed'
              AND job.attempt_count = 1
              AND job.last_error_code IS NULL
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:relationships:collect'
              AND job.track = 'relationships'
              AND job.kind = 'collection'
              AND job.status = 'failed'
              AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:target-evidence:collect'
              AND job.track = 'target_evidence'
              AND job.kind = 'collection'
              AND job.status = 'cancelled'
              AND job.attempt_count = 1
              AND job.last_error_code = 'REQUEST_TERMINATED'
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status IN ('pending', 'processing', 'retryable')
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_provider_cost_ledger AS cost
            WHERE cost.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
            WHERE checkpoint.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_relationship_sides AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_target_evidence_manifests AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR 7 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_original_request.id
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_original_request.id
              AND provider_run.status = 'succeeded'
              AND provider_run.run_id IS NOT NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_original_request.id
              AND provider_run.status = 'aborted'
              AND provider_run.job_key = 'track:profiles:batch:4'
              AND provider_run.run_id IS NOT NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_original_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
            WHERE checkpoint.request_id = v_original_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.request_id = v_original_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_cleanup_intents AS cleanup
            WHERE cleanup.request_id = v_original_request.id
              AND cleanup.completed_at IS NULL
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflights AS next_preflight
            WHERE next_preflight.user_id = v_order.user_id
              AND next_preflight.idempotency_key = v_base_preflight_key || '.r5'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_RELATIONSHIP_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r5',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_preflight.target_followers_count, v_preflight.target_following_count,
        FALSE, v_preflight.capacity_required_plan_id, v_preflight.required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now
    );

    INSERT INTO public.earlybird_v211_relationship_lineage_failure_rearms(
        order_id, original_failed_request_id, relationship_failed_request_id,
        source_preflight_id, rearmed_preflight_id,
        expected_fulfillment_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_original_request.id, v_request.id,
        v_preflight.id, v_new_preflight_id,
        v_fulfillment.attempt_count, p_expected_manual_review_at
    );

    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'paid', preflight_id = v_new_preflight_id,
        result_request_id = NULL, updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', attempt_count = 0, request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        operator_admitted_at = v_now, last_error_code = NULL,
        last_error_at = NULL, manual_review_at = NULL,
        completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT
        v_order.id, 'admission_pending'::TEXT,
        v_new_preflight_id, v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_relationship_lineage_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_relationship_lineage_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.rearm_earlybird_v211_relationship_lineage_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) IS
    'Operator-only one-generation rearm for the zero-side-effect v2.11 relationship lineage failure.';

DO $final_guard$
DECLARE
    v_ready_signature TEXT :=
        'public.earlybird_v211_relationship_lineage_rearm_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_adoption_signature TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_exact_signature TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_rearm_signature TEXT :=
        'public.rearm_earlybird_v211_relationship_lineage_failure('
        || 'uuid,uuid,timestamp with time zone)';
    v_definition TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_exact_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(
            v_definition,
            'public.earlybird_v211_relationship_lineage_rearm_ready('
       ) = 0
       OR pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(
                v_adoption_signature::pg_catalog.regprocedure
            ),
            'public.earlybird_v211_relationship_lineage_rearm_ready('
       ) = 0
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid IN (
                v_ready_signature::pg_catalog.regprocedure,
                v_adoption_signature::pg_catalog.regprocedure,
                v_exact_signature::pg_catalog.regprocedure,
                v_rearm_signature::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_rearm_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
            'authenticated', v_rearm_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_rearm_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_ready_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_adoption_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_exact_signature, 'EXECUTE'
       ) THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_RELATIONSHIP_REARM_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
