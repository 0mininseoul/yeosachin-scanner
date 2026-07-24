SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.analysis_v2_gemini_leases (
    slot SMALLINT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'available',
    fence BIGINT NOT NULL DEFAULT 0,
    request_id UUID,
    job_key VARCHAR(160),
    attempt SMALLINT,
    lease_claim_token UUID,
    acquired_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    quarantined_at TIMESTAMP WITH TIME ZONE,
    resolution_evidence_hash VARCHAR(64),
    resolved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_gemini_leases_slot_check CHECK (slot BETWEEN 1 AND 8),
    CONSTRAINT analysis_v2_gemini_leases_state_check CHECK (
        state IN ('available', 'leased', 'quarantined')
    ),
    CONSTRAINT analysis_v2_gemini_leases_fence_check CHECK (
        fence BETWEEN 0 AND 9223372036854775806
    ),
    CONSTRAINT analysis_v2_gemini_leases_job_key_check CHECK (
        job_key IS NULL
        OR (
            pg_catalog.char_length(job_key) BETWEEN 1 AND 160
            AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
        )
    ),
    CONSTRAINT analysis_v2_gemini_leases_attempt_check CHECK (
        attempt IS NULL OR attempt BETWEEN 1 AND 4
    ),
    CONSTRAINT analysis_v2_gemini_leases_resolution_hash_check CHECK (
        resolution_evidence_hash IS NULL
        OR resolution_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_v2_gemini_leases_shape_check CHECK (
        (
            state = 'available'
            AND request_id IS NULL
            AND job_key IS NULL
            AND attempt IS NULL
            AND lease_claim_token IS NULL
            AND acquired_at IS NULL
            AND expires_at IS NULL
            AND quarantined_at IS NULL
        )
        OR (
            state = 'leased'
            AND request_id IS NOT NULL
            AND job_key IS NOT NULL
            AND attempt IS NOT NULL
            AND lease_claim_token IS NOT NULL
            AND acquired_at IS NOT NULL
            AND expires_at > acquired_at
            AND quarantined_at IS NULL
        )
        OR (
            state = 'quarantined'
            AND request_id IS NOT NULL
            AND job_key IS NOT NULL
            AND attempt IS NOT NULL
            AND lease_claim_token IS NOT NULL
            AND acquired_at IS NOT NULL
            AND expires_at IS NOT NULL
            AND quarantined_at IS NOT NULL
        )
    )
);

INSERT INTO public.analysis_v2_gemini_leases(slot)
SELECT slot.value::SMALLINT
FROM pg_catalog.generate_series(1, 8) AS slot(value);

ALTER TABLE public.analysis_v2_gemini_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_gemini_leases
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.acquire_analysis_v2_gemini_lease(
    p_request_id UUID,
    p_job_key TEXT,
    p_attempt INTEGER,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 240
)
RETURNS TABLE(
    outcome TEXT,
    slot SMALLINT,
    lease_claim_token UUID,
    fence BIGINT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 4
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 225 AND 300
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );

    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'quarantined',
        quarantined_at = v_now,
        updated_at = v_now
    WHERE lease.state = 'leased'
      AND lease.expires_at <= v_now;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.request_id = p_request_id
      AND lease.job_key = p_job_key
      AND lease.attempt = p_attempt
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_lease.state = 'leased'
           AND v_lease.lease_claim_token = p_claim_token
           AND v_lease.expires_at > v_now THEN
            RETURN QUERY SELECT
                'acquired'::TEXT,
                v_lease.slot,
                v_lease.lease_claim_token,
                v_lease.fence,
                v_lease.expires_at;
            RETURN;
        END IF;
        IF v_lease.state = 'leased' THEN
            UPDATE public.analysis_v2_gemini_leases AS lease
            SET state = 'quarantined',
                quarantined_at = v_now,
                updated_at = v_now
            WHERE lease.slot = v_lease.slot
            RETURNING lease.* INTO v_lease;
        END IF;
        RETURN QUERY SELECT
            'quarantine_active'::TEXT,
            v_lease.slot,
            NULL::UUID,
            v_lease.fence,
            v_lease.expires_at;
        RETURN;
    END IF;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.state = 'available'
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
        IF EXISTS (
            SELECT 1
            FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.state = 'quarantined'
        ) THEN
            RETURN QUERY SELECT
                'quarantine_active'::TEXT,
                NULL::SMALLINT,
                NULL::UUID,
                NULL::BIGINT,
                NULL::TIMESTAMP WITH TIME ZONE;
        ELSE
            RETURN QUERY SELECT
                'capacity_pending'::TEXT,
                NULL::SMALLINT,
                NULL::UUID,
                NULL::BIGINT,
                NULL::TIMESTAMP WITH TIME ZONE;
        END IF;
        RETURN;
    END IF;

    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'leased',
        fence = lease.fence + 1,
        request_id = p_request_id,
        job_key = p_job_key,
        attempt = p_attempt,
        lease_claim_token = p_claim_token,
        acquired_at = v_now,
        expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
        quarantined_at = NULL,
        updated_at = v_now
    WHERE lease.slot = v_lease.slot
      AND lease.state = 'available'
    RETURNING lease.* INTO v_lease;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_AMBIGUOUS',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        'acquired'::TEXT,
        v_lease.slot,
        v_lease.lease_claim_token,
        v_lease.fence,
        v_lease.expires_at;
END;
$$;

CREATE FUNCTION public.renew_analysis_v2_gemini_lease(
    p_slot INTEGER,
    p_claim_token UUID,
    p_fence BIGINT,
    p_lease_seconds INTEGER DEFAULT 240
)
RETURNS TABLE(
    renewed BOOLEAN,
    lease_state TEXT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    IF p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 8
       OR p_claim_token IS NULL
       OR p_fence IS NULL OR p_fence < 1
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 225 AND 300 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.slot = p_slot
    FOR UPDATE;
    IF v_lease.state = 'leased'
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence
       AND v_lease.expires_at > v_now THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
        RETURN QUERY SELECT TRUE, v_lease.state::TEXT, v_lease.expires_at;
        RETURN;
    END IF;
    IF v_lease.state = 'leased'
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence
       AND v_lease.expires_at <= v_now THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'quarantined',
            quarantined_at = v_now,
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
    END IF;
    RETURN QUERY SELECT FALSE, v_lease.state::TEXT, v_lease.expires_at;
END;
$$;

CREATE FUNCTION public.release_analysis_v2_gemini_lease(
    p_slot INTEGER,
    p_claim_token UUID,
    p_fence BIGINT
)
RETURNS TABLE(released BOOLEAN, lease_state TEXT, fence BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    IF p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 8
       OR p_claim_token IS NULL
       OR p_fence IS NULL OR p_fence < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.slot = p_slot
    FOR UPDATE;
    IF v_lease.state = 'leased'
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'available',
            request_id = NULL,
            job_key = NULL,
            attempt = NULL,
            lease_claim_token = NULL,
            acquired_at = NULL,
            expires_at = NULL,
            quarantined_at = NULL,
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
        RETURN QUERY SELECT TRUE, v_lease.state::TEXT, v_lease.fence;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v_lease.state::TEXT, v_lease.fence;
END;
$$;

CREATE FUNCTION public.resolve_analysis_v2_gemini_lease_quarantine(
    p_slot INTEGER,
    p_expected_fence BIGINT,
    p_evidence_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 8
       OR p_expected_fence IS NULL OR p_expected_fence < 1
       OR p_evidence_hash IS NULL
       OR p_evidence_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_QUARANTINE_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'available',
        request_id = NULL,
        job_key = NULL,
        attempt = NULL,
        lease_claim_token = NULL,
        acquired_at = NULL,
        expires_at = NULL,
        quarantined_at = NULL,
        resolution_evidence_hash = p_evidence_hash,
        resolved_at = v_now,
        updated_at = v_now
    WHERE lease.slot = p_slot
      AND lease.state = 'quarantined'
      AND lease.fence = p_expected_fence;
    RETURN FOUND;
END;
$$;

ALTER TABLE public.analysis_pipeline_jobs
    ADD COLUMN ai_capacity_deferral_count INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT analysis_pipeline_jobs_ai_capacity_deferral_count_check
        CHECK (ai_capacity_deferral_count BETWEEN 0 AND 100000);

CREATE FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
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
            'ANALYSIS_V2_AI_QUARANTINE_ACTIVE'
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

REVOKE ALL ON FUNCTION public.acquire_analysis_v2_gemini_lease(
    UUID, TEXT, INTEGER, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.renew_analysis_v2_gemini_lease(
    INTEGER, UUID, BIGINT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_v2_gemini_lease(
    INTEGER, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_gemini_lease_quarantine(
    INTEGER, BIGINT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.acquire_analysis_v2_gemini_lease(
    UUID, TEXT, INTEGER, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_analysis_v2_gemini_lease(
    INTEGER, UUID, BIGINT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_gemini_lease(
    INTEGER, UUID, BIGINT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_analysis_v2_job_for_ai_capacity(
    UUID, TEXT, UUID, TEXT
) TO service_role;
