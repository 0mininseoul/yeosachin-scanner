-- MIGRATION_PREDECESSOR=20260815231000
-- Continue only the exact recorded generation-two Quinary successor into a
-- generation-three Primary rearm.  The creator rebind and readiness branch
-- remain byte-shape guarded so no unrelated recovery topology is widened.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815231000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

DO $creator_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_expected_definition_md5 CONSTANT TEXT :=
        'f5477a2d0080259277bd3a90269167a7';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
        SELECT rearm.source_request_id
        INTO v_first15_rearm_failed_request_id
        FROM public.earlybird_first15_canary_provider_rearms AS rearm
        WHERE rearm.order_id = v_order.id
          AND rearm.rearmed_preflight_id = v_preflight.id
          AND rearm.rearm_generation = 2
        FOR KEY SHARE;
$old$;
    v_new TEXT := $new$
        SELECT rearm.source_request_id
        INTO v_first15_rearm_failed_request_id
        FROM public.earlybird_first15_canary_provider_rearms AS rearm
        WHERE rearm.order_id = v_order.id
          AND rearm.rearmed_preflight_id = v_preflight.id
          AND rearm.rearm_generation IN (2, 3)
        FOR KEY SHARE;
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
            MESSAGE = 'FIRST15_CANARY_GEN3_CREATOR_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'rearm.rearm_generation IN (2, 3)'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_CREATOR_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$creator_patch$;

DO $readiness_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.earlybird_first15_canary_provider_rearm_request_ready(uuid,uuid,uuid)';
    v_expected_definition_md5 CONSTANT TEXT :=
        '542a0f3f45263b0d07a669dd91401d92';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$
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
$old$;
    v_new TEXT := $new$
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
            MESSAGE = 'FIRST15_CANARY_GEN3_READINESS_OLD_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'rearm.rearm_generation = 3') = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'parent_rearm.source_failure_code = rearm.source_failure_code'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'rearm.fallback_credential_slot = ''primary'''
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_GEN3_READINESS_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$readiness_patch$;

COMMIT;
