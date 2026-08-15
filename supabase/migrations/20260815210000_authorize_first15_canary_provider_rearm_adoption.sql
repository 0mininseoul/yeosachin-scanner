-- MIGRATION_PREDECESSOR=20260815200000
-- The first15 rearm ledger is an immutable, pre-provider authorization for
-- one successor request.  Preserve the common creator and every prior
-- recovery lineage; only its existing request-conflict and adoption gates
-- learn this exact lineage.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815200000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_REARM_ADOPTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

CREATE FUNCTION public.earlybird_first15_canary_provider_rearm_request_ready(
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
        FROM public.earlybird_first15_canary_provider_rearms AS rearm
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = rearm.order_id
        JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = earlybird_order.id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = rearm.source_request_id
        JOIN public.analysis_preflights AS source_preflight
          ON source_preflight.id = rearm.source_preflight_id
        JOIN public.analysis_preflights AS rearmed_preflight
          ON rearmed_preflight.id = rearm.rearmed_preflight_id
        WHERE rearm.order_id = p_order_id
          AND rearm.source_request_id = p_failed_request_id
          AND rearm.rearmed_preflight_id = p_recovery_preflight_id
          AND earlybird_order.preflight_id = rearm.rearmed_preflight_id
          AND earlybird_order.status = 'paid'
          AND earlybird_order.result_request_id IS NULL
          AND earlybird_order.concierge_apify_credential_slot
                = rearm.fallback_credential_slot
          AND fulfillment.status = 'admission_pending'
          AND fulfillment.request_id IS NULL
          AND fulfillment.lease_token IS NOT NULL
          AND fulfillment.lease_fence >= 1
          AND fulfillment.lease_expires_at > pg_catalog.clock_timestamp()
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.preflight_id = rearm.source_preflight_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND failed_request.current_step = 'failed'
          AND failed_request.error_message = rearm.source_failure_code
          AND failed_request.error_message IN (
              'SCRAPING_INCOMPLETE_ERROR',
              'SCRAPING_PROVIDER_QUOTA_ERROR',
              'SCRAPING_PROVIDER_START_REJECTED_ERROR'
          )
          AND source_preflight.user_id = earlybird_order.user_id
          AND source_preflight.status = 'consumed'
          AND source_preflight.consumed_request_id = failed_request.id
          AND rearmed_preflight.user_id = earlybird_order.user_id
          AND rearmed_preflight.status = 'ready'
          AND rearmed_preflight.access_mode = 'production'
          AND rearmed_preflight.target_instagram_id
                = earlybird_order.target_instagram_id
          AND rearmed_preflight.admission_status = 'ready'
          AND rearmed_preflight.admission_selected_plan_id = earlybird_order.plan_id
          AND rearmed_preflight.idempotency_key =
              'earlybird.fulfillment.'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              || '.first15r' || rearm.rearm_generation::TEXT
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.error_code = failed_request.error_message
                AND receipt.failed_job_key IN (
                    'track:relationships:collect',
                    'track:target-evidence:collect'
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.status IN ('pending', 'processing', 'retryable')
          )
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND source_run.status IN ('starting', 'running')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND source_run.status IN (
                    'succeeded', 'aborted', 'failed', 'timed_out'
                )
                AND source_run.run_id IS NOT NULL
                AND (
                    source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_first15_canary_provider_rearm_request_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) RENAME TO earlybird_provider_run_adoption_ready_pre_first15;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready_pre_first15(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_provider_run_adoption_ready(
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
    SELECT public.earlybird_provider_run_adoption_ready_pre_first15(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    )
    OR public.earlybird_first15_canary_provider_rearm_request_ready(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $creator_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_expected_definition_md5 CONSTANT TEXT := '84f73a0ee1ad726f1e432c55fa6f3d86';
    v_definition TEXT;
    v_rewritten TEXT;
    v_declaration_old TEXT :=
        '    v_rebind_preflight_generation_prefix TEXT;';
    v_declaration_new TEXT :=
        '    v_rebind_preflight_generation_prefix TEXT;'
        || pg_catalog.chr(10)
        || '    v_first15_rearm_ready BOOLEAN := FALSE;';
    v_conflict_old TEXT := $old$
        v_rebind_preflight_generation_prefix :=
            v_rebind_preflight_base_key || '.r';
        IF v_recovery.order_id IS NULL
           OR v_recovery_preflight.id IS NULL
$old$;
    v_conflict_new TEXT := $new$
        v_rebind_preflight_generation_prefix :=
            v_rebind_preflight_base_key || '.r';
        v_first15_rearm_ready :=
            public.earlybird_first15_canary_provider_rearm_request_ready(
                v_order.id, v_conflicting_request.id, v_preflight.id
            );
        IF (
                v_recovery.order_id IS NULL
                AND NOT v_first15_rearm_ready
            )
           OR (
                v_recovery_preflight.id IS NULL
                AND NOT v_first15_rearm_ready
            )
$new$;
    v_snapshot_mismatch_old TEXT := $old$
           OR (
                v_preflight.id IS DISTINCT FROM v_recovery.recovery_preflight_id
                AND (
$old$;
    v_snapshot_mismatch_new TEXT := $new$
           OR (
                NOT v_first15_rearm_ready
                AND v_preflight.id IS DISTINCT FROM v_recovery.recovery_preflight_id
                AND (
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_declaration_old) = 0
       OR pg_catalog.strpos(v_definition, v_conflict_old) = 0
       OR pg_catalog.strpos(v_definition, v_snapshot_mismatch_old) = 0
       OR pg_catalog.strpos(
            v_definition, 'earlybird_provider_run_adoption_ready('
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_REARM_CREATOR_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(
        v_definition, v_declaration_old, v_declaration_new
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_conflict_old, v_conflict_new
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_snapshot_mismatch_old, v_snapshot_mismatch_new
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'v_first15_rearm_ready BOOLEAN := FALSE;'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_first15_canary_provider_rearm_request_ready('
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'NOT v_first15_rearm_ready'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_REARM_CREATOR_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$creator_patch$;

REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) TO service_role;

COMMIT;
