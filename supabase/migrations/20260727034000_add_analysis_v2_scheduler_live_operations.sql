-- MIGRATION_PREDECESSOR=20260727033000
-- Durable scheduler operations and atomic same-job continuation for the exact v2.8 rollout.
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
                WHERE version = '20260727033000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_LIVE_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

ALTER TABLE public.analysis_pipeline_jobs
    ADD COLUMN scheduler_not_before_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE public.analysis_v2_scheduler_operations (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(86) NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed',
    claim_token UUID NOT NULL,
    lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    not_before_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    recovery_deadline_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT (pg_catalog.clock_timestamp() + INTERVAL '6 minutes'),
    result_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, operation_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_scheduler_operation_job_key_check CHECK (
        pg_catalog.char_length(job_key) BETWEEN 1 AND 160
        AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_v2_scheduler_operation_identity_check CHECK (
        public.analysis_v2_valid_ai_operation_key(operation_key)
        AND (
            (stage = 'genderTriage' AND operation_key ~ '^gender-triage:[0-9a-f]{64}$')
            OR (stage = 'featureAnalysis' AND operation_key ~ '^feature-analysis:[0-9a-f]{64}$')
            OR (
                stage = 'privateAccountName'
                AND operation_key ~ '^private-account-name:[0-9a-f]{64}$'
            )
        )
    ),
    CONSTRAINT analysis_v2_scheduler_operation_status_check CHECK (
        status IN ('claimed', 'ready', 'terminal_unavailable')
    ),
    CONSTRAINT analysis_v2_scheduler_operation_result_check CHECK (
        (
            status = 'claimed'
            AND result_json IS NULL
            AND completed_at IS NULL
        )
        OR (
            status = 'ready'
            AND pg_catalog.jsonb_typeof(result_json) = 'object'
            AND pg_catalog.octet_length(result_json::TEXT) BETWEEN 2 AND 524288
            AND completed_at IS NOT NULL
        )
        OR (
            status = 'terminal_unavailable'
            AND result_json IS NULL
            AND completed_at IS NULL
        )
    )
);

ALTER TABLE public.analysis_v2_scheduler_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_scheduler_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_scheduler_operations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analysis_v2_scheduler_operations
    TO service_role;

CREATE FUNCTION public.claim_analysis_v2_scheduler_operation(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_operation_key TEXT,
    p_stage TEXT,
    p_operation_claim_token UUID,
    p_lease_seconds INTEGER
)
RETURNS TABLE(
    decision TEXT,
    operation_claim_token UUID,
    recovery_only BOOLEAN,
    result_json JSONB,
    not_before_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_operation public.analysis_v2_scheduler_operations%ROWTYPE;
    v_has_attempt BOOLEAN := FALSE;
    v_has_unsafe_attempt BOOLEAN := FALSE;
    v_has_result BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL
       OR p_operation_claim_token IS NULL
       OR p_operation_key IS NULL
       OR p_stage IS NULL
       OR p_lease_seconds NOT BETWEEN 240 AND 360
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT (
            (p_stage = 'genderTriage' AND p_operation_key ~ '^gender-triage:[0-9a-f]{64}$')
            OR (
                p_stage = 'featureAnalysis'
                AND p_operation_key ~ '^feature-analysis:[0-9a-f]{64}$'
            )
            OR (
                p_stage = 'privateAccountName'
                AND p_operation_key ~ '^private-account-name:[0-9a-f]{64}$'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
            'pipeline', 'v2',
            'risk', 'risk-policy-v2.4',
            'aiStage', 'ai-stage-policy-v2.8',
            'scheduler', 'ai-scheduler-v1'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT operation.* INTO v_operation
    FROM public.analysis_v2_scheduler_operations AS operation
    WHERE operation.request_id = p_request_id
      AND operation.operation_key = p_operation_key
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.analysis_v2_scheduler_operations (
            request_id, job_key, operation_key, stage, status,
            claim_token, lease_expires_at, not_before_at, recovery_deadline_at
        ) VALUES (
            p_request_id, p_job_key, p_operation_key, p_stage, 'claimed',
            p_operation_claim_token,
            v_now + pg_catalog.make_interval(secs => p_lease_seconds),
            v_now,
            v_now + INTERVAL '6 minutes'
        )
        RETURNING * INTO v_operation;
        RETURN QUERY SELECT
            'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    IF v_operation.job_key <> p_job_key OR v_operation.stage <> p_stage THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_operation.status = 'ready' THEN
        RETURN QUERY SELECT
            'ready'::TEXT, NULL::UUID, FALSE, v_operation.result_json,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.status = 'terminal_unavailable' THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token,
            lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
            updated_at = v_now
        WHERE operation.request_id = p_request_id
          AND operation.operation_key = p_operation_key
        RETURNING * INTO v_operation;
        RETURN QUERY SELECT
            'terminal_unavailable'::TEXT,
            v_operation.claim_token,
            TRUE,
            NULL::JSONB,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
        WHERE checkpoint.request_id = p_request_id
          AND checkpoint.job_key = p_job_key
          AND checkpoint.operation_key = p_operation_key
          AND checkpoint.stage = p_stage
    ) INTO v_has_result;
    IF v_has_result THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token,
            lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
            updated_at = v_now
        WHERE operation.request_id = p_request_id
          AND operation.operation_key = p_operation_key
        RETURNING * INTO v_operation;
        RETURN QUERY SELECT
            'execute'::TEXT, v_operation.claim_token, TRUE, NULL::JSONB,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_request_id
          AND attempt.job_key = p_job_key
          AND attempt.operation_key = p_operation_key
    ) INTO v_has_attempt;
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_request_id
          AND attempt.job_key = p_job_key
          AND attempt.operation_key = p_operation_key
          AND attempt.status <> 'rate_limited'
    ) INTO v_has_unsafe_attempt;
    -- A prior generation may yield at a retry/backoff admission cutoff. Fully terminalized
    -- rate-limit attempts are explicitly resumable by the existing attempt ledger; reserved,
    -- ambiguous, rejected, or successful-without-checkpoint histories remain recovery-only.
    IF v_operation.not_before_at > v_now THEN
        RETURN QUERY SELECT
            'deferred'::TEXT,
            NULL::UUID,
            FALSE,
            NULL::JSONB,
            v_operation.not_before_at;
        RETURN;
    END IF;
    IF v_has_attempt AND NOT v_has_unsafe_attempt
       AND v_operation.lease_expires_at <= v_now THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token,
            lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
            recovery_deadline_at = v_now + INTERVAL '6 minutes',
            updated_at = v_now
        WHERE operation.request_id = p_request_id
          AND operation.operation_key = p_operation_key
        RETURNING * INTO v_operation;
        RETURN QUERY SELECT
            'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.lease_expires_at <= v_now AND NOT v_has_attempt THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token,
            lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
            recovery_deadline_at = v_now + INTERVAL '6 minutes',
            updated_at = v_now
        WHERE operation.request_id = p_request_id
          AND operation.operation_key = p_operation_key
        RETURNING * INTO v_operation;
        RETURN QUERY SELECT
            'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_has_unsafe_attempt THEN
        IF v_operation.recovery_deadline_at <= v_now THEN
            UPDATE public.analysis_v2_scheduler_operations AS operation
            SET status = 'terminal_unavailable',
                claim_token = p_operation_claim_token,
                lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
                updated_at = v_now
            WHERE operation.request_id = p_request_id
              AND operation.operation_key = p_operation_key
            RETURNING * INTO v_operation;
            RETURN QUERY SELECT
                'terminal_unavailable'::TEXT,
                v_operation.claim_token,
                TRUE,
                NULL::JSONB,
                NULL::TIMESTAMP WITH TIME ZONE;
            RETURN;
        END IF;
        RETURN QUERY SELECT
            'deferred'::TEXT,
            NULL::UUID,
            FALSE,
            NULL::JSONB,
            v_operation.recovery_deadline_at;
        RETURN;
    END IF;
    RETURN QUERY SELECT
        'deferred'::TEXT,
        NULL::UUID,
        FALSE,
        NULL::JSONB,
        v_operation.lease_expires_at;
END;
$$;

CREATE FUNCTION public.defer_analysis_v2_scheduler_operation(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_operation_key TEXT,
    p_stage TEXT,
    p_operation_claim_token UUID,
    p_reason TEXT
)
RETURNS TIMESTAMP WITH TIME ZONE
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_operation public.analysis_v2_scheduler_operations%ROWTYPE;
    v_delay INTERVAL;
BEGIN
    IF p_reason = 'ANALYSIS_V2_AI_CAPACITY_PENDING' THEN
        v_delay := INTERVAL '5 seconds';
    ELSIF p_reason = 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT' THEN
        v_delay := INTERVAL '30 seconds';
    ELSIF p_reason = 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE' THEN
        v_delay := INTERVAL '60 seconds';
    ELSE
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT operation.* INTO v_operation
    FROM public.analysis_v2_scheduler_operations AS operation
    WHERE operation.request_id = p_request_id
      AND operation.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_operation.job_key <> p_job_key
       OR v_operation.stage <> p_stage
       OR v_operation.status <> 'claimed'
       OR v_operation.claim_token IS DISTINCT FROM p_operation_claim_token
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = p_request_id
              AND attempt.job_key = p_job_key
              AND attempt.operation_key = p_operation_key
              AND attempt.status <> 'rate_limited'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_scheduler_operations AS operation
    SET lease_expires_at = v_now,
        not_before_at = v_now + v_delay,
        updated_at = v_now
    WHERE operation.request_id = p_request_id
      AND operation.operation_key = p_operation_key
    RETURNING * INTO v_operation;
    RETURN v_operation.not_before_at;
END;
$$;

CREATE FUNCTION public.recover_analysis_v2_scheduler_operations(
    p_limit INTEGER DEFAULT 8
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_candidate RECORD;
    v_recovered INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 32 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    FOR v_candidate IN
        SELECT
            operation.request_id,
            operation.job_key,
            operation.operation_key,
            attempt.job_claim_token,
            attempt.attempt,
            attempt.reservation_token,
            attempt.model_name,
            attempt.location,
            attempt.stage,
            attempt.thinking_level,
            attempt.media_count,
            attempt.media_resolution,
            attempt.prompt_version,
            attempt.schema_version,
            attempt.max_output_tokens,
            attempt.retry_count,
            attempt.created_at,
            lease.slot,
            lease.lease_claim_token,
            lease.fence
        FROM public.analysis_v2_scheduler_operations AS operation
        INNER JOIN public.analysis_v2_ai_attempts AS attempt
          ON attempt.request_id = operation.request_id
         AND attempt.job_key = operation.job_key
         AND attempt.operation_key = operation.operation_key
        INNER JOIN public.analysis_v2_gemini_leases AS lease
          ON lease.request_id = attempt.request_id
         AND lease.job_key = attempt.job_key
         AND lease.operation_key = attempt.operation_key
         AND lease.attempt = attempt.attempt
        WHERE operation.status = 'claimed'
          AND operation.recovery_deadline_at <= v_now
          AND attempt.stage IN ('genderTriage', 'featureAnalysis', 'privateAccountName')
          AND attempt.status = 'reserved'
          AND lease.state IN ('leased', 'quarantined')
          AND lease.expires_at <= v_now
        ORDER BY operation.recovery_deadline_at, operation.request_id, operation.operation_key
        LIMIT p_limit
    LOOP
        PERFORM public.analysis_v2_terminalize_ai_attempt_internal(
            v_candidate.request_id,
            v_candidate.job_key,
            v_candidate.job_claim_token,
            v_candidate.operation_key,
            v_candidate.attempt,
            v_candidate.reservation_token,
            'cutoff',
            pg_catalog.jsonb_build_object(
                'model_name', v_candidate.model_name,
                'location', v_candidate.location,
                'stage', v_candidate.stage,
                'thinking_level', v_candidate.thinking_level,
                'media_count', v_candidate.media_count,
                'media_resolution', v_candidate.media_resolution,
                'prompt_version', v_candidate.prompt_version,
                'schema_version', v_candidate.schema_version,
                'max_output_tokens', v_candidate.max_output_tokens,
                'retry_count', v_candidate.retry_count,
                'usage_metadata_status', 'missing',
                'usage_complete', FALSE,
                'prompt_tokens', NULL,
                'completion_tokens', NULL,
                'total_tokens', NULL,
                'thinking_tokens', NULL,
                'latency_ms', LEAST(
                    3600000::NUMERIC,
                    GREATEST(
                        0::NUMERIC,
                        EXTRACT(EPOCH FROM (v_now - v_candidate.created_at)) * 1000
                    )
                )::INTEGER,
                'estimated_cost_usd', NULL,
                'finish_reason', NULL
            )
        );
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'available',
            request_id = NULL,
            job_key = NULL,
            operation_key = NULL,
            stage = NULL,
            attempt = NULL,
            lease_claim_token = NULL,
            acquired_at = NULL,
            expires_at = NULL,
            quarantined_at = NULL,
            updated_at = v_now
        WHERE lease.slot = v_candidate.slot
          AND lease.lease_claim_token = v_candidate.lease_claim_token
          AND lease.fence = v_candidate.fence
          AND lease.expires_at <= v_now;
        v_recovered := v_recovered + 1;
    END LOOP;

    WITH terminal AS (
        SELECT operation.request_id, operation.operation_key
        FROM public.analysis_v2_scheduler_operations AS operation
        WHERE operation.status = 'claimed'
          AND operation.recovery_deadline_at <= v_now
          AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
                WHERE checkpoint.request_id = operation.request_id
                  AND checkpoint.job_key = operation.job_key
                  AND checkpoint.operation_key = operation.operation_key
                  AND checkpoint.stage = operation.stage
          )
          AND EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_attempts AS attempt
                WHERE attempt.request_id = operation.request_id
                  AND attempt.job_key = operation.job_key
                  AND attempt.operation_key = operation.operation_key
                  AND attempt.status <> 'rate_limited'
          )
        ORDER BY operation.recovery_deadline_at, operation.request_id, operation.operation_key
        LIMIT p_limit
        FOR UPDATE
    )
    UPDATE public.analysis_v2_scheduler_operations AS operation
    SET status = 'terminal_unavailable',
        updated_at = v_now
    FROM terminal
    WHERE operation.request_id = terminal.request_id
      AND operation.operation_key = terminal.operation_key;
    GET DIAGNOSTICS v_recovered = ROW_COUNT;
    RETURN v_recovered;
END;
$$;

CREATE FUNCTION public.reap_analysis_v2_scheduler_gemini_leases(
    p_limit INTEGER DEFAULT 8
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_reaped INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    WITH expired AS (
        SELECT lease.slot
        FROM public.analysis_v2_gemini_leases AS lease
        WHERE lease.state = 'quarantined'
          AND lease.stage IN ('genderTriage', 'featureAnalysis', 'privateAccountName')
          AND lease.expires_at <= v_now
          AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_attempts AS attempt
                WHERE attempt.request_id = lease.request_id
                  AND attempt.job_key = lease.job_key
                  AND attempt.operation_key = lease.operation_key
                  AND attempt.attempt = lease.attempt
                  AND attempt.status = 'reserved'
          )
        ORDER BY lease.slot
        LIMIT p_limit
        FOR UPDATE
    )
    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'available',
        request_id = NULL,
        job_key = NULL,
        operation_key = NULL,
        stage = NULL,
        attempt = NULL,
        lease_claim_token = NULL,
        acquired_at = NULL,
        expires_at = NULL,
        quarantined_at = NULL,
        updated_at = v_now
    FROM expired
    WHERE lease.slot = expired.slot;
    GET DIAGNOSTICS v_reaped = ROW_COUNT;
    RETURN v_reaped;
END;
$$;

CREATE FUNCTION public.commit_analysis_v2_scheduler_operation(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_operation_key TEXT,
    p_stage TEXT,
    p_operation_claim_token UUID,
    p_result_json JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_operation public.analysis_v2_scheduler_operations%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL
       OR p_operation_claim_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_operation_key IS NULL
       OR p_stage IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT (
            (p_stage = 'genderTriage' AND p_operation_key ~ '^gender-triage:[0-9a-f]{64}$')
            OR (
                p_stage = 'featureAnalysis'
                AND p_operation_key ~ '^feature-analysis:[0-9a-f]{64}$'
            )
            OR (
                p_stage = 'privateAccountName'
                AND p_operation_key ~ '^private-account-name:[0-9a-f]{64}$'
            )
       )
       OR p_result_json IS NULL
       OR pg_catalog.jsonb_typeof(p_result_json) <> 'object'
       OR pg_catalog.octet_length(p_result_json::TEXT) NOT BETWEEN 2 AND 524288 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    SELECT operation.* INTO v_operation
    FROM public.analysis_v2_scheduler_operations AS operation
    WHERE operation.request_id = p_request_id
      AND operation.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND OR v_operation.job_key <> p_job_key OR v_operation.stage <> p_stage THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_operation.status = 'ready' THEN
        IF v_operation.result_json = p_result_json THEN
            RETURN TRUE;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_RESULT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_operation.claim_token IS DISTINCT FROM p_operation_claim_token
       OR v_operation.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_scheduler_operations AS operation
    SET status = 'ready',
        result_json = p_result_json,
        completed_at = v_now,
        updated_at = v_now
    WHERE operation.request_id = p_request_id
      AND operation.operation_key = p_operation_key;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION public.acquire_analysis_v2_scheduler_gemini_lease_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_stage TEXT,
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
    v_request public.analysis_requests%ROWTYPE;
    v_existing public.analysis_v2_gemini_leases%ROWTYPE;
    v_stage_count INTEGER;
    v_stage_limit INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 4
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 225 AND 300
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT (
            (
                p_stage = 'genderTriage'
                AND p_operation_key ~ '^gender-triage:[0-9a-f]{64}$'
            )
            OR (
                p_stage = 'featureAnalysis'
                AND p_operation_key ~ '^feature-analysis:[0-9a-f]{64}$'
            )
            OR (
                p_stage = 'privateAccountName'
                AND p_operation_key ~ '^private-account-name:[0-9a-f]{64}$'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
    FOR SHARE;
    IF NOT FOUND
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
            'pipeline', 'v2',
            'risk', 'risk-policy-v2.4',
            'aiStage', 'ai-stage-policy-v2.8',
            'scheduler', 'ai-scheduler-v1'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH',
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

    SELECT lease.* INTO v_existing
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.request_id = p_request_id
      AND lease.job_key = p_job_key
      AND lease.operation_key = p_operation_key
      AND lease.attempt = p_attempt
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.state = 'leased'
           AND v_existing.lease_claim_token = p_claim_token
           AND v_existing.expires_at > v_now THEN
            RETURN QUERY SELECT
                'acquired'::TEXT,
                v_existing.slot::SMALLINT,
                v_existing.lease_claim_token,
                v_existing.fence,
                v_existing.expires_at;
            RETURN;
        END IF;
        RETURN QUERY
        SELECT *
        FROM public.acquire_analysis_v2_gemini_lease_v2(
            p_request_id,
            p_job_key,
            p_operation_key,
            p_stage,
            p_attempt,
            p_claim_token,
            p_lease_seconds
        );
        RETURN;
    END IF;

    v_stage_limit := CASE p_stage
        WHEN 'genderTriage' THEN 6
        WHEN 'featureAnalysis' THEN 3
        WHEN 'privateAccountName' THEN 2
        ELSE NULL
    END;
    SELECT pg_catalog.count(*)::INTEGER INTO v_stage_count
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.state IN ('leased', 'quarantined')
      AND lease.stage = p_stage;
    IF v_stage_count >= v_stage_limit THEN
        RETURN QUERY SELECT
            'capacity_pending'::TEXT,
            NULL::SMALLINT,
            NULL::UUID,
            NULL::BIGINT,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.acquire_analysis_v2_gemini_lease_v2(
        p_request_id,
        p_job_key,
        p_operation_key,
        p_stage,
        p_attempt,
        p_claim_token,
        p_lease_seconds
    );
END;
$$;

CREATE FUNCTION public.continue_analysis_v2_scheduler_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_dispatch_token UUID,
    p_error_code TEXT,
    p_delay_seconds INTEGER
)
RETURNS TABLE(
    reserved BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT,
    task_name TEXT,
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
    IF p_request_id IS NULL OR p_claim_token IS NULL OR p_dispatch_token IS NULL
       OR p_error_code IS NULL
       OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 300
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_error_code NOT IN (
            'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
            'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING',
            'ANALYSIS_V2_AI_CAPACITY_PENDING',
            'ANALYSIS_V2_AI_QUARANTINE_ACTIVE'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_CONTINUATION_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_job.attempt_count < 1
       OR v_job.dispatch_generation NOT BETWEEN 1 AND 999 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'pending',
        dispatch_state = 'reserved',
        dispatch_generation = job.dispatch_generation + 1,
        dispatch_reservation_token = p_dispatch_token,
        dispatch_reserved_at = v_now,
        dispatched_at = NULL,
        dispatch_task_name = NULL,
        delivered_at = NULL,
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
        scheduler_not_before_at =
            v_now + pg_catalog.make_interval(secs => p_delay_seconds),
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    RETURN QUERY SELECT
        TRUE,
        v_job.dispatch_generation,
        v_job.dispatch_reservation_token,
        v_job.status::TEXT,
        v_job.dispatch_state::TEXT,
        NULL::TEXT,
        v_job.attempt_count,
        v_request.status::TEXT;
END;
$$;

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
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_SCAN_INPUT',
            ERRCODE = 'P0001';
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
      AND job.status IN ('pending', 'processing')
      AND job.recovery_not_before <= pg_catalog.clock_timestamp()
      AND (
            job.scheduler_not_before_at IS NULL
            OR job.scheduler_not_before_at <= pg_catalog.clock_timestamp()
      )
    ORDER BY job.recovery_not_before, job.request_id, job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_analysis_v2_scheduler_gemini_lease_v1(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commit_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.defer_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.recover_analysis_v2_scheduler_operations(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reap_analysis_v2_scheduler_gemini_leases(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.continue_analysis_v2_scheduler_job(
    UUID, TEXT, UUID, UUID, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_analysis_v2_scheduler_gemini_lease_v1(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_analysis_v2_scheduler_operation(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_analysis_v2_scheduler_operations(INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_analysis_v2_scheduler_gemini_leases(INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.continue_analysis_v2_scheduler_job(
    UUID, TEXT, UUID, UUID, TEXT, INTEGER
) TO service_role;

COMMENT ON COLUMN public.analysis_pipeline_jobs.scheduler_not_before_at IS
    'Durable scheduler continuation fence; recovery cannot redispatch this generation early.';
COMMENT ON FUNCTION public.acquire_analysis_v2_scheduler_gemini_lease_v1(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) IS 'Atomically enforces deployment-wide v2.8 scheduler stage caps over durable Gemini leases.';
