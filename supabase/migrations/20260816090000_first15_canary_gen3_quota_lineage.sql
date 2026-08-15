-- MIGRATION_PREDECESSOR=20260816060000
-- Admit only the already-recorded generation-two quota successor whose
-- terminal destination is JOB_ATTEMPTS_EXHAUSTED.  The existing two
-- generation-three branches remain unchanged; this migration only surfaces
-- the omitted exact row, carries its immutable media receipt fence, and keeps
-- the service-role RPC boundary and ordered Quinary-to-Primary fallback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260816060000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
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
        'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
        'JOB_ATTEMPTS_EXHAUSTED'
    ));

DO $candidate_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.list_earlybird_first15_canary_provider_recovery_candidates()';
    v_expected_definition_md5 CONSTANT TEXT :=
        'b4748729b5019ca4315112f425190e1c';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
    ORDER BY error_code, order_id
    LIMIT 24;
$old$;
    v_new TEXT := $new$
    UNION ALL

    SELECT parent.order_id,
        request.id AS request_id,
        request.preflight_id,
        'SCRAPING_PROVIDER_QUOTA_ERROR'::TEXT AS error_code,
        earlybird_order.concierge_apify_credential_slot AS credential_slot
    FROM public.earlybird_first15_canary_provider_rearms AS parent
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = parent.order_id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = parent.order_id
    JOIN public.analysis_requests AS request
      ON request.preflight_id = parent.rearmed_preflight_id
    WHERE parent.rearm_generation = 2
      AND NOT EXISTS (
          SELECT 1 FROM public.earlybird_first15_canary_provider_rearms AS child
          WHERE child.order_id = parent.order_id
            AND child.rearm_generation = 3
      )
      AND parent.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = request.id
      AND earlybird_order.concierge_apify_credential_slot = 'quinary'
      AND fulfillment.status = 'analysis_in_progress'
      AND fulfillment.request_id = request.id
      AND request.pipeline_version = 'v2'
      AND request.status = 'failed'
      AND request.current_step = 'failed'
      AND request.error_message = 'JOB_ATTEMPTS_EXHAUSTED'
      AND EXISTS (
          SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
          WHERE receipt.request_id = request.id
            AND receipt.failed_job_key = 'track:profile-ai:batch:2'
            AND receipt.error_code = request.error_message
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
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR (
           pg_catalog.char_length(v_definition)
           - pg_catalog.char_length(pg_catalog.replace(v_definition, v_old, ''))
       ) / pg_catalog.char_length(v_old) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_CANDIDATE_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'JOB_ATTEMPTS_EXHAUSTED') = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'parent.source_failure_code = ''ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'''
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_CANDIDATE_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$candidate_patch$;

DO $rearm_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.rearm_earlybird_first15_canary_provider_failure(uuid,uuid,text)';
    v_expected_definition_md5 CONSTANT TEXT :=
        'ed3acfe712a39115c8332b7a3f91781b';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
           ),
           FALSE
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_pipeline_jobs AS job
$old$;
    v_new TEXT := $new$
           )
           OR (
               v_previous.order_id IS NOT NULL
               AND v_previous.rearm_generation = 2
               AND v_order.concierge_apify_credential_slot = 'quinary'
               AND p_fallback_credential_slot = 'primary'
               AND v_previous.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
               AND v_source_request.error_message = 'JOB_ATTEMPTS_EXHAUSTED'
               AND EXISTS (
                   SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                   WHERE receipt.request_id = v_source_request.id
                     AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                     AND receipt.error_code = v_source_request.error_message
               )
           ),
           FALSE
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_pipeline_jobs AS job
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR (
           pg_catalog.char_length(v_definition)
           - pg_catalog.char_length(pg_catalog.replace(v_definition, v_old, ''))
       ) / pg_catalog.char_length(v_old) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_REARM_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'v_source_request.error_message = ''JOB_ATTEMPTS_EXHAUSTED''') = 0
       OR pg_catalog.strpos(v_rewritten, 'p_fallback_credential_slot = ''primary''') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_REARM_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$rearm_patch$;

DO $readiness_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.earlybird_first15_canary_provider_rearm_request_ready(uuid,uuid,uuid)';
    v_expected_definition_md5 CONSTANT TEXT :=
        '64c75c02008a57dcdeb6a38e2077dfa1';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
              OR (
                  rearm.rearm_generation = 3
                  AND parent_rearm.order_id IS NOT NULL
                  AND parent_rearm.rearm_generation = 2
                  AND parent_rearm.fallback_credential_slot = rearm.source_credential_slot
                  AND rearm.source_credential_slot = 'quinary'
                  AND rearm.fallback_credential_slot = 'primary'
                  AND parent_rearm.source_failure_code = rearm.source_failure_code
                  AND rearm.source_failure_code IN (
                      'ANALYSIS_V2_JOB_HANDLER_FAILED',
                      'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                  )
                  AND (
                      (rearm.source_failure_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key IN (
                                 'track:relationships:collect',
                                 'track:target-evidence:collect'
                             )
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                      OR (rearm.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                  )
              )
$old$;
    v_new TEXT := $new$
              OR (
                  rearm.rearm_generation = 3
                  AND parent_rearm.order_id IS NOT NULL
                  AND parent_rearm.rearm_generation = 2
                  AND parent_rearm.fallback_credential_slot = rearm.source_credential_slot
                  AND rearm.source_credential_slot = 'quinary'
                  AND rearm.fallback_credential_slot = 'primary'
                  AND (
                      (parent_rearm.source_failure_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
                       AND rearm.source_failure_code IN (
                           'SCRAPING_INCOMPLETE_ERROR',
                           'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                       )
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.error_code = rearm.source_failure_code
                             AND (
                                 (rearm.source_failure_code = 'SCRAPING_INCOMPLETE_ERROR'
                                  AND receipt.failed_job_key = 'track:relationships:collect')
                                 OR (rearm.source_failure_code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
                                  AND receipt.failed_job_key = 'track:target-evidence:collect')
                             )
                       ))
                      OR (parent_rearm.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                       AND rearm.source_failure_code = 'JOB_ATTEMPTS_EXHAUSTED'
                       AND EXISTS (
                           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                           WHERE receipt.request_id = failed_request.id
                             AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                             AND receipt.error_code = rearm.source_failure_code
                       ))
                  )
              )
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_definition_md5
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR (
           pg_catalog.char_length(v_definition)
           - pg_catalog.char_length(pg_catalog.replace(v_definition, v_old, ''))
       ) / pg_catalog.char_length(v_old) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_READINESS_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'JOB_ATTEMPTS_EXHAUSTED') = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'parent_rearm.source_failure_code = ''ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'''
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_READINESS_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$readiness_patch$;

COMMIT;
