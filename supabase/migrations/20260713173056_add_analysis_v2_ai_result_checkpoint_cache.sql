-- Phase E.5: atomic, recoverable Gemini result checkpoints and a small exact-input cache.
-- Successful generation must commit its attempt telemetry and strictly validated JSON result
-- in one transaction. Cross-request reuse is limited to the two deterministic classification
-- stages and is keyed only by a domain-separated SHA-256 identity.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_result_identity(
    p_identity JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_identity) = 'object'
       AND p_identity ?& ARRAY[
            'stage', 'model_name', 'thinking_level', 'media_resolution',
            'prompt_version', 'schema_version', 'input_hash',
            'max_output_tokens', 'media_snapshot_hash', 'cache_scope'
       ]
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_identity) AS identity_key(value)
            WHERE identity_key.value <> ALL(ARRAY[
                'stage', 'model_name', 'thinking_level', 'media_resolution',
                'prompt_version', 'schema_version', 'input_hash',
                'max_output_tokens', 'media_snapshot_hash', 'cache_scope'
            ])
       )
       AND pg_catalog.jsonb_typeof(p_identity->'stage') = 'string'
       AND p_identity->>'stage' IN (
            'genderTriage', 'featureAnalysis', 'highRiskNarrative',
            'privateAccountName', 'partnerSafety'
       )
       AND pg_catalog.jsonb_typeof(p_identity->'model_name') = 'string'
       AND p_identity->>'model_name' ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
       AND (
            p_identity->'thinking_level' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_identity->'thinking_level') = 'string'
                AND p_identity->>'thinking_level' IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND (
            p_identity->'media_resolution' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_identity->'media_resolution') = 'string'
                AND p_identity->>'media_resolution' IN ('LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND pg_catalog.jsonb_typeof(p_identity->'prompt_version') = 'string'
       AND pg_catalog.char_length(p_identity->>'prompt_version') BETWEEN 1 AND 64
       AND p_identity->>'prompt_version' ~ '^[A-Za-z0-9._:-]+$'
       AND pg_catalog.jsonb_typeof(p_identity->'schema_version') = 'number'
       AND p_identity->>'schema_version' ~ '^[1-9][0-9]{0,3}$'
       AND (p_identity->>'schema_version')::INTEGER BETWEEN 1 AND 9999
       AND pg_catalog.jsonb_typeof(p_identity->'max_output_tokens') = 'number'
       AND p_identity->>'max_output_tokens' ~ '^[1-9][0-9]{0,4}$'
       AND (p_identity->>'max_output_tokens')::INTEGER BETWEEN 1 AND 65536
       AND pg_catalog.jsonb_typeof(p_identity->'input_hash') = 'string'
       AND p_identity->>'input_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_identity->'media_snapshot_hash') = 'string'
       AND p_identity->>'media_snapshot_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_identity->'cache_scope') = 'string'
       AND p_identity->>'cache_scope' IN ('request', 'global_ttl')
       AND (
            p_identity->>'cache_scope' = 'request'
            OR p_identity->>'stage' IN ('genderTriage', 'featureAnalysis')
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_result_identity(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_result_cache_key(
    p_identity JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.concat_ws(
                E'\n',
                'analysis-v2-ai-result-cache:v1',
                p_identity->>'stage',
                p_identity->>'model_name',
                pg_catalog.coalesce(p_identity->>'thinking_level', '-'),
                pg_catalog.coalesce(p_identity->>'media_resolution', '-'),
                p_identity->>'prompt_version',
                p_identity->>'schema_version',
                p_identity->>'max_output_tokens',
                p_identity->>'input_hash',
                p_identity->>'media_snapshot_hash'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_result_cache_key(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_result_operation_key(
    p_identity JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT CASE p_identity->>'stage'
        WHEN 'genderTriage' THEN 'gender-triage:'
        WHEN 'featureAnalysis' THEN 'feature-analysis:'
        WHEN 'highRiskNarrative' THEN 'high-risk-narrative:'
        WHEN 'privateAccountName' THEN 'private-account-name:'
        WHEN 'partnerSafety' THEN 'partner-safety:'
    END || public.analysis_v2_ai_result_cache_key(p_identity);
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_result_operation_key(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_result_json(
    p_result JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_result) = 'object'
       AND pg_catalog.octet_length(pg_catalog.convert_to(p_result::TEXT, 'UTF8'))
            BETWEEN 2 AND 262144
       AND (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(p_result)
       ) <= 256;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_result_json(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_result_envelope(
    p_result JSONB,
    p_canonical TEXT,
    p_result_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
BEGIN
    RETURN public.analysis_v2_valid_ai_result_json(p_result)
       AND pg_catalog.octet_length(pg_catalog.convert_to(p_canonical, 'UTF8'))
            BETWEEN 2 AND 262144
       AND p_canonical::JSONB = p_result
       AND p_result_hash ~ '^[0-9a-f]{64}$'
       AND p_result_hash = pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-ai-result-content:v1' || pg_catalog.chr(0) || p_canonical,
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
       );
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_result_envelope(JSONB, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_ai_attempts
    ADD CONSTRAINT analysis_v2_ai_attempt_result_fence_unique
    UNIQUE (request_id, operation_key, attempt, reservation_token);

CREATE TABLE public.analysis_v2_ai_result_checkpoints (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(86) NOT NULL,
    cache_key VARCHAR(64) NOT NULL,
    stage TEXT NOT NULL,
    model_name VARCHAR(100) NOT NULL,
    thinking_level TEXT,
    media_resolution TEXT,
    prompt_version VARCHAR(64) NOT NULL,
    schema_version SMALLINT NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    media_snapshot_hash VARCHAR(64) NOT NULL,
    cache_scope TEXT NOT NULL,
    source TEXT NOT NULL,
    attempt SMALLINT,
    reservation_token UUID,
    result_json JSONB NOT NULL,
    result_canonical_json TEXT NOT NULL,
    result_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, operation_key),
    UNIQUE (reservation_token),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    FOREIGN KEY (request_id, operation_key, attempt, reservation_token)
        REFERENCES public.analysis_v2_ai_attempts(
            request_id, operation_key, attempt, reservation_token
        ) MATCH FULL ON DELETE CASCADE,
    CONSTRAINT analysis_v2_ai_result_checkpoint_job_key_check CHECK (
        pg_catalog.char_length(job_key) BETWEEN 1 AND 160
        AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_operation_key_check CHECK (
        public.analysis_v2_valid_ai_operation_key(operation_key)
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_hash_check CHECK (
        cache_key ~ '^[0-9a-f]{64}$'
        AND input_hash ~ '^[0-9a-f]{64}$'
        AND media_snapshot_hash ~ '^[0-9a-f]{64}$'
        AND result_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_stage_check CHECK (
        stage IN (
            'genderTriage', 'featureAnalysis', 'highRiskNarrative',
            'privateAccountName', 'partnerSafety'
        )
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_model_check CHECK (
        model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_policy_check CHECK (
        (thinking_level IS NULL OR thinking_level IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH'))
        AND (media_resolution IS NULL OR media_resolution IN ('LOW', 'MEDIUM', 'HIGH'))
        AND pg_catalog.char_length(prompt_version) BETWEEN 1 AND 64
        AND prompt_version ~ '^[A-Za-z0-9._:-]+$'
        AND schema_version BETWEEN 1 AND 9999
        AND max_output_tokens BETWEEN 1 AND 65536
        AND cache_scope IN ('request', 'global_ttl')
        AND (cache_scope = 'request' OR stage IN ('genderTriage', 'featureAnalysis'))
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_result_check CHECK (
        public.analysis_v2_valid_ai_result_envelope(
            result_json,
            result_canonical_json,
            result_hash
        )
    ),
    CONSTRAINT analysis_v2_ai_result_checkpoint_source_check CHECK (
        (
            source = 'generated'
            AND attempt BETWEEN 1 AND 4
            AND reservation_token IS NOT NULL
        )
        OR (
            source = 'global_cache'
            AND cache_scope = 'global_ttl'
            AND stage IN ('genderTriage', 'featureAnalysis')
            AND attempt IS NULL
            AND reservation_token IS NULL
        )
    )
);

CREATE INDEX idx_analysis_v2_ai_result_checkpoints_request_job
    ON public.analysis_v2_ai_result_checkpoints(request_id, job_key, stage, operation_key);

COMMENT ON TABLE public.analysis_v2_ai_result_checkpoints IS
    'Service-only request result snapshots. Each generated row is committed atomically with its successful Gemini attempt.';
COMMENT ON COLUMN public.analysis_v2_ai_result_checkpoints.operation_key IS
    'Stage prefix plus the exact policy/input/media cache digest; raw prompts, usernames, URLs, and captions are forbidden.';
COMMENT ON COLUMN public.analysis_v2_ai_result_checkpoints.result_json IS
    'Application-schema-validated JSON copied only after strict Gemini response validation.';

ALTER TABLE public.analysis_v2_ai_result_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_ai_result_checkpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_ai_result_checkpoints
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_ai_global_result_cache (
    cache_key VARCHAR(64) PRIMARY KEY,
    stage TEXT NOT NULL,
    model_name VARCHAR(100) NOT NULL,
    thinking_level TEXT,
    media_resolution TEXT,
    prompt_version VARCHAR(64) NOT NULL,
    schema_version SMALLINT NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    media_snapshot_hash VARCHAR(64) NOT NULL,
    result_json JSONB NOT NULL,
    result_canonical_json TEXT NOT NULL,
    result_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_accessed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    hit_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT analysis_v2_ai_global_cache_stage_check CHECK (
        stage IN ('genderTriage', 'featureAnalysis')
    ),
    CONSTRAINT analysis_v2_ai_global_cache_identity_check CHECK (
        cache_key ~ '^[0-9a-f]{64}$'
        AND model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
        AND (thinking_level IS NULL OR thinking_level IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH'))
        AND (media_resolution IS NULL OR media_resolution IN ('LOW', 'MEDIUM', 'HIGH'))
        AND pg_catalog.char_length(prompt_version) BETWEEN 1 AND 64
        AND prompt_version ~ '^[A-Za-z0-9._:-]+$'
        AND schema_version BETWEEN 1 AND 9999
        AND max_output_tokens BETWEEN 1 AND 65536
        AND input_hash ~ '^[0-9a-f]{64}$'
        AND media_snapshot_hash ~ '^[0-9a-f]{64}$'
        AND result_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_ai_global_cache_result_check CHECK (
        public.analysis_v2_valid_ai_result_envelope(
            result_json,
            result_canonical_json,
            result_hash
        )
    ),
    CONSTRAINT analysis_v2_ai_global_cache_ttl_check CHECK (
        expires_at > created_at
        AND expires_at <= created_at + INTERVAL '6 hours'
        AND last_accessed_at >= created_at
        AND hit_count BETWEEN 0 AND 1000000000
    )
);

CREATE INDEX idx_analysis_v2_ai_global_result_cache_expiry
    ON public.analysis_v2_ai_global_result_cache(expires_at, cache_key);
CREATE INDEX idx_analysis_v2_ai_global_result_cache_lru
    ON public.analysis_v2_ai_global_result_cache(last_accessed_at DESC, created_at DESC, cache_key);

COMMENT ON TABLE public.analysis_v2_ai_global_result_cache IS
    'Service-only exact-input cache, limited to gender triage and feature analysis, six-hour TTL, and 10000 rows.';

ALTER TABLE public.analysis_v2_ai_global_result_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_ai_global_result_cache FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_ai_global_result_cache
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_maintain_ai_global_result_cache(
    p_delete_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_acquired BOOLEAN;
    v_now TIMESTAMP WITH TIME ZONE;
    v_deleted_expired INTEGER := 0;
    v_deleted_overflow INTEGER := 0;
BEGIN
    IF p_delete_limit IS NULL OR p_delete_limit NOT BETWEEN 1 AND 10000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_CACHE_MAINTENANCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_acquired := pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-ai-global-cache-maintenance:v1', 0)
    );
    IF NOT v_acquired THEN
        RETURN pg_catalog.jsonb_build_object(
            'acquired', FALSE,
            'deletedExpired', 0,
            'deletedOverflow', 0
        );
    END IF;

    v_now := pg_catalog.clock_timestamp();
    WITH expired AS (
        SELECT cache.ctid
        FROM public.analysis_v2_ai_global_result_cache AS cache
        WHERE cache.expires_at <= v_now
        ORDER BY cache.expires_at, cache.cache_key
        LIMIT p_delete_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
    USING expired
    WHERE cache.ctid = expired.ctid;
    GET DIAGNOSTICS v_deleted_expired = ROW_COUNT;

    WITH overflow AS (
        SELECT cache.ctid
        FROM public.analysis_v2_ai_global_result_cache AS cache
        ORDER BY
            cache.last_accessed_at DESC,
            cache.created_at DESC,
            cache.cache_key
        OFFSET 10000
        LIMIT p_delete_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
    USING overflow
    WHERE cache.ctid = overflow.ctid;
    GET DIAGNOSTICS v_deleted_overflow = ROW_COUNT;

    RETURN pg_catalog.jsonb_build_object(
        'acquired', TRUE,
        'deletedExpired', v_deleted_expired,
        'deletedOverflow', v_deleted_overflow
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_maintain_ai_global_result_cache(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.maintain_analysis_v2_ai_global_result_cache(
    p_delete_limit INTEGER DEFAULT 2000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN public.analysis_v2_maintain_ai_global_result_cache(p_delete_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.maintain_analysis_v2_ai_global_result_cache(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.maintain_analysis_v2_ai_global_result_cache(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_result_checkpoint_json(
    p_checkpoint public.analysis_v2_ai_result_checkpoints
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_checkpoint.request_id,
        'jobKey', p_checkpoint.job_key,
        'operationKey', p_checkpoint.operation_key,
        'cacheKey', p_checkpoint.cache_key,
        'stage', p_checkpoint.stage,
        'modelName', p_checkpoint.model_name,
        'thinkingLevel', p_checkpoint.thinking_level,
        'mediaResolution', p_checkpoint.media_resolution,
        'promptVersion', p_checkpoint.prompt_version,
        'schemaVersion', p_checkpoint.schema_version,
        'maxOutputTokens', p_checkpoint.max_output_tokens,
        'inputHash', p_checkpoint.input_hash,
        'mediaSnapshotHash', p_checkpoint.media_snapshot_hash,
        'cacheScope', p_checkpoint.cache_scope,
        'source', p_checkpoint.source,
        'attempt', p_checkpoint.attempt,
        'reservationToken', p_checkpoint.reservation_token,
        'result', p_checkpoint.result_json,
        'resultHash', p_checkpoint.result_hash,
        'chargeStatus', CASE
            WHEN p_checkpoint.source = 'global_cache' THEN 'cache_hit'
            WHEN ai_attempt.usage_metadata_status = 'complete' THEN 'generated_complete'
            ELSE 'generated_unknown'
        END,
        'usageMetadataStatus', ai_attempt.usage_metadata_status,
        'usageComplete', ai_attempt.usage_complete,
        'tokenUsage', CASE
            WHEN ai_attempt.usage_metadata_status = 'complete' THEN
                pg_catalog.jsonb_build_object(
                    'promptTokens', ai_attempt.prompt_tokens,
                    'completionTokens', ai_attempt.completion_tokens,
                    'totalTokens', ai_attempt.total_tokens,
                    'thinkingTokens', ai_attempt.thinking_tokens
                )
            ELSE NULL
        END,
        'latencyMs', ai_attempt.latency_ms,
        'estimatedCostUsd', ai_attempt.estimated_cost_usd,
        'finishReason', ai_attempt.finish_reason,
        'createdAt', p_checkpoint.created_at
    )
    FROM (SELECT 1) AS one_row
    LEFT JOIN public.analysis_v2_ai_attempts AS ai_attempt
      ON p_checkpoint.source = 'generated'
     AND ai_attempt.request_id = p_checkpoint.request_id
     AND ai_attempt.operation_key = p_checkpoint.operation_key
     AND ai_attempt.attempt = p_checkpoint.attempt
     AND ai_attempt.reservation_token = p_checkpoint.reservation_token;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_result_checkpoint_json(
    public.analysis_v2_ai_result_checkpoints
) FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the original terminalization implementation as an unexposed primitive. The public
-- compatibility RPC remains available for non-success outcomes only, so success cannot bypass
-- the atomic result checkpoint path added below.
ALTER FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) RENAME TO analysis_v2_terminalize_ai_attempt_internal;

REVOKE ALL ON FUNCTION public.analysis_v2_terminalize_ai_attempt_internal(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.terminalize_analysis_v2_ai_attempt(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_status TEXT,
    p_telemetry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_status = 'success' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_REQUIRED',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_terminalize_ai_attempt_internal(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_operation_key,
        p_attempt,
        p_reservation_token,
        p_status,
        p_telemetry
    );
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.terminalize_analysis_v2_ai_attempt_with_result(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_telemetry JSONB,
    p_result_identity JSONB,
    p_result JSONB,
    p_result_canonical TEXT,
    p_result_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_attempt JSONB;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_cache_key TEXT;
    v_result_hash TEXT;
    v_checkpoint public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_cached public.analysis_v2_ai_global_result_cache%ROWTYPE;
    v_now TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_result_identity IS NULL
       OR p_result IS NULL
       OR p_result_canonical IS NULL
       OR p_result_hash IS NULL
       OR p_telemetry IS NULL
       OR NOT public.analysis_v2_valid_ai_result_identity(p_result_identity)
       OR NOT public.analysis_v2_valid_ai_result_envelope(
            p_result,
            p_result_canonical,
            p_result_hash
       )
       OR p_operation_key IS DISTINCT FROM
            public.analysis_v2_ai_result_operation_key(p_result_identity)
       OR p_telemetry->>'stage' IS DISTINCT FROM p_result_identity->>'stage'
       OR p_telemetry->>'model_name' IS DISTINCT FROM p_result_identity->>'model_name'
       OR NULLIF(p_telemetry->>'thinking_level', '') IS DISTINCT FROM
            NULLIF(p_result_identity->>'thinking_level', '')
       OR NULLIF(p_telemetry->>'media_resolution', '') IS DISTINCT FROM
            NULLIF(p_result_identity->>'media_resolution', '')
       OR p_telemetry->>'prompt_version' IS DISTINCT FROM
            p_result_identity->>'prompt_version'
       OR p_telemetry->>'schema_version' IS DISTINCT FROM
            p_result_identity->>'schema_version'
       OR p_telemetry->>'max_output_tokens' IS DISTINCT FROM
            p_result_identity->>'max_output_tokens'
       OR p_telemetry->>'finish_reason' IS DISTINCT FROM 'STOP' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_cache_key := public.analysis_v2_ai_result_cache_key(p_result_identity);
    v_result_hash := p_result_hash;

    -- The nested SECURITY DEFINER call participates in this transaction. Active-fence
    -- persistence failures roll back terminalization; a lost fence returns a committed,
    -- telemetry-only outcome without mutating a request checkpoint or global cache row.
    v_attempt := public.analysis_v2_terminalize_ai_attempt_internal(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_operation_key,
        p_attempt,
        p_reservation_token,
        'success',
        p_telemetry
    );

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();
    IF v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RETURN pg_catalog.jsonb_build_object(
            'outcome', 'fenced',
            'requestId', p_request_id,
            'operationKey', p_operation_key,
            'attempt', p_attempt,
            'reservationToken', p_reservation_token
        );
    END IF;

    SELECT checkpoint.*
    INTO v_checkpoint
    FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.operation_key = p_operation_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_checkpoint.job_key IS DISTINCT FROM p_job_key
           OR v_checkpoint.cache_key IS DISTINCT FROM v_cache_key
           OR v_checkpoint.stage IS DISTINCT FROM p_result_identity->>'stage'
           OR v_checkpoint.model_name IS DISTINCT FROM p_result_identity->>'model_name'
           OR v_checkpoint.thinking_level IS DISTINCT FROM
                NULLIF(p_result_identity->>'thinking_level', '')
           OR v_checkpoint.media_resolution IS DISTINCT FROM
                NULLIF(p_result_identity->>'media_resolution', '')
           OR v_checkpoint.prompt_version IS DISTINCT FROM
                p_result_identity->>'prompt_version'
           OR v_checkpoint.schema_version IS DISTINCT FROM
                (p_result_identity->>'schema_version')::SMALLINT
           OR v_checkpoint.max_output_tokens IS DISTINCT FROM
                (p_result_identity->>'max_output_tokens')::INTEGER
           OR v_checkpoint.input_hash IS DISTINCT FROM p_result_identity->>'input_hash'
           OR v_checkpoint.media_snapshot_hash IS DISTINCT FROM
                p_result_identity->>'media_snapshot_hash'
           OR v_checkpoint.cache_scope IS DISTINCT FROM p_result_identity->>'cache_scope'
           OR v_checkpoint.source IS DISTINCT FROM 'generated'
           OR v_checkpoint.attempt IS DISTINCT FROM p_attempt
           OR v_checkpoint.reservation_token IS DISTINCT FROM p_reservation_token
           OR v_checkpoint.result_hash IS DISTINCT FROM v_result_hash
           OR v_checkpoint.result_canonical_json IS DISTINCT FROM p_result_canonical THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_RESULT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'outcome', 'checkpointed',
            'checkpoint', public.analysis_v2_ai_result_checkpoint_json(v_checkpoint)
        );
    END IF;

    INSERT INTO public.analysis_v2_ai_result_checkpoints (
        request_id,
        job_key,
        operation_key,
        cache_key,
        stage,
        model_name,
        thinking_level,
        media_resolution,
        prompt_version,
        schema_version,
        max_output_tokens,
        input_hash,
        media_snapshot_hash,
        cache_scope,
        source,
        attempt,
        reservation_token,
        result_json,
        result_canonical_json,
        result_hash,
        created_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_operation_key,
        v_cache_key,
        p_result_identity->>'stage',
        p_result_identity->>'model_name',
        NULLIF(p_result_identity->>'thinking_level', ''),
        NULLIF(p_result_identity->>'media_resolution', ''),
        p_result_identity->>'prompt_version',
        (p_result_identity->>'schema_version')::SMALLINT,
        (p_result_identity->>'max_output_tokens')::INTEGER,
        p_result_identity->>'input_hash',
        p_result_identity->>'media_snapshot_hash',
        p_result_identity->>'cache_scope',
        'generated',
        p_attempt,
        p_reservation_token,
        p_result,
        p_result_canonical,
        v_result_hash,
        v_now
    )
    RETURNING * INTO v_checkpoint;

    IF p_result_identity->>'cache_scope' = 'global_ttl' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'analysis-v2-ai-result-cache-key:' || v_cache_key,
                0
            )
        );
        v_now := pg_catalog.clock_timestamp();

        DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
        WHERE cache.cache_key = v_cache_key
          AND cache.expires_at <= v_now;

        SELECT cache.*
        INTO v_cached
        FROM public.analysis_v2_ai_global_result_cache AS cache
        WHERE cache.cache_key = v_cache_key
        FOR UPDATE;

        IF FOUND THEN
            IF v_cached.stage IS DISTINCT FROM p_result_identity->>'stage'
               OR v_cached.model_name IS DISTINCT FROM p_result_identity->>'model_name'
               OR v_cached.thinking_level IS DISTINCT FROM
                    NULLIF(p_result_identity->>'thinking_level', '')
               OR v_cached.media_resolution IS DISTINCT FROM
                    NULLIF(p_result_identity->>'media_resolution', '')
               OR v_cached.prompt_version IS DISTINCT FROM
                    p_result_identity->>'prompt_version'
               OR v_cached.schema_version IS DISTINCT FROM
                    (p_result_identity->>'schema_version')::SMALLINT
               OR v_cached.max_output_tokens IS DISTINCT FROM
                    (p_result_identity->>'max_output_tokens')::INTEGER
               OR v_cached.input_hash IS DISTINCT FROM p_result_identity->>'input_hash'
               OR v_cached.media_snapshot_hash IS DISTINCT FROM
                    p_result_identity->>'media_snapshot_hash' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_AI_RESULT_CONFLICT',
                    ERRCODE = 'P0001';
            END IF;

            IF NOT public.analysis_v2_valid_ai_result_envelope(
                v_cached.result_json,
                v_cached.result_canonical_json,
                v_cached.result_hash
            ) THEN
                DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
                WHERE cache.cache_key = v_cache_key;
                v_cached.cache_key := NULL;
            END IF;
        END IF;

        IF v_cached.cache_key IS NULL THEN
            INSERT INTO public.analysis_v2_ai_global_result_cache (
                cache_key,
                stage,
                model_name,
                thinking_level,
                media_resolution,
                prompt_version,
                schema_version,
                max_output_tokens,
                input_hash,
                media_snapshot_hash,
                result_json,
                result_canonical_json,
                result_hash,
                created_at,
                expires_at,
                last_accessed_at
            ) VALUES (
                v_cache_key,
                p_result_identity->>'stage',
                p_result_identity->>'model_name',
                NULLIF(p_result_identity->>'thinking_level', ''),
                NULLIF(p_result_identity->>'media_resolution', ''),
                p_result_identity->>'prompt_version',
                (p_result_identity->>'schema_version')::SMALLINT,
                (p_result_identity->>'max_output_tokens')::INTEGER,
                p_result_identity->>'input_hash',
                p_result_identity->>'media_snapshot_hash',
                p_result,
                p_result_canonical,
                v_result_hash,
                v_now,
                v_now + INTERVAL '6 hours',
                v_now
            );
        END IF;

        PERFORM public.analysis_v2_maintain_ai_global_result_cache(2000);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'outcome', 'checkpointed',
        'checkpoint', public.analysis_v2_ai_result_checkpoint_json(v_checkpoint)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_ai_attempt_with_result(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_ai_attempt_with_result(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_result_identity JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_checkpoint public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_cached public.analysis_v2_ai_global_result_cache%ROWTYPE;
    v_cache_key TEXT;
    v_now TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR p_result_identity IS NULL
       OR NOT public.analysis_v2_valid_ai_result_identity(p_result_identity)
       OR p_result_identity->>'cache_scope' <> 'global_ttl'
       OR p_operation_key IS DISTINCT FROM
            public.analysis_v2_ai_result_operation_key(p_result_identity) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_cache_key := public.analysis_v2_ai_result_cache_key(p_result_identity);

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT checkpoint.*
    INTO v_checkpoint
    FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.operation_key = p_operation_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_checkpoint.job_key IS DISTINCT FROM p_job_key
           OR v_checkpoint.cache_key IS DISTINCT FROM v_cache_key
           OR v_checkpoint.stage IS DISTINCT FROM p_result_identity->>'stage'
           OR v_checkpoint.model_name IS DISTINCT FROM p_result_identity->>'model_name'
           OR v_checkpoint.thinking_level IS DISTINCT FROM
                NULLIF(p_result_identity->>'thinking_level', '')
           OR v_checkpoint.media_resolution IS DISTINCT FROM
                NULLIF(p_result_identity->>'media_resolution', '')
           OR v_checkpoint.prompt_version IS DISTINCT FROM
                p_result_identity->>'prompt_version'
           OR v_checkpoint.schema_version IS DISTINCT FROM
                (p_result_identity->>'schema_version')::SMALLINT
           OR v_checkpoint.max_output_tokens IS DISTINCT FROM
                (p_result_identity->>'max_output_tokens')::INTEGER
           OR v_checkpoint.input_hash IS DISTINCT FROM p_result_identity->>'input_hash'
           OR v_checkpoint.media_snapshot_hash IS DISTINCT FROM
                p_result_identity->>'media_snapshot_hash'
           OR v_checkpoint.cache_scope IS DISTINCT FROM 'global_ttl' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_RESULT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_ai_result_checkpoint_json(v_checkpoint);
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'analysis-v2-ai-result-cache-key:' || v_cache_key,
            0
        )
    );
    v_now := pg_catalog.clock_timestamp();

    DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
    WHERE cache.cache_key = v_cache_key
      AND cache.expires_at <= v_now;

    SELECT cache.*
    INTO v_cached
    FROM public.analysis_v2_ai_global_result_cache AS cache
    WHERE cache.cache_key = v_cache_key
      AND cache.expires_at > v_now
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_cached.stage IS DISTINCT FROM p_result_identity->>'stage'
       OR v_cached.model_name IS DISTINCT FROM p_result_identity->>'model_name'
       OR v_cached.thinking_level IS DISTINCT FROM
            NULLIF(p_result_identity->>'thinking_level', '')
       OR v_cached.media_resolution IS DISTINCT FROM
            NULLIF(p_result_identity->>'media_resolution', '')
       OR v_cached.prompt_version IS DISTINCT FROM p_result_identity->>'prompt_version'
       OR v_cached.schema_version IS DISTINCT FROM
            (p_result_identity->>'schema_version')::SMALLINT
       OR v_cached.max_output_tokens IS DISTINCT FROM
            (p_result_identity->>'max_output_tokens')::INTEGER
       OR v_cached.input_hash IS DISTINCT FROM p_result_identity->>'input_hash'
       OR v_cached.media_snapshot_hash IS DISTINCT FROM
            p_result_identity->>'media_snapshot_hash' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF NOT public.analysis_v2_valid_ai_result_envelope(
        v_cached.result_json,
        v_cached.result_canonical_json,
        v_cached.result_hash
    ) THEN
        DELETE FROM public.analysis_v2_ai_global_result_cache AS cache
        WHERE cache.cache_key = v_cache_key;
        RETURN NULL;
    END IF;

    UPDATE public.analysis_v2_ai_global_result_cache AS cache
    SET last_accessed_at = v_now,
        hit_count = CASE
            WHEN cache.hit_count < 1000000000 THEN cache.hit_count + 1
            ELSE cache.hit_count
        END
    WHERE cache.cache_key = v_cache_key;

    INSERT INTO public.analysis_v2_ai_result_checkpoints (
        request_id,
        job_key,
        operation_key,
        cache_key,
        stage,
        model_name,
        thinking_level,
        media_resolution,
        prompt_version,
        schema_version,
        max_output_tokens,
        input_hash,
        media_snapshot_hash,
        cache_scope,
        source,
        attempt,
        reservation_token,
        result_json,
        result_canonical_json,
        result_hash,
        created_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_operation_key,
        v_cache_key,
        p_result_identity->>'stage',
        p_result_identity->>'model_name',
        NULLIF(p_result_identity->>'thinking_level', ''),
        NULLIF(p_result_identity->>'media_resolution', ''),
        p_result_identity->>'prompt_version',
        (p_result_identity->>'schema_version')::SMALLINT,
        (p_result_identity->>'max_output_tokens')::INTEGER,
        p_result_identity->>'input_hash',
        p_result_identity->>'media_snapshot_hash',
        'global_ttl',
        'global_cache',
        NULL,
        NULL,
        v_cached.result_json,
        v_cached.result_canonical_json,
        v_cached.result_hash,
        v_now
    )
    RETURNING * INTO v_checkpoint;

    RETURN public.analysis_v2_ai_result_checkpoint_json(v_checkpoint);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_ai_result_checkpoint(
    p_request_id UUID,
    p_operation_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_checkpoint public.analysis_v2_ai_result_checkpoints%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT checkpoint.*
    INTO v_checkpoint
    FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.operation_key = p_operation_key;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN public.analysis_v2_ai_result_checkpoint_json(v_checkpoint);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_ai_result_checkpoint(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_ai_result_checkpoint(UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.purge_analysis_v2_ai_result_checkpoints(
    p_request_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status IN ('completed', 'failed')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    DELETE FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_analysis_v2_ai_result_checkpoints(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_analysis_v2_ai_result_checkpoints(UUID)
    TO service_role;

COMMENT ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) IS
    'Terminalizes only non-success outcomes. Successful generation must use the atomic result RPC.';
COMMENT ON FUNCTION public.terminalize_analysis_v2_ai_attempt_with_result(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT
) IS
    'Commits successful attempt telemetry, then checkpoints/cache-writes only while the exact request job lease remains live; a lost fence returns a telemetry-only outcome.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit(
    UUID, TEXT, UUID, TEXT, JSONB
) IS
    'Under a live V2 job fence, snapshots an unexpired exact-input classification cache hit into the request.';
COMMENT ON FUNCTION public.load_analysis_v2_ai_result_checkpoint(UUID, TEXT) IS
    'Loads a generated or cached request result with explicit usage and incremental charge status.';
COMMENT ON FUNCTION public.purge_analysis_v2_ai_result_checkpoints(UUID) IS
    'Purges terminal request result snapshots only. The PII-free attempt ledger and global exact-input cache are retained.';
COMMENT ON FUNCTION public.maintain_analysis_v2_ai_global_result_cache(INTEGER) IS
    'Best-effort bounded expired/LRU cache maintenance using a nonblocking maintenance lease and row-level SKIP LOCKED deletion.';
