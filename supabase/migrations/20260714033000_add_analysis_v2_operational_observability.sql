-- Persistent, PII-free V2 operational telemetry and one service-only admin read boundary.

CREATE TABLE public.analysis_v2_profile_fetch_telemetry (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    source VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    failure_category VARCHAR(32),
    http_status SMALLINT,
    failure_category_key VARCHAR(32) GENERATED ALWAYS AS (
        COALESCE(failure_category, 'none')
    ) STORED,
    http_status_key SMALLINT GENERATED ALWAYS AS (
        COALESCE(http_status, 0)
    ) STORED,
    outcome_count SMALLINT NOT NULL,
    request_count_total INTEGER NOT NULL,
    latency_ms_total BIGINT NOT NULL,
    latency_ms_max INTEGER NOT NULL,
    first_captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (
        request_id, job_key, source, status, failure_category_key, http_status_key
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_job_check CHECK (
        pg_catalog.char_length(job_key) BETWEEN 1 AND 160
        AND (
            job_key = 'track:target-evidence:collect'
            OR job_key ~ '^track:profiles:batch:[0-9]+$'
        )
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_source_check CHECK (
        source IN ('cache', 'selfhosted', 'fallback')
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_status_check CHECK (
        status IN ('success', 'unavailable', 'failed')
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_result_check CHECK (
        (
            status = 'success'
            AND failure_category IS NULL
            AND http_status IS NULL
        )
        OR (
            status = 'unavailable'
            AND failure_category IN ('not_found', 'empty_user')
            AND (http_status IS NULL OR http_status = 404)
        )
        OR (
            status = 'failed'
            AND failure_category IN (
                'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                'transport', 'http', 'unknown'
            )
            AND (http_status IS NULL OR http_status BETWEEN 400 AND 599)
        )
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_count_check CHECK (
        outcome_count BETWEEN 1 AND 30
        AND request_count_total BETWEEN 0 AND 300
        AND latency_ms_total BETWEEN 0 AND 9000000
        AND latency_ms_max BETWEEN 0 AND 300000
    ),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_time_check CHECK (
        last_captured_at >= first_captured_at
        AND updated_at >= created_at
    )
);

CREATE INDEX idx_analysis_v2_profile_fetch_telemetry_request
    ON public.analysis_v2_profile_fetch_telemetry(
        request_id, job_key, source, status, failure_category, http_status
    );

ALTER TABLE public.analysis_v2_profile_fetch_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_fetch_telemetry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_profile_fetch_telemetry
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_profile_fetch_telemetry IS
    'Permanent request/job profile outcome counters. Contains no username, profile snapshot, URL, provider payload, or credential.';

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source TEXT := CASE
        WHEN NEW.attempt = 'fallback' THEN 'fallback'
        ELSE NEW.source
    END;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    INSERT INTO public.analysis_v2_profile_fetch_telemetry (
        request_id,
        job_key,
        source,
        status,
        failure_category,
        http_status,
        outcome_count,
        request_count_total,
        latency_ms_total,
        latency_ms_max,
        first_captured_at,
        last_captured_at,
        created_at,
        updated_at
    ) VALUES (
        NEW.request_id,
        NEW.job_key,
        v_source,
        NEW.status,
        NEW.failure_category,
        NEW.http_status,
        1,
        NEW.request_count,
        NEW.latency_ms,
        NEW.latency_ms,
        NEW.captured_at,
        NEW.captured_at,
        v_now,
        v_now
    )
    ON CONFLICT (
        request_id, job_key, source, status, failure_category_key, http_status_key
    ) DO UPDATE
    SET outcome_count = public.analysis_v2_profile_fetch_telemetry.outcome_count + 1,
        request_count_total =
            public.analysis_v2_profile_fetch_telemetry.request_count_total
            + EXCLUDED.request_count_total,
        latency_ms_total = public.analysis_v2_profile_fetch_telemetry.latency_ms_total
            + EXCLUDED.latency_ms_total,
        latency_ms_max = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.latency_ms_max,
            EXCLUDED.latency_ms_max
        ),
        first_captured_at = LEAST(
            public.analysis_v2_profile_fetch_telemetry.first_captured_at,
            EXCLUDED.first_captured_at
        ),
        last_captured_at = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.last_captured_at,
            EXCLUDED.last_captured_at
        ),
        updated_at = v_now;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
    FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.analysis_v2_profile_fetch_telemetry (
    request_id,
    job_key,
    source,
    status,
    failure_category,
    http_status,
    outcome_count,
    request_count_total,
    latency_ms_total,
    latency_ms_max,
    first_captured_at,
    last_captured_at
)
SELECT
    outcome.request_id,
    outcome.job_key,
    CASE WHEN outcome.attempt = 'fallback' THEN 'fallback' ELSE outcome.source END,
    outcome.status,
    outcome.failure_category,
    outcome.http_status,
    pg_catalog.count(*)::SMALLINT,
    pg_catalog.sum(outcome.request_count)::INTEGER,
    pg_catalog.sum(outcome.latency_ms)::BIGINT,
    pg_catalog.max(outcome.latency_ms)::INTEGER,
    pg_catalog.min(outcome.captured_at),
    pg_catalog.max(outcome.captured_at)
FROM public.analysis_v2_profile_fetch_outcomes AS outcome
GROUP BY
    outcome.request_id,
    outcome.job_key,
    CASE WHEN outcome.attempt = 'fallback' THEN 'fallback' ELSE outcome.source END,
    outcome.status,
    outcome.failure_category,
    outcome.http_status;

CREATE TRIGGER analysis_v2_profile_fetch_telemetry_capture
AFTER INSERT ON public.analysis_v2_profile_fetch_outcomes
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry();

CREATE TABLE public.analysis_v2_result_coverage_telemetry (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    plan_id VARCHAR(16) NOT NULL CHECK (plan_id IN ('basic', 'standard', 'plus')),
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    CONSTRAINT analysis_v2_result_coverage_telemetry_counts_check CHECK (
        followers_declared BETWEEN 0 AND 1200
        AND followers_collected BETWEEN 0 AND followers_declared
        AND following_declared BETWEEN 0 AND 1200
        AND following_collected BETWEEN 0 AND following_declared
        AND detected_mutuals BETWEEN 0 AND 1200
        AND public_mutuals BETWEEN 0 AND detected_mutuals
        AND private_mutuals BETWEEN 0 AND detected_mutuals
        AND public_mutuals + private_mutuals = detected_mutuals
        AND screened_mutuals BETWEEN 0 AND public_mutuals
        AND not_screened_mutuals = public_mutuals - screened_mutuals
        AND fetch_unavailable_count BETWEEN 0 AND screened_mutuals
        AND media_unavailable_count BETWEEN 0 AND screened_mutuals
        AND fetch_unavailable_count + media_unavailable_count <= screened_mutuals
    )
);

ALTER TABLE public.analysis_v2_result_coverage_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_coverage_telemetry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_result_coverage_telemetry
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_result_coverage_telemetry IS
    'Permanent PII-free V2 plan and numeric result coverage captured before result working-set purge.';

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.analysis_v2_result_coverage_telemetry (
        request_id,
        plan_id,
        followers_declared,
        followers_collected,
        following_declared,
        following_collected,
        detected_mutuals,
        public_mutuals,
        private_mutuals,
        screened_mutuals,
        not_screened_mutuals,
        fetch_unavailable_count,
        media_unavailable_count
    ) VALUES (
        NEW.request_id,
        NEW.plan_id,
        NEW.followers_declared,
        NEW.followers_collected,
        NEW.following_declared,
        NEW.following_collected,
        NEW.detected_mutuals,
        NEW.public_mutuals,
        NEW.private_mutuals,
        NEW.screened_mutuals,
        NEW.not_screened_mutuals,
        NEW.fetch_unavailable_count,
        NEW.media_unavailable_count
    )
    ON CONFLICT (request_id) DO UPDATE
    SET plan_id = EXCLUDED.plan_id,
        followers_declared = EXCLUDED.followers_declared,
        followers_collected = EXCLUDED.followers_collected,
        following_declared = EXCLUDED.following_declared,
        following_collected = EXCLUDED.following_collected,
        detected_mutuals = EXCLUDED.detected_mutuals,
        public_mutuals = EXCLUDED.public_mutuals,
        private_mutuals = EXCLUDED.private_mutuals,
        screened_mutuals = EXCLUDED.screened_mutuals,
        not_screened_mutuals = EXCLUDED.not_screened_mutuals,
        fetch_unavailable_count = EXCLUDED.fetch_unavailable_count,
        media_unavailable_count = EXCLUDED.media_unavailable_count;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
    FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.analysis_v2_result_coverage_telemetry (
    request_id,
    plan_id,
    followers_declared,
    followers_collected,
    following_declared,
    following_collected,
    detected_mutuals,
    public_mutuals,
    private_mutuals,
    screened_mutuals,
    not_screened_mutuals,
    fetch_unavailable_count,
    media_unavailable_count
)
SELECT
    summary.request_id,
    summary.plan_id,
    summary.followers_declared,
    summary.followers_collected,
    summary.following_declared,
    summary.following_collected,
    summary.detected_mutuals,
    summary.public_mutuals,
    summary.private_mutuals,
    summary.screened_mutuals,
    summary.not_screened_mutuals,
    summary.fetch_unavailable_count,
    summary.media_unavailable_count
FROM public.analysis_v2_result_summaries AS summary;

CREATE TRIGGER analysis_v2_result_coverage_telemetry_capture
AFTER INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_result_coverage_telemetry();

CREATE OR REPLACE FUNCTION public.load_analysis_v2_operational_observability(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_OBSERVABILITY_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RETURN NULL;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_request_id
          AND job.job_key !~ '^(coordinator:(bootstrap|candidate-screening|finalize|join:(primary-evidence|final-score))|track:(relationships:collect|target-evidence:collect|profiles:batch:[0-9]+|profile-ai:batch:[0-9]+|private-names:batch:[0-9]+|reverse-likes:collect|partner-safety:batch:0|narratives:batch:0))$'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_OBSERVABILITY_UNSAFE_JOB', ERRCODE = 'P0001';
    END IF;

    RETURN (
        WITH provider AS (
            SELECT
                pg_catalog.count(*)::INTEGER AS run_count,
                pg_catalog.count(*) FILTER (
                    WHERE provider_run.status IN ('starting', 'running')
                )::INTEGER AS active_count,
                pg_catalog.count(*) FILTER (
                    WHERE provider_run.status IN (
                        'succeeded', 'failed', 'aborted', 'timed_out'
                    ) AND provider_run.actual_usage_usd IS NULL
                )::INTEGER AS unreconciled_count,
                pg_catalog.count(provider_run.actual_usage_usd)::INTEGER
                    AS actual_cost_count,
                COALESCE(pg_catalog.sum(provider_run.actual_usage_usd), 0::NUMERIC)
                    AS actual_usd,
                COALESCE(pg_catalog.sum(COALESCE(
                    provider_run.actual_usage_usd,
                    provider_run.max_charge_usd
                )), 0::NUMERIC) AS conservative_usd,
                COALESCE(pg_catalog.sum(CASE
                    WHEN provider_run.run_started_at IS NULL THEN 0
                    ELSE pg_catalog.floor(pg_catalog.date_part('epoch', (
                        COALESCE(
                            provider_run.terminalized_at,
                            pg_catalog.statement_timestamp()
                        ) - provider_run.run_started_at
                    )) * 1000)::BIGINT
                END), 0::NUMERIC)::BIGINT AS runtime_ms_total
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = p_request_id
        ),
        ai AS (
            SELECT
                pg_catalog.count(*)::INTEGER AS attempt_count,
                pg_catalog.count(*) FILTER (
                    WHERE ai_attempt.status = 'reserved'
                )::INTEGER AS reserved_count,
                pg_catalog.count(*) FILTER (
                    WHERE ai_attempt.status <> 'reserved'
                      AND (
                          ai_attempt.usage_complete IS DISTINCT FROM TRUE
                          OR ai_attempt.estimated_cost_usd IS NULL
                      )
                )::INTEGER AS missing_usage_count,
                pg_catalog.count(ai_attempt.estimated_cost_usd)::INTEGER
                    AS estimated_cost_count,
                COALESCE(pg_catalog.sum(ai_attempt.estimated_cost_usd), 0::NUMERIC)
                    AS estimated_usd,
                COALESCE(pg_catalog.sum(ai_attempt.latency_ms), 0::BIGINT)::BIGINT
                    AS latency_ms_total,
                COALESCE(pg_catalog.sum(ai_attempt.prompt_tokens), 0::BIGINT)::BIGINT
                    AS prompt_tokens,
                COALESCE(pg_catalog.sum(ai_attempt.completion_tokens), 0::BIGINT)::BIGINT
                    AS completion_tokens,
                COALESCE(pg_catalog.sum(ai_attempt.thinking_tokens), 0::BIGINT)::BIGINT
                    AS thinking_tokens
            FROM public.analysis_v2_ai_attempts AS ai_attempt
            WHERE ai_attempt.request_id = p_request_id
        ),
        job_rollup AS (
            SELECT
                pg_catalog.count(*)::INTEGER AS job_count,
                pg_catalog.count(*) FILTER (
                    WHERE job.status = 'pending'
                )::INTEGER AS pending_count,
                pg_catalog.count(*) FILTER (
                    WHERE job.status = 'processing'
                )::INTEGER AS processing_count,
                pg_catalog.count(*) FILTER (
                    WHERE job.status = 'completed'
                )::INTEGER AS completed_count,
                pg_catalog.count(*) FILTER (
                    WHERE job.status = 'failed'
                )::INTEGER AS failed_count,
                pg_catalog.count(*) FILTER (
                    WHERE job.status = 'cancelled'
                )::INTEGER AS cancelled_count,
                pg_catalog.min(job.first_started_at) AS first_started_at,
                pg_catalog.max(job.completed_at) AS last_completed_at,
                COALESCE(pg_catalog.sum(job.attempt_count), 0::BIGINT)::BIGINT
                    AS attempt_count_total
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = p_request_id
        ),
        profile_rows AS (
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'jobKey', telemetry.job_key,
                    'source', telemetry.source,
                    'status', telemetry.status,
                    'failureCategory', telemetry.failure_category,
                    'httpStatus', telemetry.http_status,
                    'outcomeCount', telemetry.outcome_count,
                    'requestCount', telemetry.request_count_total,
                    'latencyMsTotal', telemetry.latency_ms_total,
                    'latencyMsMax', telemetry.latency_ms_max
                ) ORDER BY
                    telemetry.job_key,
                    telemetry.source,
                    telemetry.status,
                    telemetry.failure_category NULLS FIRST,
                    telemetry.http_status NULLS FIRST
            ), '[]'::JSONB) AS payload
            FROM public.analysis_v2_profile_fetch_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
        ),
        coverage AS (
            SELECT pg_catalog.jsonb_build_object(
                'planId', telemetry.plan_id,
                'followersDeclared', telemetry.followers_declared,
                'followersCollected', telemetry.followers_collected,
                'followingDeclared', telemetry.following_declared,
                'followingCollected', telemetry.following_collected,
                'detectedMutuals', telemetry.detected_mutuals,
                'publicMutuals', telemetry.public_mutuals,
                'privateMutuals', telemetry.private_mutuals,
                'screenedMutuals', telemetry.screened_mutuals,
                'notScreenedMutuals', telemetry.not_screened_mutuals,
                'fetchUnavailableCount', telemetry.fetch_unavailable_count,
                'mediaUnavailableCount', telemetry.media_unavailable_count
            ) AS payload
            FROM public.analysis_v2_result_coverage_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
        ),
        jobs AS (
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'jobKey', job.job_key,
                    'track', job.track,
                    'kind', job.kind,
                    'batch', job.batch,
                    'status', job.status,
                    'dispatchState', job.dispatch_state,
                    'attemptCount', job.attempt_count,
                    'firstStartedAt', job.first_started_at,
                    'completedAt', job.completed_at,
                    'durationMs', CASE
                        WHEN job.first_started_at IS NULL THEN NULL
                        ELSE GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', (
                            COALESCE(
                                job.completed_at,
                                pg_catalog.statement_timestamp()
                            ) - job.first_started_at
                        )) * 1000)::BIGINT)
                    END,
                    'lastErrorCode', job.last_error_code
                ) ORDER BY job.job_key
            ), '[]'::JSONB) AS payload
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = p_request_id
        )
        SELECT pg_catalog.jsonb_build_object(
            'pipelineVersion', 'v2',
            'summary', pg_catalog.jsonb_build_object(
                'schemaVersion', 1,
                'requestId', p_request_id,
                'requestStatus', v_request.status,
                'planId', v_request.selected_plan_id_snapshot,
                'timing', pg_catalog.jsonb_build_object(
                    'createdAt', v_request.created_at,
                    'firstStartedAt', job_rollup.first_started_at,
                    'completedAt', v_request.completed_at,
                    'wallTimeMs', GREATEST(0, pg_catalog.floor(
                        pg_catalog.date_part('epoch', (
                            COALESCE(
                                v_request.completed_at,
                                pg_catalog.statement_timestamp()
                            ) - v_request.created_at
                        )) * 1000
                    )::BIGINT),
                    'queueDelayMs', CASE
                        WHEN job_rollup.first_started_at IS NULL THEN NULL
                        ELSE GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', (
                            job_rollup.first_started_at - v_request.created_at
                        )) * 1000)::BIGINT)
                    END,
                    'processingTimeMs', CASE
                        WHEN job_rollup.first_started_at IS NULL THEN NULL
                        ELSE GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', (
                            COALESCE(
                                v_request.completed_at,
                                pg_catalog.statement_timestamp()
                            ) - job_rollup.first_started_at
                        )) * 1000)::BIGINT)
                    END,
                    'providerRuntimeMsTotal', provider.runtime_ms_total,
                    'geminiLatencyMsTotal', ai.latency_ms_total
                ),
                'cost', pg_catalog.jsonb_build_object(
                    'currency', 'USD',
                    'providerActualUsd', provider.actual_usd,
                    'providerConservativeUsd', provider.conservative_usd,
                    'geminiEstimatedUsd', ai.estimated_usd,
                    'actualPlusGeminiEstimatedUsd',
                        provider.actual_usd + ai.estimated_usd,
                    'conservativePlusGeminiEstimatedUsd',
                        provider.conservative_usd + ai.estimated_usd,
                    'gcpInfrastructureIncluded', FALSE
                ),
                'completeness', pg_catalog.jsonb_build_object(
                    'costComplete',
                        v_request.status IN ('completed', 'failed')
                        AND provider.active_count = 0
                        AND provider.unreconciled_count = 0
                        AND ai.reserved_count = 0
                        AND ai.missing_usage_count = 0,
                    'pipelineComplete',
                        v_request.status = 'completed'
                        AND job_rollup.job_count > 0
                        AND job_rollup.pending_count = 0
                        AND job_rollup.processing_count = 0
                        AND job_rollup.failed_count = 0
                        AND job_rollup.cancelled_count = 0
                        AND EXISTS (SELECT 1 FROM coverage),
                    'resultCoverageAvailable', EXISTS (SELECT 1 FROM coverage),
                    'providerRunCount', provider.run_count,
                    'providerActiveCount', provider.active_count,
                    'providerUnreconciledCount', provider.unreconciled_count,
                    'providerActualCostCount', provider.actual_cost_count,
                    'aiAttemptCount', ai.attempt_count,
                    'aiReservedCount', ai.reserved_count,
                    'aiMissingUsageCount', ai.missing_usage_count,
                    'aiEstimatedCostCount', ai.estimated_cost_count,
                    'jobCount', job_rollup.job_count,
                    'jobPendingCount', job_rollup.pending_count,
                    'jobProcessingCount', job_rollup.processing_count,
                    'jobCompletedCount', job_rollup.completed_count,
                    'jobFailedCount', job_rollup.failed_count,
                    'jobCancelledCount', job_rollup.cancelled_count,
                    'jobAttemptCountTotal', job_rollup.attempt_count_total
                ),
                'geminiUsage', pg_catalog.jsonb_build_object(
                    'promptTokens', ai.prompt_tokens,
                    'completionTokens', ai.completion_tokens,
                    'thinkingTokens', ai.thinking_tokens
                ),
                'profileOutcomes', profile_rows.payload,
                'resultCoverage', (SELECT coverage.payload FROM coverage)
            ),
            'jobs', jobs.payload
        )
        FROM provider, ai, job_rollup, profile_rows, jobs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_operational_observability(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_operational_observability(UUID)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_operational_observability(UUID) IS
    'Returns only PII-free V2 cost, timing, completeness, profile-source counters, result coverage, and bounded job metadata to service_role.';
