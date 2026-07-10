-- Persist only bounded job metadata and positive interaction evidence. Raw unrelated liker and
-- commenter lists are discarded in memory and never stored.
CREATE TABLE analysis_interaction_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('target_likers', 'target_comments', 'candidate_likers')),
    batch_index INTEGER NOT NULL DEFAULT 0 CHECK (batch_index >= 0),
    provider TEXT NOT NULL CHECK (provider IN ('apify')),
    post_count INTEGER NOT NULL CHECK (post_count >= 0 AND post_count <= 40),
    requested_per_post INTEGER NOT NULL CHECK (requested_per_post >= 1 AND requested_per_post <= 200),
    requested_result_cap INTEGER NOT NULL CHECK (requested_result_cap >= 0 AND requested_result_cap <= 4000),
    returned_count INTEGER NOT NULL DEFAULT 0 CHECK (returned_count >= 0 AND returned_count <= 4000),
    estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
    coverage JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(coverage) = 'array'),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    provider_run_id TEXT,
    error_code TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, kind, batch_index)
);

CREATE TABLE analysis_interaction_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
    candidate_username VARCHAR(30) NOT NULL CHECK (
        candidate_username = lower(candidate_username)
        AND candidate_username ~ '^[a-z0-9._]{1,30}$'
    ),
    post_id VARCHAR(100) NOT NULL,
    signal TEXT NOT NULL CHECK (
        signal IN ('female_target_like', 'female_target_comment', 'target_female_like')
    ),
    source_interaction_id VARCHAR(150) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, candidate_username, signal, post_id, source_interaction_id)
);

CREATE TABLE analysis_interaction_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
    candidate_username VARCHAR(30) NOT NULL CHECK (
        candidate_username = lower(candidate_username)
        AND candidate_username ~ '^[a-z0-9._]{1,30}$'
    ),
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    coverage NUMERIC(6, 5) NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
    coverage_status TEXT NOT NULL CHECK (coverage_status IN ('high', 'medium', 'low')),
    female_to_target_likes_count INTEGER NOT NULL DEFAULT 0 CHECK (female_to_target_likes_count >= 0),
    female_to_target_comments_count INTEGER NOT NULL DEFAULT 0 CHECK (female_to_target_comments_count >= 0),
    target_to_female_likes_count INTEGER NOT NULL DEFAULT 0 CHECK (target_to_female_likes_count >= 0),
    breakdown JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(breakdown) = 'object'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, candidate_username)
);

ALTER TABLE analysis_results
    ADD COLUMN IF NOT EXISTS interaction_score INTEGER NOT NULL DEFAULT 0
        CHECK (interaction_score >= 0 AND interaction_score <= 100),
    ADD COLUMN IF NOT EXISTS interaction_coverage NUMERIC(6, 5) NOT NULL DEFAULT 0
        CHECK (interaction_coverage >= 0 AND interaction_coverage <= 1),
    ADD COLUMN IF NOT EXISTS interaction_coverage_status TEXT NOT NULL DEFAULT 'low'
        CHECK (interaction_coverage_status IN ('high', 'medium', 'low')),
    ADD COLUMN IF NOT EXISTS female_to_target_likes_count INTEGER NOT NULL DEFAULT 0
        CHECK (female_to_target_likes_count >= 0),
    ADD COLUMN IF NOT EXISTS female_to_target_comments_count INTEGER NOT NULL DEFAULT 0
        CHECK (female_to_target_comments_count >= 0),
    ADD COLUMN IF NOT EXISTS target_to_female_likes_count INTEGER NOT NULL DEFAULT 0
        CHECK (target_to_female_likes_count >= 0);

CREATE INDEX idx_analysis_interaction_jobs_request
    ON analysis_interaction_jobs(request_id, kind, batch_index);
CREATE INDEX idx_analysis_interaction_evidence_candidate
    ON analysis_interaction_evidence(request_id, candidate_username);
CREATE INDEX idx_analysis_interaction_scores_request
    ON analysis_interaction_scores(request_id);

ALTER TABLE analysis_interaction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_interaction_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_interaction_scores ENABLE ROW LEVEL SECURITY;

-- These are server-internal staging tables. End-user APIs expose only bounded aggregates copied
-- to analysis_results under its existing ownership policy.
REVOKE ALL ON analysis_interaction_jobs FROM anon, authenticated;
REVOKE ALL ON analysis_interaction_evidence FROM anon, authenticated;
REVOKE ALL ON analysis_interaction_scores FROM anon, authenticated;
GRANT ALL ON analysis_interaction_jobs TO service_role;
GRANT ALL ON analysis_interaction_evidence TO service_role;
GRANT ALL ON analysis_interaction_scores TO service_role;

COMMENT ON TABLE analysis_interaction_jobs IS
    'Bounded Apify interaction collection batches and per-post coverage metadata.';
COMMENT ON TABLE analysis_interaction_evidence IS
    'Only positive interactions involving a public mutual female candidate; unrelated rows are discarded.';
COMMENT ON COLUMN analysis_results.interaction_coverage IS
    'Observed provider coverage from 0 to 1; missing rows in truncated pages are not negative evidence.';
