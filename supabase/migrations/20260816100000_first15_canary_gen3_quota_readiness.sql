BEGIN;

-- MIGRATION_PREDECESSOR=20260816090000
-- Extend only the final provider-run existence fence for the exact gen3
-- Quinary-to-Primary successor of the recorded gen2 media/quota lineage.
-- The gen3 branch already enforces the failed receipt, order, lease, and
-- no-active-run fences; this migration only permits that destination request
-- to have no provider-run row because it has not started provider work yet.
DO $readiness_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.earlybird_first15_canary_provider_rearm_request_ready(uuid,uuid,uuid)';
    v_expected_definition_md5 CONSTANT TEXT :=
        'c49331a579150cfa30dc5d11822a5928';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
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
$old$;
    v_new TEXT := $new$
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
              OR (
                  rearm.rearm_generation = 3
                  AND parent_rearm.order_id IS NOT NULL
                  AND parent_rearm.rearm_generation = 2
                  AND parent_rearm.fallback_credential_slot = rearm.source_credential_slot
                  AND rearm.source_credential_slot = 'quinary'
                  AND rearm.fallback_credential_slot = 'primary'
                  AND parent_rearm.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
                  AND rearm.source_failure_code = 'JOB_ATTEMPTS_EXHAUSTED'
                  AND EXISTS (
                      SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
                      WHERE receipt.request_id = failed_request.id
                        AND receipt.failed_job_key = 'track:profile-ai:batch:2'
                        AND receipt.error_code = rearm.source_failure_code
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
                      WHERE source_run.request_id = failed_request.id
                  )
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
       OR pg_catalog.strpos(
            v_rewritten,
            'parent_rearm.source_failure_code = ''ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'''
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'rearm.source_failure_code = ''JOB_ATTEMPTS_EXHAUSTED'''
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'receipt.failed_job_key = ''track:profile-ai:batch:2'''
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_QUOTA_READINESS_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$readiness_patch$;

COMMIT;
