-- Extend only the frozen concierge cohort's failed-request eligibility. The
-- two observed terminal V2 codes are admitted only when their exact request
-- lineage is inactive and every charge-bearing terminal provider run is
-- reconciled. This migration changes no order, fulfillment, request, job,
-- provider-run, preflight, publication, or rearm row.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    SELECT constraint_row.conname INTO v_constraint_name
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.earlybird_concierge_batch_cohort_members'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%snapshot_error_code%';
    IF v_constraint_name IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_ERROR_CODE_CONSTRAINT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.format(
        'ALTER TABLE public.earlybird_concierge_batch_cohort_members DROP CONSTRAINT %I',
        v_constraint_name
    );
END;
$$;
ALTER TABLE public.earlybird_concierge_batch_cohort_members
    ADD CONSTRAINT concierge_batch_snapshot_error_code_check
    CHECK (
        snapshot_error_code IS NULL
        OR snapshot_error_code IN (
            'SCRAPING_INCOMPLETE_ERROR',
            'SCRAPING_PROVIDER_QUOTA_ERROR',
            'SCRAPING_PROVIDER_START_REJECTED_ERROR',
            'ANALYSIS_V2_JOB_HANDLER_FAILED',
            'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
        )
    );

CREATE FUNCTION public.earlybird_concierge_batch_failed_request_eligible(
    p_request_id UUID,
    p_error_code TEXT,
    p_fulfillment_request_id UUID,
    p_request_owner_id UUID,
    p_order_owner_id UUID,
    p_request_preflight_id UUID,
    p_order_preflight_id UUID,
    p_request_target TEXT,
    p_order_target TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT p_fulfillment_request_id IS NOT DISTINCT FROM p_request_id
       AND p_request_owner_id IS NOT DISTINCT FROM p_order_owner_id
       AND p_request_preflight_id IS NOT DISTINCT FROM p_order_preflight_id
       AND pg_catalog.lower(pg_catalog.btrim(p_request_target))
            IS NOT DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_order_target))
       AND p_error_code IN (
               'SCRAPING_INCOMPLETE_ERROR',
               'SCRAPING_PROVIDER_QUOTA_ERROR',
               'SCRAPING_PROVIDER_START_REJECTED_ERROR',
               'ANALYSIS_V2_JOB_HANDLER_FAILED',
               'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
           )
       AND NOT EXISTS (
           SELECT 1
           FROM public.analysis_pipeline_jobs AS job
           WHERE job.request_id = p_request_id
             AND job.status IN ('pending', 'processing', 'retryable')
       )
       AND NOT EXISTS (
           SELECT 1
           FROM public.analysis_v2_provider_runs AS provider_run
           WHERE provider_run.request_id = p_request_id
             AND provider_run.status IN ('starting', 'running')
       )
       AND NOT EXISTS (
           SELECT 1
           FROM public.analysis_v2_provider_runs AS provider_run
           WHERE provider_run.request_id = p_request_id
             AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
             AND provider_run.max_charge_usd > 0
             AND (
                 provider_run.actual_usage_usd IS NULL
                 OR provider_run.usage_reconciled_at IS NULL
             )
       );
$$;

REVOKE ALL ON FUNCTION public.earlybird_concierge_batch_failed_request_eligible(
    UUID, TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT
)
    FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
    v_definition TEXT;
    v_original_occurrences INTEGER;
    v_rewritten_occurrences INTEGER;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.freeze_concierge_batch_cohort(text)'::pg_catalog.regprocedure
    ) INTO v_definition;

    v_original_occurrences := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, 'request.error_message IN (', ''))
    ) / pg_catalog.length('request.error_message IN (');
    IF v_original_occurrences <> 5 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_FREEZE_DEFINITION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_definition := pg_catalog.regexp_replace(
        v_definition,
        'request\.error_message IN \([[:space:]]*''SCRAPING_INCOMPLETE_ERROR'',[[:space:]]*''SCRAPING_PROVIDER_QUOTA_ERROR'',[[:space:]]*''SCRAPING_PROVIDER_START_REJECTED_ERROR''[[:space:]]*\)',
        'public.earlybird_concierge_batch_failed_request_eligible(request.id, request.error_message, fulfillment.request_id, request.user_id, earlybird_order.user_id, request.preflight_id, earlybird_order.preflight_id, request.target_instagram_id, earlybird_order.target_instagram_id)',
        'g'
    );
    v_rewritten_occurrences := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
            v_definition,
            'public.earlybird_concierge_batch_failed_request_eligible(request.id, request.error_message, fulfillment.request_id, request.user_id, earlybird_order.user_id, request.preflight_id, earlybird_order.preflight_id, request.target_instagram_id, earlybird_order.target_instagram_id)',
            ''
        ))
    ) / pg_catalog.length(
        'public.earlybird_concierge_batch_failed_request_eligible(request.id, request.error_message, fulfillment.request_id, request.user_id, earlybird_order.user_id, request.preflight_id, earlybird_order.preflight_id, request.target_instagram_id, earlybird_order.target_instagram_id)'
    );
    IF v_rewritten_occurrences <> 5
       OR v_definition LIKE '%request.error_message IN (%' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_FREEZE_REWRITE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    EXECUTE v_definition;
END;
$$;

COMMIT;
