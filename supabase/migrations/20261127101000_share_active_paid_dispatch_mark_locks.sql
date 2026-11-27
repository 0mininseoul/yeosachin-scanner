BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Keep the previous wrapper intact below the fast path, including the legacy
-- paid revenue guard and identical-task replay. Fail closed on a changed contract.
DO $contract$
BEGIN
    IF EXISTS (
        SELECT FROM (VALUES
          ('public.mark_analysis_v2_job_dispatched_v2(uuid,text,integer,uuid,text,text,smallint)', 'c75db6859e91fd75321d9897bf0a9057'),
          ('public.mark_analysis_v2_job_dispatched(uuid,text,integer,uuid,text)', '3a664af48471aaf6fca07c527cb58c5c'),
          ('public.mark_analysis_v2_job_dispatched_unfenced_20260811(uuid,text,integer,uuid,text)', '3764686ee6d4446ca380fcad8ea92267'),
          ('public.assert_analysis_revenue_dispatch_guard_v1(uuid,text)', '085ece02a42e6444c7ca538abebf3740'),
          ('public.refresh_analysis_v2_score_audit_scan_locator(uuid)', '6a4cf3a986aafae23c9b4246fb2d0659')
        ) known(signature, body_md5)
        LEFT JOIN pg_catalog.pg_proc proc ON proc.oid = pg_catalog.to_regprocedure(known.signature)
        WHERE pg_catalog.md5(proc.prosrc) IS DISTINCT FROM known.body_md5
          AND (known.signature <> 'public.mark_analysis_v2_job_dispatched_v2(uuid,text,integer,uuid,text,text,smallint)'
               OR pg_catalog.md5(proc.prosrc) IS DISTINCT FROM '0da2dfb883f9ac1c79f6bb951222087a')
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_ACTIVE_PAID_MARK_FUNCTION_DRIFT';
    END IF;
END;
$contract$;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_job_dispatched_v2(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_task_name TEXT,
    p_workload_role TEXT,
    p_contract_version SMALLINT
)
RETURNS TABLE(marked BOOLEAN, job_status TEXT, dispatch_state TEXT, task_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_result RECORD;
    v_preflight_id UUID;
    v_now TIMESTAMPTZ;
BEGIN
    IF p_workload_role IS DISTINCT FROM 'paid' OR p_contract_version IS DISTINCT FROM 2 THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT; RETURN;
    END IF;

    IF p_request_id IS NOT NULL AND p_dispatch_token IS NOT NULL
       AND p_dispatch_generation BETWEEN 1 AND 1000
       AND (p_job_key ~ '^track:(profiles|profile-ai|private-names):batch:[0-9]+$'
            OR p_job_key IN (
                'track:relationships:collect', 'track:target-evidence:collect', 'track:reverse-likes:collect',
                'track:partner-safety:batch:0', 'track:narratives:batch:0', 'coordinator:join:primary-evidence',
                'coordinator:candidate-screening', 'coordinator:join:final-score', 'coordinator:finalize'
            ))
       AND char_length(p_job_key) <= 160 AND char_length(p_task_name) <= 512
       AND p_task_name ~ '^projects/[A-Za-z0-9._-]+/locations/[A-Za-z0-9._-]+/queues/[A-Za-z0-9._-]+/tasks/[A-Za-z0-9._-]+$'
       AND split_part(p_task_name, '/', 8) = 'analysis-v2-' || p_request_id::text || '-' ||
           left(encode(sha256(convert_to(p_job_key, 'UTF8')), 'hex'), 24) || '-g' || p_dispatch_generation
    THEN
        BEGIN
            SELECT p.id INTO v_preflight_id FROM public.analysis_preflights p
            WHERE p.consumed_request_id = p_request_id AND p.status = 'consumed' AND p.access_mode = 'production'
              AND p.beta_entry_provenance IS NULL
            FOR SHARE;
            IF NOT FOUND THEN
                RAISE SQLSTATE 'ZX872';
            END IF;

            -- Hold exactly the parents whose identity, cancellation and four
            -- progress fields the original mark tests or writes.
            PERFORM 1 FROM public.analysis_requests r
            WHERE r.id = p_request_id AND r.preflight_id = v_preflight_id
              AND r.pipeline_version = 'v2' AND r.plan_access_mode_snapshot = 'production'
              AND r.selected_plan_id_snapshot = 'standard' AND r.test_entitlement_jti_hash IS NULL
              AND r.status = 'processing' AND r.background_processing IS TRUE
              AND r.progress_step = 'V2 analysis queued' AND r.current_step = 'v2_pipeline'
            FOR SHARE;
            IF NOT FOUND THEN
                RAISE SQLSTATE 'ZX872';
            END IF;

            SELECT j.* INTO v_job FROM public.analysis_pipeline_jobs j
            WHERE j.request_id = p_request_id AND j.job_key = p_job_key FOR UPDATE;
            IF NOT FOUND OR v_job.dispatch_workload_role IS DISTINCT FROM 'paid'
               OR v_job.dispatch_contract_version IS DISTINCT FROM 2
               OR v_job.dispatch_generation IS DISTINCT FROM p_dispatch_generation
               OR v_job.dispatch_reservation_token IS DISTINCT FROM p_dispatch_token
               OR EXISTS (SELECT FROM public.analysis_v2_provider_execution_policies pol
                          WHERE pol.request_id = p_request_id)
               OR EXISTS (SELECT FROM public.analysis_v2_provider_cleanup_intents ci
                          WHERE ci.request_id = p_request_id AND ci.completed_at IS NULL)
            THEN
                RAISE SQLSTATE 'ZX872';
            END IF;

            IF v_job.dispatch_state IN ('enqueued', 'delivered') AND v_job.dispatch_task_name = p_task_name THEN
                RETURN QUERY SELECT TRUE, v_job.status::text, v_job.dispatch_state::text, v_job.dispatch_task_name::text;
                RETURN;
            END IF;
            IF v_job.status IS DISTINCT FROM 'pending' OR v_job.dispatch_state IS DISTINCT FROM 'reserved' THEN
                RAISE SQLSTATE 'ZX872';
            END IF;

            -- A no-op request UPDATE OF status normally fires the score audit
            -- locator refresh. Under the same audit fence its only effect with
            -- neither a summary nor a locator is a zero-row DELETE. Real audit
            -- work must run through the original trigger.
            IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(p_request_id::text, 0)) THEN
                RAISE SQLSTATE 'ZX872';
            END IF;
            IF EXISTS (SELECT FROM public.analysis_v2_result_summaries s WHERE s.request_id = p_request_id)
               OR EXISTS (SELECT FROM public.analysis_v2_score_audit_scan_locators l WHERE l.request_id = p_request_id)
            THEN
                RAISE SQLSTATE 'ZX872';
            END IF;

            v_now := clock_timestamp();
            UPDATE public.analysis_pipeline_jobs j
            SET dispatch_state = 'enqueued', dispatched_at = v_now, dispatch_task_name = p_task_name, updated_at = v_now
            WHERE j.request_id = p_request_id AND j.job_key = p_job_key
            RETURNING j.* INTO STRICT v_job;
            RETURN QUERY SELECT TRUE, v_job.status::text, v_job.dispatch_state::text, v_job.dispatch_task_name::text;
            RETURN;
        EXCEPTION WHEN SQLSTATE 'ZX872' THEN
            -- Roll back the shared locks before the old path takes exclusive
            -- parent locks. Siblings must never upgrade one another's locks.
            NULL;
        END;
    END IF;

    PERFORM public.lock_analysis_v2_dispatch_parents(p_request_id);
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF NOT FOUND
       OR v_job.dispatch_workload_role IS DISTINCT FROM 'paid'
       OR v_job.dispatch_contract_version IS DISTINCT FROM 2 THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT; RETURN;
    END IF;
    IF v_job.dispatch_state IN ('enqueued', 'delivered')
       AND v_job.dispatch_generation = p_dispatch_generation
       AND v_job.dispatch_reservation_token = p_dispatch_token
       AND v_job.dispatch_task_name = p_task_name THEN
        RETURN QUERY SELECT TRUE, v_job.status::TEXT, v_job.dispatch_state::TEXT,
            v_job.dispatch_task_name::TEXT; RETURN;
    END IF;
    SELECT marked.* INTO v_result FROM public.mark_analysis_v2_job_dispatched(
        p_request_id, p_job_key, p_dispatch_generation, p_dispatch_token, p_task_name
    ) AS marked;
    RETURN QUERY SELECT v_result.marked, v_result.job_status,
        v_result.dispatch_state, v_result.task_name;
END;
$$;
COMMIT;
