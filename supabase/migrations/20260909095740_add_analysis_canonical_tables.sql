-- Analysis canonicalization is additive. Existing V2 source families stay
-- authoritative for the observation window and are intentionally untouched.

CREATE TABLE public.analysis_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'collection', 'ai', 'finalize', 'recovery')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'blocked')),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
    dependency_count INTEGER NOT NULL DEFAULT 0 CHECK (dependency_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    lease_expires_at TIMESTAMPTZ,
    completion_hash TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, job_key, generation),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'lifecycle', 'operational')),
    state TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_artifacts (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('evidence', 'manifest', 'media_ref', 'replay')),
    artifact_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'retained', 'expired', 'blocked')),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, artifact_key, content_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_costs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    amount_known NUMERIC(18,12),
    amount_conservative NUMERIC(18,12),
    usage_unknown BOOLEAN NOT NULL,
    source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (amount_known IS NULL OR amount_known >= 0),
    CHECK (amount_conservative IS NULL OR amount_conservative >= 0),
    CHECK (NOT usage_unknown OR amount_known IS NULL),
    CHECK (amount_conservative IS NULL OR amount_known IS NULL OR amount_conservative >= amount_known),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_cache (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('ai', 'profile', 'anonymous', 'blite')),
    cache_key_hash TEXT NOT NULL CHECK (cache_key_hash ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    single_flight_token_hash TEXT CHECK (
        single_flight_token_hash IS NULL OR single_flight_token_hash ~ '^[a-f0-9]{64}$'
    ),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (scope, cache_key_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_audit_bundles (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 100000),
    kind TEXT NOT NULL CHECK (kind IN ('bundle', 'candidate', 'interaction')),
    candidate_key TEXT,
    ordinal INTEGER,
    state TEXT NOT NULL CHECK (state IN ('complete', 'partial', 'inconsistent', 'failed')),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, version, kind, content_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE INDEX analysis_jobs_dispatch_idx
    ON public.analysis_jobs(state, next_attempt_at, updated_at);
CREATE INDEX analysis_events_request_created_idx
    ON public.analysis_events(request_id, created_at);
CREATE INDEX analysis_artifacts_request_kind_idx
    ON public.analysis_artifacts(request_id, kind, created_at);
CREATE INDEX analysis_costs_request_recorded_idx
    ON public.analysis_costs(request_id, recorded_at);
CREATE INDEX analysis_cache_expiry_idx
    ON public.analysis_cache(expires_at, state);
CREATE INDEX analysis_audit_request_version_idx
    ON public.analysis_audit_bundles(request_id, version, kind);
CREATE UNIQUE INDEX analysis_events_retry_key_idx
    ON public.analysis_events(request_id, state, content_hash)
    WHERE kind = 'operational' AND state = 'canonical_retry';

ALTER TABLE public.analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_costs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_audit_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_audit_bundles FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_jobs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_artifacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_costs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_cache FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_audit_bundles FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_analysis_canonical_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'ANALYSIS_CANONICAL_APPEND_ONLY: %', TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_canonical_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_events_append_only
    BEFORE UPDATE OR DELETE ON public.analysis_events
    FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_canonical_mutation();
CREATE TRIGGER analysis_costs_append_only
    BEFORE UPDATE OR DELETE ON public.analysis_costs
    FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_canonical_mutation();
CREATE TRIGGER analysis_audit_bundles_append_only
    BEFORE UPDATE OR DELETE ON public.analysis_audit_bundles
    FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_canonical_mutation();

CREATE OR REPLACE FUNCTION public.record_analysis_canonical_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_kind TEXT,
    p_state TEXT,
    p_generation BIGINT DEFAULT 0,
    p_attempt_count INTEGER DEFAULT 0,
    p_dependency_count INTEGER DEFAULT 0,
    p_next_attempt_at TIMESTAMPTZ DEFAULT NULL,
    p_lease_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_completion_hash TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::JSONB,
    p_retention_class TEXT DEFAULT 'standard'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_jobs;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_jobs(
        request_id, job_key, kind, state, generation, attempt_count,
        dependency_count, next_attempt_at, lease_expires_at, completion_hash,
        payload, retention_class
    ) VALUES (
        p_request_id, p_job_key, p_kind, p_state, p_generation, p_attempt_count,
        p_dependency_count, COALESCE(p_next_attempt_at, pg_catalog.clock_timestamp()),
        p_lease_expires_at, p_completion_hash, p_payload, p_retention_class
    )
    ON CONFLICT (request_id, job_key, generation) DO UPDATE SET
        state = EXCLUDED.state,
        attempt_count = EXCLUDED.attempt_count,
        dependency_count = EXCLUDED.dependency_count,
        next_attempt_at = EXCLUDED.next_attempt_at,
        lease_expires_at = EXCLUDED.lease_expires_at,
        completion_hash = EXCLUDED.completion_hash,
        payload = EXCLUDED.payload,
        retention_class = EXCLUDED.retention_class,
        updated_at = pg_catalog.clock_timestamp()
    RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.append_analysis_canonical_event(
    p_request_id UUID,
    p_job_id UUID,
    p_kind TEXT,
    p_state TEXT,
    p_payload JSONB,
    p_content_hash TEXT,
    p_retention_class TEXT DEFAULT 'standard'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_events;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_events(
        request_id, job_id, kind, state, payload, content_hash, retention_class
    ) VALUES (
        p_request_id, p_job_id, p_kind, p_state, p_payload, p_content_hash, p_retention_class
    ) RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.append_analysis_canonical_artifact(
    p_request_id UUID,
    p_job_id UUID,
    p_kind TEXT,
    p_artifact_key TEXT,
    p_state TEXT,
    p_content_hash TEXT,
    p_payload JSONB,
    p_retention_class TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_artifacts;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_artifacts(
        request_id, job_id, kind, artifact_key, state, content_hash,
        payload, retention_class
    ) VALUES (
        p_request_id, p_job_id, p_kind, p_artifact_key, p_state, p_content_hash,
        p_payload, p_retention_class
    )
    ON CONFLICT (request_id, artifact_key, content_hash) DO UPDATE SET
        state = EXCLUDED.state,
        payload = EXCLUDED.payload,
        retention_class = EXCLUDED.retention_class,
        updated_at = pg_catalog.clock_timestamp()
    RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.append_analysis_canonical_cost(
    p_request_id UUID,
    p_provider TEXT,
    p_operation_key TEXT,
    p_stage TEXT,
    p_currency CHAR(3),
    p_amount_known NUMERIC,
    p_amount_conservative NUMERIC,
    p_usage_unknown BOOLEAN,
    p_source_hash TEXT,
    p_payload JSONB DEFAULT '{}'::JSONB,
    p_retention_class TEXT DEFAULT 'permanent'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_costs;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_costs(
        request_id, provider, operation_key, stage, currency, amount_known,
        amount_conservative, usage_unknown, source_hash, payload, retention_class
    ) VALUES (
        p_request_id, p_provider, p_operation_key, p_stage,
        COALESCE(p_currency, 'USD'), p_amount_known, p_amount_conservative,
        p_usage_unknown, p_source_hash, p_payload, p_retention_class
    ) RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_analysis_canonical_cache(
    p_scope TEXT,
    p_cache_key_hash TEXT,
    p_state TEXT,
    p_expires_at TIMESTAMPTZ,
    p_single_flight_token_hash TEXT,
    p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_cache;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_cache(
        scope, cache_key_hash, state, expires_at,
        single_flight_token_hash, payload
    ) VALUES (
        p_scope, p_cache_key_hash, p_state, p_expires_at,
        p_single_flight_token_hash, p_payload
    )
    ON CONFLICT (scope, cache_key_hash) DO UPDATE SET
        state = EXCLUDED.state,
        expires_at = EXCLUDED.expires_at,
        single_flight_token_hash = EXCLUDED.single_flight_token_hash,
        payload = EXCLUDED.payload,
        updated_at = pg_catalog.clock_timestamp()
    RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.append_analysis_canonical_audit(
    p_request_id UUID,
    p_version INTEGER,
    p_kind TEXT,
    p_candidate_key TEXT,
    p_ordinal INTEGER,
    p_state TEXT,
    p_content_hash TEXT,
    p_retention_class TEXT DEFAULT 'permanent',
    p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.analysis_audit_bundles;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_audit_bundles(
        request_id, version, kind, candidate_key, ordinal, state,
        content_hash, retention_class, payload
    ) VALUES (
        p_request_id, p_version, p_kind, p_candidate_key, p_ordinal, p_state,
        p_content_hash, p_retention_class, p_payload
    ) RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_analysis_canonical_retry(
    p_request_id UUID,
    p_family TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_key TEXT := p_request_id::TEXT || ':' || p_family;
    v_hash TEXT := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'),
        'hex'
    );
    v_row public.analysis_events;
BEGIN
    IF p_family NOT IN ('jobs', 'evidence', 'cost', 'cache', 'audit') THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_RETRY_FAMILY' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_events(
        request_id, kind, state, payload, content_hash, retention_class
    ) VALUES (
        p_request_id, 'operational', 'canonical_retry',
        pg_catalog.jsonb_build_object('family', p_family, 'retryKey', v_key),
        v_hash, 'standard'
    )
    ON CONFLICT (request_id, state, content_hash)
        WHERE kind = 'operational' AND state = 'canonical_retry'
    DO NOTHING
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
        SELECT * INTO v_row FROM public.analysis_events
        WHERE request_id = p_request_id
          AND kind = 'operational'
          AND state = 'canonical_retry'
          AND content_hash = v_hash;
    END IF;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_canonical_family(
    p_request_id UUID,
    p_family TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_family NOT IN ('jobs', 'evidence', 'cost', 'cache', 'audit') THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_READ_FAMILY' USING ERRCODE = '22023';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'jobs', CASE WHEN p_family = 'jobs' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM public.analysis_jobs AS row
            WHERE row.request_id = p_request_id
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'events', CASE WHEN p_family = 'evidence' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM public.analysis_events AS row
            WHERE row.request_id = p_request_id
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'artifacts', CASE WHEN p_family = 'evidence' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM public.analysis_artifacts AS row
            WHERE row.request_id = p_request_id
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'costs', CASE WHEN p_family = 'cost' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.recorded_at, row.id)
            FROM public.analysis_costs AS row
            WHERE row.request_id = p_request_id
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'audits', CASE WHEN p_family = 'audit' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM public.analysis_audit_bundles AS row
            WHERE row.request_id = p_request_id
        ), '[]'::JSONB) ELSE '[]'::JSONB END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_canonical_job(UUID, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_event(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_analysis_canonical_cache(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.record_analysis_canonical_job(UUID, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_event(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_canonical_cache(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) TO service_role;
