-- Active audit calls only read their worker fence, then write per-attempt
-- state. Sharing the job row lets sibling calls and wire authorization run
-- concurrently while an attempt is being reserved or saved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_reserve constant regprocedure :=
        'public.reserve_analysis_v2_ai_attempt(uuid,text,uuid,text,smallint,uuid,jsonb)';
    v_terminalize constant regprocedure :=
        'public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)';
    v_result constant regprocedure :=
        'public.terminalize_analysis_v2_ai_attempt_with_result(uuid,text,uuid,text,smallint,uuid,jsonb,jsonb,jsonb,text,text)';
    v_job_lock constant text := E'      AND job.job_key = p_job_key\n    FOR NO KEY UPDATE;';
    v_reservation_read constant text := E'    SELECT ai_attempt.*\n    INTO v_existing';
    v_reservation_fence constant text := $fence$    -- Preserve same-operation idempotency previously provided by the job lock.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'analysis-v2-ai-attempt:' || p_request_id::text || ':' || p_operation_key, 0
    ));

$fence$;
    v_baseline record;
    v_before pg_catalog.pg_proc%ROWTYPE;
    v_updated text;
BEGIN
    FOR v_baseline IN
        SELECT * FROM (VALUES
            (v_reserve, '91cd7e78e93c11e06423e68d7f10d56d'),
            (v_terminalize, 'a9365caa2f1a6592ae365057a34f3c7e'),
            (v_result, '3713f5d27ce1667afa48c157a179ce53')
        ) AS expected(routine, source_hash)
    LOOP
        SELECT * INTO STRICT v_before FROM pg_catalog.pg_proc WHERE oid = v_baseline.routine;
        IF pg_catalog.md5(v_before.prosrc) <> v_baseline.source_hash
           OR pg_catalog.length(v_before.prosrc) -
              pg_catalog.length(pg_catalog.replace(v_before.prosrc, v_job_lock, '')) <> pg_catalog.length(v_job_lock)
        THEN
            RAISE EXCEPTION 'ANALYSIS_V2_AI_AUDIT_JOB_FENCE_DRIFT: %', v_baseline.routine;
        END IF;

        v_updated := pg_catalog.replace(v_before.prosrc, v_job_lock,
            pg_catalog.replace(v_job_lock, 'FOR NO KEY UPDATE', 'FOR SHARE'));
        IF v_baseline.routine = v_reserve THEN
            IF pg_catalog.length(v_updated) -
               pg_catalog.length(pg_catalog.replace(v_updated, v_reservation_read, ''))
               <> pg_catalog.length(v_reservation_read)
            THEN
                RAISE EXCEPTION 'ANALYSIS_V2_AI_AUDIT_JOB_RESERVATION_DRIFT';
            END IF;
            v_updated := pg_catalog.replace(v_updated, v_reservation_read,
                v_reservation_fence || v_reservation_read);
        END IF;

        EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_baseline.routine),
            v_before.prosrc, v_updated);
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc AS updated
            WHERE updated.oid = v_before.oid AND updated.prosrc = v_updated
              AND updated.proowner = v_before.proowner AND updated.prosecdef = v_before.prosecdef
              AND updated.proconfig IS NOT DISTINCT FROM v_before.proconfig
              AND updated.proacl IS NOT DISTINCT FROM v_before.proacl
        ) THEN
            RAISE EXCEPTION 'ANALYSIS_V2_AI_AUDIT_JOB_FENCE_UNVERIFIED';
        END IF;
    END LOOP;
END;
$migration$;

COMMIT;
