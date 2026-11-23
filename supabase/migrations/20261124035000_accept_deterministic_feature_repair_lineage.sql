-- v2.11 can deterministically repair a rejected overview. The scheduler
-- retains the repaired output while the original provider audit remains
-- response_rejected. Recognize that exact lineage without rewriting the audit.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.analysis_v2_has_repaired_feature_lineage_v1(
    p_request_id uuid,
    p_job_key text,
    p_operation_key text,
    p_result_hash text
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_scheduler_operations AS scheduler
        JOIN public.analysis_requests AS request ON request.id = scheduler.request_id
        WHERE scheduler.request_id = p_request_id
          AND scheduler.job_key = p_job_key
          AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$'
          AND scheduler.operation_key = p_operation_key
          AND p_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
          AND scheduler.stage = 'featureAnalysis'
          AND scheduler.status = 'ready'
          AND request.pipeline_version = 'v2'
          AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'
          AND scheduler.result_json->>'source' = 'checkpoint'
          AND scheduler.result_json->>'operationKey' = p_operation_key
          AND scheduler.result_json->>'resultHash' = p_result_hash
          AND CASE WHEN pg_catalog.jsonb_typeof(scheduler.result_json->'result'->'features') = 'object'
              THEN public.analysis_v2_valid_ai_result_envelope(
                  scheduler.result_json->'result'->'features',
                  public.analysis_v2_ai_canonical_json_text(scheduler.result_json->'result'->'features'),
                  p_result_hash
              )
              ELSE false
          END
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_ai_attempts AS attempt
              WHERE attempt.request_id = scheduler.request_id
                AND attempt.job_key = scheduler.job_key
                AND attempt.operation_key = scheduler.operation_key
                AND attempt.stage = 'featureAnalysis'
                AND attempt.status = 'response_rejected'
                AND attempt.finish_reason = 'STOP'
                AND attempt.terminalized_at <= scheduler.completed_at
          )
    );
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_has_repaired_feature_lineage_v1(uuid,text,text,text)
    FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_function constant regprocedure :=
        'public.analysis_v2_checkpoint_candidate_features_complete_v26(uuid,text,uuid,text,integer,integer,jsonb)'::regprocedure;
    v_previous pg_catalog.pg_proc%ROWTYPE;
    v_updated text;
    v_standard_proof constant text := $proof$                        item.value->'featureOperationKey' <> 'null'::JSONB
                        AND NOT EXISTS (
                            SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                            WHERE ai_result.request_id = p_request_id
                              AND ai_result.job_key = p_job_key
                              AND ai_result.operation_key = item.value->>'featureOperationKey'
                              AND ai_result.stage = 'featureAnalysis'
                              AND ai_result.result_hash = item.value->>'featureResultHash'
                        )$proof$;
    v_repair_proof constant text := $proof$
                        AND public.analysis_v2_has_repaired_feature_lineage_v1(
                            p_request_id, p_job_key, item.value->>'featureOperationKey',
                            item.value->>'featureResultHash'
                        ) IS NOT TRUE$proof$;
BEGIN
    SELECT * INTO STRICT v_previous FROM pg_catalog.pg_proc WHERE oid = v_function;
    IF NOT v_previous.prosecdef
       OR v_previous.proconfig IS DISTINCT FROM ARRAY['search_path=""']
       OR pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR pg_catalog.length(v_previous.prosrc)
          - pg_catalog.length(pg_catalog.replace(v_previous.prosrc, v_standard_proof, ''))
          <> pg_catalog.length(v_standard_proof)
       OR pg_catalog.strpos(v_previous.prosrc, 'analysis_v2_has_repaired_feature_lineage_v1') <> 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_REPAIRED_FEATURE_LINEAGE_BASELINE_MISMATCH';
    END IF;
    v_updated := pg_catalog.replace(v_previous.prosrc, v_standard_proof, v_standard_proof || v_repair_proof);
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_function), v_previous.prosrc, v_updated);
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS updated
        WHERE updated.oid = v_function
          AND updated.prosrc = v_updated
          AND updated.proowner = v_previous.proowner
          AND updated.prosecdef = v_previous.prosecdef
          AND updated.proconfig IS NOT DISTINCT FROM v_previous.proconfig
          AND updated.proacl IS NOT DISTINCT FROM v_previous.proacl
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_REPAIRED_FEATURE_LINEAGE_PATCH_UNVERIFIED';
    END IF;
END;
$migration$;

COMMIT;
