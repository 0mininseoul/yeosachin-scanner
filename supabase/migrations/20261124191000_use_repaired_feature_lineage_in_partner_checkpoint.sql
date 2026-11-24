-- Consume the same deterministic feature repair already accepted by the
-- profile checkpoint. Keep the original rejected Vertex audit intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
    v_function constant regprocedure :=
        'public.analysis_v2_result_partner_safety_row_matches(uuid,text,jsonb)'::regprocedure;
    v_previous pg_catalog.pg_proc%ROWTYPE;
    v_updated text;
    v_raw constant text := $body$    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- featureAnalysis checkpoints contain the raw validated model response.
    v_features := v_feature_ai.result_json;$body$;
    v_scoped_proof constant text := $body$    IF FOUND THEN
        -- featureAnalysis checkpoints contain the raw validated model response.
        v_features := v_feature_ai.result_json;
    ELSE
        SELECT scheduler.result_json->'result'->'features'
        INTO v_features
        FROM public.analysis_v2_candidate_feature_manifests AS manifest
        JOIN public.analysis_v2_scheduler_operations AS scheduler
          ON scheduler.request_id = manifest.request_id
         AND scheduler.job_key = manifest.producer_job_key
         AND scheduler.operation_key = v_feature.feature_operation_key
        WHERE manifest.request_id = v_feature.request_id
          AND manifest.batch = v_feature.batch
          AND public.analysis_v2_has_repaired_feature_lineage_v1(
              manifest.request_id, manifest.producer_job_key,
              v_feature.feature_operation_key, v_feature.feature_result_hash
          );
        IF NOT FOUND THEN
            RETURN FALSE;
        END IF;
    END IF;$body$;
BEGIN
    SELECT * INTO STRICT v_previous FROM pg_catalog.pg_proc WHERE oid = v_function;
    IF pg_catalog.md5(v_previous.prosrc) <> '2bddba62e29186cd6f46cee3518b287f'
       OR v_previous.prosecdef
       OR v_previous.provolatile <> 's'
       OR v_previous.proconfig IS DISTINCT FROM ARRAY['search_path=""']
       OR pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR pg_catalog.length(v_previous.prosrc)
          - pg_catalog.length(pg_catalog.replace(v_previous.prosrc, v_raw, ''))
          <> pg_catalog.length(v_raw) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PARTNER_REPAIRED_FEATURE_BASELINE_MISMATCH';
    END IF;

    v_updated := pg_catalog.replace(v_previous.prosrc, v_raw, v_scoped_proof);
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_function), v_previous.prosrc, v_updated);
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS updated
        WHERE updated.oid = v_function
          AND updated.prosrc = v_updated
          AND updated.proowner = v_previous.proowner
          AND updated.provolatile = v_previous.provolatile
          AND updated.prosecdef = v_previous.prosecdef
          AND updated.proconfig IS NOT DISTINCT FROM v_previous.proconfig
          AND updated.proacl IS NOT DISTINCT FROM v_previous.proacl
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PARTNER_REPAIRED_FEATURE_PATCH_UNVERIFIED';
    END IF;
END;
$migration$;

COMMIT;
