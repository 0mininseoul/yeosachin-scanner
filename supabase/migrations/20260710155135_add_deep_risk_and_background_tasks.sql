ALTER TABLE analysis_requests
    ADD COLUMN IF NOT EXISTS background_processing BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE analysis_interaction_evidence
    ADD COLUMN IF NOT EXISTS comment_text TEXT
        CHECK (comment_text IS NULL OR char_length(comment_text) <= 1000);

ALTER TABLE analysis_interaction_scores
    ADD COLUMN IF NOT EXISTS intermediate_score NUMERIC(8, 3) NOT NULL DEFAULT 0
        CHECK (intermediate_score >= 0 AND intermediate_score <= 190),
    ADD COLUMN IF NOT EXISTS recency_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0
        CHECK (recency_bonus >= 0 AND recency_bonus <= 20),
    ADD COLUMN IF NOT EXISTS deep_analysis JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (
            jsonb_typeof(deep_analysis) = 'array'
            AND jsonb_array_length(deep_analysis) <= 2
        );

ALTER TABLE analysis_results
    ADD COLUMN IF NOT EXISTS recency_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0
        CHECK (recency_bonus >= 0 AND recency_bonus <= 20),
    ADD COLUMN IF NOT EXISTS risk_analysis JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (
            jsonb_typeof(risk_analysis) = 'array'
            AND jsonb_array_length(risk_analysis) <= 2
        );

COMMENT ON COLUMN analysis_requests.background_processing IS
    'True only after a durable Cloud Task has been accepted for this analysis.';
COMMENT ON COLUMN analysis_interaction_evidence.comment_text IS
    'Bounded text for a positively matched candidate comment; unrelated comments are discarded.';
COMMENT ON COLUMN analysis_interaction_scores.intermediate_score IS
    'Appearance, exposure, target tag, and newest-mutual bonus before interaction scoring.';
COMMENT ON COLUMN analysis_interaction_scores.deep_analysis IS
    'Two bounded Korean evidence-analysis lines for high-risk result accounts.';
