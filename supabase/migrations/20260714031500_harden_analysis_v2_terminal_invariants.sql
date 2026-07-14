-- Close terminal and legacy-RPC gaps discovered during the pre-launch V2 review.
-- This migration is deliberately additive so an already-migrated environment is
-- hardened without rewriting provider-run or result history.

-- The foundation finalizer predates result staging and provider cleanup. It must
-- remain present for migration compatibility, but no runtime role may call it.
REVOKE ALL ON FUNCTION public.finalize_analysis_v2_request(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.finalize_analysis_v2_request(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Deprecated DB-owner-only V2 foundation finalizer. Runtime uses the exact result and provider-cleanup gates.';

-- Legacy V1 request-wide leases remain usable for NULL/v1 rows, but can never
-- acquire or release a durable V2 request.
CREATE OR REPLACE FUNCTION public.acquire_analysis_request_lease(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_lease_token UUID,
    p_lease_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_lease_seconds < 30 OR p_lease_seconds > 7200 THEN
        RAISE EXCEPTION 'lease duration out of range';
    END IF;

    UPDATE public.analysis_requests AS analysis_request
    SET processing_lease_token = p_lease_token,
        processing_lease_expires_at = pg_catalog.clock_timestamp()
            + pg_catalog.make_interval(secs => p_lease_seconds)
    WHERE analysis_request.id = p_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.pipeline_version IS DISTINCT FROM 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND COALESCE(analysis_request.current_step, 'pending') = p_expected_step
      AND (
          analysis_request.processing_lease_token IS NULL
          OR analysis_request.processing_lease_expires_at IS NULL
          OR analysis_request.processing_lease_expires_at <= pg_catalog.clock_timestamp()
      );

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_analysis_request_lease(
    p_request_id UUID,
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    UPDATE public.analysis_requests AS analysis_request
    SET processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version IS DISTINCT FROM 'v2'
      AND analysis_request.processing_lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_analysis_request_lease(
    UUID, UUID, TEXT, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_request_lease(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_analysis_request_lease(
    UUID, UUID, TEXT, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_request_lease(UUID, UUID)
    TO service_role;

-- Rebind the two V1 terminal RPCs with the same compact-state contract and an
-- explicit pipeline-version predicate. A V2 call returns false before any purge.
CREATE OR REPLACE FUNCTION public.complete_analysis_request_and_purge_staging(
    p_request_id UUID,
    p_user_id UUID,
    p_step_data JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_step_data IS NULL OR pg_catalog.jsonb_typeof(p_step_data) <> 'object' THEN
        RAISE EXCEPTION 'invalid compact analysis step data';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(p_step_data) AS keys(key_name)
        WHERE keys.key_name NOT IN ('mutualFollows', 'targetProfileImage')
    ) THEN
        RAISE EXCEPTION 'compact analysis step data contains unsupported keys';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND pg_catalog.jsonb_typeof(p_step_data->'mutualFollows') <> 'array' THEN
        RAISE EXCEPTION 'invalid compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND pg_catalog.jsonb_array_length(p_step_data->'mutualFollows') > 10 THEN
        RAISE EXCEPTION 'too many compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(
               p_step_data->'mutualFollows'
           ) AS mutual(username)
           WHERE pg_catalog.jsonb_typeof(mutual.username) <> 'string'
              OR pg_catalog.char_length(mutual.username #>> '{}') > 30
              OR (mutual.username #>> '{}') !~ '^[a-z0-9._]{1,30}$'
       ) THEN
        RAISE EXCEPTION 'invalid compact mutual follow username';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND pg_catalog.jsonb_typeof(p_step_data->'targetProfileImage') <> 'string' THEN
        RAISE EXCEPTION 'invalid compact target profile image';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND pg_catalog.char_length(p_step_data->>'targetProfileImage') > 8192 THEN
        RAISE EXCEPTION 'compact target profile image is too long';
    END IF;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'completed',
        current_step = 'completed',
        progress = 100,
        progress_step = '분석 완료!',
        completed_at = pg_catalog.clock_timestamp(),
        background_processing = FALSE,
        step_data = p_step_data,
        processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE analysis_request.id = p_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.pipeline_version IS DISTINCT FROM 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND COALESCE(analysis_request.current_step, 'pending') = 'finalize';

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.analysis_interaction_jobs
    WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_evidence
    WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_scores
    WHERE request_id = p_request_id;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_analysis_request_and_purge_staging(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_error_message TEXT,
    p_step_data JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_expected_step IS NULL
       OR pg_catalog.char_length(p_expected_step) NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'invalid expected analysis step';
    END IF;
    IF p_error_message IS NULL
       OR pg_catalog.char_length(p_error_message) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'invalid analysis failure message';
    END IF;
    IF p_step_data IS NULL OR pg_catalog.jsonb_typeof(p_step_data) <> 'object' THEN
        RAISE EXCEPTION 'invalid compact analysis step data';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(p_step_data) AS keys(key_name)
        WHERE keys.key_name NOT IN ('mutualFollows', 'targetProfileImage')
    ) THEN
        RAISE EXCEPTION 'compact analysis step data contains unsupported keys';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND pg_catalog.jsonb_typeof(p_step_data->'mutualFollows') <> 'array' THEN
        RAISE EXCEPTION 'invalid compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND pg_catalog.jsonb_array_length(p_step_data->'mutualFollows') > 10 THEN
        RAISE EXCEPTION 'too many compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(
               p_step_data->'mutualFollows'
           ) AS mutual(username)
           WHERE pg_catalog.jsonb_typeof(mutual.username) <> 'string'
              OR pg_catalog.char_length(mutual.username #>> '{}') > 30
              OR (mutual.username #>> '{}') !~ '^[a-z0-9._]{1,30}$'
       ) THEN
        RAISE EXCEPTION 'invalid compact mutual follow username';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND pg_catalog.jsonb_typeof(p_step_data->'targetProfileImage') <> 'string' THEN
        RAISE EXCEPTION 'invalid compact target profile image';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND pg_catalog.char_length(p_step_data->>'targetProfileImage') > 8192 THEN
        RAISE EXCEPTION 'compact target profile image is too long';
    END IF;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'failed',
        current_step = 'failed',
        progress_step = '분석 처리 중 오류가 발생했습니다.',
        error_message = p_error_message,
        background_processing = FALSE,
        step_data = p_step_data,
        processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE analysis_request.id = p_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.pipeline_version IS DISTINCT FROM 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND COALESCE(analysis_request.current_step, 'pending') = p_expected_step;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.analysis_interaction_jobs WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_evidence WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_scores WHERE request_id = p_request_id;
    DELETE FROM public.analysis_results WHERE request_id = p_request_id;
    DELETE FROM public.private_accounts WHERE request_id = p_request_id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_request_and_purge_staging(
    UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fail_analysis_request_and_purge_staging(
    UUID, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_request_and_purge_staging(
    UUID, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_analysis_request_and_purge_staging(
    UUID, UUID, TEXT, TEXT, JSONB
) TO service_role;

-- Keep the latest concurrency trigger non-mutating. In particular, it never
-- invokes either V1 stale-failure RPC for a V2 row.
CREATE OR REPLACE FUNCTION public.reject_concurrent_analysis_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.user_id = NEW.user_id
          AND analysis_request.status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_ALREADY_IN_PROGRESS';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_concurrent_analysis_request()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_concurrent_analysis_request()
    TO service_role;

-- A claim that discovers an exhausted crash must not fail or purge the request.
-- It installs a fresh cleanup-capable lease, preserving an earlier intent or
-- creating JOB_ATTEMPTS_EXHAUSTED, so cleanup runs before the stage handler.
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
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
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_CLAIM_INPUT', ERRCODE = 'P0001';
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
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status IN ('completed', 'failed', 'cancelled')
       OR v_request.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY SELECT
            FALSE, v_job.status::TEXT, v_job.attempt_count,
            v_job.lease_expires_at, v_job.track::TEXT, v_job.kind::TEXT,
            v_job.batch, v_job.input_hash::TEXT;
        RETURN;
    END IF;

    IF v_job.dispatch_generation <> p_dispatch_generation
       OR v_job.dispatch_reservation_token <> p_dispatch_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_job.dispatch_state = 'reserved' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_job.dispatch_state NOT IN ('enqueued', 'delivered') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_job.status = 'processing' AND v_job.lease_expires_at > v_now THEN
        RETURN QUERY SELECT
            v_job.lease_token = p_claim_token, v_job.status::TEXT,
            v_job.attempt_count, v_job.lease_expires_at, v_job.track::TEXT,
            v_job.kind::TEXT, v_job.batch, v_job.input_hash::TEXT;
        RETURN;
    END IF;

    IF v_job.attempt_count >= p_max_attempts THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET status = 'processing',
            dispatch_state = 'delivered',
            delivered_at = COALESCE(job.delivered_at, v_now),
            lease_token = p_claim_token,
            lease_expires_at = v_now
                + p_lease_seconds * INTERVAL '1 second',
            last_error_code = 'JOB_ATTEMPTS_EXHAUSTED',
            last_error_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;

        SELECT intent.* INTO v_intent
        FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id
        FOR UPDATE;
        IF FOUND THEN
            IF v_intent.failed_job_key IS DISTINCT FROM p_job_key
               OR v_intent.failed_job_input_hash IS DISTINCT FROM v_job.input_hash
               OR v_intent.completed_at IS NOT NULL THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT',
                    ERRCODE = 'P0001';
            END IF;
            UPDATE public.analysis_v2_provider_cleanup_intents AS intent
            SET failed_claim_token = p_claim_token
            WHERE intent.request_id = p_request_id;
        ELSE
            INSERT INTO public.analysis_v2_provider_cleanup_intents (
                request_id, failed_job_key, failed_job_input_hash,
                failed_claim_token, error_code
            ) VALUES (
                p_request_id, p_job_key, v_job.input_hash,
                p_claim_token, 'JOB_ATTEMPTS_EXHAUSTED'
            );
        END IF;

        UPDATE public.analysis_requests AS analysis_request
        SET status = 'processing', background_processing = TRUE
        WHERE analysis_request.id = p_request_id
          AND analysis_request.status IN ('pending', 'processing');

        RETURN QUERY SELECT
            TRUE, v_job.status::TEXT, v_job.attempt_count,
            v_job.lease_expires_at, v_job.track::TEXT, v_job.kind::TEXT,
            v_job.batch, v_job.input_hash::TEXT;
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
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'processing', background_processing = TRUE
    WHERE analysis_request.id = p_request_id
      AND analysis_request.status IN ('pending', 'processing');

    RETURN QUERY SELECT
        TRUE, v_job.status::TEXT, v_job.attempt_count,
        v_job.lease_expires_at, v_job.track::TEXT, v_job.kind::TEXT,
        v_job.batch, v_job.input_hash::TEXT;
END;
$$;

-- A release is a retry transition only. Terminal callers must use the provider
-- cleanup lifecycle; this function refuses to mutate terminal state.
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_claim_token IS NULL OR p_retryable IS NULL
       OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 20
       OR (p_error_code IS NOT NULL
           AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$')
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_RELEASE_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status <> 'processing' THEN
        RETURN QUERY SELECT
            FALSE, v_job.status::TEXT, v_job.attempt_count, v_request.status::TEXT;
        RETURN;
    END IF;
    IF v_job.lease_token <> p_claim_token OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF NOT p_retryable OR v_job.attempt_count >= p_max_attempts THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_CLEANUP_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = COALESCE(p_error_code, 'JOB_RETRYABLE_FAILURE'),
        last_error_at = v_now,
        updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    RETURN QUERY SELECT
        TRUE, v_job.status::TEXT, v_job.attempt_count, v_request.status::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_v2_job_claim(
    UUID, TEXT, UUID, TEXT, BOOLEAN, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_job_claim(
    UUID, TEXT, UUID, TEXT, BOOLEAN, INTEGER
) TO service_role;

-- Every fatal path converges on this helper. Even a DB-owner call must present
-- the exact cleanup intent and cannot fail a request while a paid run is active.
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
    v_progress public.analysis_progress_state%ROWTYPE;
    v_tracks JSONB;
    v_fingerprint TEXT;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_error_code IS NULL
       OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FAILURE_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();
    IF v_request.id IS NULL OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL OR v_job.status <> 'processing'
       OR v_job.lease_token IS NULL OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_intent.request_id IS NULL
       OR v_intent.failed_job_key IS DISTINCT FROM p_job_key
       OR v_intent.failed_job_input_hash IS DISTINCT FROM v_job.input_hash
       OR v_intent.failed_claim_token IS DISTINCT FROM v_job.lease_token
       OR v_intent.error_code IS DISTINCT FROM p_error_code
       OR v_intent.completed_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND (
              provider_run.status = 'running'
              OR (
                  provider_run.status = 'starting'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.analysis_v2_unconfirmed_start_resolutions AS resolution
                      WHERE resolution.reservation_token = provider_run.reservation_token
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = p_error_code, last_error_at = v_now,
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
      AND job.status = 'processing';
    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = COALESCE(job.last_error_code, 'REQUEST_TERMINATED'),
        last_error_at = COALESCE(job.last_error_at, v_now),
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key <> p_job_key
      AND job.status IN ('pending', 'processing');

    SELECT progress_state.* INTO v_progress
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id FOR UPDATE;
    IF v_progress.request_id IS NOT NULL
       AND v_progress.status IN ('queued', 'processing') THEN
        v_tracks := pg_catalog.jsonb_build_object(
            'relationshipAi', pg_catalog.jsonb_set(
                v_progress.tracks->'relationshipAi', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'relationshipAi'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            ),
            'interactions', pg_catalog.jsonb_set(
                v_progress.tracks->'interactions', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'interactions'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            ),
            'finalization', pg_catalog.jsonb_set(
                v_progress.tracks->'finalization', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'finalization'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            )
        );
        v_fingerprint := public.analysis_v2_dag_hash_json(
            pg_catalog.jsonb_build_object(
                'domain', 'analysis-v2-progress-snapshot-v1',
                'requestId', p_request_id, 'status', 'failed',
                'progressBp', v_progress.progress_bp,
                'backgroundProcessing', FALSE,
                'tracks', v_tracks, 'activeProfile', NULL,
                'etaRange', NULL, 'errorCode', p_error_code
            )
        );
        UPDATE public.analysis_progress_state AS progress_state
        SET revision = progress_state.revision + 1,
            status = 'failed', background_processing = FALSE,
            tracks = v_tracks, active_profile = NULL, eta_range = NULL,
            snapshot_fingerprint = v_fingerprint, updated_at = v_now
        WHERE progress_state.request_id = p_request_id;
    END IF;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'failed', background_processing = FALSE,
        progress_step = 'V2 analysis failed', current_step = 'failed',
        error_message = p_error_code,
        completed_at = COALESCE(analysis_request.completed_at, v_now)
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing');

    PERFORM public.analysis_v2_purge_result_working_set(p_request_id, FALSE);
    PERFORM public.analysis_v2_scrub_terminal_request_pii(p_request_id, v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_analysis_v2_request_from_job(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- Manual resolution of an ambiguous start is valid only after the whole request
-- has been quiescent for 30 minutes. Canonical locks prevent a concurrent worker
-- from changing the failed lease or provider identity during the audit insert.
CREATE OR REPLACE FUNCTION public.analysis_v2_validate_unconfirmed_start_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_quiet_before TIMESTAMP WITH TIME ZONE;
    v_intent_job_key TEXT;
    v_request public.analysis_requests%ROWTYPE;
    v_failed_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_IMMUTABLE',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = NEW.request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = NEW.request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT intent.failed_job_key INTO v_intent_job_key
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = NEW.request_id AND intent.completed_at IS NULL;
    IF v_intent_job_key IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_failed_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = NEW.request_id AND job.job_key = v_intent_job_key
    FOR UPDATE;
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = NEW.request_id
    FOR UPDATE;
    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = NEW.reservation_token
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();
    v_quiet_before := v_now - INTERVAL '30 minutes';
    IF v_intent.request_id IS NULL OR v_intent.completed_at IS NOT NULL
       OR v_intent.failed_job_key IS DISTINCT FROM v_intent_job_key
       OR v_failed_job.request_id IS NULL
       OR v_failed_job.status <> 'processing'
       OR v_failed_job.input_hash IS DISTINCT FROM v_intent.failed_job_input_hash
       OR v_failed_job.lease_token IS DISTINCT FROM v_intent.failed_claim_token
       OR v_failed_job.lease_expires_at IS NULL
       OR v_failed_job.lease_expires_at > v_quiet_before
       OR v_intent.requested_at > v_quiet_before
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS live_job
            WHERE live_job.request_id = NEW.request_id
              AND live_job.status = 'processing'
              AND live_job.lease_expires_at > v_quiet_before
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_NOT_QUIESCENT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.reservation_token IS NULL OR v_run.status <> 'starting'
       OR v_run.run_id IS NOT NULL
       OR v_run.reserved_at > v_quiet_before
       OR v_run.updated_at > v_quiet_before
       OR v_run.request_id IS DISTINCT FROM NEW.request_id
       OR v_run.job_key IS DISTINCT FROM NEW.job_key
       OR v_run.operation_key IS DISTINCT FROM NEW.operation_key
       OR v_run.input_hash IS DISTINCT FROM NEW.input_hash
       OR v_run.logical_provider IS DISTINCT FROM NEW.logical_provider
       OR v_run.actor_id IS DISTINCT FROM NEW.actor_id
       OR v_run.credential_slot IS DISTINCT FROM NEW.credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM NEW.max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    NEW.database_actor := SESSION_USER;
    NEW.confirmed_at := v_now;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_validate_unconfirmed_start_resolution()
    FROM PUBLIC, anon, authenticated, service_role;

-- Heartbeats are working state. Terminal job transitions purge them in the same
-- transaction, and the one-time delete removes rows retained by older code.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_terminal_active_profile_heartbeat()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status IN ('completed', 'failed', 'cancelled')
       AND OLD.status IS DISTINCT FROM NEW.status THEN
        DELETE FROM public.analysis_v2_active_profile_heartbeats AS heartbeat
        WHERE heartbeat.request_id = NEW.request_id
          AND heartbeat.job_key = NEW.job_key;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_purge_terminal_active_profile_heartbeat()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS analysis_v2_active_profile_terminal_purge
    ON public.analysis_pipeline_jobs;
CREATE TRIGGER analysis_v2_active_profile_terminal_purge
AFTER UPDATE OF status ON public.analysis_pipeline_jobs
FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_purge_terminal_active_profile_heartbeat();

DELETE FROM public.analysis_v2_active_profile_heartbeats AS heartbeat
USING public.analysis_pipeline_jobs AS job,
      public.analysis_requests AS analysis_request
WHERE job.request_id = heartbeat.request_id
  AND job.job_key = heartbeat.job_key
  AND analysis_request.id = heartbeat.request_id
  AND (
      job.status IN ('completed', 'failed', 'cancelled')
      OR analysis_request.status IN ('completed', 'failed')
  );

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_started_at TIMESTAMP WITH TIME ZONE,
    p_total_count INTEGER,
    p_masked_username TEXT,
    p_image_url TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_expected_total INTEGER;
    v_advanced BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^track:(profiles|profile-ai):batch:[0-9]+$'
       OR p_claim_token IS NULL OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_started_at IS NULL
       OR p_started_at < v_now - INTERVAL '30 minutes'
       OR p_started_at > v_now + INTERVAL '5 minutes'
       OR p_total_count IS NULL OR p_total_count NOT BETWEEN 1 AND 30
       OR p_masked_username IS NULL
       OR p_masked_username !~ '^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$'
       OR pg_catalog.char_length(p_masked_username) NOT BETWEEN 1 AND 30
       OR (
            p_image_url IS NOT NULL AND (
                pg_catalog.char_length(p_image_url) NOT BETWEEN 1 AND 2048
                OR p_image_url NOT LIKE '/api/image-proxy?%'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT topology.item_count INTO v_expected_total
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id
      AND topology.topology_kind = 'profile'
      AND topology.batch = pg_catalog.substring(p_job_key, '([0-9]+)$')::INTEGER;
    IF NOT FOUND OR v_expected_total IS DISTINCT FROM p_total_count THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_active_profile_heartbeats (
        request_id, job_key, job_input_hash, claim_token, started_at,
        completed_count, total_count, masked_username, image_url, updated_at
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token, p_started_at,
        0, p_total_count, p_masked_username, p_image_url, v_now
    )
    ON CONFLICT (request_id, job_key) DO UPDATE
    SET job_input_hash = EXCLUDED.job_input_hash,
        claim_token = EXCLUDED.claim_token,
        started_at = EXCLUDED.started_at,
        completed_count = CASE
            WHEN EXCLUDED.claim_token IS DISTINCT FROM
                public.analysis_v2_active_profile_heartbeats.claim_token THEN 0
            ELSE public.analysis_v2_active_profile_heartbeats.completed_count
        END,
        total_count = EXCLUDED.total_count,
        masked_username = EXCLUDED.masked_username,
        image_url = EXCLUDED.image_url,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.claim_token
            IS DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token
       OR (
            EXCLUDED.claim_token
                IS NOT DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token
            AND EXCLUDED.started_at
                > public.analysis_v2_active_profile_heartbeats.started_at
       )
    RETURNING TRUE INTO v_advanced;

    RETURN COALESCE(v_advanced, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
) TO service_role;

-- Failed usage reads receive bounded exponential backoff and rotate behind rows
-- that have never or least recently been attempted. The scheduling metadata is
-- PII-free and remains absent from the runtime JSON contract.
ALTER TABLE public.analysis_v2_provider_runs
    ADD COLUMN usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.analysis_v2_provider_runs
    ADD CONSTRAINT analysis_v2_provider_usage_attempt_count_check CHECK (
        usage_reconciliation_attempt_count BETWEEN 0 AND 100000
    ),
    ADD CONSTRAINT analysis_v2_provider_usage_attempt_time_check CHECK (
        usage_reconciliation_attempted_at IS NULL
        OR usage_reconciliation_attempted_at >= terminalized_at
    );

CREATE INDEX idx_analysis_v2_provider_runs_reconciliation_rotation
    ON public.analysis_v2_provider_runs(
        usage_reconciliation_attempted_at,
        terminalized_at,
        request_id,
        job_key,
        operation_key
    )
    WHERE status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND actual_usage_usd IS NULL
      AND usage_reconciled_at IS NULL;

COMMENT ON COLUMN public.analysis_v2_provider_runs.usage_reconciliation_attempt_count IS
    'PII-free bounded counter used only to back off eventual usage reads.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.usage_reconciliation_attempted_at IS
    'PII-free scheduler timestamp used for least-recently-attempted reconciliation rotation.';

CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    WITH candidate_keys AS MATERIALIZED (
        SELECT
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
          AND provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'
          AND (
              provider_run.usage_reconciliation_attempted_at IS NULL
              OR provider_run.usage_reconciliation_attempted_at <= v_now
                  - pg_catalog.make_interval(
                      secs => LEAST(
                          3600,
                          30 * (1 << LEAST(
                              provider_run.usage_reconciliation_attempt_count,
                              7
                          ))
                      )::DOUBLE PRECISION
                  )
          )
        ORDER BY
            provider_run.usage_reconciliation_attempted_at NULLS FIRST,
            provider_run.terminalized_at,
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), attempted AS (
        UPDATE public.analysis_v2_provider_runs AS provider_run
        SET usage_reconciliation_attempt_count = LEAST(
                provider_run.usage_reconciliation_attempt_count + 1,
                100000
            ),
            usage_reconciliation_attempted_at = v_now,
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE provider_run.request_id = candidate.request_id
          AND provider_run.job_key = candidate.job_key
          AND provider_run.operation_key = candidate.operation_key
        RETURNING provider_run.*
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_v2_provider_run_json(candidate)
            ORDER BY candidate.terminalized_at, candidate.request_id,
                candidate.job_key, candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM attempted AS candidate;

    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER) IS
    'Claims a bounded PII-free, backoff-eligible, least-recently-attempted page of terminal provider usage rows.';
