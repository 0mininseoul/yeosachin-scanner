-- Operational-policy-v1 additive compatibility/predeploy contract.
--
-- This migration only provisions the retained execution compatibility surface.
-- Existing tables, validators, RPCs, indexes, triggers, ACLs, and dependent
-- objects remain available for old revisions during the observation window.
-- The later exact contraction is a separate migration authored only after the
-- code deploy, old-revision drain, fresh independent evidence, and an embedded
-- exact manifest have been reviewed.

-- The old jobs/events validators remain authoritative for old writers. These
-- v1 validators are additive and use the retained execution vocabulary that
-- the TypeScript producer and consumer validate, including recursive progress
-- and result objects.
CREATE OR REPLACE FUNCTION public.analysis_execution_json_object_has_exact_keys_v1(
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
       AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value))
           = pg_catalog.cardinality(p_keys)
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_object_keys(p_value) AS key
           WHERE key <> ALL (p_keys)
       );
$$;

CREATE OR REPLACE FUNCTION public.analysis_execution_json_value_valid_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_entry RECORD;
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
            IF NOT public.analysis_execution_json_value_valid_v1(v_entry.value) THEN
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
        IF v_entry.key = 'schemaVersion' AND v_entry.value <> '1'::JSONB THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key NOT IN (
            'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
            'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state',
            'counts', 'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'kind', 'progress',
            'result', 'relationshipAi', 'interactions', 'finalization', 'stageCode', 'done',
            'total', 'completed', 'lowSeconds', 'highSeconds', 'retryKey', 'family', 'rank',
            'score'
        ) THEN
            RETURN FALSE;
        END IF;
        IF pg_catalog.lower(v_entry.key) IN (
            'provider_token', 'access_token', 'cookie', 'cookies', 'authorization', 'secret',
            'raw', 'raw_source', 'raw_provider_payload', 'synthetic', 'placeholder',
            'partial_evidence', 'targetusername', 'target_username'
        ) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'progress'
           AND NOT public.analysis_execution_json_object_has_exact_keys_v1(
               v_entry.value, ARRAY['state', 'completed', 'total']::TEXT[]
           ) THEN
            RETURN FALSE;
        END IF;
        IF v_entry.key = 'result'
           AND NOT public.analysis_execution_json_object_has_exact_keys_v1(
               v_entry.value, ARRAY['rank', 'score']::TEXT[]
           ) THEN
            RETURN FALSE;
        END IF;
        IF NOT public.analysis_execution_json_value_valid_v1(v_entry.value) THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_execution_payload_valid_v1(p_payload JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_payload IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_payload) = 'object'
       AND pg_catalog.octet_length(p_payload::TEXT) <= 32768
       AND (
           (
               (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_payload)) = 2
               AND p_payload ? 'family'
               AND p_payload ? 'retryKey'
               AND p_payload -> 'family' IN ('"jobs"'::JSONB, '"events"'::JSONB)
               AND pg_catalog.jsonb_typeof(p_payload -> 'retryKey') = 'string'
           )
           OR (
               p_payload ? 'schemaVersion'
               AND p_payload -> 'schemaVersion' = '1'::JSONB
               AND public.analysis_execution_json_value_valid_v1(p_payload)
           )
       );
$$;

CREATE OR REPLACE FUNCTION public.analysis_execution_payload_has_only_keys_v1(
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
       AND public.analysis_execution_payload_valid_v1(p_payload);
$$;

REVOKE ALL ON FUNCTION public.analysis_execution_json_object_has_exact_keys_v1(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_execution_json_value_valid_v1(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_execution_payload_valid_v1(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_execution_payload_has_only_keys_v1(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

-- New execution RPCs read and write only the retained jobs/events pair. They
-- do not replace the old RPCs, so old revisions can drain safely.
CREATE OR REPLACE FUNCTION public.enqueue_analysis_execution_retry_v1(
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
        extensions.digest(pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'), 'hex'
    );
    v_payload JSONB := pg_catalog.jsonb_build_object(
        'family', p_family,
        'retryKey', v_key
    );
    v_row public.analysis_events;
BEGIN
    IF p_request_id IS NULL OR p_family NOT IN ('jobs', 'events') THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_RETRY_FAMILY' USING ERRCODE = '22023';
    END IF;
    IF NOT public.analysis_execution_payload_valid_v1(v_payload) THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_RETRY_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_events(
        request_id, kind, state, payload, content_hash, retention_class
    ) VALUES (
        p_request_id, 'operational', 'canonical_retry', v_payload, v_hash, 'standard'
    )
    ON CONFLICT (request_id, state, content_hash)
        WHERE kind = 'operational' AND state = 'canonical_retry'
    DO NOTHING
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
        SELECT source_row.* INTO v_row
        FROM public.analysis_events AS source_row
        WHERE source_row.request_id = p_request_id
          AND source_row.kind = 'operational'
          AND source_row.state = 'canonical_retry'
          AND source_row.content_hash = v_hash;
    END IF;
    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_RETRY_NOT_PERSISTED' USING ERRCODE = '55000';
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

CREATE OR REPLACE FUNCTION public.load_analysis_execution_family_v1(
    p_request_id UUID,
    p_family TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL OR p_family NOT IN ('jobs', 'events') THEN
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
        'events', CASE WHEN p_family = 'events' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.*
                FROM public.analysis_events AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id
                LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_analysis_execution_retry_v1(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_analysis_execution_retry_v1(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_execution_family_v1(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_execution_family_v1(UUID, TEXT) TO service_role;

-- No schema contraction or caller-controlled session evidence is performed in
-- this predeploy migration. The exact contraction package is intentionally
-- deferred until its post-deploy evidence and fixed manifest exist.
