-- MIGRATION_PREDECESSOR=20260808150000
-- Preserve the terminal first-payment request and admit one clean replacement
-- after the worker's v2.11 Gemini lease-policy allowlist has been corrected.
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
                WHERE version = '20260808150000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_lease_policy_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    source_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count BETWEEN 0 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_v211_lease_policy_failure_rearms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_lease_policy_failure_rearms
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_lease_policy_failure_rearms
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_lease_policy_failure_rearm_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_v211_lease_policy_failure_rearms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.rearm_earlybird_v211_lease_policy_failure(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    failed_request_id UUID,
    request_id UUID
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
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_v211_lease_policy_failure_rearms%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_user_id_hint THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT audit.* INTO v_existing
    FROM public.earlybird_v211_lease_policy_failure_rearms AS audit
    WHERE audit.order_id = p_order_id;
    IF FOUND THEN
        IF v_existing.failed_request_id IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at
           OR v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status NOT IN ('paid', 'analysis_in_progress', 'completed')
           OR v_order.seller_reference_confirmed_at IS NULL
           OR v_order.payment_id IS NULL
           OR v_order.actual_amount_krw <> 990
           OR v_order.actual_groble_product_id
                IS DISTINCT FROM v_order.expected_groble_product_id
           OR v_fulfillment.status NOT IN (
                'admission_pending', 'retryable_failure',
                'analysis_in_progress', 'completed', 'manual_review'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_existing.rearmed_preflight_id,
            v_existing.failed_request_id, v_fulfillment.request_id;
        RETURN;
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');

    IF v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.attempt_count <> 1
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.operator_admitted_at IS NULL
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_request.id IS NULL
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.background_processing
       OR v_request.current_step <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_request.completed_at IS NULL
       OR v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
            'pipeline', 'v2',
            'risk', 'risk-policy-v2.5',
            'aiStage', 'ai-stage-policy-v2.11',
            'scheduler', 'ai-scheduler-v1'
       )
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
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.idempotency_key
            IS DISTINCT FROM (v_base_preflight_key || '.r3')
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.exclusion_decision
            IS DISTINCT FROM v_order.exclusion_decision
       OR v_preflight.excluded_instagram_id
            IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_preflight.capacity_required_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_preflight.required_plan_id IS DISTINCT FROM v_order.plan_id
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
       OR v_preflight.plan_catalog_snapshot->v_order.plan_id->>'launchStatus'
            <> 'production'
       OR v_preflight.target_followers_count > (
            v_preflight.plan_catalog_snapshot->v_order.plan_id
                ->'relationshipCapacity'->>'followers'
       )::INTEGER
       OR v_preflight.target_following_count > (
            v_preflight.plan_catalog_snapshot->v_order.plan_id
                ->'relationshipCapacity'->>'following'
       )::INTEGER
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflights AS next_preflight
            WHERE next_preflight.user_id = v_order.user_id
              AND next_preflight.idempotency_key = v_base_preflight_key || '.r4'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.failed_job_key = 'track:profile-ai:batch:0'
              AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR 10 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:profile-ai:batch:0'
              AND job.track = 'profile_ai'
              AND job.kind = 'ai'
              AND job.status = 'failed'
              AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status IN ('pending', 'processing')
       )
       OR 7 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.status = 'claimed'
              AND operation.result_json IS NULL
              AND operation.completed_at IS NULL
       )
       OR 7 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
            WHERE checkpoint.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.request_id = v_request.id
       )
       OR 7 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.status = 'succeeded'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.status = 'aborted'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND (
                    provider_run.status IN ('starting', 'running')
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
              )
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_cleanup_intents AS cleanup
            WHERE cleanup.request_id = v_request.id
              AND cleanup.completed_at IS NULL
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_LEASE_REARM_INELIGIBLE',
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
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r4',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_preflight.target_followers_count, v_preflight.target_following_count, FALSE,
        v_preflight.capacity_required_plan_id, v_preflight.required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now
    );

    INSERT INTO public.earlybird_v211_lease_policy_failure_rearms(
        order_id, failed_request_id, source_preflight_id,
        rearmed_preflight_id, expected_fulfillment_attempt_count,
        expected_manual_review_at
    ) VALUES (
        v_order.id, v_request.id, v_preflight.id,
        v_new_preflight_id, v_fulfillment.attempt_count,
        p_expected_manual_review_at
    );

    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'paid', preflight_id = v_new_preflight_id,
        result_request_id = NULL, updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        last_error_code = NULL, last_error_at = NULL,
        manual_review_at = NULL, completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT
        v_order.id, 'admission_pending'::TEXT, v_new_preflight_id,
        v_request.id, NULL::UUID;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_lease_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_lease_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.rearm_earlybird_v211_lease_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) IS
    'Operator-only one-generation rearm for the zero-Gemini-attempt v2.11 lease allowlist incident.';
