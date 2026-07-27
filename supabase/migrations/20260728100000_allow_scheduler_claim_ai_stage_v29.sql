-- The scheduler operation ledger is shared by the canonical v2.8 and v2.9
-- stage policies. Keep every other request fence exact.
CREATE OR REPLACE FUNCTION public.claim_analysis_v2_scheduler_operation(
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
       OR (
            v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
                'pipeline', 'v2',
                'risk', 'risk-policy-v2.4',
                'aiStage', 'ai-stage-policy-v2.8',
                'scheduler', 'ai-scheduler-v1'
            )
            AND v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
                'pipeline', 'v2',
                'risk', 'risk-policy-v2.4',
                'aiStage', 'ai-stage-policy-v2.9',
                'scheduler', 'ai-scheduler-v1'
            )
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
