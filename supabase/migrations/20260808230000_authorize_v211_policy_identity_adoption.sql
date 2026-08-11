-- MIGRATION_PREDECESSOR=20260808220000
-- Recovery preflights are fail-closed unless the exact provider-run lineage is
-- authorized. Extend the immutable adoption resolver to the r8 policy-identity
-- incident, then expose one operator-only admission resume for the requestless
-- PROVIDER_RUN_ADOPTION_REQUIRED outcome.
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
                WHERE version = '20260808220000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_ADOPTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.earlybird_v211_policy_identity_replay_ready(
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
        FROM public.earlybird_v211_policy_identity_replays AS replay
        JOIN public.earlybird_v211_profile_ai_diagnostic_replays AS diagnostic
          ON diagnostic.order_id = replay.order_id
         AND diagnostic.original_failed_request_id = replay.original_failed_request_id
         AND diagnostic.rearmed_preflight_id = replay.failed_preflight_id
        JOIN public.earlybird_v211_concierge_replays AS concierge
          ON concierge.order_id = replay.order_id
         AND concierge.original_failed_request_id = replay.original_failed_request_id
        JOIN public.earlybird_schema_failure_recoveries AS recovery
          ON recovery.order_id = replay.order_id
         AND recovery.failed_request_id = replay.original_failed_request_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = replay.order_id
        JOIN public.analysis_requests AS original_request
          ON original_request.id = replay.original_failed_request_id
        JOIN public.analysis_requests AS policy_request
          ON policy_request.id = replay.policy_identity_failed_request_id
        JOIN public.analysis_preflights AS failed_preflight
          ON failed_preflight.id = replay.failed_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = replay.rearmed_preflight_id
        JOIN public.analysis_preflights AS source_preflight
          ON source_preflight.id = original_request.preflight_id
        WHERE replay.order_id = p_order_id
          AND replay.original_failed_request_id = p_original_failed_request_id
          AND recovery.recovery_preflight_id = p_recovery_preflight_id
          AND replay.rearmed_preflight_id = p_current_preflight_id
          AND replay.expected_fulfillment_attempt_count = 1
          AND diagnostic.expected_fulfillment_attempt_count = 1
          AND recovery.prior_attempt_count = 1
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
          AND original_request.user_id = earlybird_order.user_id
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
          AND policy_request.user_id = earlybird_order.user_id
          AND policy_request.preflight_id = failed_preflight.id
          AND policy_request.pipeline_version = 'v2'
          AND policy_request.status = 'failed'
          AND policy_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND policy_request.idempotency_key =
                'earlybird:' || pg_catalog.lower(earlybird_order.id::TEXT) || '.r4'
          AND failed_preflight.user_id = earlybird_order.user_id
          AND failed_preflight.status = 'consumed'
          AND failed_preflight.consumed_request_id = policy_request.id
          AND failed_preflight.pii_scrubbed_at IS NOT NULL
          AND failed_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r7'
          AND current_preflight.user_id = earlybird_order.user_id
          AND current_preflight.access_mode = 'production'
          AND current_preflight.status IN ('ready', 'consumed')
          AND current_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r8'
          AND current_preflight.target_instagram_id =
                earlybird_order.target_instagram_id
          AND current_preflight.target_followers_count =
                source_preflight.admission_target_followers_count
          AND current_preflight.target_following_count =
                source_preflight.admission_target_following_count
          AND current_preflight.admission_status = 'ready'
          AND current_preflight.admission_selected_plan_id = 'basic'
          AND current_preflight.admission_target_followers_count =
                current_preflight.target_followers_count
          AND current_preflight.admission_target_following_count =
                current_preflight.target_following_count
          AND current_preflight.launch_status_snapshot =
                failed_preflight.launch_status_snapshot
          AND current_preflight.plan_catalog_snapshot =
                failed_preflight.plan_catalog_snapshot
          AND current_preflight.pricing_version = failed_preflight.pricing_version
          AND current_preflight.pricing_snapshot = failed_preflight.pricing_snapshot
          AND current_preflight.policy_versions_snapshot =
                failed_preflight.policy_versions_snapshot
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = policy_request.id
                AND receipt.failed_job_key = 'track:profile-ai:batch:3'
                AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = policy_request.id
          )
          AND 12 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = policy_request.id
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = policy_request.id
                AND job.job_key = 'track:profile-ai:batch:3'
                AND job.status = 'failed'
                AND job.attempt_count = 1
                AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND 6 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
              WHERE adoption.request_id = policy_request.id
                AND adoption.source_request_id = original_request.id
          )
          AND 4 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = policy_request.id
                AND provider_run.status IN ('succeeded', 'aborted')
                AND provider_run.run_id IS NOT NULL
                AND provider_run.actual_usage_usd IS NOT NULL
                AND provider_run.usage_reconciled_at IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = policy_request.id
                AND cleanup.completed_at IS NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = policy_request.id
                AND attempt.job_key = 'track:private-names:batch:0'
                AND attempt.stage = 'privateAccountName'
                AND attempt.status = 'success'
                AND attempt.terminalized_at IS NOT NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = policy_request.id
          )
          AND 12 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = policy_request.id
          )
          AND 5 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = policy_request.id
                AND operation.job_key = 'track:profile-ai:batch:0'
                AND operation.stage = 'genderTriage'
                AND operation.status = 'claimed'
                AND operation.completed_at IS NULL
          )
          AND 6 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = policy_request.id
                AND operation.job_key = 'track:profile-ai:batch:3'
                AND operation.stage = 'genderTriage'
                AND operation.status = 'claimed'
                AND operation.completed_at IS NULL
          )
          AND 1 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_scheduler_operations AS operation
              WHERE operation.request_id = policy_request.id
                AND operation.job_key = 'track:private-names:batch:0'
                AND operation.stage = 'privateAccountName'
                AND operation.status = 'ready'
                AND operation.completed_at IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_gemini_leases AS lease
              WHERE lease.request_id = policy_request.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
              WHERE checkpoint.request_id = policy_request.id
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
              FROM public.analysis_v2_provider_cleanup_intents AS cleanup
              WHERE cleanup.request_id = original_request.id
                AND cleanup.completed_at IS NULL
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_v211_policy_identity_replay_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $readiness_patch$
DECLARE
    v_signature TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := '4388067ac704171dc4941fa14b4f437b';
    v_old TEXT := $old$                                  OR (
                                      public.earlybird_v211_profile_ai_diagnostic_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r7'
                                  )$old$;
    v_new TEXT := $new$                                  OR (
                                      public.earlybird_v211_profile_ai_diagnostic_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r7'
                                  )
                                  OR (
                                      public.earlybird_v211_policy_identity_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r8'
                                  )$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            v_definition,
            'public.analysis_v2_valid_recovery_adoption_preflights('
       ) = 0
       OR pg_catalog.strpos(v_definition, 'source_run.status = ''aborted''') = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_ADOPTION_READINESS_OLD_SHAPE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_v211_policy_identity_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, ') || ''.r8''') = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_ADOPTION_READINESS_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$readiness_patch$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $exact_resolver_patch$
DECLARE
    v_signature TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := 'dd8797d275e908273ff316f94e164e8d';
    v_old_tombstone TEXT := $old$            AND NOT (
                public.earlybird_v211_relationship_lineage_rearm_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
                OR public.earlybird_v211_concierge_replay_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
                OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
            )
            AND ($old$;
    v_new_tombstone TEXT := $new$            AND NOT (
                public.earlybird_v211_relationship_lineage_rearm_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
                OR public.earlybird_v211_concierge_replay_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
                OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
                OR public.earlybird_v211_policy_identity_replay_ready(
                    v_order.id, v_recovery.failed_request_id,
                    v_recovery_preflight.id, v_current_preflight.id
                )
            )
            AND ($new$;
    v_old_not_found TEXT := $old$    IF NOT FOUND THEN
        IF public.earlybird_v211_concierge_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;$old$;
    v_new_not_found TEXT := $new$    IF NOT FOUND THEN
        IF public.earlybird_v211_concierge_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_policy_identity_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;$new$;
    v_old_invalid TEXT := $old$    IF v_source.status <> 'succeeded'
       OR v_source.run_id IS NULL
       OR v_source.actual_usage_usd IS NULL
       OR v_source.usage_reconciled_at IS NULL THEN
        IF public.earlybird_v211_concierge_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_source.input_hash IS DISTINCT FROM p_input_hash
       OR v_source.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_source.actor_id IS DISTINCT FROM p_actor_id
       OR v_source.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;$old$;
    v_new_invalid TEXT := $new$    IF v_source.status <> 'succeeded'
       OR v_source.run_id IS NULL
       OR v_source.actual_usage_usd IS NULL
       OR v_source.usage_reconciled_at IS NULL THEN
        IF public.earlybird_v211_concierge_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_profile_ai_diagnostic_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) OR public.earlybird_v211_policy_identity_replay_ready(
            v_order.id, v_recovery.failed_request_id,
            v_recovery_preflight.id, v_current_preflight.id
        ) THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_source.input_hash IS DISTINCT FROM p_input_hash
       OR v_source.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_source.actor_id IS DISTINCT FROM p_actor_id
       OR v_source.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old_tombstone) = 0
       OR pg_catalog.strpos(v_definition, v_old_not_found) = 0
       OR pg_catalog.strpos(v_definition, v_old_invalid) = 0
       OR pg_catalog.strpos(
            v_definition, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_definition, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT'
       ) = 0 THEN
        RAISE EXCEPTION
            'ANALYSIS_V2_V211_POLICY_ADOPTION_RESOLVER_OLD_SHAPE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(
        v_definition, v_old_tombstone, v_new_tombstone
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_old_not_found, v_new_not_found
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_old_invalid, v_new_invalid
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_v211_policy_identity_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, 'RETURN NULL;') = 0
       OR pg_catalog.strpos(
            v_rewritten, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd'
       ) = 0 THEN
        RAISE EXCEPTION
            'ANALYSIS_V2_V211_POLICY_ADOPTION_RESOLVER_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$exact_resolver_patch$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.resume_earlybird_v211_policy_identity_admission(
    p_order_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_replay public.earlybird_v211_policy_identity_replays%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_order_id IS NULL OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_ADMISSION_RESUME_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_policy_identity_replays AS replay
    WHERE replay.order_id = p_order_id FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_replay.rearmed_preflight_id FOR UPDATE;

    IF v_order.id IS NULL
       OR v_replay.order_id IS NULL
       OR v_order.preflight_id IS DISTINCT FROM v_replay.rearmed_preflight_id
       OR v_order.status <> 'paid'
       OR v_order.result_request_id IS NOT NULL
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.attempt_count <> 1
       OR v_fulfillment.request_id IS NOT NULL
       OR v_fulfillment.last_error_code <> 'PROVIDER_RUN_ADOPTION_REQUIRED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.idempotency_key IS DISTINCT FROM (
            'earlybird.fulfillment.'
            || pg_catalog.replace(v_order.id::TEXT, '-', '') || '.r8'
       )
       OR v_preflight.target_instagram_id IS DISTINCT FROM
            v_order.target_instagram_id
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id <> 'basic'
       OR v_preflight.admission_dispatch_state <> 'enqueued'
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR EXISTS (
            SELECT 1 FROM public.analysis_requests AS request
            WHERE request.preflight_id = v_preflight.id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_ADMISSION_RESUME_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', attempt_count = 0, request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        operator_admitted_at = v_now, last_error_code = NULL,
        last_error_at = NULL, manual_review_at = NULL,
        completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_earlybird_v211_policy_identity_admission(
    UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_earlybird_v211_policy_identity_admission(
    UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $final_guard$
DECLARE
    v_helper TEXT :=
        'public.earlybird_v211_policy_identity_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_readiness TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_exact TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_resume TEXT :=
        'public.resume_earlybird_v211_policy_identity_admission('
        || 'uuid,timestamp with time zone)';
BEGIN
    IF pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_readiness::pg_catalog.regprocedure),
            'public.earlybird_v211_policy_identity_replay_ready('
       ) = 0
       OR pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_exact::pg_catalog.regprocedure),
            'public.earlybird_v211_policy_identity_replay_ready('
       ) = 0
       OR pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_exact::pg_catalog.regprocedure),
            'RETURN NULL;'
       ) = 0
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid IN (
                v_helper::pg_catalog.regprocedure,
                v_readiness::pg_catalog.regprocedure,
                v_exact::pg_catalog.regprocedure,
                v_resume::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_resume, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_resume, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_resume, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_readiness, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_exact, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_ADOPTION_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
