-- Partner safety reads the already-checkpointed target profile to bind target-aware captions.
-- Keep the producer and consumer identities exact while adding the missing DAG consumer.
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

    v_consumer := public.analysis_v2_assert_result_job_fence(
        p_request_id,
        p_consumer_job_key,
        p_consumer_claim_token,
        p_consumer_input_hash
    );

    SELECT job.* INTO v_producer
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_producer_job_key
    FOR SHARE;
    SELECT batch.* INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_producer_job_key
    FOR SHARE;

    IF v_producer.request_id IS NULL
       OR v_producer.status <> 'completed'
       OR v_batch.request_id IS NULL
       OR pg_catalog.cardinality(v_batch.requested_usernames) <> p_expected_item_count
       OR (
            pg_catalog.cardinality(v_batch.frozen_unresolved_usernames) > 0
            AND v_batch.fallback_completed_at IS NULL
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
        SELECT preflight.target_instagram_id INTO v_target_username
        FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id;
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
