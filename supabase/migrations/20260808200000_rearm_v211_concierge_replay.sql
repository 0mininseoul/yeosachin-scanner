-- MIGRATION_PREDECESSOR=20260808190000
-- The r2 recovery proved that both relationship runs can be resolved, but one
-- adopted Dataset was smaller than the newly observed follower count. For the
-- already-paid first order, preserve that terminal request and create one
-- concierge replay pinned to the original admitted snapshot. Reuse every
-- settled source run and permit a fresh paid run only where that exact source
-- run is missing or non-succeeded (the one aborted profile batch).
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
                WHERE version = '20260808190000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_concierge_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    first_relationship_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    second_relationship_failed_request_id UUID NOT NULL UNIQUE
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

ALTER TABLE public.earlybird_v211_concierge_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_replays FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_concierge_replays
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_concierge_replay_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_concierge_replays
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.earlybird_v211_concierge_replay_ready(
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
        FROM public.earlybird_v211_concierge_replays AS concierge
        JOIN public.earlybird_v211_relationship_lineage_failure_rearms AS first_rearm
          ON first_rearm.order_id = concierge.order_id
         AND first_rearm.original_failed_request_id =
                concierge.original_failed_request_id
         AND first_rearm.relationship_failed_request_id =
                concierge.first_relationship_failed_request_id
         AND first_rearm.rearmed_preflight_id = concierge.failed_preflight_id
        JOIN public.earlybird_v211_lease_policy_failure_rearms AS incident
          ON incident.order_id = concierge.order_id
         AND incident.failed_request_id = concierge.original_failed_request_id
        JOIN public.earlybird_schema_failure_recoveries AS recovery
          ON recovery.order_id = concierge.order_id
         AND recovery.failed_request_id = concierge.original_failed_request_id
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = concierge.order_id
        JOIN public.analysis_requests AS original_request
          ON original_request.id = concierge.original_failed_request_id
        JOIN public.analysis_requests AS second_request
          ON second_request.id = concierge.second_relationship_failed_request_id
        JOIN public.analysis_preflights AS failed_preflight
          ON failed_preflight.id = concierge.failed_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = concierge.rearmed_preflight_id
        JOIN public.analysis_preflights AS source_preflight
          ON source_preflight.id = original_request.preflight_id
        WHERE concierge.order_id = p_order_id
          AND concierge.original_failed_request_id = p_original_failed_request_id
          AND recovery.recovery_preflight_id = p_recovery_preflight_id
          AND concierge.rearmed_preflight_id = p_current_preflight_id
          AND concierge.expected_fulfillment_attempt_count = 1
          AND recovery.prior_attempt_count = 1
          AND incident.rearmed_preflight_id = recovery.recovery_preflight_id
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
          AND second_request.user_id = earlybird_order.user_id
          AND second_request.preflight_id = failed_preflight.id
          AND second_request.pipeline_version = 'v2'
          AND second_request.status = 'failed'
          AND second_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          AND second_request.idempotency_key =
                'earlybird:' || pg_catalog.lower(earlybird_order.id::TEXT) || '.r2'
          AND failed_preflight.user_id = earlybird_order.user_id
          AND failed_preflight.status = 'consumed'
          AND failed_preflight.consumed_request_id = second_request.id
          AND failed_preflight.pii_scrubbed_at IS NOT NULL
          AND failed_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r5'
          AND current_preflight.user_id = earlybird_order.user_id
          AND current_preflight.access_mode = 'production'
          AND current_preflight.status IN ('ready', 'consumed')
          AND current_preflight.idempotency_key =
                'earlybird.fulfillment.'
                || pg_catalog.replace(earlybird_order.id::TEXT, '-', '') || '.r6'
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
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = second_request.id
                AND receipt.failed_job_key = 'track:relationships:collect'
                AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
          )
          AND 2 = (
              SELECT pg_catalog.count(*)
              FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
              WHERE adoption.request_id = second_request.id
                AND adoption.source_request_id = original_request.id
                AND adoption.job_key = 'track:relationships:collect'
                AND adoption.source_job_key = 'track:relationships:collect'
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = second_request.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_provider_cost_ledger AS cost
              WHERE cost.request_id = second_request.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = second_request.id
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
              SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = original_request.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
              WHERE checkpoint.request_id = original_request.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_gemini_leases AS lease
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

REVOKE ALL ON FUNCTION public.earlybird_v211_concierge_replay_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $readiness_patch$
DECLARE
    v_signature TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := '6b002907f4e43f5cf1bb2fa4b86c0bc7';
    v_old TEXT := $old$                                  OR (
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
                                  )$old$;
    v_new TEXT := $new$                                  OR (
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
                                  OR (
                                      public.earlybird_v211_concierge_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r6'
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
            'EARLYBIRD_V211_CONCIERGE_READINESS_OLD_SHAPE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten, 'public.earlybird_v211_concierge_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, ') || ''.r6''') = 0
       OR pg_catalog.strpos(v_rewritten, 'source_run.status = ''aborted''') = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_CONCIERGE_READINESS_REWRITE_MISMATCH';
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
    v_expected_old_hash CONSTANT TEXT := '594dff87077e184aa360bc825a2ad15f';
    v_old_tombstone TEXT := $old$            AND NOT public.earlybird_v211_relationship_lineage_rearm_ready(
                v_order.id, v_recovery.failed_request_id,
                v_recovery_preflight.id, v_current_preflight.id
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
            )
            AND ($new$;
    v_old_not_found TEXT := $old$    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;$old$;
    v_new_not_found TEXT := $new$    IF NOT FOUND THEN
        IF public.earlybird_v211_concierge_replay_ready(
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
       OR v_source.usage_reconciled_at IS NULL
       OR v_source.input_hash IS DISTINCT FROM p_input_hash
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
            'ANALYSIS_V2_V211_CONCIERGE_EXACT_RESOLVER_OLD_SHAPE_MISMATCH';
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
            v_rewritten, 'public.earlybird_v211_concierge_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, 'RETURN NULL;') = 0
       OR pg_catalog.strpos(
            v_rewritten, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten, 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten, 'v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd'
       ) = 0 THEN
        RAISE EXCEPTION
            'ANALYSIS_V2_V211_CONCIERGE_EXACT_RESOLVER_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$exact_resolver_patch$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rearm_earlybird_v211_concierge_replay(
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
    v_recovery_preflight public.analysis_preflights%ROWTYPE;
    v_first_rearm public.earlybird_v211_relationship_lineage_failure_rearms%ROWTYPE;
    v_incident public.earlybird_v211_lease_policy_failure_rearms%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_existing public.earlybird_v211_concierge_replays%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
    v_entitlement_hash TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT audit.* INTO v_existing
    FROM public.earlybird_v211_concierge_replays AS audit
    WHERE audit.order_id = p_order_id FOR UPDATE;
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id FOR UPDATE;
        IF v_existing.second_relationship_failed_request_id
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
                MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id, v_fulfillment.status, v_existing.rearmed_preflight_id,
            v_existing.second_relationship_failed_request_id;
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
    SELECT audit.* INTO v_first_rearm
    FROM public.earlybird_v211_relationship_lineage_failure_rearms AS audit
    WHERE audit.order_id = p_order_id FOR UPDATE;
    SELECT incident.* INTO v_incident
    FROM public.earlybird_v211_lease_policy_failure_rearms AS incident
    WHERE incident.order_id = p_order_id FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_original_request
    FROM public.analysis_requests AS request
    WHERE request.id = v_recovery.failed_request_id FOR UPDATE;
    SELECT preflight.* INTO v_source_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_original_request.preflight_id FOR UPDATE;
    SELECT preflight.* INTO v_recovery_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_recovery.recovery_preflight_id FOR UPDATE;

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
       OR v_first_rearm.order_id IS NULL
       OR v_first_rearm.original_failed_request_id
            IS DISTINCT FROM v_original_request.id
       OR v_first_rearm.relationship_failed_request_id IS NULL
       OR v_first_rearm.source_preflight_id
            IS DISTINCT FROM v_recovery_preflight.id
       OR v_first_rearm.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_first_rearm.expected_fulfillment_attempt_count <> 1
       OR v_incident.order_id IS NULL
       OR v_incident.failed_request_id IS DISTINCT FROM v_original_request.id
       OR v_incident.source_preflight_id IS DISTINCT FROM v_source_preflight.id
       OR v_incident.rearmed_preflight_id
            IS DISTINCT FROM v_recovery_preflight.id
       OR v_recovery.order_id IS NULL
       OR v_recovery.failed_request_id IS DISTINCT FROM v_original_request.id
       OR v_recovery.recovery_preflight_id
            IS DISTINCT FROM v_recovery_preflight.id
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
            ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r2')
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.idempotency_key IS DISTINCT FROM
            (v_base_preflight_key || '.r5')
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
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:relationships:collect'
              AND job.status = 'failed'
              AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status IN ('pending', 'processing', 'retryable')
       )
       OR 2 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
              AND adoption.source_request_id = v_original_request.id
              AND adoption.job_key = 'track:relationships:collect'
              AND adoption.source_job_key = 'track:relationships:collect'
       )
       OR 2 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
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
            SELECT 1 FROM public.analysis_preflights AS next_preflight
            WHERE next_preflight.user_id = v_order.user_id
              AND next_preflight.idempotency_key = v_base_preflight_key || '.r6'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REPLAY_INELIGIBLE',
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
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r6',
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

    INSERT INTO public.earlybird_v211_concierge_replays(
        order_id, original_failed_request_id,
        first_relationship_failed_request_id,
        second_relationship_failed_request_id,
        failed_preflight_id, rearmed_preflight_id,
        expected_fulfillment_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_original_request.id,
        v_first_rearm.relationship_failed_request_id, v_request.id,
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

REVOKE ALL ON FUNCTION public.rearm_earlybird_v211_concierge_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_concierge_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.rearm_earlybird_v211_concierge_replay(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) IS
    'Operator-only original-snapshot concierge replay for the first paid v2.11 incident.';

DO $final_guard$
DECLARE
    v_helper TEXT :=
        'public.earlybird_v211_concierge_replay_ready(uuid,uuid,uuid,uuid)';
    v_readiness TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_exact TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_rearm TEXT :=
        'public.rearm_earlybird_v211_concierge_replay('
        || 'uuid,uuid,timestamp with time zone)';
BEGIN
    IF pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_readiness::pg_catalog.regprocedure),
            'public.earlybird_v211_concierge_replay_ready('
       ) = 0
       OR pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_exact::pg_catalog.regprocedure),
            'public.earlybird_v211_concierge_replay_ready('
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
                v_rearm::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_rearm, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_rearm, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_rearm, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_readiness, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_exact, 'EXECUTE') THEN
        RAISE EXCEPTION 'EARLYBIRD_V211_CONCIERGE_REPLAY_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
