SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A profile consumer reads a checkpoint from a completed producer. The read
-- needs a consistent fence and payload, but no row locks or manifest writes.
-- Keep the shared write fence and manifest adoption on the write paths.
CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    p_request_id UUID,
    p_consumer_job_key TEXT,
    p_consumer_claim_token UUID,
    p_consumer_input_hash TEXT,
    p_producer_job_key TEXT,
    p_expected_producer_input_hash TEXT,
    p_expected_item_count INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_consumer public.analysis_pipeline_jobs%ROWTYPE;
    v_producer public.analysis_pipeline_jobs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_target_username TEXT;
    v_batch_suffix TEXT;
BEGIN
    IF p_producer_job_key IS NULL
       OR pg_catalog.char_length(p_producer_job_key) NOT BETWEEN 1 AND 160
       OR p_producer_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_expected_item_count IS NULL
       OR p_expected_item_count NOT BETWEEN 1 AND 30
       OR (
            p_expected_producer_input_hash IS NOT NULL
            AND p_expected_producer_input_hash !~ '^[a-f0-9]{64}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    -- Check the same fence as the write path using the snapshot that supplies
    -- the completed producer and payload. Subsequent writes and provider
    -- admission independently acquire and validate their current claim.
    IF p_request_id IS NULL
       OR p_consumer_job_key IS NULL
       OR p_consumer_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_consumer_claim_token IS NULL
       OR p_consumer_input_hash IS NULL
       OR p_consumer_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.target_instagram_id INTO v_target_username
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.pipeline_version = 'v2'
          AND request.status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_consumer
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_consumer_job_key;
    IF NOT FOUND
       OR v_consumer.status <> 'processing'
       OR v_consumer.input_hash IS DISTINCT FROM p_consumer_input_hash
       OR v_consumer.lease_token IS DISTINCT FROM p_consumer_claim_token
       OR v_consumer.lease_expires_at IS NULL
       OR v_consumer.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_producer
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_producer_job_key;
    SELECT batch.* INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_producer_job_key;

    IF v_producer.request_id IS NULL
       OR v_producer.status <> 'completed'
       OR v_batch.request_id IS NULL
       OR pg_catalog.cardinality(v_batch.requested_usernames) <> p_expected_item_count
       OR (
            pg_catalog.cardinality(v_batch.frozen_unresolved_usernames) > 0
            AND v_batch.fallback_completed_at IS NULL
            AND NOT public.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready(
                p_request_id,
                p_producer_job_key,
                p_expected_item_count
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF p_producer_job_key LIKE 'track:profiles:batch:%' THEN
        v_batch_suffix := pg_catalog.substring(
            p_producer_job_key,
            '^track:profiles:batch:([0-9]+)$'
        );
        IF v_batch_suffix IS NULL
           OR p_expected_producer_input_hash IS NULL
           OR v_producer.input_hash IS DISTINCT FROM p_expected_producer_input_hash
           OR v_producer.track <> 'profiles'
           OR v_producer.kind <> 'profile_fetch'
           OR v_producer.batch IS DISTINCT FROM v_batch_suffix::INTEGER
           OR v_consumer.job_key <> 'track:profile-ai:batch:' || v_batch_suffix
           OR v_consumer.track <> 'profile_ai'
           OR v_consumer.kind <> 'ai'
           OR v_consumer.batch IS DISTINCT FROM v_batch_suffix::INTEGER THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSIF p_producer_job_key = 'track:target-evidence:collect' THEN
        IF p_expected_producer_input_hash IS NOT NULL
           OR p_expected_item_count <> 1
           OR v_producer.track <> 'target_evidence'
           OR v_producer.kind <> 'collection'
           OR v_batch.requested_usernames <> ARRAY[v_target_username]
           OR v_consumer.job_key NOT IN (
                'coordinator:candidate-screening',
                'track:reverse-likes:collect',
                'track:partner-safety:batch:0',
                'track:narratives:batch:0',
                'coordinator:finalize'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(
        p_request_id,
        p_producer_job_key
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;

-- Other scheduler continuations retain the original revenue guard and locking
-- contract. A timed-out checkpoint read can reschedule using only its own job
-- lock. Dispatch marking and the next worker claim still take their full fences.
CREATE OR REPLACE FUNCTION public.continue_analysis_v2_scheduler_job(
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
    v_now TIMESTAMPTZ;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_guarded BOOLEAN;
BEGIN
    IF p_error_code IS DISTINCT FROM 'ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT' THEN
        PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
        RETURN QUERY SELECT * FROM public.continue_analysis_v2_scheduler_job_unfenced_20260811(
            p_request_id, p_job_key, p_claim_token, p_dispatch_token, p_error_code, p_delay_seconds
        );
        RETURN;
    END IF;

    IF p_request_id IS NULL OR p_claim_token IS NULL OR p_dispatch_token IS NULL
       OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 300
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR (
            p_job_key !~ '^track:profile-ai:batch:[0-9]+$'
            AND p_job_key NOT IN (
                'coordinator:candidate-screening',
                'track:reverse-likes:collect',
                'track:partner-safety:batch:0',
                'track:narratives:batch:0',
                'coordinator:finalize'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_CONTINUATION_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Strict revenue dispatch must still invoke the original guard before
    -- taking any job lock to preserve its parent-to-child lock order.
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS request
        JOIN public.analysis_v2_provider_execution_policies AS policy
          ON policy.request_id = request.id
        WHERE request.id = p_request_id
          AND request.pipeline_version = 'v2'
          AND request.plan_access_mode_snapshot = 'test_entitlement'
          AND request.selected_plan_id_snapshot IN ('basic', 'standard')
          AND policy.mode = 'test_operation_split'
          AND policy.policy_version = 'authorized-free-e2e-v1'
    ) INTO v_guarded;
    IF v_guarded THEN
        PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR NO KEY UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_job.attempt_count < 1
       OR v_job.dispatch_generation NOT BETWEEN 1 AND 999 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- Recheck after any wait for the job. No parent lock is taken here. If a
    -- terminal transaction has not yet committed, its status/job update still
    -- fences the queued delivery before any provider call can be admitted.
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
      AND request.status = 'processing'
      AND EXISTS (
          SELECT 1 FROM public.analysis_preflights AS preflight
          WHERE preflight.consumed_request_id = request.id
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    -- Fail closed if a strict provider policy became visible while waiting.
    IF NOT v_guarded
       AND v_request.plan_access_mode_snapshot = 'test_entitlement'
       AND v_request.selected_plan_id_snapshot IN ('basic', 'standard')
       AND EXISTS (
           SELECT 1 FROM public.analysis_v2_provider_execution_policies AS policy
           WHERE policy.request_id = p_request_id
             AND policy.mode = 'test_operation_split'
             AND policy.policy_version = 'authorized-free-e2e-v1'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
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
        first_started_at = CASE WHEN job.attempt_count = 1 THEN NULL ELSE job.first_started_at END,
        ai_capacity_deferral_count = job.ai_capacity_deferral_count + 1,
        last_error_code = p_error_code,
        last_error_at = v_now,
        scheduler_not_before_at = v_now + pg_catalog.make_interval(secs => p_delay_seconds),
        updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    RETURN QUERY SELECT TRUE, v_job.dispatch_generation,
        v_job.dispatch_reservation_token, v_job.status::TEXT, v_job.dispatch_state::TEXT,
        NULL::TEXT, v_job.attempt_count, v_request.status::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.continue_analysis_v2_scheduler_job(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.continue_analysis_v2_scheduler_job(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    TO service_role;
