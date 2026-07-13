-- Durable, PII-free pipeline history for operational debugging. Raw provider
-- payloads, usernames, captions, comments, and exception messages do not belong
-- in this table.
CREATE TABLE public.analysis_step_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    step TEXT NOT NULL
        CHECK (step IN (
            'pending', 'collect', 'profiles', 'analyze', 'interactions',
            'deep_analysis', 'finalize', 'completed', 'failed',
            'gender', 'features'
        )),
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'started', 'completed', 'retrying', 'failed', 'skipped', 'aborted'
        )),
    delivery_attempt INTEGER
        CHECK (delivery_attempt IS NULL OR delivery_attempt BETWEEN 1 AND 100),
    progress INTEGER
        CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
    latency_ms INTEGER
        CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 86400000),
    failure_category TEXT
        CHECK (
            failure_category IS NULL OR failure_category IN (
                'configuration', 'schema', 'incomplete', 'budget', 'timeout',
                'provider', 'persistence', 'retry_exhausted', 'unknown'
            )
        ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (event_type IN ('retrying', 'failed', 'aborted') AND failure_category IS NOT NULL)
        OR (event_type NOT IN ('retrying', 'failed', 'aborted') AND failure_category IS NULL)
    )
);

CREATE INDEX analysis_step_events_request_created
    ON public.analysis_step_events(request_id, created_at);
CREATE INDEX analysis_step_events_failed_created
    ON public.analysis_step_events(created_at DESC)
    WHERE event_type IN ('failed', 'aborted');

ALTER TABLE public.analysis_step_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_step_events
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_step_events TO service_role;

COMMENT ON TABLE public.analysis_step_events IS
    'PII-free append-only analysis pipeline events for service-role operational diagnostics.';
COMMENT ON COLUMN public.analysis_step_events.failure_category IS
    'Sanitized error class only. Never store provider payloads or exception messages.';

-- One service-role-only row per analysis request. Paid Actor telemetry is
-- intentionally not added to scraper_estimated_cost_usd because the same Actor
-- call can appear in both tables. The provider ledger is the billing source of
-- truth; scraper telemetry remains a completeness and latency diagnostic.
CREATE VIEW public.analysis_operational_cost_summary
WITH (security_invoker = true)
AS
WITH provider_cost AS (
    SELECT
        request_id,
        COUNT(*)::INTEGER AS provider_run_count,
        COUNT(*) FILTER (WHERE status = 'running')::INTEGER AS provider_running_run_count,
        COUNT(*) FILTER (
            WHERE status <> 'running' AND usage_total_usd IS NULL
        )::INTEGER AS provider_missing_actual_run_count,
        COALESCE(SUM(usage_total_usd), 0)::NUMERIC AS provider_actual_cost_usd,
        COALESCE(SUM(COALESCE(usage_total_usd, max_charge_usd)), 0)::NUMERIC
            AS provider_conservative_cost_usd
    FROM public.analysis_provider_cost_ledger
    WHERE request_id IS NOT NULL
    GROUP BY request_id
), gemini_cost AS (
    SELECT
        request_id,
        COUNT(*)::INTEGER AS gemini_record_count,
        COUNT(*) FILTER (WHERE cached_hit IS TRUE)::INTEGER AS gemini_cache_hit_count,
        COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::INTEGER
            AS gemini_missing_estimate_count,
        COALESCE(SUM(prompt_tokens), 0)::BIGINT AS gemini_prompt_tokens,
        COALESCE(SUM(total_tokens), 0)::BIGINT AS gemini_total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0)::NUMERIC AS gemini_estimated_cost_usd,
        ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::INTEGER
            AS gemini_average_latency_ms
    FROM public.gemini_token_usage
    WHERE request_id IS NOT NULL
    GROUP BY request_id
), scraper_usage AS (
    SELECT
        request_id,
        COUNT(*)::INTEGER AS scraper_call_count,
        COUNT(*) FILTER (WHERE status = 'error')::INTEGER AS scraper_error_count,
        COALESCE(SUM(result_count), 0)::BIGINT AS scraper_result_count,
        COALESCE(SUM(estimated_cost_usd), 0)::NUMERIC AS scraper_estimated_cost_usd,
        ROUND(AVG(latency_ms))::INTEGER AS scraper_average_latency_ms
    FROM public.scraper_provider_usage
    WHERE request_id IS NOT NULL
    GROUP BY request_id
), step_history AS (
    SELECT
        request_id,
        COUNT(*)::INTEGER AS step_event_count,
        MIN(created_at) FILTER (WHERE event_type = 'started') AS first_step_started_at,
        MAX(created_at) AS last_step_event_at,
        COUNT(*) FILTER (WHERE event_type = 'retrying')::INTEGER AS retry_event_count,
        COUNT(*) FILTER (WHERE event_type IN ('failed', 'aborted'))::INTEGER
            AS failure_event_count
    FROM public.analysis_step_events
    GROUP BY request_id
)
SELECT
    analysis_request.id AS request_id,
    analysis_request.status,
    COALESCE(analysis_request.current_step, 'pending') AS current_step,
    analysis_request.created_at,
    analysis_request.completed_at,
    CASE
        WHEN analysis_request.completed_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            ROUND(EXTRACT(EPOCH FROM (
                analysis_request.completed_at - analysis_request.created_at
            )) * 1000)::BIGINT
        )
    END AS analysis_duration_ms,
    COALESCE(provider_cost.provider_run_count, 0) AS provider_run_count,
    COALESCE(provider_cost.provider_running_run_count, 0) AS provider_running_run_count,
    COALESCE(provider_cost.provider_missing_actual_run_count, 0)
        AS provider_missing_actual_run_count,
    COALESCE(provider_cost.provider_actual_cost_usd, 0)::NUMERIC
        AS provider_actual_cost_usd,
    COALESCE(provider_cost.provider_conservative_cost_usd, 0)::NUMERIC
        AS provider_conservative_cost_usd,
    (
        COALESCE(provider_cost.provider_running_run_count, 0) = 0
        AND COALESCE(provider_cost.provider_missing_actual_run_count, 0) = 0
    ) AS provider_cost_complete,
    COALESCE(gemini_cost.gemini_record_count, 0) AS gemini_record_count,
    COALESCE(gemini_cost.gemini_cache_hit_count, 0) AS gemini_cache_hit_count,
    COALESCE(gemini_cost.gemini_missing_estimate_count, 0)
        AS gemini_missing_estimate_count,
    COALESCE(gemini_cost.gemini_prompt_tokens, 0) AS gemini_prompt_tokens,
    COALESCE(gemini_cost.gemini_total_tokens, 0) AS gemini_total_tokens,
    COALESCE(gemini_cost.gemini_estimated_cost_usd, 0)::NUMERIC
        AS gemini_estimated_cost_usd,
    gemini_cost.gemini_average_latency_ms,
    (COALESCE(gemini_cost.gemini_missing_estimate_count, 0) = 0)
        AS gemini_cost_complete,
    (
        COALESCE(provider_cost.provider_actual_cost_usd, 0)
        + COALESCE(gemini_cost.gemini_estimated_cost_usd, 0)
    )::NUMERIC AS known_total_cost_usd,
    (
        COALESCE(provider_cost.provider_conservative_cost_usd, 0)
        + COALESCE(gemini_cost.gemini_estimated_cost_usd, 0)
    )::NUMERIC AS conservative_total_cost_usd,
    (
        COALESCE(provider_cost.provider_running_run_count, 0) = 0
        AND COALESCE(provider_cost.provider_missing_actual_run_count, 0) = 0
        AND COALESCE(gemini_cost.gemini_missing_estimate_count, 0) = 0
    ) AS total_cost_complete,
    COALESCE(scraper_usage.scraper_call_count, 0) AS scraper_call_count,
    COALESCE(scraper_usage.scraper_error_count, 0) AS scraper_error_count,
    COALESCE(scraper_usage.scraper_result_count, 0) AS scraper_result_count,
    COALESCE(scraper_usage.scraper_estimated_cost_usd, 0)::NUMERIC
        AS scraper_estimated_cost_usd,
    scraper_usage.scraper_average_latency_ms,
    COALESCE(step_history.step_event_count, 0) AS step_event_count,
    step_history.first_step_started_at,
    step_history.last_step_event_at,
    COALESCE(step_history.retry_event_count, 0) AS retry_event_count,
    COALESCE(step_history.failure_event_count, 0) AS failure_event_count
FROM public.analysis_requests AS analysis_request
LEFT JOIN provider_cost ON provider_cost.request_id = analysis_request.id
LEFT JOIN gemini_cost ON gemini_cost.request_id = analysis_request.id
LEFT JOIN scraper_usage ON scraper_usage.request_id = analysis_request.id
LEFT JOIN step_history ON step_history.request_id = analysis_request.id;

REVOKE ALL ON TABLE public.analysis_operational_cost_summary
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_operational_cost_summary TO service_role;

COMMENT ON VIEW public.analysis_operational_cost_summary IS
    'Service-role-only request cost and latency rollup. Provider ledger costs are not double-counted with scraper telemetry estimates.';
