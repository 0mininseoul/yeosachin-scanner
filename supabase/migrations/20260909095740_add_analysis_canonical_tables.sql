-- Analysis canonicalization is additive. Existing V2 source families stay
-- authoritative for the observation window and are intentionally untouched.

-- JSONB is a bounded, versioned envelope. Historical defaults are materialized
-- as schemaVersion = 1, while the retry
-- marker is the one deliberately exact, non-versioned operational envelope.
CREATE OR REPLACE FUNCTION public.analysis_canonical_json_object_has_exact_keys(
    p_value JSONB,
    p_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_value IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_value) = 'object'
       AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value)) = pg_catalog.cardinality(p_keys)
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_object_keys(p_value) AS key
           WHERE key <> ALL (p_keys)
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_canonical_json_object_has_exact_keys(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_canonical_json_value_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_entry RECORD;
    v_nested RECORD;
BEGIN
    IF p_value IS NULL THEN
        RETURN FALSE;
    END IF;
    IF pg_catalog.jsonb_typeof(p_value) = 'string'
       AND pg_catalog.char_length(p_value #>> '{}') > 8192 THEN
        RETURN FALSE;
    END IF;
    IF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
        IF pg_catalog.jsonb_array_length(p_value) > 100 THEN
            RETURN FALSE;
        END IF;
        FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_value) LOOP
            IF NOT public.analysis_canonical_json_value_valid(v_entry.value) THEN
                RETURN FALSE;
            END IF;
        END LOOP;
        RETURN TRUE;
    END IF;
    IF pg_catalog.jsonb_typeof(p_value) <> 'object' THEN
        RETURN TRUE;
    END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value)) > 64 THEN
        RETURN FALSE;
    END IF;
    FOR v_entry IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
        IF v_entry.key = 'schemaVersion'
           AND v_entry.value <> '1'::JSONB THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key NOT IN (
            'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
            'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state', 'counts',
            'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'artifactKey', 'kind', 'source',
            'resultHash', 'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'evidence',
            'runId', 'status', 'maxChargeUsd', 'credentialSlot', 'usageUnknown', 'amountKnown',
            'amountConservative', 'sourceHash', 'operationKey', 'provider', 'requestId', 'scope',
            'cacheKeyHash', 'expiresAt', 'singleFlightTokenHash', 'finalized', 'resultStatus',
            'projection', 'lateCost', 'unknownSource', 'cost', 'progress', 'result',
            'id', 'request_id', 'job_id', 'job_key',
            'generation', 'attempt_count', 'dependency_count', 'next_attempt_at', 'lease_expires_at',
            'completion_hash', 'payload', 'retention_class', 'created_at', 'updated_at', 'artifact_key',
            'cache_key_hash', 'single_flight_token_hash', 'version', 'candidate_key', 'ordinal',
            'content_hash', 'idempotency_key', 'recorded_at', 'currency', 'provider_operation', 'stage',
            'scope', 'expires_at', 'key', 'candidateKey', 'signal', 'occurredAt', 'evidenceId', 'list',
            'rank', 'score', 'interactorCount', 'likerCount', 'commentCount', 'targetManifests',
            'targetInteractions', 'family', 'retryKey', 'detectedMutuals', 'publicMutuals',
            'privateMutuals', 'screenedMutuals', 'candidates', 'interactions', 'jobs', 'events',
            'artifacts', 'costs', 'caches', 'audits', 'ok', 'message', 'errorCode', 'details',
            'source', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'frozenAt',
            'successorCount', 'track', 'batch', 'jobKey', 'eventCode', 'copyCode', 'aggregateCount',
            'resultHash', 'targetManifest', 'retention', 'lateCost', 'relationshipAi',
            'interactions', 'finalization', 'stageCode', 'done', 'total', 'completed',
            'lowSeconds', 'highSeconds', 'orderHash', 'providerOperation', 'auditRetention',
            'familyRows'
        ) THEN
            RETURN FALSE;
        END IF;
        IF pg_catalog.lower(v_entry.key) IN (
            pg_catalog.concat('provider', '_', 'token'),
            pg_catalog.concat('access', '_', 'token'),
            pg_catalog.concat('coo', 'kie'),
            pg_catalog.concat('coo', 'kies'),
            'authorization', 'secret', 'raw',
            pg_catalog.concat('raw', '_', 'source'),
            pg_catalog.concat('raw', '_', 'provider', '_', 'payload'),
            'synthetic', 'placeholder',
            pg_catalog.concat('partial', 'evidence'),
            pg_catalog.concat('partial', '_', 'evidence')
        ) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'counts'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals',
               'candidates', 'interactions'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'cost'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'amountKnown', 'amountConservative', 'usageUnknown', 'sourceHash'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'candidate'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'key', 'ordinal', 'rank', 'score', 'state', 'contentHash'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'interaction'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'key', 'candidateKey', 'signal', 'occurredAt', 'evidenceId', 'contentHash'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'order'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'key', 'list', 'ordinal', 'rank'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'tracks'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'relationshipAi', 'interactions', 'finalization'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key IN ('relationshipAi', 'interactions', 'finalization')
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'state', 'stageCode', 'done', 'total'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'progress'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'state', 'completed', 'total'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'result'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'rank', 'score'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'evidence'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'targetManifests', 'targetInteractions'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'targetManifest'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'key', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'resultHash',
               'interactorCount', 'likerCount', 'commentCount', 'retention'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key IN ('targetManifests', 'targetInteractions')
           AND pg_catalog.jsonb_typeof(v_entry.value) <> 'array' THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'targetManifests' THEN
            FOR v_nested IN SELECT value FROM pg_catalog.jsonb_array_elements(v_entry.value) LOOP
                IF NOT public.analysis_canonical_json_object_has_exact_keys(v_nested.value, ARRAY[
                    'key', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'resultHash',
                    'interactorCount', 'likerCount', 'commentCount', 'retention'
                ]::TEXT[]) THEN
                    RETURN FALSE;
                END IF;
            END LOOP;
        END IF;
        IF v_entry.key = 'targetInteractions' THEN
            FOR v_nested IN SELECT value FROM pg_catalog.jsonb_array_elements(v_entry.value) LOOP
                IF NOT public.analysis_canonical_json_object_has_exact_keys(v_nested.value, ARRAY[
                    'key', 'signal', 'occurredAt', 'evidenceId'
                ]::TEXT[]) THEN
                    RETURN FALSE;
                END IF;
            END LOOP;
        END IF;
        IF v_entry.key = 'projection'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'schemaVersion', 'requestId', 'requestStatus', 'ownership', 'state', 'counts',
               'candidate', 'interaction', 'order', 'orderHash', 'contentHash', 'progress', 'result',
               'providerOperation', 'cost', 'retention', 'auditRetention', 'unknownSource', 'evidence',
               'familyRows'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'familyRows'
           AND NOT public.analysis_canonical_json_object_has_exact_keys(v_entry.value, ARRAY[
               'jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'
           ]::TEXT[]) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key IN ('jobs', 'events', 'artifacts', 'costs', 'caches', 'audits') THEN
            IF pg_catalog.jsonb_typeof(v_entry.value) <> 'array' THEN
                RETURN FALSE;
            END IF;
            FOR v_nested IN SELECT value FROM pg_catalog.jsonb_array_elements(v_entry.value) LOOP
                IF NOT public.analysis_canonical_json_object_has_exact_keys(
                    v_nested.value,
                    CASE v_entry.key
                        WHEN 'jobs' THEN ARRAY[
                            'id', 'request_id', 'job_key', 'kind', 'state', 'generation', 'attempt_count',
                            'dependency_count', 'next_attempt_at', 'lease_expires_at', 'completion_hash',
                            'payload', 'retention_class', 'created_at', 'updated_at'
                        ]::TEXT[]
                        WHEN 'events' THEN ARRAY[
                            'id', 'request_id', 'job_id', 'kind', 'state', 'payload', 'content_hash',
                            'retention_class', 'created_at'
                        ]::TEXT[]
                        WHEN 'artifacts' THEN ARRAY[
                            'id', 'request_id', 'job_id', 'kind', 'artifact_key', 'state', 'content_hash',
                            'payload', 'retention_class', 'created_at', 'updated_at'
                        ]::TEXT[]
                        WHEN 'costs' THEN ARRAY[
                            'id', 'request_id', 'provider', 'operation_key', 'stage', 'currency',
                            'amount_known', 'amount_conservative', 'usage_unknown', 'source_hash',
                            'idempotency_key', 'payload', 'retention_class', 'recorded_at'
                        ]::TEXT[]
                        WHEN 'caches' THEN ARRAY[
                            'id', 'request_id', 'scope', 'cache_key_hash', 'state', 'expires_at',
                            'single_flight_token_hash', 'payload', 'created_at', 'updated_at'
                        ]::TEXT[]
                        ELSE ARRAY[
                            'id', 'request_id', 'version', 'kind', 'candidate_key', 'ordinal', 'state',
                            'content_hash', 'idempotency_key', 'retention_class', 'payload', 'created_at'
                        ]::TEXT[]
                    END
                ) THEN
                    RETURN FALSE;
                END IF;
            END LOOP;
        END IF;
        IF NOT public.analysis_canonical_json_value_valid(v_entry.value) THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_canonical_payload_valid(p_payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR pg_catalog.octet_length(p_payload::TEXT) > 32768 THEN
        RETURN FALSE;
    END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_payload)) = 2
       AND p_payload ? 'family'
       AND p_payload ? 'retryKey'
       AND pg_catalog.jsonb_typeof(p_payload -> 'family') = 'string'
       AND pg_catalog.jsonb_typeof(p_payload -> 'retryKey') = 'string' THEN
        RETURN TRUE;
    END IF;
    RETURN p_payload ? 'schemaVersion'
        AND p_payload -> 'schemaVersion' = '1'::JSONB
        AND public.analysis_canonical_json_value_valid(p_payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_canonical_payload_has_only_keys(
    p_payload JSONB,
    p_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_payload IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_payload) = 'object'
       AND p_payload ? 'schemaVersion'
       AND p_payload -> 'schemaVersion' = '1'::JSONB
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_object_keys(p_payload) AS key
           WHERE key <> ALL (p_keys)
       )
       AND public.analysis_canonical_json_value_valid(p_payload);
$$;

REVOKE ALL ON FUNCTION public.analysis_canonical_payload_has_only_keys(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.analysis_canonical_json_value_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_canonical_payload_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

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
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, job_key, generation),
    CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
        'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
        'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state', 'counts'
    ]::TEXT[]))
);

CREATE TABLE public.analysis_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'lifecycle', 'operational')),
    state TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (
        (kind = 'operational' AND state = 'canonical_retry'
            AND payload = pg_catalog.jsonb_build_object(
                'family', payload -> 'family', 'retryKey', payload -> 'retryKey'
            )
            AND payload ? 'family' AND payload ? 'retryKey'
            AND pg_catalog.jsonb_typeof(payload -> 'family') = 'string'
            AND pg_catalog.jsonb_typeof(payload -> 'retryKey') = 'string')
        OR public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
            'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
            'aggregateCount', 'tracks', 'artifactKey', 'kind', 'state', 'source', 'resultHash',
            'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence'
        ]::TEXT[])
    )
);

CREATE TABLE public.analysis_artifacts (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('evidence', 'manifest', 'media_ref', 'replay')),
    artifact_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'retained', 'expired', 'blocked')),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    retention_class TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, artifact_key, content_hash),
    CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
        'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
        'aggregateCount', 'tracks', 'artifactKey', 'kind', 'state', 'source', 'resultHash',
        'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence',
        'inputHash', 'likerSourceHash', 'commentSourceHash', 'interactorCount',
        'likerCount', 'commentCount', 'frozenAt'
    ]::TEXT[]))
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
    -- A provider/source observation can be retried after a lost response.  The
    -- key is durable so reconciliation does not allocate another cost row.
    idempotency_key TEXT,
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (amount_known IS NULL OR amount_known >= 0),
    CHECK (amount_conservative IS NULL OR amount_conservative >= 0),
    CHECK (NOT usage_unknown OR amount_known IS NULL),
    CHECK (amount_conservative IS NULL OR amount_known IS NULL OR amount_conservative >= amount_known),
    CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
        'schemaVersion', 'runId', 'status', 'maxChargeUsd', 'credentialSlot', 'usageUnknown',
        'amountKnown', 'amountConservative', 'sourceHash', 'operationKey', 'provider'
    ]::TEXT[]))
);

CREATE TABLE public.analysis_cache (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    scope TEXT NOT NULL CHECK (scope IN ('ai', 'profile', 'anonymous', 'blite')),
    cache_key_hash TEXT NOT NULL CHECK (cache_key_hash ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    single_flight_token_hash TEXT CHECK (
        single_flight_token_hash IS NULL OR single_flight_token_hash ~ '^[a-f0-9]{64}$'
    ),
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, scope, cache_key_hash),
    CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
        'schemaVersion', 'requestId', 'scope', 'cacheKeyHash', 'state', 'expiresAt',
        'singleFlightTokenHash'
    ]::TEXT[]))
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
    -- Late cost audit rows carry the same durable key as their cost row.  It is
    -- nullable for ordinary audit rows, which keeps the family append-only.
    idempotency_key TEXT,
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, version, kind, content_hash),
    CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
        'schemaVersion', 'finalized', 'requestStatus', 'resultStatus', 'projection', 'lateCost',
        'provider', 'operationKey', 'cost', 'retention', 'unknownSource', 'candidate',
        'interaction', 'order', 'state'
    ]::TEXT[]))
);

CREATE INDEX analysis_jobs_dispatch_idx
    ON public.analysis_jobs(state, next_attempt_at, updated_at);
CREATE INDEX analysis_events_request_created_idx
    ON public.analysis_events(request_id, created_at);
CREATE INDEX analysis_artifacts_request_kind_idx
    ON public.analysis_artifacts(request_id, kind, created_at);
CREATE INDEX analysis_costs_request_recorded_idx
    ON public.analysis_costs(request_id, recorded_at);
CREATE UNIQUE INDEX analysis_costs_request_idempotency_idx
    ON public.analysis_costs(request_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX analysis_cache_expiry_idx
    ON public.analysis_cache(expires_at, state);
CREATE INDEX analysis_cache_request_updated_idx
    ON public.analysis_cache(request_id, updated_at, id);
CREATE INDEX analysis_audit_request_version_idx
    ON public.analysis_audit_bundles(request_id, version, kind);
CREATE UNIQUE INDEX analysis_audit_request_idempotency_idx
    ON public.analysis_audit_bundles(request_id, kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
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
    p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB,
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
    RETURN pg_catalog.jsonb_build_object(
        'id', v_row.id,
        'request_id', v_row.request_id,
        'kind', v_row.kind,
        'state', v_row.state,
        'payload', v_row.payload,
        'content_hash', v_row.content_hash,
        'retention_class', v_row.retention_class,
        'created_at', pg_catalog.to_char(
            v_row.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
    );
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
    p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB,
    p_retention_class TEXT DEFAULT 'permanent',
    p_idempotency_key TEXT DEFAULT NULL
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
    IF p_idempotency_key IS NOT NULL THEN
        SELECT * INTO v_row
        FROM public.analysis_costs
        WHERE request_id = p_request_id
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;
        IF v_row.id IS NOT NULL AND v_row.source_hash <> p_source_hash THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
        END IF;
    END IF;
    INSERT INTO public.analysis_costs(
        request_id, provider, operation_key, stage, currency, amount_known,
        amount_conservative, usage_unknown, source_hash, idempotency_key, payload, retention_class
    ) VALUES (
        p_request_id, p_provider, p_operation_key, p_stage,
        COALESCE(p_currency, 'USD'), p_amount_known, p_amount_conservative,
        p_usage_unknown, p_source_hash, p_idempotency_key, p_payload, p_retention_class
    )
    ON CONFLICT (request_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        WHERE public.analysis_costs.source_hash = EXCLUDED.source_hash
    RETURNING * INTO v_row;
    IF p_idempotency_key IS NOT NULL AND NOT FOUND THEN
        -- A concurrent insert may have won the unique-key race after the
        -- preflight SELECT above. Re-read its committed row and apply the
        -- same source-hash conflict rule instead of silently accepting it.
        SELECT * INTO v_row
        FROM public.analysis_costs
        WHERE request_id = p_request_id
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;
        IF NOT FOUND OR v_row.source_hash IS DISTINCT FROM p_source_hash THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
        END IF;
    END IF;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_analysis_canonical_cache(
    p_request_id UUID,
    p_scope TEXT,
    p_cache_key_hash TEXT,
    p_state TEXT,
    p_expires_at TIMESTAMPTZ,
    p_single_flight_token_hash TEXT,
    p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB
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
        request_id, scope, cache_key_hash, state, expires_at,
        single_flight_token_hash, payload
    ) VALUES (
        p_request_id, p_scope, p_cache_key_hash, p_state, p_expires_at,
        p_single_flight_token_hash, p_payload
    )
    ON CONFLICT (request_id, scope, cache_key_hash) DO UPDATE SET
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
    p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB,
    p_idempotency_key TEXT DEFAULT NULL
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
    -- Serialize every audit writer on the request aggregate. A version is a
    -- bundle-level fence, so a max(version)+1 read must share the same lock as
    -- an ordinary append to prevent a late-cost writer from racing it.
    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
    FOR UPDATE;
    INSERT INTO public.analysis_audit_bundles(
        request_id, version, kind, candidate_key, ordinal, state,
        content_hash, idempotency_key, retention_class, payload
    ) VALUES (
        p_request_id, p_version, p_kind, p_candidate_key, p_ordinal, p_state,
        p_content_hash, p_idempotency_key, p_retention_class, p_payload
    ) RETURNING * INTO v_row;
    RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.append_analysis_canonical_late_cost_audit(
    p_request_id UUID,
    p_provider TEXT,
    p_operation_key TEXT,
    p_stage TEXT,
    p_currency CHAR(3),
    p_amount_known NUMERIC,
    p_amount_conservative NUMERIC,
    p_usage_unknown BOOLEAN,
    p_source_hash TEXT,
    p_idempotency_key TEXT,
    p_cost_payload JSONB,
    p_cost_retention_class TEXT,
    p_audit_content_hash TEXT,
    p_audit_payload JSONB,
    p_audit_retention_class TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_version INTEGER;
    v_cost public.analysis_costs;
    v_audit public.analysis_audit_bundles;
    v_existing_cost public.analysis_costs;
    v_existing_audit public.analysis_audit_bundles;
BEGIN
    IF p_cost_payload IS NULL OR pg_catalog.jsonb_typeof(p_cost_payload) <> 'object'
       OR p_audit_payload IS NULL OR pg_catalog.jsonb_typeof(p_audit_payload) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) < 1
       OR pg_catalog.char_length(p_idempotency_key) > 256 THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
    END IF;
    -- The parent aggregate row exists for every canonical cost/audit row and
    -- provides a stable lock even when this request has no audit rows yet.
    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
    FOR UPDATE;
    -- Reconcile a replay after the client lost the successful response before
    -- allocating a new version.  Both rows are written in this transaction, so
    -- a committed result is always discoverable by its durable key.
    SELECT * INTO v_existing_cost
      FROM public.analysis_costs
     WHERE request_id = p_request_id
       AND idempotency_key = p_idempotency_key
     FOR UPDATE;
    SELECT * INTO v_existing_audit
      FROM public.analysis_audit_bundles
     WHERE request_id = p_request_id
       AND kind = 'bundle'
       AND idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF v_existing_cost.id IS NOT NULL OR v_existing_audit.id IS NOT NULL THEN
        IF v_existing_cost.id IS NOT NULL
           AND v_existing_cost.source_hash <> p_source_hash THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
        END IF;
        IF v_existing_audit.id IS NOT NULL
           AND v_existing_audit.content_hash <> p_audit_content_hash THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
        END IF;
    END IF;
    v_version := CASE
        WHEN v_existing_audit.id IS NOT NULL THEN v_existing_audit.version
        ELSE NULL
    END;
    IF v_version IS NULL THEN
        SELECT COALESCE(pg_catalog.max(version), 0) + 1
          INTO v_version
          FROM public.analysis_audit_bundles
         WHERE request_id = p_request_id;
    END IF;
    IF v_version > 100000 THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_AUDIT_VERSION_EXHAUSTED' USING ERRCODE = '22023';
    END IF;
    IF v_existing_cost.id IS NULL THEN
        INSERT INTO public.analysis_costs(
            request_id, provider, operation_key, stage, currency, amount_known,
            amount_conservative, usage_unknown, source_hash, idempotency_key,
            payload, retention_class
        ) VALUES (
            p_request_id, p_provider, p_operation_key, p_stage,
            COALESCE(p_currency, 'USD'), p_amount_known,
            p_amount_conservative, p_usage_unknown, p_source_hash,
            p_idempotency_key, p_cost_payload, p_cost_retention_class
        ) RETURNING * INTO v_cost;
    ELSE
        v_cost := v_existing_cost;
    END IF;
    IF v_existing_audit.id IS NULL THEN
        INSERT INTO public.analysis_audit_bundles(
            request_id, version, kind, state, content_hash, idempotency_key,
            retention_class, payload
        ) VALUES (
            p_request_id, v_version, 'bundle', 'complete', p_audit_content_hash,
            p_idempotency_key, p_audit_retention_class, p_audit_payload
        ) RETURNING * INTO v_audit;
    ELSE
        v_audit := v_existing_audit;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'version', v_version,
        'cost', pg_catalog.to_jsonb(v_cost),
        'audit', pg_catalog.to_jsonb(v_audit)
    );
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
    RETURN pg_catalog.jsonb_build_object(
        'id', v_row.id,
        'request_id', v_row.request_id,
        'kind', v_row.kind,
        'state', v_row.state,
        'payload', v_row.payload,
        'content_hash', v_row.content_hash,
        'retention_class', v_row.retention_class,
        'created_at', pg_catalog.to_char(
            v_row.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
    );
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
            FROM (
                SELECT source_row.*
                FROM public.analysis_jobs AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'events', CASE WHEN p_family = 'evidence' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_events AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'artifacts', CASE WHEN p_family = 'evidence' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_artifacts AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'costs', CASE WHEN p_family = 'cost' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.recorded_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_costs AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.recorded_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'caches', CASE WHEN p_family = 'cache' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.updated_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_cache AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.updated_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'audits', CASE WHEN p_family = 'audit' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_audit_bundles AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_canonical_job(UUID, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_event(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_analysis_canonical_cache(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_late_cost_audit(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.record_analysis_canonical_job(UUID, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_event(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_canonical_cache(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_late_cost_audit(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) TO service_role;
