-- Optional extended telemetry for model cost and latency canaries.
-- Application inserts fall back to the original 005 schema until this migration is applied.
ALTER TABLE gemini_token_usage
    ADD COLUMN IF NOT EXISTS thinking_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
    ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(18, 12),
    ADD COLUMN IF NOT EXISTS model_location TEXT NOT NULL DEFAULT 'global';

ALTER TABLE gemini_token_usage
    DROP CONSTRAINT IF EXISTS gemini_token_usage_thinking_tokens_nonnegative,
    DROP CONSTRAINT IF EXISTS gemini_token_usage_latency_ms_nonnegative,
    DROP CONSTRAINT IF EXISTS gemini_token_usage_estimated_cost_usd_nonnegative;

ALTER TABLE gemini_token_usage
    ADD CONSTRAINT gemini_token_usage_thinking_tokens_nonnegative
        CHECK (thinking_tokens >= 0),
    ADD CONSTRAINT gemini_token_usage_latency_ms_nonnegative
        CHECK (latency_ms IS NULL OR latency_ms >= 0),
    ADD CONSTRAINT gemini_token_usage_estimated_cost_usd_nonnegative
        CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);

COMMENT ON COLUMN gemini_token_usage.completion_tokens IS
    'Visible candidate tokens only; reasoning tokens are stored in thinking_tokens.';
COMMENT ON COLUMN gemini_token_usage.total_tokens IS
    'Provider total including prompt, candidate, and reasoning tokens.';
COMMENT ON COLUMN gemini_token_usage.estimated_cost_usd IS
    'Point-in-time standard Vertex AI USD estimate based on model, location, and usage metadata.';
