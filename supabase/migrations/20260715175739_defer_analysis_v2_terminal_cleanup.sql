-- Cleanup-only retries must not consume or bypass the handler attempt budget.
CREATE OR REPLACE FUNCTION public.defer_analysis_v2_terminal_cleanup(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID
)
RETURNS TABLE(
    released BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    request_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_TERMINAL_CLEANUP_DEFER_INPUT',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY',
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
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_intent.completed_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
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
        TRUE, v_job.status::TEXT, v_job.attempt_count, v_request.status::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.defer_analysis_v2_terminal_cleanup(
    UUID, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_analysis_v2_terminal_cleanup(
    UUID, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.defer_analysis_v2_terminal_cleanup(
    UUID, TEXT, UUID
) IS 'Defers an exact live V2 job claim while request-wide provider cleanup remains incomplete.';
