-- MIGRATION_PREDECESSOR=20260725013000
-- Resolver recovery-pending is a durable nonterminal state, not a job failure.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260725013000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RECOVERY_DEFER_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_error_code TEXT
)
RETURNS TABLE(
    released BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    request_status TEXT,
    ai_capacity_deferral_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_claim_token IS NULL
       OR p_error_code NOT IN (
            'ANALYSIS_V2_AI_CAPACITY_PENDING',
            'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
            'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
            'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING'
       )
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_CAPACITY_DEFER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_CAPACITY_DEFER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_job.attempt_count < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        attempt_count = job.attempt_count - 1,
        first_started_at = CASE
            WHEN job.attempt_count = 1 THEN NULL
            ELSE job.first_started_at
        END,
        ai_capacity_deferral_count = job.ai_capacity_deferral_count + 1,
        last_error_code = p_error_code,
        last_error_at = v_now,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status = 'processing'
      AND job.lease_token = p_claim_token
    RETURNING job.* INTO v_job;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.attempt_count,
        v_request.status::TEXT,
        v_job.ai_capacity_deferral_count;
END;
$$;

REVOKE ALL ON FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    UUID, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    UUID, TEXT, UUID, TEXT
) IS 'Returns capacity, quarantine, deadline, and resolver-recovery waits to durable pending state without consuming the ordinary job attempt budget.';
