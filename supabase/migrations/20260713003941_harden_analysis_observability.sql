-- A paid Actor can be charged even if its start response is lost before a run ID
-- is checkpointed. Capture the PII-free operation and its maximum charge before
-- every Actor start so absence from the cost ledger is itself observable.
CREATE TABLE public.analysis_provider_usage_expectations (
    request_id UUID NOT NULL,
    operation_key TEXT NOT NULL
        CHECK (
            operation_key ~ '^(profile:target|profiles:(0|[1-9][0-9]{0,6})|relationship:(followers|following)|interaction:(target_likers|target_comments|candidate_likers):(0|[1-9][0-9]{0,6}))$'
        ),
    logical_provider TEXT NOT NULL
        CHECK (logical_provider IN ('apify', 'coderx')),
    actor_id TEXT NOT NULL
        CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'),
    max_charge_usd NUMERIC NOT NULL
        CHECK (
            max_charge_usd::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND max_charge_usd BETWEEN 0 AND 100000
        ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, operation_key)
);

ALTER TABLE public.analysis_provider_usage_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_provider_usage_expectations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_provider_usage_expectations TO service_role;

INSERT INTO public.analysis_provider_usage_expectations (
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
)
SELECT
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
FROM public.analysis_provider_cost_ledger
WHERE request_id IS NOT NULL
ON CONFLICT (request_id, operation_key) DO NOTHING;

INSERT INTO public.analysis_provider_usage_expectations (
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
)
SELECT
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
FROM public.analysis_provider_runs
ON CONFLICT (request_id, operation_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.capture_analysis_provider_usage_expectation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.analysis_provider_usage_expectations (
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        max_charge_usd
    ) VALUES (
        NEW.request_id,
        NEW.operation_key,
        NEW.logical_provider,
        NEW.actor_id,
        NEW.max_charge_usd
    )
    ON CONFLICT (request_id, operation_key) DO UPDATE
    SET logical_provider = EXCLUDED.logical_provider,
        actor_id = EXCLUDED.actor_id,
        max_charge_usd = EXCLUDED.max_charge_usd
    WHERE public.analysis_provider_usage_expectations.logical_provider = EXCLUDED.logical_provider
      AND public.analysis_provider_usage_expectations.actor_id = EXCLUDED.actor_id
      AND public.analysis_provider_usage_expectations.max_charge_usd = EXCLUDED.max_charge_usd;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_EXPECTATION_MISMATCH',
            ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_analysis_provider_usage_expectation
    ON public.analysis_provider_runs;
CREATE TRIGGER capture_analysis_provider_usage_expectation
    AFTER INSERT ON public.analysis_provider_runs
    FOR EACH ROW
    EXECUTE FUNCTION public.capture_analysis_provider_usage_expectation();

REVOKE ALL ON FUNCTION public.capture_analysis_provider_usage_expectation()
    FROM PUBLIC, anon, authenticated;

-- Gemini calls have no provider run ID. Persist the number of token-usage rows
-- expected for each generation operation before any model request starts.
CREATE TABLE public.analysis_gemini_usage_expectations (
    request_id UUID NOT NULL,
    operation_key TEXT NOT NULL
        CHECK (
            operation_key ~ '^(private-names|combined:(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,6})|deep-risk:0)$'
        ),
    generation_kind TEXT NOT NULL
        CHECK (generation_kind IN ('private_names', 'combined', 'deep_risk')),
    expected_record_count INTEGER NOT NULL
        CHECK (expected_record_count BETWEEN 1 AND 10000),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, operation_key)
);

ALTER TABLE public.analysis_gemini_usage_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_gemini_usage_expectations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_gemini_usage_expectations TO service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_gemini_usage_expectation(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_generation_kind TEXT,
    p_expected_record_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    existing public.analysis_gemini_usage_expectations%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_expected_step NOT IN ('collect', 'analyze', 'deep_analysis')
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(private-names|combined:(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,6})|deep-risk:0)$'
       OR p_generation_kind NOT IN ('private_names', 'combined', 'deep_risk')
       OR p_expected_record_count IS NULL
       OR p_expected_record_count NOT BETWEEN 1 AND 10000
       OR (p_generation_kind = 'private_names' AND p_expected_step <> 'collect')
       OR (p_generation_kind = 'combined' AND p_expected_step <> 'analyze')
       OR (p_generation_kind = 'deep_risk' AND p_expected_step <> 'deep_analysis') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_GEMINI_EXPECTATION_INVALID',
            ERRCODE = '22023';
    END IF;

    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT *
    INTO existing
    FROM public.analysis_gemini_usage_expectations
    WHERE request_id = p_request_id
      AND operation_key = p_operation_key;

    IF FOUND THEN
        IF existing.generation_kind <> p_generation_kind
           OR existing.expected_record_count <> p_expected_record_count THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_GEMINI_EXPECTATION_MISMATCH',
                ERRCODE = '22023';
        END IF;
        RETURN TRUE;
    END IF;

    INSERT INTO public.analysis_gemini_usage_expectations (
        request_id,
        operation_key,
        generation_kind,
        expected_record_count
    ) VALUES (
        p_request_id,
        p_operation_key,
        p_generation_kind,
        p_expected_record_count
    );
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_gemini_usage_expectation(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_analysis_gemini_usage_expectation(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;

-- These tables contain only operational counters, sanitized categories, Actor
-- IDs, and opaque UUIDs. Preserve correlation after the product request is
-- deleted; no Instagram identity or generated content is retained here.
ALTER TABLE public.analysis_step_events
    DROP CONSTRAINT IF EXISTS analysis_step_events_request_id_fkey;
ALTER TABLE public.analysis_provider_cost_ledger
    DROP CONSTRAINT IF EXISTS analysis_provider_cost_ledger_request_id_fkey;
ALTER TABLE public.gemini_token_usage
    DROP CONSTRAINT IF EXISTS gemini_token_usage_request_id_fkey;
ALTER TABLE public.scraper_provider_usage
    DROP CONSTRAINT IF EXISTS scraper_provider_usage_request_id_fkey;

CREATE OR REPLACE VIEW public.analysis_operational_cost_summary
WITH (security_invoker = true)
AS
WITH observed_request_rows AS (
    SELECT id AS request_id, created_at FROM public.analysis_requests
    UNION ALL
    SELECT request_id, created_at FROM public.analysis_provider_usage_expectations
    UNION ALL
    SELECT request_id, created_at FROM public.analysis_gemini_usage_expectations
    UNION ALL
    SELECT request_id, created_at
    FROM public.analysis_provider_cost_ledger
    WHERE request_id IS NOT NULL
    UNION ALL
    SELECT request_id, created_at
    FROM public.gemini_token_usage
    WHERE request_id IS NOT NULL
    UNION ALL
    SELECT request_id, created_at
    FROM public.scraper_provider_usage
    WHERE request_id IS NOT NULL
    UNION ALL
    SELECT request_id, created_at FROM public.analysis_step_events
), observed_requests AS (
    SELECT request_id, MIN(created_at) AS first_observed_at
    FROM observed_request_rows
    GROUP BY request_id
), provider_cost AS (
    SELECT
        expectation.request_id,
        COUNT(*)::INTEGER AS provider_expected_run_count,
        COUNT(ledger.run_id)::INTEGER AS provider_run_count,
        COUNT(*) FILTER (WHERE ledger.status = 'running')::INTEGER
            AS provider_running_run_count,
        COUNT(*) FILTER (
            WHERE ledger.run_id IS NULL
               OR ledger.status = 'running'
               OR ledger.usage_total_usd IS NULL
        )::INTEGER AS provider_missing_actual_run_count,
        COALESCE(SUM(ledger.usage_total_usd), 0)::NUMERIC AS provider_actual_cost_usd,
        COALESCE(SUM(COALESCE(
            ledger.usage_total_usd,
            ledger.max_charge_usd,
            expectation.max_charge_usd
        )), 0)::NUMERIC AS provider_conservative_cost_usd
    FROM public.analysis_provider_usage_expectations AS expectation
    LEFT JOIN public.analysis_provider_cost_ledger AS ledger
      ON ledger.request_id = expectation.request_id
     AND ledger.operation_key = expectation.operation_key
    GROUP BY expectation.request_id
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
), gemini_expectation AS (
    SELECT
        request_id,
        COUNT(*)::INTEGER AS gemini_expected_operation_count,
        SUM(expected_record_count)::INTEGER AS gemini_expected_record_count
    FROM public.analysis_gemini_usage_expectations
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
    observed_request.request_id,
    COALESCE(analysis_request.status, 'deleted')::VARCHAR(20) AS status,
    COALESCE(analysis_request.current_step, 'deleted')::VARCHAR AS current_step,
    COALESCE(analysis_request.created_at, observed_request.first_observed_at) AS created_at,
    analysis_request.completed_at,
    CASE
        WHEN analysis_request.completed_at IS NULL THEN NULL
        ELSE GREATEST(
            0,
            ROUND(EXTRACT(EPOCH FROM (
                analysis_request.completed_at
                - COALESCE(analysis_request.created_at, observed_request.first_observed_at)
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
        COALESCE(provider_cost.provider_expected_run_count, 0) > 0
        AND COALESCE(provider_cost.provider_expected_run_count, 0)
            = COALESCE(provider_cost.provider_run_count, 0)
        AND COALESCE(provider_cost.provider_running_run_count, 0) = 0
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
    (
        (
            COALESCE(gemini_expectation.gemini_expected_record_count, 0) > 0
            AND COALESCE(gemini_expectation.gemini_expected_record_count, 0)
                = COALESCE(gemini_cost.gemini_record_count, 0)
            AND COALESCE(gemini_cost.gemini_missing_estimate_count, 0) = 0
        )
        OR (
            COALESCE(gemini_expectation.gemini_expected_record_count, 0) = 0
            AND COALESCE(analysis_request.mutual_follows, -1) = 0
            AND COALESCE(gemini_cost.gemini_record_count, 0) = 0
        )
    ) AS gemini_cost_complete,
    (
        COALESCE(provider_cost.provider_actual_cost_usd, 0)
        + COALESCE(gemini_cost.gemini_estimated_cost_usd, 0)
    )::NUMERIC AS known_total_cost_usd,
    (
        COALESCE(provider_cost.provider_conservative_cost_usd, 0)
        + COALESCE(gemini_cost.gemini_estimated_cost_usd, 0)
    )::NUMERIC AS conservative_total_cost_usd,
    (
        COALESCE(analysis_request.status, 'deleted') IN ('completed', 'failed', 'deleted')
        AND COALESCE(provider_cost.provider_expected_run_count, 0) > 0
        AND COALESCE(provider_cost.provider_expected_run_count, 0)
            = COALESCE(provider_cost.provider_run_count, 0)
        AND COALESCE(provider_cost.provider_running_run_count, 0) = 0
        AND COALESCE(provider_cost.provider_missing_actual_run_count, 0) = 0
        AND (
            (
                COALESCE(gemini_expectation.gemini_expected_record_count, 0) > 0
                AND COALESCE(gemini_expectation.gemini_expected_record_count, 0)
                    = COALESCE(gemini_cost.gemini_record_count, 0)
                AND COALESCE(gemini_cost.gemini_missing_estimate_count, 0) = 0
            )
            OR (
                COALESCE(gemini_expectation.gemini_expected_record_count, 0) = 0
                AND COALESCE(analysis_request.mutual_follows, -1) = 0
                AND COALESCE(gemini_cost.gemini_record_count, 0) = 0
            )
        )
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
    COALESCE(step_history.failure_event_count, 0) AS failure_event_count,
    COALESCE(provider_cost.provider_expected_run_count, 0)
        AS provider_expected_run_count,
    COALESCE(gemini_expectation.gemini_expected_operation_count, 0)
        AS gemini_expected_operation_count,
    COALESCE(gemini_expectation.gemini_expected_record_count, 0)
        AS gemini_expected_record_count
FROM observed_requests AS observed_request
LEFT JOIN public.analysis_requests AS analysis_request
  ON analysis_request.id = observed_request.request_id
LEFT JOIN provider_cost ON provider_cost.request_id = observed_request.request_id
LEFT JOIN gemini_cost ON gemini_cost.request_id = observed_request.request_id
LEFT JOIN gemini_expectation
  ON gemini_expectation.request_id = observed_request.request_id
LEFT JOIN scraper_usage ON scraper_usage.request_id = observed_request.request_id
LEFT JOIN step_history ON step_history.request_id = observed_request.request_id;

REVOKE ALL ON TABLE public.analysis_operational_cost_summary
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_operational_cost_summary TO service_role;

COMMENT ON TABLE public.analysis_provider_usage_expectations IS
    'PII-free pre-start maximum-charge marker for every paid Actor operation.';
COMMENT ON TABLE public.analysis_gemini_usage_expectations IS
    'PII-free expected Gemini token-log row count recorded before model execution.';
COMMENT ON VIEW public.analysis_operational_cost_summary IS
    'Deletion-resistant service-role cost rollup. Completeness requires pre-call expectations to match settled provider and Gemini records.';
