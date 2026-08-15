-- MIGRATION_PREDECESSOR=20260815210000
-- Continue only the recorded three first15 canaries through the existing
-- maintenance route.  This preserves the immutable failed requests and lets
-- the existing recovery service reconcile current provider rows before rearm.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM supabase_migrations.schema_migrations
           WHERE version = '20260815210000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_PREDECESSOR_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

ALTER TABLE public.earlybird_first15_canary_provider_rearms
    DROP CONSTRAINT earlybird_first15_canary_provider_rea_source_failure_code_check;
ALTER TABLE public.earlybird_first15_canary_provider_rearms
    ADD CONSTRAINT earlybird_first15_canary_provider_rea_source_failure_code_check
    CHECK (source_failure_code IN (
        'SCRAPING_INCOMPLETE_ERROR',
        'SCRAPING_PROVIDER_QUOTA_ERROR',
        'SCRAPING_PROVIDER_START_REJECTED_ERROR',
        'ANALYSIS_V2_JOB_HANDLER_FAILED',
        'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
    ));

-- Keep the existing route's input contract.  A recorded first-generation
-- lineage is surfaced using its immutable original failure code, while the
-- current request id/preflight remains the actual terminal successor.
CREATE OR REPLACE FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
RETURNS TABLE(
    order_id UUID,
    request_id UUID,
    preflight_id UUID,
    error_code TEXT,
    credential_slot TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT fulfillment.order_id,
        request.id AS request_id,
        request.preflight_id,
        request.error_message AS error_code,
        earlybird_order.concierge_apify_credential_slot AS credential_slot
    FROM public.earlybird_fulfillments AS fulfillment
    JOIN public.analysis_requests AS request
      ON request.id = fulfillment.request_id
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = fulfillment.order_id
    WHERE fulfillment.status = 'analysis_in_progress'
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = request.id
      AND request.pipeline_version = 'v2'
      AND request.status = 'failed'
      AND request.current_step = 'failed'
      AND request.error_message IN (
          'SCRAPING_INCOMPLETE_ERROR',
          'SCRAPING_PROVIDER_QUOTA_ERROR',
          'SCRAPING_PROVIDER_START_REJECTED_ERROR'
      )

    UNION ALL

    SELECT parent.order_id,
        request.id AS request_id,
        request.preflight_id,
        parent.source_failure_code AS error_code,
        earlybird_order.concierge_apify_credential_slot AS credential_slot
    FROM public.earlybird_first15_canary_provider_rearms AS parent
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = parent.order_id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = parent.order_id
    JOIN public.analysis_requests AS request
      ON request.preflight_id = parent.rearmed_preflight_id
    WHERE parent.rearm_generation = 1
      AND NOT EXISTS (
          SELECT 1 FROM public.earlybird_first15_canary_provider_rearms AS child
          WHERE child.order_id = parent.order_id
            AND child.rearm_generation = 2
      )
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = request.id
      AND earlybird_order.concierge_apify_credential_slot = 'tertiary'
      AND fulfillment.status = 'analysis_in_progress'
      AND fulfillment.request_id = request.id
      AND request.pipeline_version = 'v2'
      AND request.status = 'failed'
      AND request.current_step = 'failed'
      AND (
          (parent.source_failure_code = 'SCRAPING_INCOMPLETE_ERROR'
            AND request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
            AND EXISTS (
                SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                WHERE receipt.request_id = request.id
                  AND receipt.failed_job_key = 'track:relationships:collect'
                  AND receipt.error_code = request.error_message
            ))
          OR (parent.source_failure_code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
            AND request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
            AND EXISTS (
                SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                WHERE receipt.request_id = request.id
                  AND receipt.failed_job_key = 'track:target-evidence:collect'
                  AND receipt.error_code = request.error_message
            ))
          OR (parent.source_failure_code = 'SCRAPING_PROVIDER_QUOTA_ERROR'
            AND request.error_message = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
            AND EXISTS (
                SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                WHERE receipt.request_id = request.id
                  AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                  AND receipt.error_code = request.error_message
            ))
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_pipeline_jobs AS job
          WHERE job.request_id = request.id
            AND job.status IN ('pending', 'processing', 'retryable')
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = request.id
            AND provider_run.status IN ('starting', 'running')
      )
    ORDER BY error_code, order_id
    LIMIT 24;
$$;

REVOKE ALL ON FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
    TO service_role;

-- Patch the deployed rearm verifier in place.  The original body and every
-- unrelated recovery topology remain byte-for-byte guarded by its definition
-- hash; only the documented gen-1 -> gen-2 receipt mapping is admitted.
DO $rearm_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.rearm_earlybird_first15_canary_provider_failure(uuid,uuid,text)';
    v_expected_definition_md5 CONSTANT TEXT := '8787d12b9bc68cfd993a09abc27b6bf3';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
       OR v_source_request.error_message NOT IN (
           'SCRAPING_INCOMPLETE_ERROR',
           'SCRAPING_PROVIDER_QUOTA_ERROR',
           'SCRAPING_PROVIDER_START_REJECTED_ERROR'
       )
       OR NOT EXISTS (
           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
           WHERE receipt.request_id = v_source_request.id
             AND receipt.failed_job_key IN (
                 'track:relationships:collect',
                 'track:target-evidence:collect'
             )
             AND receipt.error_code = v_source_request.error_message
       )
$old$;
    v_new TEXT := $new$
       OR NOT COALESCE(
           (
               v_source_request.error_message IN (
                   'SCRAPING_INCOMPLETE_ERROR',
                   'SCRAPING_PROVIDER_QUOTA_ERROR',
                   'SCRAPING_PROVIDER_START_REJECTED_ERROR'
               )
               AND EXISTS (
                   SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                   WHERE receipt.request_id = v_source_request.id
                     AND receipt.failed_job_key IN (
                         'track:relationships:collect',
                         'track:target-evidence:collect'
                     )
                     AND receipt.error_code = v_source_request.error_message
               )
           )
           OR (
               v_previous.order_id IS NOT NULL
               AND v_previous.rearm_generation = 1
               AND v_order.concierge_apify_credential_slot = 'tertiary'
               AND p_fallback_credential_slot = 'quinary'
               AND (
                   (v_previous.source_failure_code = 'SCRAPING_INCOMPLETE_ERROR'
                    AND v_source_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                    AND EXISTS (
                        SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                        WHERE receipt.request_id = v_source_request.id
                          AND receipt.failed_job_key = 'track:relationships:collect'
                          AND receipt.error_code = v_source_request.error_message
                    ))
                   OR (v_previous.source_failure_code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                    AND v_source_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                    AND EXISTS (
                        SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                        WHERE receipt.request_id = v_source_request.id
                          AND receipt.failed_job_key = 'track:target-evidence:collect'
                          AND receipt.error_code = v_source_request.error_message
                    ))
                   OR (v_previous.source_failure_code = 'SCRAPING_PROVIDER_QUOTA_ERROR'
                    AND v_source_request.error_message = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                    AND EXISTS (
                        SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                        WHERE receipt.request_id = v_source_request.id
                          AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                          AND receipt.error_code = v_source_request.error_message
                    ))
               )
           ),
           FALSE
       )
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure);
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_REARM_OLD_SHAPE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'track:profile-ai:batch:2') = 0
       OR pg_catalog.strpos(v_rewritten, 'p_fallback_credential_slot = ''quinary''') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN2_REARM_REWRITE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$rearm_patch$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_first15_canary_provider_failure(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_first15_canary_provider_failure(
    UUID, UUID, TEXT
) TO service_role;

-- The existing fulfillment creator consults this private readiness fence
-- before accepting a conflicting failed request.  It retains its original
-- first-generation path and admits only the three exact successor receipts.
CREATE OR REPLACE FUNCTION public.earlybird_first15_canary_provider_rearm_request_ready(
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
        LEFT JOIN public.earlybird_first15_canary_provider_rearms AS parent_rearm
          ON parent_rearm.order_id = rearm.order_id
         AND parent_rearm.rearmed_preflight_id = rearm.source_preflight_id
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
          AND (
              (
                  rearm.rearm_generation = 1
                  AND rearm.source_failure_code IN (
                      'SCRAPING_INCOMPLETE_ERROR',
                      'SCRAPING_PROVIDER_QUOTA_ERROR',
                      'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                  )
                  AND EXISTS (
                      SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                      WHERE receipt.request_id = failed_request.id
                        AND receipt.error_code = failed_request.error_message
                        AND receipt.failed_job_key IN (
                            'track:relationships:collect',
                            'track:target-evidence:collect'
                        )
                  )
              )
              OR (
                  rearm.rearm_generation = 2
                  AND parent_rearm.order_id IS NOT NULL
                  AND parent_rearm.rearm_generation = 1
                  AND parent_rearm.fallback_credential_slot = rearm.source_credential_slot
                  AND rearm.source_credential_slot = 'tertiary'
                  AND rearm.fallback_credential_slot = 'quinary'
                  AND (
                      (parent_rearm.source_failure_code = 'SCRAPING_INCOMPLETE_ERROR'
                       AND rearm.source_failure_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key = 'track:relationships:collect'
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                      OR (parent_rearm.source_failure_code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                       AND rearm.source_failure_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key = 'track:target-evidence:collect'
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                      OR (parent_rearm.source_failure_code = 'SCRAPING_PROVIDER_QUOTA_ERROR'
                       AND rearm.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                  )
              )
          )
          AND source_preflight.user_id = earlybird_order.user_id
          AND source_preflight.status = 'consumed'
          AND source_preflight.consumed_request_id = failed_request.id
          AND rearmed_preflight.user_id = earlybird_order.user_id
          AND rearmed_preflight.status = 'ready'
          AND rearmed_preflight.access_mode = 'production'
          AND rearmed_preflight.target_instagram_id = earlybird_order.target_instagram_id
          AND rearmed_preflight.admission_status = 'ready'
          AND rearmed_preflight.admission_selected_plan_id = earlybird_order.plan_id
          AND rearmed_preflight.idempotency_key =
              'earlybird.fulfillment.'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              || '.first15r' || rearm.rearm_generation::TEXT
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = failed_request.id
                AND job.status IN ('pending', 'processing', 'retryable')
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND source_run.status IN ('starting', 'running')
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND source_run.status IN ('succeeded', 'aborted', 'failed', 'timed_out')
                AND source_run.run_id IS NOT NULL
                AND (
                    source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
          AND (
              EXISTS (
                  SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
                  WHERE source_run.request_id = failed_request.id
              )
              OR (
                  rearm.rearm_generation = 2
                  AND parent_rearm.source_failure_code IN (
                      'SCRAPING_INCOMPLETE_ERROR',
                      'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
                      WHERE source_run.request_id = failed_request.id
                  )
              )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_first15_canary_provider_rearm_request_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
