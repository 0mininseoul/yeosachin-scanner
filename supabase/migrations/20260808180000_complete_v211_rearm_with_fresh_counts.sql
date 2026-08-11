-- MIGRATION_PREDECESSOR=20260808170000
-- The immutable v2.11 incident bridge reuses the schema-recovery request
-- lineage, but its rearmed r4 preflight already carries a newer capacity-safe
-- observation than the paid order. Route only that audited topology through
-- the normal fresh-count core; every other recovery keeps the approved-
-- entitlement wrapper unchanged.
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
                WHERE version = '20260808170000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_FRESH_COUNT_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_target_instagram_id TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN
)
RETURNS TABLE(admission_status TEXT, admission_error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_card JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_card_followers INTEGER;
    v_card_following INTEGER;
    v_required_card_count INTEGER;
    v_plan_id TEXT;
    v_status TEXT := 'ready';
    v_error_code TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_target_followers_count IS NULL
       OR p_target_followers_count NOT BETWEEN 0 AND 10000000
       OR p_target_following_count IS NULL
       OR p_target_following_count NOT BETWEEN 0 AND 10000000
       OR p_target_is_private IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token
    FOR UPDATE;

    IF NOT FOUND OR NOT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        WHERE recovery.recovery_preflight_id = p_preflight_id
    ) OR EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        JOIN public.earlybird_v211_lease_policy_failure_rearms AS incident
          ON incident.order_id = recovery.order_id
         AND incident.failed_request_id = recovery.failed_request_id
         AND incident.rearmed_preflight_id = recovery.recovery_preflight_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = recovery.order_id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = recovery.failed_request_id
        WHERE recovery.recovery_preflight_id = p_preflight_id
          AND incident.rearmed_preflight_id = v_preflight.id
          AND incident.source_preflight_id = failed_request.preflight_id
          AND incident.expected_fulfillment_attempt_count = 1
          AND recovery.prior_attempt_count = 1
          AND earlybird_order.preflight_id = v_preflight.id
          AND earlybird_order.user_id = v_preflight.user_id
          AND earlybird_order.target_instagram_id = v_preflight.target_instagram_id
          AND earlybird_order.status = 'paid'
          AND earlybird_order.plan_id = 'basic'
          AND earlybird_order.expected_amount_krw = 990
          AND earlybird_order.actual_amount_krw = 990
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.actual_groble_product_id
              IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND earlybird_order.result_request_id IS NULL
          AND fulfillment.status = 'admission_pending'
          AND fulfillment.request_id IS NULL
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND failed_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND failed_request.policy_versions_snapshot =
              pg_catalog.jsonb_build_object(
                  'pipeline', 'v2',
                  'risk', 'risk-policy-v2.5',
                  'aiStage', 'ai-stage-policy-v2.11',
                  'scheduler', 'ai-scheduler-v1'
              )
          AND v_preflight.status = 'ready'
          AND v_preflight.consumed_request_id IS NULL
          AND v_preflight.access_mode = 'production'
          AND v_preflight.admission_selected_plan_id = earlybird_order.plan_id
          AND v_preflight.idempotency_key =
              'earlybird.fulfillment.'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r4'
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.failed_job_key = 'track:profile-ai:batch:0'
                AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = failed_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
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
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = failed_request.id
                AND cleanup.completed_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_requests AS successor
              WHERE successor.user_id = earlybird_order.user_id
                AND successor.idempotency_key ~ (
                    '^earlybird:' || pg_catalog.lower(earlybird_order.id::TEXT)
                    || '[.]r[0-9]{1,3}$'
                )
          )
    ) THEN
        RETURN QUERY SELECT *
        FROM public.complete_analysis_v2_preflight_admission_core_20260730140000(
            p_preflight_id, p_admission_generation, p_claim_token,
            p_target_instagram_id, p_target_followers_count,
            p_target_following_count, p_target_is_private
        );
        RETURN;
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_schema_failure_recoveries AS recovery
    INNER JOIN public.earlybird_orders AS earlybird_order
        ON earlybird_order.id = recovery.order_id
    WHERE recovery.recovery_preflight_id = v_preflight.id
      AND earlybird_order.preflight_id = v_preflight.id
    FOR UPDATE OF earlybird_order;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    IF NOT FOUND
       OR v_order.user_id IS DISTINCT FROM v_preflight.user_id
       OR v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_fulfillment.status <> 'admission_pending'
       OR v_preflight.target_instagram_id IS DISTINCT FROM p_target_instagram_id
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR v_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_capacity_rank := CASE v_preflight.capacity_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_required_rank := CASE v_preflight.required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_selected_rank := CASE v_order.plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE NULL END;
    v_required_card_count := 0;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_card := v_preflight.plan_cards_snapshot->v_plan_id;
        IF v_card->>'selectionState' = 'required' THEN
            v_required_card_count := v_required_card_count + 1;
        END IF;
    END LOOP;
    v_card := v_preflight.plan_cards_snapshot->v_order.plan_id;
    IF v_capacity_rank IS NULL
       OR v_required_rank IS NULL
       OR v_selected_rank IS NULL
       OR v_required_rank < v_capacity_rank
       OR v_selected_rank < v_required_rank
       OR v_required_card_count <> 1
       OR v_preflight.plan_cards_snapshot
            ->v_preflight.required_plan_id->>'selectionState'
            IS DISTINCT FROM 'required'
       OR v_preflight.plan_cards_snapshot
            ->v_preflight.required_plan_id->>'launchStatus'
            IS DISTINCT FROM 'production'
       OR v_card->>'launchStatus' IS DISTINCT FROM 'production'
       OR COALESCE(v_card->>'selectionState', '')
            NOT IN ('required', 'available_upgrade')
       OR COALESCE(v_card->'relationshipCapacity'->>'followers', '')
            !~ '^[0-9]+$'
       OR COALESCE(v_card->'relationshipCapacity'->>'following', '')
            !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED',
            ERRCODE = 'P0001';
    END IF;
    v_card_followers :=
        (v_card->'relationshipCapacity'->>'followers')::INTEGER;
    v_card_following :=
        (v_card->'relationshipCapacity'->>'following')::INTEGER;
    IF p_target_followers_count > v_card_followers
       OR p_target_following_count > v_card_following THEN
        v_status := 'blocked';
        v_error_code := 'ANALYSIS_V2_PLAN_NOT_ALLOWED';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET target_followers_count = CASE WHEN v_status = 'ready'
            THEN p_target_followers_count ELSE preflight.target_followers_count END,
        target_following_count = CASE WHEN v_status = 'ready'
            THEN p_target_following_count ELSE preflight.target_following_count END,
        target_is_private = CASE WHEN v_status = 'ready'
            THEN FALSE ELSE preflight.target_is_private END,
        admission_status = v_status,
        admission_refreshed_at = v_now,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_error_code = v_error_code,
        admission_target_followers_count = p_target_followers_count,
        admission_target_following_count = p_target_following_count,
        admission_capacity_required_plan_id =
            v_preflight.capacity_required_plan_id,
        admission_required_plan_id = v_preflight.required_plan_id,
        admission_plan_cards_snapshot = v_preflight.plan_cards_snapshot,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT v_status, v_error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) TO service_role;
