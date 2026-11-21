BEGIN;

-- Vertex audit and the revenue guard lock consumed preflight -> request -> job.
-- The paid v2 wrappers must take the same parents before checking job markers.
-- Keep the checks before the existing guarded call, including mark replays.
CREATE OR REPLACE FUNCTION public.lock_analysis_v2_dispatch_parents(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    PERFORM 1
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_analysis_v2_dispatch_parents(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- Patch only the known wrapper bodies. CREATE OR REPLACE retains function
-- signatures, security configuration and existing grants for both callers.
DO $migration$
DECLARE
    v_wrapper RECORD;
    v_function REGPROCEDURE;
    v_body TEXT;
    v_original TEXT;
    v_definition TEXT;
    v_job_lock CONSTANT TEXT := $lock$    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;$lock$;
    v_ordered_lock CONSTANT TEXT :=
        E'    PERFORM public.lock_analysis_v2_dispatch_parents(p_request_id);\n' || v_job_lock;
BEGIN
    FOR v_wrapper IN
        SELECT * FROM (VALUES
            ('public.reserve_analysis_v2_job_dispatch_v2(uuid,text,uuid,text,smallint)', 'de4c04cd04ffd3db4e625d8c639e77d4'),
            ('public.rearm_analysis_v2_job_dispatch_v2(uuid,text,integer,uuid,uuid,text,smallint)', '1b12acbcc40cd9c822c9d913552e42d8'),
            ('public.mark_analysis_v2_job_dispatched_v2(uuid,text,integer,uuid,text,text,smallint)', 'cb05d2c408c15e509c6e151828b429a8'),
            ('public.claim_analysis_v2_job_v2(uuid,text,integer,uuid,uuid,integer,integer,text,smallint)', '93cd998c21af75b1655f4c5065f3b323')
        ) AS wrappers(signature, original_hash)
    LOOP
        v_function := pg_catalog.to_regprocedure(v_wrapper.signature);
        SELECT proc.prosrc INTO v_body FROM pg_catalog.pg_proc AS proc WHERE proc.oid = v_function;
        v_original := pg_catalog.replace(v_body, v_ordered_lock, v_job_lock);
        IF pg_catalog.md5(v_original) IS DISTINCT FROM v_wrapper.original_hash
           OR pg_catalog.char_length(v_original) - pg_catalog.char_length(pg_catalog.replace(v_original, v_job_lock, ''))
               IS DISTINCT FROM pg_catalog.char_length(v_job_lock) THEN
            RAISE EXCEPTION 'ANALYSIS_V2_DISPATCH_LOCK_WRAPPER_DRIFT: %', v_wrapper.signature;
        END IF;
        IF v_body = v_original THEN
            v_definition := pg_catalog.pg_get_functiondef(v_function);
            EXECUTE pg_catalog.replace(v_definition, v_job_lock, v_ordered_lock);
        END IF;
    END LOOP;
END;
$migration$;

COMMIT;
