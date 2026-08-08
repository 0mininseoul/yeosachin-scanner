-- MIGRATION_PREDECESSOR=20260808240000
-- The corrected v2.11 execution crossed the original policy-identity failure,
-- then one single-candidate Apify profile batch exhausted two transient
-- deliveries. Preserve that failed request and admit one r9 replay. Existing
-- reconciled source runs remain adoptable; unavailable or aborted source runs
-- are collected fresh by the already fail-closed resolver.
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
                WHERE version = '20260808240000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_TRANSIENT_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_apify_transient_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_identity_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    transient_failed_request_id UUID NOT NULL UNIQUE
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

ALTER TABLE public.earlybird_v211_apify_transient_replays
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_replays
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_apify_transient_replays
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_apify_transient_replay_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_v211_apify_transient_replays
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.earlybird_v211_apify_transient_failure_ready(
    p_order_id UUID,
    p_original_failed_request_id UUID,
    p_failed_request_id UUID,
    p_failed_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_v211_policy_identity_replays AS policy_replay
        JOIN public.earlybird_v211_profile_ai_diagnostic_replays AS diagnostic
          ON diagnostic.order_id = policy_replay.order_id
         AND diagnostic.original_failed_request_id =
                policy_replay.original_failed_request_id
         AND diagnostic.rearmed_preflight_id = policy_replay.failed_preflight_id
        JOIN public.earlybird_v211_concierge_replays AS concierge
          ON concierge.order_id = policy_replay.order_id
         AND concierge.original_failed_request_id =
                policy_replay.original_failed_request_id
        JOIN public.earlybird_schema_failure_recoveries AS recovery
          ON recovery.order_id = policy_replay.order_id
         AND recovery.failed_request_id =
                policy_replay.original_failed_request_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = policy_replay.order_id
        JOIN public.analysis_requests AS original_request
          ON original_request.id = policy_replay.original_failed_request_id
        JOIN public.analysis_requests AS policy_request
          ON policy_request.id = policy_replay.policy_identity_failed_request_id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = p_failed_request_id
        JOIN public.analysis_preflights AS failed_preflight
          ON failed_preflight.id = p_failed_preflight_id
        WHERE policy_replay.order_id = p_order_id
          AND policy_replay.original_failed_request_id =
                p_original_failed_request_id
          AND policy_replay.rearmed_preflight_id = p_failed_preflight_id
          AND failed_request.preflight_id = failed_preflight.id
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND failed_request.current_step = 'failed'
          AND NOT failed_request.background_processing
          AND failed_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND failed_request.idempotency_key =
                'earlybird:' || pg_catalog.lower(earlybird_order.id::TEXT) || '.r5'
          AND failed_request.target_instagram_id = (
                'retained.' || pg_catalog.substr(
                    pg_catalog.replace(failed_request.id::TEXT, '-', ''), 1, 20
                )
          )
          AND failed_request.policy_versions_snapshot =
                pg_catalog.jsonb_build_object(
                    'pipeline', 'v2',
                    'risk', 'risk-policy-v2.5',
                    'aiStage', 'ai-stage-policy-v2.11',
                    'scheduler', 'ai-scheduler-v1'
                )
          AND failed_preflight.user_id = earlybird_order.user_id
          AND failed_preflight.access_mode = 'production'
          AND failed_preflight.status = 'consumed'
          AND failed_preflight.consumed_request_id = failed_request.id
          AND failed_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r8'
          AND failed_preflight.pii_scrubbed_at IS NOT NULL
          AND failed_preflight.target_instagram_id = (
                'retained.' || pg_catalog.substr(
                    pg_catalog.replace(failed_preflight.id::TEXT, '-', ''), 1, 20
                )
          )
          AND failed_preflight.admission_status = 'ready'
          AND failed_preflight.admission_selected_plan_id = 'basic'
          AND public.analysis_v2_valid_launch_snapshot(
                failed_preflight.launch_status_snapshot
          )
          AND public.analysis_v2_valid_plan_catalog_snapshot(
                failed_preflight.plan_catalog_snapshot
          )
          AND public.analysis_v2_valid_plan_cards_snapshot(
                failed_preflight.plan_cards_snapshot
          )
          AND public.analysis_v2_valid_pricing_snapshot(
                failed_preflight.pricing_snapshot
          )
          AND public.analysis_v2_valid_policy_versions_snapshot(
                failed_preflight.policy_versions_snapshot
          )
          AND original_request.user_id = earlybird_order.user_id
          AND original_request.pipeline_version = 'v2'
          AND original_request.status = 'failed'
          AND original_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND policy_request.user_id = earlybird_order.user_id
          AND policy_request.pipeline_version = 'v2'
          AND policy_request.status = 'failed'
          AND policy_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND earlybird_order.plan_id = 'basic'
          AND earlybird_order.expected_amount_krw = 990
          AND earlybird_order.actual_amount_krw = 990
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.actual_groble_product_id
                IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.failed_job_key = 'track:profiles:batch:3'
                AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
          )
          AND 11 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
          )
          AND 6 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.status = 'completed'
          )
          AND 4 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.status = 'cancelled'
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.job_key = 'track:profiles:batch:3'
                AND job.status = 'failed'
                AND job.attempt_count = 2
                AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.status IN ('pending', 'processing')
          )
          AND 3 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = failed_request.id
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = failed_request.id
                AND provider_run.job_key = 'track:profiles:batch:2'
                AND provider_run.status = 'aborted'
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = failed_request.id
                AND provider_run.job_key = 'track:profiles:batch:4'
                AND provider_run.status = 'succeeded'
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = failed_request.id
                AND provider_run.job_key = 'track:relationships:collect'
                AND provider_run.status = 'succeeded'
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = failed_request.id
                AND cleanup.completed_at IS NULL
          )
          AND 30 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 14 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
                AND attempt.stage = 'genderTriage'
                AND attempt.status = 'success'
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 8 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
                AND attempt.stage = 'featureAnalysis'
                AND attempt.status = 'success'
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 2 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
                AND attempt.status = 'response_rejected'
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
                AND attempt.stage = 'privateAccountName'
                AND attempt.status = 'cutoff'
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 24 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = failed_request.id
          )
          AND 22 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = failed_request.id
                AND operation.status = 'ready'
                AND operation.completed_at IS NOT NULL
          )
          AND 2 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = failed_request.id
                AND operation.status = 'terminal_unavailable'
                AND operation.completed_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_gemini_leases AS lease
              WHERE lease.request_id = failed_request.id
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_v211_apify_transient_failure_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_v211_apify_transient_replay_ready(
    p_order_id UUID,
    p_original_failed_request_id UUID,
    p_recovery_preflight_id UUID,
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
        FROM public.earlybird_v211_apify_transient_replays AS replay
        JOIN public.earlybird_schema_failure_recoveries AS recovery
          ON recovery.order_id = replay.order_id
         AND recovery.failed_request_id = replay.original_failed_request_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = replay.order_id
        JOIN public.analysis_preflights AS failed_preflight
          ON failed_preflight.id = replay.failed_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = replay.rearmed_preflight_id
        WHERE replay.order_id = p_order_id
          AND replay.original_failed_request_id = p_original_failed_request_id
          AND recovery.recovery_preflight_id = p_recovery_preflight_id
          AND replay.rearmed_preflight_id = p_current_preflight_id
          AND replay.expected_fulfillment_attempt_count = 1
          AND public.earlybird_v211_apify_transient_failure_ready(
                replay.order_id,
                replay.original_failed_request_id,
                replay.transient_failed_request_id,
                replay.failed_preflight_id
          )
          AND earlybird_order.preflight_id = current_preflight.id
          AND earlybird_order.user_id = current_preflight.user_id
          AND earlybird_order.status IN ('paid', 'analysis_in_progress')
          AND earlybird_order.plan_id = 'basic'
          AND earlybird_order.expected_amount_krw = 990
          AND earlybird_order.actual_amount_krw = 990
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.actual_groble_product_id
                IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND current_preflight.user_id = earlybird_order.user_id
          AND current_preflight.access_mode = 'production'
          AND current_preflight.status IN ('ready', 'consumed')
          AND current_preflight.pii_scrubbed_at IS NULL
          AND current_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r9'
          AND current_preflight.target_instagram_id =
                earlybird_order.target_instagram_id
          AND current_preflight.admission_status = 'ready'
          AND current_preflight.admission_selected_plan_id = 'basic'
          AND current_preflight.admission_target_followers_count =
                current_preflight.target_followers_count
          AND current_preflight.admission_target_following_count =
                current_preflight.target_following_count
          AND current_preflight.admission_capacity_required_plan_id
                IS NOT DISTINCT FROM current_preflight.capacity_required_plan_id
          AND current_preflight.admission_required_plan_id
                IS NOT DISTINCT FROM current_preflight.required_plan_id
          AND current_preflight.admission_plan_cards_snapshot =
                current_preflight.plan_cards_snapshot
          AND current_preflight.launch_status_snapshot =
                failed_preflight.launch_status_snapshot
          AND current_preflight.plan_catalog_snapshot =
                failed_preflight.plan_catalog_snapshot
          AND current_preflight.plan_cards_snapshot =
                failed_preflight.plan_cards_snapshot
          AND current_preflight.pricing_version = failed_preflight.pricing_version
          AND current_preflight.pricing_snapshot = failed_preflight.pricing_snapshot
          AND current_preflight.policy_versions_snapshot =
                failed_preflight.policy_versions_snapshot
          AND public.analysis_v2_valid_plan_cards_snapshot(
                current_preflight.plan_cards_snapshot
          )
          AND current_preflight.plan_cards_snapshot
                -> 'basic' ->> 'launchStatus' = 'production'
          AND current_preflight.plan_cards_snapshot
                -> 'basic' ->> 'selectionState'
                IN ('required', 'available_upgrade')
          AND current_preflight.target_followers_count BETWEEN 0 AND CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers'
                )::INTEGER
                ELSE -1
          END
          AND current_preflight.target_following_count BETWEEN 0 AND CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following'
                )::INTEGER
                ELSE -1
          END
          AND earlybird_order.target_followers_count BETWEEN 0 AND CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers'
                )::INTEGER
                ELSE -1
          END
          AND earlybird_order.target_following_count BETWEEN 0 AND CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following'
                )::INTEGER
                ELSE -1
          END
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_v211_apify_transient_replay_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rearm_earlybird_v211_apify_transient_replay(
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
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_policy_replay public.earlybird_v211_policy_identity_replays%ROWTYPE;
    v_existing public.earlybird_v211_apify_transient_replays%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
    v_entitlement_hash TEXT;
    v_card JSONB;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_TRANSIENT_REPLAY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT replay.* INTO v_existing
    FROM public.earlybird_v211_apify_transient_replays AS replay
    WHERE replay.order_id = p_order_id FOR UPDATE;
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id FOR UPDATE;
        IF v_existing.transient_failed_request_id
                IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at
           OR v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status NOT IN ('paid', 'analysis_in_progress', 'completed')
           OR v_fulfillment.status NOT IN (
                'admission_pending', 'retryable_failure',
                'analysis_in_progress', 'completed', 'manual_review'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_APIFY_TRANSIENT_REPLAY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT v_order.id, v_fulfillment.status,
            v_existing.rearmed_preflight_id,
            v_existing.transient_failed_request_id;
        RETURN;
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id FOR UPDATE;
    SELECT replay.* INTO v_policy_replay
    FROM public.earlybird_v211_policy_identity_replays AS replay
    WHERE replay.order_id = p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_policy_replay.rearmed_preflight_id FOR UPDATE;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_entitlement_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(
            'earlybird-fulfillment-admission-v1'
            || pg_catalog.chr(10) || pg_catalog.lower(v_order.id::TEXT),
            'UTF8'
        ), 'sha256'
    ), 'hex');
    v_card := v_preflight.admission_plan_cards_snapshot -> 'basic';

    IF v_order.id IS NULL
       OR v_policy_replay.order_id IS NULL
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id
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
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_preflight.id IS DISTINCT FROM v_policy_replay.rearmed_preflight_id
       OR v_preflight.admission_target_followers_count
            IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count
            IS DISTINCT FROM v_preflight.target_following_count
       OR v_preflight.admission_capacity_required_plan_id
            IS DISTINCT FROM v_preflight.capacity_required_plan_id
       OR v_preflight.admission_required_plan_id
            IS DISTINCT FROM v_preflight.required_plan_id
       OR v_preflight.admission_plan_cards_snapshot
            IS DISTINCT FROM v_preflight.plan_cards_snapshot
       OR v_card IS NULL
       OR v_card->>'launchStatus' <> 'production'
       OR v_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR COALESCE(
            v_card->'relationshipCapacity'->>'followers', ''
       ) !~ '^[0-9]+$'
       OR COALESCE(
            v_card->'relationshipCapacity'->>'following', ''
       ) !~ '^[0-9]+$'
       OR v_order.target_followers_count IS NULL
       OR v_order.target_followers_count < 0
       OR v_order.target_followers_count >
            (v_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_order.target_following_count IS NULL
       OR v_order.target_following_count < 0
       OR v_order.target_following_count >
            (v_card->'relationshipCapacity'->>'following')::INTEGER
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_followers_count < 0
       OR v_preflight.target_followers_count >
            (v_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_following_count < 0
       OR v_preflight.target_following_count >
            (v_card->'relationshipCapacity'->>'following')::INTEGER
       OR NOT public.earlybird_v211_apify_transient_failure_ready(
            v_order.id,
            v_policy_replay.original_failed_request_id,
            v_request.id,
            v_preflight.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_preflights AS next_preflight
            WHERE next_preflight.user_id = v_order.user_id
              AND next_preflight.idempotency_key = v_base_preflight_key || '.r9'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_TRANSIENT_REPLAY_INELIGIBLE',
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
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r9',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.admission_plan_cards_snapshot,
        v_preflight.pricing_version, v_preflight.pricing_snapshot,
        v_preflight.policy_versions_snapshot,
        v_preflight.admission_target_followers_count,
        v_preflight.admission_target_following_count, FALSE,
        v_preflight.admission_capacity_required_plan_id,
        v_preflight.admission_required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now,
        'ready', 1, 'basic', v_entitlement_hash,
        extensions.gen_random_uuid(), v_now, v_now,
        'enqueued', 1, extensions.gen_random_uuid(), v_now, v_now,
        v_preflight.admission_target_followers_count,
        v_preflight.admission_target_following_count,
        v_preflight.admission_capacity_required_plan_id,
        v_preflight.admission_required_plan_id,
        v_preflight.admission_plan_cards_snapshot, 0
    );

    INSERT INTO public.earlybird_v211_apify_transient_replays(
        order_id, original_failed_request_id,
        policy_identity_failed_request_id, transient_failed_request_id,
        failed_preflight_id, rearmed_preflight_id,
        expected_fulfillment_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_policy_replay.original_failed_request_id,
        v_policy_replay.policy_identity_failed_request_id, v_request.id,
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

    RETURN QUERY SELECT v_order.id, 'admission_pending'::TEXT,
        v_new_preflight_id, v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_apify_transient_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_apify_transient_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $adoption_bridge_patch$
DECLARE
    v_signature TEXT :=
        'public.earlybird_v211_policy_identity_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := 'd18925ec6a5df5621048330f6e9ab1cd';
    v_old_tail TEXT := $old$          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = original_request.id
                AND cleanup.completed_at IS NULL
          )
    );$old$;
    v_new_tail TEXT := $new$          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = original_request.id
                AND cleanup.completed_at IS NULL
          )
    ) OR public.earlybird_v211_apify_transient_replay_ready(
        p_order_id,
        p_original_failed_request_id,
        p_recovery_preflight_id,
        p_current_preflight_id
    );$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old_tail) = 0
       OR pg_catalog.strpos(
            v_definition,
            'source_preflight.admission_target_followers_count <= CASE'
       ) = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_TRANSIENT_BRIDGE_OLD_SHAPE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old_tail, v_new_tail);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_v211_apify_transient_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, v_old_tail) <> 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_TRANSIENT_BRIDGE_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$adoption_bridge_patch$;

REVOKE ALL ON FUNCTION public.earlybird_v211_policy_identity_replay_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $final_guard$
DECLARE
    v_failure TEXT :=
        'public.earlybird_v211_apify_transient_failure_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_replay TEXT :=
        'public.earlybird_v211_apify_transient_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_rearm TEXT :=
        'public.rearm_earlybird_v211_apify_transient_replay('
        || 'uuid,uuid,timestamp with time zone)';
    v_parent TEXT :=
        'public.earlybird_v211_policy_identity_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
BEGIN
    IF pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_parent::pg_catalog.regprocedure),
            'public.earlybird_v211_apify_transient_replay_ready('
       ) = 0
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid IN (
                v_failure::pg_catalog.regprocedure,
                v_replay::pg_catalog.regprocedure,
                v_rearm::pg_catalog.regprocedure,
                v_parent::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_rearm, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_rearm, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_rearm, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_failure, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_replay, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_parent, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_TRANSIENT_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
