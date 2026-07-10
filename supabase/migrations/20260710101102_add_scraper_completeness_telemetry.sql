ALTER TABLE scraper_provider_usage
    ADD COLUMN IF NOT EXISTS expected_result_count INTEGER,
    ADD COLUMN IF NOT EXISTS minimum_complete_count INTEGER,
    ADD COLUMN IF NOT EXISTS coverage_ratio DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS failure_category TEXT;

ALTER TABLE scraper_provider_usage
    DROP CONSTRAINT IF EXISTS scraper_usage_expected_result_count_nonnegative,
    DROP CONSTRAINT IF EXISTS scraper_usage_minimum_complete_count_nonnegative,
    DROP CONSTRAINT IF EXISTS scraper_usage_coverage_ratio_nonnegative,
    DROP CONSTRAINT IF EXISTS scraper_usage_failure_category_valid;

ALTER TABLE scraper_provider_usage
    ADD CONSTRAINT scraper_usage_expected_result_count_nonnegative
        CHECK (expected_result_count IS NULL OR expected_result_count >= 0),
    ADD CONSTRAINT scraper_usage_minimum_complete_count_nonnegative
        CHECK (minimum_complete_count IS NULL OR minimum_complete_count >= 0),
    ADD CONSTRAINT scraper_usage_coverage_ratio_nonnegative
        CHECK (coverage_ratio IS NULL OR coverage_ratio >= 0),
    ADD CONSTRAINT scraper_usage_failure_category_valid
        CHECK (
            failure_category IS NULL OR failure_category IN (
                'configuration',
                'schema',
                'incomplete',
                'budget',
                'timeout',
                'provider'
            )
        );

COMMENT ON COLUMN scraper_provider_usage.expected_result_count IS
    'Target profile declared count capped by the requested plan limit.';
COMMENT ON COLUMN scraper_provider_usage.minimum_complete_count IS
    'Minimum unique rows required by the shared relationship completeness gate.';
COMMENT ON COLUMN scraper_provider_usage.coverage_ratio IS
    'Unique result count divided by expected_result_count; 1 for an expected empty list.';
COMMENT ON COLUMN scraper_provider_usage.failure_category IS
    'Sanitized operational failure class without provider payload or credentials.';
