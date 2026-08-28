-- The DAG consumer's "not ready" gate was written for the legacy
-- primary/fallback shape: any unresolved (non-success) username requires a
-- completed fallback pass before a downstream track may read the batch. A
-- direct fresh_apify producer (checkpoint_analysis_v2_profile_fresh_apify_v1
-- / checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1) never runs a
-- fallback round -- it is a single bounded Apify pass that tolerates a small,
-- server-computed number of incomplete/schema failures -- so a completed
-- producer with a within-bound number of such failures was permanently
-- unconsumable: the legacy gate demanded a fallback_completed_at timestamp
-- that this producer family structurally never sets.
--
-- This migration adds one narrow, additive bypass: the consumer may skip the
-- legacy fallback-timestamp requirement only when server-side evidence
-- proves the batch is an exact, uncorrupted, bounded direct fresh_apify
-- result -- never by trusting a caller-supplied flag. Every existing
-- fence, the target/partner-safety scope rules, the legacy primary/fallback
-- path, and the checkpoint snapshot shape are byte-for-byte unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Proves, entirely from the immutable batch/outcome rows already written by
-- the producer, that this is an exact bounded direct fresh_apify result --
-- mirroring evaluateProfileBatchCompleteness/projectTerminalResults
-- (lib/services/analysis/v2-collection-executors.ts,
-- lib/services/analysis/v2-ai-scoring-runtime-deps.ts) exactly, rather than
-- inventing a parallel admission rule:
--   * the requested/outcome cardinalities match;
--   * every outcome row is attempt 'fresh_apify' + source 'apify' at its
--     correctly aligned ordinal and requested username;
--   * no fallback or repair state or rows exist anywhere on the batch;
--   * the stored frozen_unresolved_usernames is exactly the set every
--     non-success (status 'unavailable' or 'failed') outcome row implies --
--     'unavailable' is a schema-valid terminal outcome (a confirmed-absent
--     account), so it is never bounded and never rejected here, exactly
--     like projectTerminalResults maps it straight through to 'unavailable';
--   * only 'failed' rows are counted against the
--     requested_count - CEIL(requested_count * 0.9) bound, and every one of
--     those 'failed' rows carries failure_category 'incomplete' or 'schema'
--     (never a transient or other category).
-- Any drift in any of these makes this predicate FALSE and the legacy gate
-- (a completed fallback pass) stays in force.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready(
    p_request_id UUID,
    p_job_key TEXT,
    p_expected_item_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT batch.request_id IS NOT NULL
       AND batch.fallback_completed_at IS NULL
       AND batch.fallback_payload_hash IS NULL
       AND batch.repair_completed_at IS NULL
       AND batch.repair_payload_hash IS NULL
       AND batch.repair_usernames IS NULL
       AND pg_catalog.cardinality(batch.requested_usernames) = p_expected_item_count
       AND batch.frozen_unresolved_usernames = COALESCE((
            SELECT pg_catalog.array_agg(outcome.username::TEXT ORDER BY outcome.ordinal)
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.status <> 'success'
       ), '{}'::TEXT[])
       AND (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
       ) = p_expected_item_count
       -- Only 'failed' rows are bounded; 'unavailable' rows never count
       -- against this ceiling, matching evaluateProfileBatchCompleteness's
       -- `failed = final.filter(status === 'failed')` exactly.
       AND (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.status = 'failed'
       ) <= (
            p_expected_item_count
            - pg_catalog.ceil(p_expected_item_count * 0.9)::INTEGER
       )
       AND NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND (
                   outcome.attempt <> 'fresh_apify'
                   OR outcome.source <> 'apify'
                   OR outcome.ordinal < 1
                   OR outcome.ordinal > p_expected_item_count
                   OR outcome.username IS DISTINCT FROM
                        batch.requested_usernames[outcome.ordinal::INTEGER]
                   OR outcome.status NOT IN ('success', 'unavailable', 'failed')
                   OR (
                        outcome.status = 'failed'
                        AND outcome.failure_category NOT IN ('incomplete', 'schema')
                   )
              )
       )
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready(
    UUID, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready(
    UUID, TEXT, INTEGER
) IS 'Server-derived proof that a completed profile-fetch batch is an exact, uncorrupted, bounded direct fresh_apify result: no fallback/repair state or rows, every row attempt=fresh_apify/source=apify at its aligned ordinal/username, frozen_unresolved_usernames exactly matches the outcome rows. Status unavailable is accepted unconditionally and never counted; only status failed rows must carry failure_category incomplete/schema, and only their count is bounded by requested_count - CEIL(requested_count * 0.9).';

-- Partner safety reads the already-checkpointed target profile to bind target-aware captions.
-- Keep the producer and consumer identities exact while adding the missing DAG consumer.
--
-- The only behavioral change from the prior version (20260722102000) is the
-- NOT_READY gate: an unresolved-but-no-fallback batch is now also accepted
-- when analysis_v2_profile_fetch_bounded_direct_fresh_apify_ready proves it
-- is an exact bounded direct fresh_apify result. Every other line, every
-- other fence, and the returned snapshot are unchanged.
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
