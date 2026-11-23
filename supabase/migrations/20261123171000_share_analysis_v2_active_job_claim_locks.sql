BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_wrapper REGPROCEDURE := pg_catalog.to_regprocedure(
        'public.claim_analysis_v2_job_v2(uuid,text,integer,uuid,uuid,integer,integer,text,smallint)'
    );
    v_claim REGPROCEDURE := pg_catalog.to_regprocedure(
        'public.claim_analysis_v2_job_unfenced_20260811(uuid,text,integer,uuid,uuid,integer,integer)'
    );
BEGIN
    IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_wrapper)
            IS DISTINCT FROM '4f595fb89d0fd2af138ea4801d0f20d2'
       OR (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_claim)
            IS DISTINCT FROM 'd905a39c8d22845dcc170457224518b6' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_ACTIVE_CLAIM_FUNCTION_DRIFT';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_job_v2(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120,
    p_max_attempts INTEGER DEFAULT 7,
    p_workload_role TEXT DEFAULT 'paid',
    p_contract_version SMALLINT DEFAULT 2
)
RETURNS TABLE(
    claimed BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    track TEXT,
    job_kind TEXT,
    batch INTEGER,
    input_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_result RECORD;
    v_preflight_id UUID;
    v_now TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_workload_role IS DISTINCT FROM 'paid' OR p_contract_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_WORKLOAD_ROLE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- An already active request needs no status update for an ordinary pending
    -- job. Preselect candidates without row locks so other cases can take the
    -- established parent-exclusive path directly.
    IF p_dispatch_generation BETWEEN 1 AND 1000
       AND p_dispatch_token IS NOT NULL AND p_claim_token IS NOT NULL
       AND p_lease_seconds BETWEEN 30 AND 600 AND p_max_attempts BETWEEN 1 AND 20
       AND p_job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       AND p_job_key <> 'coordinator:bootstrap'
       AND EXISTS (
           SELECT 1
           FROM public.analysis_requests AS request
           JOIN public.analysis_pipeline_jobs AS job ON job.request_id = request.id
           WHERE request.id = p_request_id
             AND request.pipeline_version = 'v2'
             AND request.status = 'processing' AND request.background_processing IS TRUE
             AND request.preflight_id IS NOT NULL
             AND job.job_key = p_job_key AND job.status = 'pending'
             AND job.attempt_count < p_max_attempts
             AND job.dispatch_generation = p_dispatch_generation
             AND job.dispatch_reservation_token = p_dispatch_token
             AND job.dispatch_state IN ('enqueued', 'delivered')
             AND job.dispatch_workload_role = 'paid' AND job.dispatch_contract_version = 2
             AND NOT EXISTS (
                 SELECT 1 FROM public.analysis_v2_provider_execution_policies AS policy
                 WHERE policy.request_id = request.id AND policy.mode = 'test_operation_split'
                   AND policy.policy_version = 'authorized-free-e2e-v1'
             )
       ) THEN
        BEGIN
            SELECT preflight.id INTO v_preflight_id
            FROM public.analysis_preflights AS preflight
            WHERE preflight.consumed_request_id = p_request_id AND preflight.status = 'consumed'
            FOR SHARE;

            PERFORM 1 FROM public.analysis_requests AS request
            WHERE request.id = p_request_id AND request.preflight_id = v_preflight_id
              AND request.pipeline_version = 'v2'
              AND request.status = 'processing' AND request.background_processing IS TRUE
            FOR SHARE;
            IF NOT FOUND THEN
                RAISE SQLSTATE 'ZX871';
            END IF;

            SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = p_request_id AND job.job_key = p_job_key
            FOR NO KEY UPDATE;
            IF NOT FOUND OR v_job.status IS DISTINCT FROM 'pending'
               OR v_job.attempt_count >= p_max_attempts
               OR v_job.dispatch_generation IS DISTINCT FROM p_dispatch_generation
               OR v_job.dispatch_reservation_token IS DISTINCT FROM p_dispatch_token
               OR v_job.dispatch_state NOT IN ('enqueued', 'delivered')
               OR v_job.dispatch_workload_role IS DISTINCT FROM 'paid'
               OR v_job.dispatch_contract_version IS DISTINCT FROM 2
               OR EXISTS (
                   SELECT 1 FROM public.analysis_v2_provider_execution_policies AS policy
                   WHERE policy.request_id = p_request_id AND policy.mode = 'test_operation_split'
                     AND policy.policy_version = 'authorized-free-e2e-v1'
               )
               OR EXISTS (
                   SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
                   WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
               ) THEN
                RAISE SQLSTATE 'ZX871';
            END IF;

            v_now := pg_catalog.clock_timestamp();
            IF v_job.scheduler_not_before_at > v_now THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY', ERRCODE = 'P0001';
            END IF;

            UPDATE public.analysis_pipeline_jobs AS job
            SET status = 'processing',
                dispatch_state = 'delivered',
                delivered_at = COALESCE(job.delivered_at, v_now),
                lease_token = p_claim_token,
                lease_expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
                attempt_count = job.attempt_count + 1,
                first_started_at = COALESCE(job.first_started_at, v_now),
                updated_at = v_now,
                claim_workload_role = 'paid',
                claim_contract_version = 2
            WHERE job.request_id = p_request_id AND job.job_key = p_job_key
            RETURNING job.* INTO STRICT v_job;

            RETURN QUERY SELECT TRUE, v_job.status::TEXT, v_job.attempt_count,
                v_job.lease_expires_at, v_job.track::TEXT, v_job.kind::TEXT,
                v_job.batch, v_job.input_hash::TEXT;
            RETURN;
        EXCEPTION WHEN SQLSTATE 'ZX871' THEN
            -- Roll back the candidate's row locks before falling back. Two
            -- sibling deliveries must never try to upgrade shared parent locks.
            NULL;
        END;
    END IF;

    PERFORM public.lock_analysis_v2_dispatch_parents(p_request_id);
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF NOT FOUND
       OR v_job.dispatch_workload_role IS DISTINCT FROM 'paid'
       OR v_job.dispatch_contract_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_WORKLOAD_ROLE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT claimed.* INTO v_result FROM public.claim_analysis_v2_job(
        p_request_id, p_job_key, p_dispatch_generation, p_dispatch_token,
        p_claim_token, p_lease_seconds, p_max_attempts
    ) AS claimed;
    IF v_result.claimed THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET claim_workload_role = 'paid', claim_contract_version = 2
        WHERE job.request_id = p_request_id AND job.job_key = p_job_key
          AND job.status = 'processing' AND job.lease_token = p_claim_token;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN QUERY SELECT v_result.claimed, v_result.job_status, v_result.attempt_count,
        v_result.lease_expires_at, v_result.track, v_result.job_kind, v_result.batch,
        v_result.input_hash;
END;
$$;

COMMIT;
