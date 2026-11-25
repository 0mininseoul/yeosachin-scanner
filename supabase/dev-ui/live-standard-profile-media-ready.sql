-- Registered Dev only. Install after the profile media inputs migration and Dev Standard admission.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR pg_catalog.to_regprocedure('dev_live_budget.valid_standard_profile_lineage(public.analysis_preflights,public.analysis_requests)') IS NULL
       OR pg_catalog.to_regprocedure('public.load_analysis_v2_profile_media_inputs(uuid,text,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_PROFILE_MEDIA_READY_WRONG_DATABASE';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_dev_standard_profile_media_ready_v1(
    p_request_id uuid, p_job_key text, p_claim_token uuid, p_input_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    media jsonb;
    ready jsonb;
BEGIN
    -- This checks the processing job, input hash, active lease and policy, and holds
    -- the existing request -> job fence through the ready read.
    media := public.load_analysis_v2_profile_media_inputs(p_request_id, p_job_key, p_claim_token, p_input_hash);
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS request
        JOIN public.analysis_preflights AS preflight ON preflight.id = request.preflight_id
        WHERE request.id = p_request_id AND dev_live_budget.valid_standard_profile_lineage(preflight, request)
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_POLICY_MISMATCH';
    END IF;

    -- A batch contains at most 30 candidates: at most 30 gender groups and one
    -- feature operation per candidate. Omitted keys use the normal scheduler claim.
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'operationKey', result.operation_key, 'stage', stages.stage, 'result', result.result_json
    ) ORDER BY result.operation_key), '[]'::jsonb) INTO ready
    FROM (VALUES ('genderTriage'), ('featureAnalysis')) AS stages(stage)
    CROSS JOIN LATERAL (
        SELECT operation.operation_key, operation.result_json
        FROM public.analysis_v2_scheduler_operations AS operation
        WHERE operation.request_id = p_request_id AND operation.job_key = p_job_key
          AND operation.stage = stages.stage AND operation.status = 'ready'
        ORDER BY operation.operation_key
        LIMIT 30
    ) AS result
    -- A scheduler receipt can be 512 KiB. Keep the combined payload under 1 MiB
    -- even for outliers; larger individual results still use the exact-key claim.
    WHERE pg_catalog.octet_length(result.result_json::text) <= 16 * 1024;
    RETURN media || pg_catalog.jsonb_build_object('readyOperations', ready);
END;
$$;
REVOKE ALL ON FUNCTION public.load_dev_standard_profile_media_ready_v1(uuid,text,uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_dev_standard_profile_media_ready_v1(uuid,text,uuid,text) TO service_role;
COMMIT;
