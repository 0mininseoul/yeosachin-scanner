BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The scheduler and the progress heartbeat only read the parent job fences.
-- Keep parent updates fenced without serializing independent readers.
DO $scheduler$
DECLARE
    v_oid REGPROCEDURE :=
        'public.claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)'::REGPROCEDURE;
    v_definition TEXT;
    v_old_request CONSTANT TEXT :=
        $old$WHERE request.id = p_request_id AND request.pipeline_version = 'v2' FOR UPDATE;$old$;
    v_old_job CONSTANT TEXT :=
        $old$WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;$old$;
    v_old_insert CONSTANT TEXT := $old$
        ) RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.job_key <> p_job_key OR v_operation.stage <> p_stage THEN$old$;
    v_new_insert CONSTANT TEXT := $new$
        )
        ON CONFLICT (request_id, operation_key) DO NOTHING
        RETURNING * INTO v_operation;
        IF FOUND THEN
            IF v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
            END IF;
            RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
            RETURN;
        END IF;

        -- Another claim inserted this operation while both held shared parent
        -- fences. Recheck the winning row under the existing operation lock.
        SELECT operation.* INTO v_operation FROM public.analysis_v2_scheduler_operations AS operation
        WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_operation.job_key <> p_job_key OR v_operation.stage <> p_stage THEN$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_definition
    FROM pg_catalog.pg_proc WHERE oid = v_oid
      AND pg_catalog.md5(prosrc) = 'b2323ec5bd1cba73b6c0e6fe1defd0a3';
    IF v_definition IS NULL OR pg_catalog.strpos(v_definition, v_old_request) = 0
       OR pg_catalog.strpos(v_definition, v_old_job) = 0
       OR pg_catalog.strpos(v_definition, v_old_insert) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_SCHEDULER_READ_FENCE_DRIFT';
    END IF;

    v_definition := pg_catalog.replace(v_definition, v_old_request,
        pg_catalog.replace(v_old_request, 'FOR UPDATE', 'FOR SHARE'));
    v_definition := pg_catalog.replace(v_definition, v_old_job,
        pg_catalog.replace(v_old_job, 'FOR UPDATE;', E'FOR SHARE;\n    v_now := pg_catalog.clock_timestamp();'));
    v_definition := pg_catalog.replace(v_definition, v_old_insert, v_new_insert);
    EXECUTE v_definition;
END;
$scheduler$;

DO $heartbeat$
DECLARE
    v_oid REGPROCEDURE :=
        'public.checkpoint_analysis_v2_active_profile_heartbeat(uuid,text,uuid,text,timestamptz,integer,text,text,text[],text,integer,text)'::REGPROCEDURE;
    v_definition TEXT;
    v_old_job CONSTANT TEXT := $old$WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;$old$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_definition
    FROM pg_catalog.pg_proc WHERE oid = v_oid
      AND pg_catalog.md5(prosrc) = '46b224e1ae00f3f8d34026c10c4befb4';
    IF v_definition IS NULL OR pg_catalog.strpos(v_definition, v_old_job) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_HEARTBEAT_READ_FENCE_DRIFT';
    END IF;

    EXECUTE pg_catalog.replace(v_definition, v_old_job,
        pg_catalog.replace(v_old_job, 'FOR UPDATE', 'FOR SHARE'));
END;
$heartbeat$;

COMMIT;
