-- MIGRATION_PREDECESSOR=20260808210000
-- The r7 concierge replay proved that the v2.11 gender microbatch audit identity
-- was incorrectly derived with the v2.9 default policy. Preserve every failed
-- generation and admit one fresh, fully paid r8 replay after the corrected worker
-- is live. This replay intentionally collects fresh provider data instead of
-- extending the incident-specific adoption resolver again.
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
                WHERE version = '20260808210000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_policy_identity_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_identity_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    failed_preflight_id UUID NOT NULL UNIQUE
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

ALTER TABLE public.earlybird_v211_policy_identity_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_policy_identity_replays FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_policy_identity_replays
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_policy_identity_replay_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_v211_policy_identity_replays
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.rearm_earlybird_v211_policy_identity_replay(
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
    v_concierge public.earlybird_v211_concierge_replays%ROWTYPE;
    v_diagnostic public.earlybird_v211_profile_ai_diagnostic_replays%ROWTYPE;
    v_existing public.earlybird_v211_policy_identity_replays%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
    v_entitlement_hash TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_REPLAY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_REPLAY_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_REPLAY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT audit.* INTO v_existing
    FROM public.earlybird_v211_policy_identity_replays AS audit
    WHERE audit.order_id = p_order_id FOR UPDATE;
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id FOR UPDATE;
        IF v_existing.policy_identity_failed_request_id
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
                MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_REPLAY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_existing.rearmed_preflight_id,
            v_existing.policy_identity_failed_request_id;
        RETURN;
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id FOR UPDATE;
    SELECT diagnostic.* INTO v_diagnostic
    FROM public.earlybird_v211_profile_ai_diagnostic_replays AS diagnostic
    WHERE diagnostic.order_id = p_order_id FOR UPDATE;
    SELECT concierge.* INTO v_concierge
    FROM public.earlybird_v211_concierge_replays AS concierge
    WHERE concierge.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_original_request
    FROM public.analysis_requests AS request
    WHERE request.id = v_concierge.original_failed_request_id FOR UPDATE;
    SELECT preflight.* INTO v_source_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_original_request.preflight_id FOR UPDATE;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_entitlement_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(
            'earlybird-fulfillment-admission-v1'
            || pg_catalog.chr(10) || pg_catalog.lower(v_order.id::TEXT),
            'UTF8'
        ), 'sha256'
    ), 'hex');

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
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.attempt_count <> 1
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.operator_admitted_at IS NULL
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_diagnostic.order_id IS NULL
       OR v_diagnostic.original_failed_request_id
            IS DISTINCT FROM v_original_request.id
       OR v_diagnostic.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_diagnostic.expected_fulfillment_attempt_count <> 1
       OR v_concierge.order_id IS NULL
       OR v_concierge.original_failed_request_id
            IS DISTINCT FROM v_original_request.id
       OR v_original_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_original_request.pipeline_version <> 'v2'
       OR v_original_request.status <> 'failed'
       OR v_source_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_source_preflight.status <> 'consumed'
       OR v_source_preflight.consumed_request_id
            IS DISTINCT FROM v_original_request.id
       OR v_source_preflight.admission_status <> 'ready'
       OR v_source_preflight.admission_selected_plan_id <> 'basic'
       OR v_source_preflight.admission_target_followers_count NOT BETWEEN 0 AND 1200
       OR v_source_preflight.admission_target_following_count NOT BETWEEN 0 AND 1200
       OR v_source_preflight.admission_capacity_required_plan_id IS NULL
       OR v_source_preflight.admission_required_plan_id IS NULL
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_source_preflight.admission_plan_cards_snapshot
       )
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.background_processing
       OR v_request.current_step <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_request.completed_at IS NULL
       OR v_request.idempotency_key IS DISTINCT FROM
            ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r4')
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_request.policy_versions_snapshot <>
            pg_catalog.jsonb_build_object(
                'pipeline', 'v2',
                'risk', 'risk-policy-v2.5',
                'aiStage', 'ai-stage-policy-v2.11',
                'scheduler', 'ai-scheduler-v1'
            )
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.idempotency_key IS DISTINCT FROM
            (v_base_preflight_key || '.r7')
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id <> 'basic'
       OR NOT public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            v_preflight.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.failed_job_key = 'track:profile-ai:batch:3'
              AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
       )
       OR 12 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status = 'completed'
       )
       OR 5 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status = 'cancelled'
              AND job.last_error_code = 'REQUEST_TERMINATED'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:profile-ai:batch:3'
              AND job.status = 'failed'
              AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status IN ('pending', 'processing', 'retryable')
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
              AND adoption.source_request_id = v_original_request.id
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       OR 4 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.status IN ('succeeded', 'aborted')
              AND provider_run.run_id IS NOT NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
       )
       OR 4 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.job_key = 'track:profiles:batch:3'
              AND provider_run.status = 'succeeded'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.job_key = 'track:target-evidence:collect'
              AND provider_run.status = 'succeeded'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.job_key = 'track:profiles:batch:2'
              AND provider_run.status = 'aborted'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND provider_run.job_key = 'track:profiles:batch:4'
              AND provider_run.status = 'aborted'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_cleanup_intents AS cleanup
            WHERE cleanup.request_id = v_request.id
              AND cleanup.completed_at IS NULL
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_provider_cost_ledger AS cost
            WHERE cost.request_id = v_request.id
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
              AND attempt.job_key = 'track:private-names:batch:0'
              AND attempt.stage = 'privateAccountName'
              AND attempt.status = 'success'
              AND attempt.terminalized_at IS NOT NULL
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
       )
       OR 12 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
       )
       OR 5 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.job_key = 'track:profile-ai:batch:0'
              AND operation.stage = 'genderTriage'
              AND operation.status = 'claimed'
              AND operation.completed_at IS NULL
       )
       OR 6 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.job_key = 'track:profile-ai:batch:3'
              AND operation.stage = 'genderTriage'
              AND operation.status = 'claimed'
              AND operation.completed_at IS NULL
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.job_key = 'track:private-names:batch:0'
              AND operation.stage = 'privateAccountName'
              AND operation.status = 'ready'
              AND operation.completed_at IS NOT NULL
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
            SELECT 1 FROM public.analysis_v2_media_artifacts AS artifact
            WHERE artifact.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_relationship_sides AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_target_evidence_manifests AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_profile_fetch_batches AS batch
            WHERE batch.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_preflights AS next_preflight
            WHERE next_preflight.user_id = v_order.user_id
              AND next_preflight.idempotency_key = v_base_preflight_key || '.r8'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_IDENTITY_REPLAY_INELIGIBLE',
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
        expires_at, ready_at,
        admission_status, admission_generation, admission_selected_plan_id,
        admission_entitlement_jti_hash, admission_token,
        admission_requested_at, admission_refreshed_at,
        admission_dispatch_state, admission_dispatch_generation,
        admission_dispatch_token, admission_dispatch_reserved_at,
        admission_dispatched_at, admission_target_followers_count,
        admission_target_following_count,
        admission_capacity_required_plan_id, admission_required_plan_id,
        admission_plan_cards_snapshot, admission_failure_count
    ) VALUES (
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r8',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_source_preflight.admission_plan_cards_snapshot,
        v_preflight.pricing_version, v_preflight.pricing_snapshot,
        v_preflight.policy_versions_snapshot,
        v_source_preflight.admission_target_followers_count,
        v_source_preflight.admission_target_following_count, FALSE,
        v_source_preflight.admission_capacity_required_plan_id,
        v_source_preflight.admission_required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now,
        'ready', 1, v_order.plan_id, v_entitlement_hash,
        extensions.gen_random_uuid(), v_now, v_now,
        'enqueued', 1, extensions.gen_random_uuid(), v_now, v_now,
        v_source_preflight.admission_target_followers_count,
        v_source_preflight.admission_target_following_count,
        v_source_preflight.admission_capacity_required_plan_id,
        v_source_preflight.admission_required_plan_id,
        v_source_preflight.admission_plan_cards_snapshot, 0
    );

    INSERT INTO public.earlybird_v211_policy_identity_replays(
        order_id, original_failed_request_id,
        policy_identity_failed_request_id, failed_preflight_id,
        rearmed_preflight_id, expected_fulfillment_attempt_count,
        expected_manual_review_at
    ) VALUES (
        v_order.id, v_original_request.id, v_request.id, v_preflight.id,
        v_new_preflight_id, v_fulfillment.attempt_count,
        p_expected_manual_review_at
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

REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_policy_identity_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_policy_identity_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.rearm_earlybird_v211_policy_identity_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) IS
    'Operator-only r8 replay after the first paid v2.11 policy-identity fix.';

DO $final_guard$
DECLARE
    v_rearm TEXT :=
        'public.rearm_earlybird_v211_policy_identity_replay('
        || 'uuid,uuid,timestamp with time zone)';
BEGIN
    IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid = v_rearm::pg_catalog.regprocedure
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_rearm, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_rearm, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_rearm, 'EXECUTE')
       OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            WHERE relation.oid =
                'public.earlybird_v211_policy_identity_replays'::pg_catalog.regclass
              AND relation.relrowsecurity
              AND relation.relforcerowsecurity
       ) THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_IDENTITY_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
