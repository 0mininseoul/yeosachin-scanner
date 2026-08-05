-- PII-free preflight failure facts.  In particular, this records validation failures
-- that are rejected before an analysis_preflights row exists.
CREATE TABLE public.analysis_preflight_failures (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE SET NULL,
    stage TEXT NOT NULL,
    error_code TEXT NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_preflight_failure_stage_check CHECK (
        stage IN ('request', 'profile', 'exclusion')
    ),
    CONSTRAINT analysis_preflight_failure_code_check CHECK (
        error_code IN (
            'HANDLE_FORMAT_INVALID',
            'TARGET_NOT_FOUND',
            'TARGET_PRIVATE',
            'PLAN_CAPACITY_EXCEEDED',
            'EXCLUSION_RULE_VIOLATION',
            'PROVIDER_TEMPORARY_FAILURE',
            'RATE_LIMITED',
            'UNAUTHORIZED',
            'INTERNAL_ERROR'
        )
    )
);

CREATE INDEX analysis_preflight_failures_occurred_idx
    ON public.analysis_preflight_failures(occurred_at, error_code);
CREATE INDEX analysis_preflight_failures_user_idx
    ON public.analysis_preflight_failures(user_id, occurred_at)
    WHERE user_id IS NOT NULL;

ALTER TABLE public.analysis_preflight_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_preflight_failures FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT ON TABLE public.analysis_preflight_failures TO service_role;

COMMENT ON TABLE public.analysis_preflight_failures IS
    'PII-free preflight failure reason ledger; target handles and raw provider messages are never stored.';
