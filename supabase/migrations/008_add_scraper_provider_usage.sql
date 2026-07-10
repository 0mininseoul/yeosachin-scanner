-- Apply this migration before enabling SCRAPER_TELEMETRY_PERSIST=true.
CREATE TABLE IF NOT EXISTS scraper_provider_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES analysis_requests(id) ON DELETE SET NULL,
    provider TEXT NOT NULL CHECK (provider IN ('apify', 'coderx', 'flashapi', 'rapidapi', 'selfhosted')),
    capability TEXT NOT NULL CHECK (capability IN ('profile', 'profilesBatch', 'followers', 'following')),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
    raw_result_count INTEGER NOT NULL DEFAULT 0 CHECK (raw_result_count >= 0),
    unique_result_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_result_count >= 0),
    unique_ratio DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (unique_ratio >= 0 AND unique_ratio <= 1),
    fallback BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    status TEXT NOT NULL CHECK (status IN ('success', 'error')),
    estimated_cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
    rate_limit_limit INTEGER CHECK (rate_limit_limit >= 0),
    rate_limit_remaining INTEGER CHECK (rate_limit_remaining >= 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_usage_request
    ON scraper_provider_usage(request_id);
CREATE INDEX IF NOT EXISTS idx_scraper_usage_created
    ON scraper_provider_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_scraper_usage_provider_capability
    ON scraper_provider_usage(provider, capability);

ALTER TABLE scraper_provider_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role access only" ON scraper_provider_usage
    FOR ALL USING (auth.role() = 'service_role');
