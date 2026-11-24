BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Read the job fence and durable checkpoint in one snapshot. Writers still
-- acquire their existing locks and adopt manifests on their own claim.
CREATE FUNCTION public.analysis_v2_assert_scoring_read_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS public.analysis_pipeline_jobs
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.pipeline_version = 'v2'
          AND request.status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_assert_scoring_read_job_fence(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_reader REGPROCEDURE;
    v_previous pg_catalog.pg_proc%ROWTYPE;
    v_anchor CONSTANT TEXT := 'public.analysis_v2_assert_result_job_fence(';
    v_replacement CONSTANT TEXT := 'public.analysis_v2_assert_scoring_read_job_fence(';
    v_body TEXT;
    v_definition TEXT;
BEGIN
    FOREACH v_reader IN ARRAY ARRAY[
        'public.load_analysis_v2_ai_scoring_stage(uuid,text,uuid,text,text)'::REGPROCEDURE,
        'public.load_analysis_v2_profile_ai_stage_batches(uuid,text,uuid,text)'::REGPROCEDURE
    ] LOOP
        SELECT * INTO STRICT v_previous FROM pg_catalog.pg_proc WHERE oid = v_reader;
        IF NOT v_previous.prosecdef
           OR v_previous.provolatile <> 'v'
           OR v_previous.proconfig IS DISTINCT FROM ARRAY['search_path=""']
           OR pg_catalog.has_function_privilege('anon', v_reader, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', v_reader, 'EXECUTE')
           OR NOT pg_catalog.has_function_privilege('service_role', v_reader, 'EXECUTE')
           OR pg_catalog.length(v_previous.prosrc)
               - pg_catalog.length(pg_catalog.replace(v_previous.prosrc, v_anchor, ''))
              <> pg_catalog.length(v_anchor)
           OR pg_catalog.strpos(v_previous.prosrc, 'public.analysis_v2_assert_ai_scoring_stage_consumer(') = 0
           OR pg_catalog.strpos(v_previous.prosrc, v_replacement) <> 0 THEN
            RAISE EXCEPTION 'ANALYSIS_V2_SCORING_READ_FENCE_BASELINE_MISMATCH: %', v_reader;
        END IF;
        v_body := pg_catalog.replace(v_previous.prosrc, v_anchor, v_replacement);
        v_definition := pg_catalog.pg_get_functiondef(v_reader);
        EXECUTE pg_catalog.replace(v_definition, v_previous.prosrc, v_body);
        EXECUTE pg_catalog.format('ALTER FUNCTION %s STABLE', v_reader);
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc AS current
            WHERE current.oid = v_reader
              AND current.prosrc = v_body
              AND current.proowner = v_previous.proowner
              AND current.provolatile = 's'
              AND current.prosecdef = v_previous.prosecdef
              AND current.proconfig IS NOT DISTINCT FROM v_previous.proconfig
              AND current.proacl IS NOT DISTINCT FROM v_previous.proacl
        ) THEN
            RAISE EXCEPTION 'ANALYSIS_V2_SCORING_READ_FENCE_PATCH_UNVERIFIED: %', v_reader;
        END IF;
    END LOOP;
END;
$migration$;

COMMIT;
