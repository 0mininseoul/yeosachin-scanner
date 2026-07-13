-- Phase C: durable, service-owned V2 jobs. V1 request-wide leases remain untouched.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_job_keys(p_keys TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.cardinality(p_keys) <= 64
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(p_keys) AS job_key(value)
            WHERE job_key.value IS NULL
               OR pg_catalog.char_length(job_key.value) NOT BETWEEN 1 AND 160
               OR job_key.value !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       )
       AND pg_catalog.cardinality(p_keys) = (
            SELECT pg_catalog.count(DISTINCT job_key.value)::INTEGER
            FROM pg_catalog.unnest(p_keys) AS job_key(value)
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_job_keys(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_job_keys(TEXT[]) TO service_role;

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    track VARCHAR(50) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    batch INTEGER,
    input_hash VARCHAR(64) NOT NULL,
    required_job_keys TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    dispatch_state VARCHAR(16) NOT NULL DEFAULT 'pending',
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    dispatch_task_name VARCHAR(512),
    delivered_at TIMESTAMP WITH TIME ZONE,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_started_at TIMESTAMP WITH TIME ZONE,
    completion_token UUID,
    completion_fanout_hash VARCHAR(32),
    last_error_code VARCHAR(64),
    last_error_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key),
    CONSTRAINT analysis_pipeline_jobs_job_key_check CHECK (
        pg_catalog.char_length(job_key) BETWEEN 1 AND 160
        AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_pipeline_jobs_track_check CHECK (
        pg_catalog.char_length(track) BETWEEN 1 AND 50
        AND track ~ '^[a-z][a-z0-9_]{0,49}$'
    ),
    CONSTRAINT analysis_pipeline_jobs_kind_check CHECK (
        pg_catalog.char_length(kind) BETWEEN 1 AND 50
        AND kind ~ '^[a-z][a-z0-9_]{0,49}$'
    ),
    CONSTRAINT analysis_pipeline_jobs_batch_check CHECK (
        batch IS NULL OR batch BETWEEN 0 AND 100000
    ),
    CONSTRAINT analysis_pipeline_jobs_input_hash_check CHECK (
        input_hash ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_pipeline_jobs_required_keys_check CHECK (
        public.analysis_v2_valid_job_keys(required_job_keys)
        AND NOT job_key = ANY(required_job_keys)
    ),
    CONSTRAINT analysis_pipeline_jobs_status_check CHECK (
        status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT analysis_pipeline_jobs_dispatch_state_check CHECK (
        dispatch_state IN ('pending', 'reserved', 'enqueued', 'delivered')
    ),
    CONSTRAINT analysis_pipeline_jobs_dispatch_generation_check CHECK (
        dispatch_generation BETWEEN 0 AND 1000
    ),
    CONSTRAINT analysis_pipeline_jobs_dispatch_pair_check CHECK (
        (
            dispatch_state = 'pending'
            AND dispatch_generation = 0
            AND dispatch_reservation_token IS NULL
            AND dispatch_reserved_at IS NULL
            AND dispatched_at IS NULL
            AND dispatch_task_name IS NULL
            AND delivered_at IS NULL
        )
        OR (
            dispatch_state = 'reserved'
            AND dispatch_generation > 0
            AND dispatch_reservation_token IS NOT NULL
            AND dispatch_reserved_at IS NOT NULL
            AND dispatched_at IS NULL
            AND dispatch_task_name IS NULL
            AND delivered_at IS NULL
        )
        OR (
            dispatch_state = 'enqueued'
            AND dispatch_generation > 0
            AND dispatch_reservation_token IS NOT NULL
            AND dispatch_reserved_at IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND dispatch_task_name IS NOT NULL
            AND delivered_at IS NULL
        )
        OR (
            dispatch_state = 'delivered'
            AND dispatch_generation > 0
            AND dispatch_reservation_token IS NOT NULL
            AND dispatch_reserved_at IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND dispatch_task_name IS NOT NULL
            AND delivered_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_task_name_check CHECK (
        dispatch_task_name IS NULL
        OR (
            pg_catalog.char_length(dispatch_task_name) BETWEEN 1 AND 512
            AND dispatch_task_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,511}$'
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_lease_check CHECK (
        (
            status = 'processing'
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND dispatch_state = 'delivered'
        )
        OR (
            status <> 'processing'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_attempt_check CHECK (
        attempt_count BETWEEN 0 AND 100
        AND (
            (attempt_count = 0 AND first_started_at IS NULL)
            OR (attempt_count > 0 AND first_started_at IS NOT NULL)
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_completion_check CHECK (
        (
            status = 'completed'
            AND completed_at IS NOT NULL
            AND completion_token IS NOT NULL
            AND completion_fanout_hash IS NOT NULL
            AND completion_fanout_hash ~ '^[a-f0-9]{32}$'
        )
        OR (
            status <> 'completed'
            AND completion_token IS NULL
            AND completion_fanout_hash IS NULL
            AND (
                (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL)
                OR (status IN ('pending', 'processing') AND completed_at IS NULL)
            )
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_error_check CHECK (
        (last_error_code IS NULL AND last_error_at IS NULL)
        OR (
            last_error_code IS NOT NULL
            AND last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
            AND last_error_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_pipeline_jobs_failed_error_check CHECK (
        status <> 'failed' OR last_error_code IS NOT NULL
    ),
    CONSTRAINT analysis_pipeline_jobs_timestamp_check CHECK (
        updated_at >= created_at
        AND (dispatch_reserved_at IS NULL OR dispatch_reserved_at >= created_at)
        AND (dispatched_at IS NULL OR dispatched_at >= dispatch_reserved_at)
        AND (delivered_at IS NULL OR delivered_at >= dispatched_at)
        AND (first_started_at IS NULL OR first_started_at >= created_at)
        AND (last_error_at IS NULL OR last_error_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
    )
);

CREATE INDEX idx_analysis_pipeline_jobs_request_status
    ON public.analysis_pipeline_jobs(request_id, status, job_key);
CREATE INDEX idx_analysis_pipeline_jobs_dispatchable
    ON public.analysis_pipeline_jobs(dispatch_state, created_at, request_id, job_key)
    WHERE status = 'pending';
CREATE INDEX idx_analysis_pipeline_jobs_dispatch_recovery
    ON public.analysis_pipeline_jobs(
        COALESCE(dispatched_at, dispatch_reserved_at, created_at),
        request_id,
        job_key
    )
    WHERE status IN ('pending', 'processing') AND dispatch_state <> 'pending';
CREATE INDEX idx_analysis_pipeline_jobs_expired_lease
    ON public.analysis_pipeline_jobs(lease_expires_at, request_id, job_key)
    WHERE status = 'processing';
CREATE INDEX idx_analysis_pipeline_jobs_terminal
    ON public.analysis_pipeline_jobs(completed_at, request_id)
    WHERE status IN ('completed', 'failed', 'cancelled');

ALTER TABLE public.analysis_pipeline_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_pipeline_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_pipeline_jobs
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analysis_pipeline_jobs TO service_role;

COMMENT ON TABLE public.analysis_pipeline_jobs IS
    'Service-only, PII-free V2 job ledger and transactional outbox keyed by request and logical job.';
COMMENT ON COLUMN public.analysis_pipeline_jobs.job_key IS
    'PII-free stable logical identity. Usernames and provider payloads are forbidden.';
COMMENT ON COLUMN public.analysis_pipeline_jobs.required_job_keys IS
    'Sorted, unique same-request prerequisites used for an atomic coordinator join.';
COMMENT ON COLUMN public.analysis_pipeline_jobs.dispatch_reservation_token IS
    'Generation fence retained across enqueue and delivery so stale tasks cannot claim newer work.';
COMMENT ON COLUMN public.analysis_pipeline_jobs.completion_fanout_hash IS
    'MD5 of canonical bounded JSONB fanout only for idempotency comparison, not security.';

-- Keep the mature entitlement validation in a private helper, then atomically add the first job.
ALTER FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
    RENAME TO consume_analysis_v2_test_entitlement_pre_job;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_test_entitlement_pre_job(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request_id UUID;
    v_created BOOLEAN;
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_input_hash TEXT;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    SELECT consumed.request_id, consumed.created
    INTO v_request_id, v_created
    FROM public.consume_analysis_v2_test_entitlement_pre_job(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash
    ) AS consumed;

    IF v_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.preflight_id = p_preflight_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_request.pipeline_version <> 'v2'
       OR v_request.plan_access_mode_snapshot <> 'test_entitlement'
       OR v_request.selected_plan_id_snapshot <> p_selected_plan_id
       OR v_request.test_entitlement_jti_hash <> p_entitlement_jti_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_input_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-job-input-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(v_request_id::TEXT)
                    || pg_catalog.chr(10)
                    || v_initial_job_key,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    INSERT INTO public.analysis_pipeline_jobs (
        request_id,
        job_key,
        track,
        kind,
        batch,
        input_hash,
        required_job_keys
    ) VALUES (
        v_request_id,
        v_initial_job_key,
        'coordinator',
        'bootstrap',
        NULL,
        v_input_hash,
        '{}'::TEXT[]
    )
    ON CONFLICT (request_id, job_key) DO NOTHING;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_request_id
      AND job.job_key = v_initial_job_key
    FOR UPDATE;

    IF NOT FOUND
       OR v_job.track <> 'coordinator'
       OR v_job.kind <> 'bootstrap'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash <> v_input_hash
       OR v_job.required_job_keys <> '{}'::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        v_request_id,
        v_created,
        v_initial_job_key,
        v_request.status::TEXT,
        v_request.background_processing;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT) IS
    'Atomically consumes/replays one entitlement, ensures coordinator:bootstrap, and returns the immutable request identity plus its current execution state.';
COMMENT ON FUNCTION public.consume_analysis_v2_test_entitlement_pre_job(UUID, UUID, TEXT, TEXT) IS
    'Internal Phase B validation helper. It has no Data API execution grant.';

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_job_dispatch(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_token UUID
)
RETURNS TABLE(
    reserved BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT,
    task_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_dispatch_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_DISPATCH_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN ('pending', 'processing') OR v_job.status <> 'pending' THEN
        RETURN QUERY SELECT
            FALSE,
            v_job.dispatch_generation,
            v_job.dispatch_reservation_token,
            v_job.status::TEXT,
            v_job.dispatch_state::TEXT,
            v_job.dispatch_task_name::TEXT;
        RETURN;
    END IF;

    IF v_job.dispatch_state = 'pending' THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET dispatch_state = 'reserved',
            dispatch_generation = 1,
            dispatch_reservation_token = p_dispatch_token,
            dispatch_reserved_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;
    ELSIF v_job.dispatch_state = 'reserved' THEN
        -- A missing/ambiguous create response reuses this exact generation and token. Age alone
        -- never rotates a task identity.
        NULL;
    ELSE
        RETURN QUERY SELECT
            FALSE,
            v_job.dispatch_generation,
            v_job.dispatch_reservation_token,
            v_job.status::TEXT,
            v_job.dispatch_state::TEXT,
            v_job.dispatch_task_name::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        TRUE,
        v_job.dispatch_generation,
        v_job.dispatch_reservation_token,
        v_job.status::TEXT,
        v_job.dispatch_state::TEXT,
        v_job.dispatch_task_name::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_job_dispatched(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_task_name TEXT
)
RETURNS TABLE(marked BOOLEAN, job_status TEXT, dispatch_state TEXT, task_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_dispatch_token IS NULL
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_task_name IS NULL
       OR pg_catalog.char_length(p_task_name) NOT BETWEEN 1 AND 512
       OR p_task_name !~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,511}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_DISPATCH_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.dispatch_state IN ('enqueued', 'delivered') THEN
        IF v_job.dispatch_generation = p_dispatch_generation
           AND v_job.dispatch_reservation_token = p_dispatch_token
           AND v_job.dispatch_task_name = p_task_name THEN
            RETURN QUERY SELECT
                TRUE,
                v_job.status::TEXT,
                v_job.dispatch_state::TEXT,
                v_job.dispatch_task_name::TEXT;
            RETURN;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'pending'
       OR v_job.dispatch_state <> 'reserved'
       OR v_job.dispatch_generation <> p_dispatch_generation
       OR v_job.dispatch_reservation_token <> p_dispatch_token THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET dispatch_state = 'enqueued',
        dispatched_at = v_now,
        dispatch_task_name = p_task_name,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'processing',
        background_processing = TRUE,
        progress_step = 'V2 analysis queued',
        current_step = 'v2_pipeline'
    WHERE analysis_request.id = p_request_id
      AND analysis_request.status IN ('pending', 'processing');

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.dispatch_state::TEXT,
        v_job.dispatch_task_name::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.rearm_analysis_v2_job_dispatch(
    p_request_id UUID,
    p_job_key TEXT,
    p_expected_generation INTEGER,
    p_expected_dispatch_token UUID,
    p_new_dispatch_token UUID
)
RETURNS TABLE(
    rearmed BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_expected_generation IS NULL
       OR p_expected_generation NOT BETWEEN 1 AND 999
       OR p_expected_dispatch_token IS NULL
       OR p_new_dispatch_token IS NULL
       OR p_new_dispatch_token = p_expected_dispatch_token
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_DISPATCH_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.dispatch_state = 'reserved'
       AND v_job.dispatch_generation = p_expected_generation + 1
       AND v_job.dispatch_reservation_token = p_new_dispatch_token THEN
        RETURN QUERY SELECT
            TRUE,
            v_job.dispatch_generation,
            v_job.dispatch_reservation_token,
            v_job.status::TEXT,
            v_job.dispatch_state::TEXT;
        RETURN;
    END IF;

    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.dispatch_state NOT IN ('enqueued', 'delivered')
       OR v_job.dispatch_generation <> p_expected_generation
       OR v_job.dispatch_reservation_token <> p_expected_dispatch_token
       OR NOT (
            v_job.status = 'pending'
            OR (
                v_job.status = 'processing'
                AND v_job.lease_expires_at <= v_now
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- The caller must first prove Cloud Tasks NOT_FOUND. The database deliberately cannot infer
    -- absence from age, because an ambiguous task-create response must reuse the old identity.
    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'pending',
        dispatch_state = 'reserved',
        dispatch_generation = p_expected_generation + 1,
        dispatch_reservation_token = p_new_dispatch_token,
        dispatch_reserved_at = v_now,
        dispatched_at = NULL,
        dispatch_task_name = NULL,
        delivered_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    RETURN QUERY SELECT
        TRUE,
        v_job.dispatch_generation,
        v_job.dispatch_reservation_token,
        v_job.status::TEXT,
        v_job.dispatch_state::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_analysis_v2_job_dispatch(
    UUID, TEXT, INTEGER, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_analysis_v2_job_dispatch(
    UUID, TEXT, INTEGER, UUID, UUID
) TO service_role;

COMMENT ON FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID) IS
    'Reserves/replays one deterministic task generation; returns reservation fence and current job/dispatch state.';
COMMENT ON FUNCTION public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT) IS
    'Fenced enqueue acknowledgement; only this transition marks the V2 request background-processing.';
COMMENT ON FUNCTION public.rearm_analysis_v2_job_dispatch(UUID, TEXT, INTEGER, UUID, UUID) IS
    'Returns a new reservation fence only after caller-verified Cloud Tasks NOT_FOUND; age never rotates identity.';

CREATE OR REPLACE FUNCTION public.fail_analysis_v2_request_from_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_error_code IS NULL
       OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FAILURE_INPUT', ERRCODE = 'P0001';
    END IF;

    -- Callers must already hold the matching preflight, request, and job locks in that order.
    -- Keeping the terminal helper lock-free prevents a request -> preflight lock inversion with
    -- entitlement replay, which acquires preflight -> request.

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'failed',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = p_error_code,
        last_error_at = v_now,
        completed_at = v_now,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status IN ('pending', 'processing');

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'cancelled',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = COALESCE(job.last_error_code, 'REQUEST_TERMINATED'),
        last_error_at = COALESCE(job.last_error_at, v_now),
        completed_at = v_now,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key <> p_job_key
      AND job.status IN ('pending', 'processing');

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'failed',
        background_processing = FALSE,
        progress_step = 'V2 analysis failed',
        current_step = 'failed',
        error_message = p_error_code,
        completed_at = v_now
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing');

    -- The job ledger is intentionally retained as PII-free telemetry. Only duplicate preflight PII
    -- is scrubbed here; later staging migrations extend terminal purging transactionally.
    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        pii_scrubbed_at = COALESCE(preflight.pii_scrubbed_at, v_now),
        updated_at = v_now
    WHERE preflight.consumed_request_id = p_request_id
      AND preflight.status = 'consumed';
END;
$$;

REVOKE ALL ON FUNCTION public.fail_analysis_v2_request_from_job(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120,
    p_max_attempts INTEGER DEFAULT 7
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
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_dispatch_token IS NULL
       OR p_claim_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 30 AND 600
       OR p_max_attempts IS NULL
       OR p_max_attempts NOT BETWEEN 1 AND 20
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status IN ('completed', 'failed', 'cancelled')
       OR v_request.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY SELECT
            FALSE,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_job.lease_expires_at,
            v_job.track::TEXT,
            v_job.kind::TEXT,
            v_job.batch,
            v_job.input_hash::TEXT;
        RETURN;
    END IF;

    IF v_job.dispatch_generation <> p_dispatch_generation
       OR v_job.dispatch_reservation_token <> p_dispatch_token THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- A task may arrive after Cloud Tasks accepted it but before the enqueue acknowledgement
    -- transaction commits. This is retryable for the same generation, not a stale delivery.
    IF v_job.dispatch_state = 'reserved' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_job.dispatch_state NOT IN ('enqueued', 'delivered') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_job.status = 'processing' AND v_job.lease_expires_at > v_now THEN
        RETURN QUERY SELECT
            v_job.lease_token = p_claim_token,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_job.lease_expires_at,
            v_job.track::TEXT,
            v_job.kind::TEXT,
            v_job.batch,
            v_job.input_hash::TEXT;
        RETURN;
    END IF;

    IF v_job.attempt_count >= p_max_attempts THEN
        PERFORM public.fail_analysis_v2_request_from_job(
            p_request_id,
            p_job_key,
            'JOB_ATTEMPTS_EXHAUSTED'
        );
        SELECT job.*
        INTO v_job
        FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key;
        RETURN QUERY SELECT
            FALSE,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_job.lease_expires_at,
            v_job.track::TEXT,
            v_job.kind::TEXT,
            v_job.batch,
            v_job.input_hash::TEXT;
        RETURN;
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'processing',
        dispatch_state = 'delivered',
        delivered_at = COALESCE(job.delivered_at, v_now),
        lease_token = p_claim_token,
        lease_expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
        attempt_count = job.attempt_count + 1,
        first_started_at = COALESCE(job.first_started_at, v_now),
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'processing',
        background_processing = TRUE
    WHERE analysis_request.id = p_request_id
      AND analysis_request.status IN ('pending', 'processing');

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.attempt_count,
        v_job.lease_expires_at,
        v_job.track::TEXT,
        v_job.kind::TEXT,
        v_job.batch,
        v_job.input_hash::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.release_analysis_v2_job_claim(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_error_code TEXT,
    p_retryable BOOLEAN,
    p_max_attempts INTEGER DEFAULT 7
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
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_retryable IS NULL
       OR p_max_attempts IS NULL
       OR p_max_attempts NOT BETWEEN 1 AND 20
       OR (
            p_error_code IS NOT NULL
            AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
       )
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_RELEASE_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status <> 'processing' THEN
        RETURN QUERY SELECT
            FALSE,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_request.status::TEXT;
        RETURN;
    END IF;

    IF v_job.lease_token <> p_claim_token OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF p_retryable AND v_job.attempt_count < p_max_attempts THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET status = 'pending',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = COALESCE(p_error_code, 'JOB_RETRYABLE_FAILURE'),
            last_error_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;
    ELSE
        PERFORM public.fail_analysis_v2_request_from_job(
            p_request_id,
            p_job_key,
            CASE
                WHEN p_retryable THEN 'JOB_ATTEMPTS_EXHAUSTED'
                ELSE COALESCE(p_error_code, 'JOB_FAILED')
            END
        );
        SELECT job.*
        INTO v_job
        FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key;
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.attempt_count,
        v_request.status::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.release_analysis_v2_job_claim(
    UUID, TEXT, UUID, TEXT, BOOLEAN, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_job_claim(
    UUID, TEXT, UUID, TEXT, BOOLEAN, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) IS 'Claims one generation-fenced V2 job with a bounded per-job attempt budget.';
COMMENT ON FUNCTION public.release_analysis_v2_job_claim(
    UUID, TEXT, UUID, TEXT, BOOLEAN, INTEGER
) IS 'Fenced retry release or terminal request failure for one V2 job attempt.';
COMMENT ON FUNCTION public.fail_analysis_v2_request_from_job(UUID, TEXT, TEXT) IS
    'Internal terminal-failure helper; retains the PII-free ledger and scrubs duplicate preflight PII.';

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_job_and_fanout(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_successors JSONB DEFAULT '[]'::JSONB
)
RETURNS TABLE(
    request_id UUID,
    completed BOOLEAN,
    job_status TEXT,
    dispatchable_job_keys TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_successor public.analysis_pipeline_jobs%ROWTYPE;
    v_spec JSONB;
    v_job_key TEXT;
    v_track TEXT;
    v_kind TEXT;
    v_batch INTEGER;
    v_input_hash TEXT;
    v_required_keys TEXT[];
    v_fanout_hash TEXT;
    v_was_completed BOOLEAN := FALSE;
    v_dispatchable TEXT[] := '{}'::TEXT[];
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_successors IS NULL
       OR pg_catalog.jsonb_typeof(p_successors) <> 'array'
       OR pg_catalog.jsonb_array_length(p_successors) > 100
       OR pg_catalog.octet_length(p_successors::TEXT) > 65536 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_successors) AS successor(spec)
        GROUP BY successor.spec->>'jobKey'
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
    END IF;

    v_fanout_hash := pg_catalog.md5(p_successors::TEXT);

    -- The request row serializes all predecessor completions. The second of two concurrent
    -- completions therefore observes the first commit and opens a join exactly once.
    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status = 'completed' THEN
        IF v_job.completion_token <> p_claim_token
           OR v_job.completion_fanout_hash <> v_fanout_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;
        v_was_completed := TRUE;
    ELSIF v_job.status = 'processing' THEN
        IF v_request.status NOT IN ('pending', 'processing')
           OR v_job.lease_token <> p_claim_token
           OR v_job.lease_expires_at <= v_now THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_pipeline_jobs AS job
        SET status = 'completed',
            lease_token = NULL,
            lease_expires_at = NULL,
            completion_token = p_claim_token,
            completion_fanout_hash = v_fanout_hash,
            completed_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;
    ELSE
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY SELECT
            p_request_id,
            NOT v_was_completed,
            v_job.status::TEXT,
            '{}'::TEXT[];
        RETURN;
    END IF;

    FOR v_spec IN
        SELECT successor.spec
        FROM pg_catalog.jsonb_array_elements(p_successors) AS successor(spec)
    LOOP
        IF pg_catalog.jsonb_typeof(v_spec) <> 'object'
           OR v_spec - ARRAY[
                'jobKey',
                'track',
                'kind',
                'batch',
                'inputHash',
                'requiredJobKeys'
           ]::TEXT[] <> '{}'::JSONB
           OR NOT (v_spec ?& ARRAY['jobKey', 'track', 'kind', 'batch', 'inputHash'])
           OR pg_catalog.jsonb_typeof(v_spec->'jobKey') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'track') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'kind') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'inputHash') <> 'string'
           OR (
                v_spec ? 'requiredJobKeys'
                AND pg_catalog.jsonb_typeof(v_spec->'requiredJobKeys') <> 'array'
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        v_job_key := v_spec->>'jobKey';
        v_track := v_spec->>'track';
        v_kind := v_spec->>'kind';
        v_input_hash := v_spec->>'inputHash';

        IF pg_catalog.char_length(v_job_key) NOT BETWEEN 1 AND 160
           OR v_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
           OR v_job_key = p_job_key
           OR pg_catalog.char_length(v_track) NOT BETWEEN 1 AND 50
           OR v_track !~ '^[a-z][a-z0-9_]{0,49}$'
           OR pg_catalog.char_length(v_kind) NOT BETWEEN 1 AND 50
           OR v_kind !~ '^[a-z][a-z0-9_]{0,49}$'
           OR v_input_hash !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        IF pg_catalog.jsonb_typeof(v_spec->'batch') = 'null' THEN
            v_batch := NULL;
        ELSIF pg_catalog.jsonb_typeof(v_spec->'batch') = 'number'
              AND v_spec->>'batch' ~ '^(0|[1-9][0-9]{0,5})$'
              AND (v_spec->>'batch')::INTEGER BETWEEN 0 AND 100000 THEN
            v_batch := (v_spec->>'batch')::INTEGER;
        ELSE
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        SELECT COALESCE(
            pg_catalog.array_agg(required_key.value ORDER BY required_key.value),
            '{}'::TEXT[]
        )
        INTO v_required_keys
        FROM pg_catalog.jsonb_array_elements_text(
            COALESCE(v_spec->'requiredJobKeys', '[]'::JSONB)
        ) AS required_key(value);

        IF NOT public.analysis_v2_valid_job_keys(v_required_keys)
           OR v_job_key = ANY(v_required_keys) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(v_required_keys) AS required_key(value)
            LEFT JOIN public.analysis_pipeline_jobs AS required_job
              ON required_job.request_id = p_request_id
             AND required_job.job_key = required_key.value
            WHERE required_job.request_id IS NULL
               OR required_job.status <> 'completed'
        ) THEN
            INSERT INTO public.analysis_pipeline_jobs (
                request_id,
                job_key,
                track,
                kind,
                batch,
                input_hash,
                required_job_keys
            ) VALUES (
                p_request_id,
                v_job_key,
                v_track,
                v_kind,
                v_batch,
                v_input_hash,
                v_required_keys
            )
            ON CONFLICT (request_id, job_key) DO NOTHING;

            SELECT successor.*
            INTO v_successor
            FROM public.analysis_pipeline_jobs AS successor
            WHERE successor.request_id = p_request_id
              AND successor.job_key = v_job_key
            FOR UPDATE;

            IF NOT FOUND
               OR v_successor.track <> v_track
               OR v_successor.kind <> v_kind
               OR v_successor.batch IS DISTINCT FROM v_batch
               OR v_successor.input_hash <> v_input_hash
               OR v_successor.required_job_keys <> v_required_keys THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_FANOUT_CONFLICT', ERRCODE = 'P0001';
            END IF;

            IF v_successor.status = 'pending' THEN
                v_dispatchable := pg_catalog.array_append(v_dispatchable, v_job_key);
            END IF;
        END IF;
    END LOOP;

    SELECT COALESCE(
        pg_catalog.array_agg(DISTINCT dispatchable_key.value ORDER BY dispatchable_key.value),
        '{}'::TEXT[]
    )
    INTO v_dispatchable
    FROM pg_catalog.unnest(v_dispatchable) AS dispatchable_key(value);

    RETURN QUERY SELECT
        p_request_id,
        NOT v_was_completed,
        v_job.status::TEXT,
        v_dispatchable;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_job_and_fanout(
    UUID, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_job_and_fanout(
    UUID, TEXT, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION public.complete_analysis_v2_job_and_fanout(UUID, TEXT, UUID, JSONB) IS
    'Completes under a lease and accepts <=100 strict {jobKey,track,kind,batch,inputHash,requiredJobKeys?} specs; returns ready keys after request-serialized joins.';

CREATE OR REPLACE FUNCTION public.list_analysis_v2_dispatchable_jobs(
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
    request_id UUID,
    job_key TEXT,
    job_status TEXT,
    dispatch_state TEXT,
    dispatch_generation INTEGER,
    reservation_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    task_name TEXT,
    lease_expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_SCAN_INPUT', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT
        job.request_id,
        job.job_key::TEXT,
        job.status::TEXT,
        job.dispatch_state::TEXT,
        job.dispatch_generation,
        job.dispatch_reservation_token,
        job.dispatch_reserved_at,
        job.dispatched_at,
        job.dispatch_task_name::TEXT,
        job.lease_expires_at
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = job.request_id
    WHERE analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND (
            (
                job.status = 'pending'
                AND (
                    job.dispatch_state IN ('pending', 'reserved')
                    OR (
                        job.dispatch_state IN ('enqueued', 'delivered')
                        AND job.updated_at <= clock_timestamp() - INTERVAL '2 minutes'
                    )
                )
            )
            OR (
                job.status = 'processing'
                AND job.lease_expires_at <= clock_timestamp()
            )
      )
    ORDER BY
        CASE job.dispatch_state
            WHEN 'pending' THEN 0
            WHEN 'reserved' THEN 1
            WHEN 'enqueued' THEN 2
            ELSE 3
        END,
        COALESCE(job.lease_expires_at, job.dispatched_at, job.dispatch_reserved_at, job.created_at),
        job.request_id,
        job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_analysis_v2_request(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_terminal_status TEXT,
    p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE(finalized BOOLEAN, request_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_terminal_status IS NULL
       OR p_terminal_status NOT IN ('completed', 'failed')
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR (
            p_terminal_status = 'completed'
            AND p_error_code IS NOT NULL
       )
       OR (
            p_terminal_status = 'failed'
            AND (
                p_error_code IS NULL
                OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_FINALIZE_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF p_terminal_status = 'completed'
       AND (
            p_job_key <> 'coordinator:finalize'
            OR v_job.track <> 'coordinator'
            OR v_job.kind <> 'finalizer'
            OR pg_catalog.cardinality(v_job.required_job_keys) < 1
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_FINALIZER', ERRCODE = 'P0001';
    END IF;

    IF v_request.status IN ('completed', 'failed') THEN
        IF v_request.status = p_terminal_status THEN
            RETURN QUERY SELECT FALSE, v_request.status::TEXT;
            RETURN;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FINALIZE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_job.status <> 'processing'
       OR v_job.lease_token <> p_claim_token
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF p_terminal_status = 'completed' AND (
        EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(v_job.required_job_keys) AS required_key(value)
            LEFT JOIN public.analysis_pipeline_jobs AS required_job
              ON required_job.request_id = p_request_id
             AND required_job.job_key = required_key.value
            WHERE required_job.request_id IS NULL
               OR required_job.status <> 'completed'
        )
        OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS sibling
            WHERE sibling.request_id = p_request_id
              AND sibling.job_key <> p_job_key
              AND sibling.status IN ('pending', 'processing')
        )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FINALIZE_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF p_terminal_status = 'failed' THEN
        PERFORM public.fail_analysis_v2_request_from_job(
            p_request_id,
            p_job_key,
            p_error_code
        );
    ELSE
        UPDATE public.analysis_pipeline_jobs AS job
        SET status = 'completed',
            lease_token = NULL,
            lease_expires_at = NULL,
            completion_token = p_claim_token,
            completion_fanout_hash = pg_catalog.md5('[]'),
            completed_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key;

        UPDATE public.analysis_requests AS analysis_request
        SET status = 'completed',
            progress = 100,
            background_processing = FALSE,
            progress_step = 'V2 analysis completed',
            current_step = 'completed',
            error_message = NULL,
            completed_at = v_now
        WHERE analysis_request.id = p_request_id
          AND analysis_request.status IN ('pending', 'processing');

        UPDATE public.analysis_preflights AS preflight
        SET target_instagram_id = 'retained.'
                || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
            target_full_name = NULL,
            target_bio = NULL,
            target_profile_image_url = NULL,
            exclusion_decision = 'skip',
            excluded_instagram_id = NULL,
            pii_scrubbed_at = COALESCE(preflight.pii_scrubbed_at, v_now),
            updated_at = v_now
        WHERE preflight.consumed_request_id = p_request_id
          AND preflight.status = 'consumed';
    END IF;

    RETURN QUERY SELECT TRUE, p_terminal_status;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_analysis_v2_request(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_analysis_v2_request(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER) IS
    'Returns <=500 undispatched, ambiguously dispatched, stale, or lease-expired active V2 jobs for recovery.';
COMMENT ON FUNCTION public.finalize_analysis_v2_request(UUID, TEXT, UUID, TEXT, TEXT) IS
    'Fenced V2 terminal transition; success is reserved for a dependency-complete coordinator:finalize job, and terminal paths scrub duplicate preflight PII.';
