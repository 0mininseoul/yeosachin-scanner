-- Revenue E2E additive ledgers.
-- This migration only creates service-owned evidence surfaces; no paid request,
-- account classification, order, or result row is changed by applying it.

CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    preflight_id UUID NOT NULL,
    user_id UUID NOT NULL,
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    access_mode TEXT NOT NULL CHECK (access_mode = 'test_entitlement'),
    target_username_hmac TEXT NOT NULL CHECK (target_username_hmac ~ '^[a-f0-9]{64}$'),
    preflight_refreshed_at TIMESTAMPTZ NOT NULL,
    request_started_at TIMESTAMPTZ NOT NULL,
    fresh_provenance JSONB NOT NULL DEFAULT '{}'::JSONB,
    cost_cap_krw INTEGER NOT NULL CHECK (cost_cap_krw IN (1808, 3634)),
    reserved_cost_krw INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_krw >= 0),
    actual_cost_krw INTEGER CHECK (actual_cost_krw IS NULL OR actual_cost_krw >= 0),
    public_mutual_count INTEGER CHECK (public_mutual_count IS NULL OR public_mutual_count >= 0),
    screened_count INTEGER CHECK (screened_count IS NULL OR screened_count >= 0),
    not_screened_count INTEGER CHECK (not_screened_count IS NULL OR not_screened_count >= 0),
    unknown_burden_count INTEGER CHECK (unknown_burden_count IS NULL OR unknown_burden_count >= 0),
    result_revision_id UUID,
    image_manifest_id UUID,
    content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'manual_review', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ
);

ALTER TABLE public.analysis_revenue_run_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_run_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_run_ledgers TO service_role;

CREATE TABLE public.analysis_result_share_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    client_nonce TEXT NOT NULL CHECK (client_nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
    share_channel TEXT NOT NULL CHECK (share_channel IN ('clipboard', 'web_share', 'kakao')),
    share_outcome TEXT NOT NULL CHECK (share_outcome IN ('started', 'succeeded', 'cancelled', 'failed', 'confirmed', 'opened')),
    event_name TEXT NOT NULL CHECK (event_name IN (
        'result_share_initiated', 'result_share_copy_succeeded',
        'result_share_handoff_completed', 'result_shared_confirmed',
        'shared_result_opened', 'result_share_cancelled', 'result_share_failed'
    )),
    traffic_class TEXT NOT NULL CHECK (traffic_class IN ('external', 'operator', 'e2e_test', 'internal_tester', 'unknown')),
    axiom_delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (request_id, client_nonce)
);

ALTER TABLE public.analysis_result_share_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_result_share_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_result_share_observations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_result_share_observations TO service_role;

COMMENT ON TABLE public.analysis_revenue_run_ledgers IS
    'Service-only revenue E2E provenance, cost, coverage, and immutable-reader equality evidence.';
COMMENT ON TABLE public.analysis_result_share_observations IS
    'Allowlisted, nonce-idempotent share semantics; raw share URLs and Kakao callback bodies are never stored.';
