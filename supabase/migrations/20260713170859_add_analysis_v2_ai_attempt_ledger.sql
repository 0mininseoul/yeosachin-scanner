-- Phase E/F: durable, PII-free Gemini generation attempt ledger.
-- A reservation is committed before a Vertex AI call. Only an explicit 429 may open
-- the next attempt; ambiguous or charged/rejected responses remain terminal so a
-- worker retry cannot silently generate and charge again.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_operation_key(
    p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.char_length(p_operation_key) BETWEEN 78 AND 86
       AND p_operation_key ~ '^(gender-triage|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$';
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_operation_key(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_operation_matches_stage(
    p_operation_key TEXT,
    p_stage TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT CASE p_stage
        WHEN 'genderTriage' THEN p_operation_key LIKE 'gender-triage:%'
        WHEN 'featureAnalysis' THEN p_operation_key LIKE 'feature-analysis:%'
        WHEN 'highRiskNarrative' THEN p_operation_key LIKE 'high-risk-narrative:%'
        WHEN 'privateAccountName' THEN p_operation_key LIKE 'private-account-name:%'
        WHEN 'partnerSafety' THEN p_operation_key LIKE 'partner-safety:%'
        ELSE FALSE
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_operation_matches_stage(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_reservation_metadata(
    p_metadata JSONB,
    p_attempt SMALLINT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_metadata) = 'object'
       AND p_attempt BETWEEN 1 AND 4
       AND p_metadata ?& ARRAY[
            'model_name', 'location', 'stage', 'thinking_level', 'media_count',
            'media_resolution', 'prompt_version', 'schema_version', 'max_output_tokens',
            'retry_count'
       ]
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_metadata) AS metadata_key(value)
            WHERE metadata_key.value <> ALL(ARRAY[
                'model_name', 'location', 'stage', 'thinking_level', 'media_count',
                'media_resolution', 'prompt_version', 'schema_version', 'max_output_tokens',
                'retry_count'
            ])
       )
       AND pg_catalog.jsonb_typeof(p_metadata->'model_name') = 'string'
       AND p_metadata->>'model_name' ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
       AND pg_catalog.jsonb_typeof(p_metadata->'location') = 'string'
       AND p_metadata->>'location' ~ '^[a-z][a-z0-9-]{0,62}$'
       AND pg_catalog.jsonb_typeof(p_metadata->'stage') = 'string'
       AND p_metadata->>'stage' IN (
            'genderTriage', 'featureAnalysis', 'highRiskNarrative', 'privateAccountName',
            'partnerSafety'
       )
       AND (
            p_metadata->'thinking_level' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_metadata->'thinking_level') = 'string'
                AND p_metadata->>'thinking_level' IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND pg_catalog.jsonb_typeof(p_metadata->'media_count') = 'number'
       AND p_metadata->>'media_count' ~ '^(0|[1-9]|10|11)$'
       AND (
            p_metadata->'media_resolution' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_metadata->'media_resolution') = 'string'
                AND p_metadata->>'media_resolution' IN ('LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND pg_catalog.jsonb_typeof(p_metadata->'prompt_version') = 'string'
       AND pg_catalog.char_length(p_metadata->>'prompt_version') BETWEEN 1 AND 64
       AND p_metadata->>'prompt_version' ~ '^[A-Za-z0-9._:-]+$'
       AND pg_catalog.jsonb_typeof(p_metadata->'schema_version') = 'number'
       AND p_metadata->>'schema_version' ~ '^[1-9][0-9]{0,3}$'
       AND (p_metadata->>'schema_version')::INTEGER BETWEEN 1 AND 9999
       AND pg_catalog.jsonb_typeof(p_metadata->'max_output_tokens') = 'number'
       AND p_metadata->>'max_output_tokens' ~ '^[1-9][0-9]{0,4}$'
       AND (p_metadata->>'max_output_tokens')::INTEGER BETWEEN 1 AND 65536
       AND pg_catalog.jsonb_typeof(p_metadata->'retry_count') = 'number'
       AND p_metadata->>'retry_count' ~ '^[0-3]$'
       AND (p_metadata->>'retry_count')::SMALLINT = p_attempt - 1;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_reservation_metadata(JSONB, SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_terminal_telemetry(
    p_telemetry JSONB,
    p_attempt SMALLINT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT public.analysis_v2_valid_ai_reservation_metadata(
            pg_catalog.jsonb_build_object(
                'model_name', p_telemetry->'model_name',
                'location', p_telemetry->'location',
                'stage', p_telemetry->'stage',
                'thinking_level', p_telemetry->'thinking_level',
                'media_count', p_telemetry->'media_count',
                'media_resolution', p_telemetry->'media_resolution',
                'prompt_version', p_telemetry->'prompt_version',
                'schema_version', p_telemetry->'schema_version',
                'max_output_tokens', p_telemetry->'max_output_tokens',
                'retry_count', p_telemetry->'retry_count'
            ),
            p_attempt
       )
       AND p_telemetry ?& ARRAY[
            'usage_metadata_status', 'usage_complete', 'prompt_tokens',
            'completion_tokens', 'total_tokens', 'thinking_tokens', 'latency_ms',
            'estimated_cost_usd', 'finish_reason'
       ]
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_telemetry) AS telemetry_key(value)
            WHERE telemetry_key.value <> ALL(ARRAY[
                'model_name', 'location', 'stage', 'thinking_level', 'media_count',
                'media_resolution', 'prompt_version', 'schema_version', 'retry_count',
                'max_output_tokens',
                'usage_metadata_status', 'usage_complete', 'prompt_tokens',
                'completion_tokens', 'total_tokens', 'thinking_tokens', 'latency_ms',
                'estimated_cost_usd', 'finish_reason'
            ])
       )
       AND pg_catalog.jsonb_typeof(p_telemetry->'usage_metadata_status') = 'string'
       AND p_telemetry->>'usage_metadata_status' IN ('complete', 'missing', 'malformed')
       AND pg_catalog.jsonb_typeof(p_telemetry->'usage_complete') = 'boolean'
       AND pg_catalog.jsonb_typeof(p_telemetry->'latency_ms') = 'number'
       AND p_telemetry->>'latency_ms' ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_telemetry->>'latency_ms')::INTEGER BETWEEN 0 AND 3600000
       AND (
            p_telemetry->'estimated_cost_usd' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_telemetry->'estimated_cost_usd') = 'number'
                AND p_telemetry->>'estimated_cost_usd'
                    ~ '^(0|[1-9][0-9]{0,2})(\.[0-9]{1,12})?$'
                AND (p_telemetry->>'estimated_cost_usd')::NUMERIC
                    BETWEEN 0 AND 999.999999999999
            )
       )
       AND (
            p_telemetry->'finish_reason' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_telemetry->'finish_reason') = 'string'
                AND pg_catalog.char_length(p_telemetry->>'finish_reason') BETWEEN 1 AND 64
                AND p_telemetry->>'finish_reason' ~ '^[A-Za-z0-9_.:-]+$'
            )
       )
       AND (
            (
                p_telemetry->>'usage_metadata_status' = 'complete'
                AND (p_telemetry->>'usage_complete')::BOOLEAN
                AND NOT EXISTS (
                    SELECT 1
                    FROM pg_catalog.unnest(ARRAY[
                        'prompt_tokens', 'completion_tokens', 'total_tokens', 'thinking_tokens'
                    ]) AS token_key(value)
                    WHERE p_telemetry->token_key.value = 'null'::JSONB
                       OR pg_catalog.jsonb_typeof(p_telemetry->token_key.value) <> 'number'
                       OR p_telemetry->>token_key.value !~ '^(0|[1-9][0-9]{0,8})$'
                       OR (p_telemetry->>token_key.value)::NUMERIC > 100000000
                )
                AND (p_telemetry->>'total_tokens')::NUMERIC
                    = (p_telemetry->>'prompt_tokens')::NUMERIC
                    + (p_telemetry->>'completion_tokens')::NUMERIC
                    + (p_telemetry->>'thinking_tokens')::NUMERIC
            )
            OR (
                p_telemetry->>'usage_metadata_status' IN ('missing', 'malformed')
                AND NOT (p_telemetry->>'usage_complete')::BOOLEAN
                AND p_telemetry->'prompt_tokens' = 'null'::JSONB
                AND p_telemetry->'completion_tokens' = 'null'::JSONB
                AND p_telemetry->'total_tokens' = 'null'::JSONB
                AND p_telemetry->'thinking_tokens' = 'null'::JSONB
                AND p_telemetry->'estimated_cost_usd' = 'null'::JSONB
            )
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_terminal_telemetry(JSONB, SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_ai_attempts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    job_claim_token UUID NOT NULL,
    operation_key VARCHAR(86) NOT NULL,
    attempt SMALLINT NOT NULL,
    reservation_token UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    model_name VARCHAR(100) NOT NULL,
    location VARCHAR(63) NOT NULL,
    stage TEXT NOT NULL,
    thinking_level TEXT,
    media_count SMALLINT NOT NULL,
    media_resolution TEXT,
    prompt_version VARCHAR(64) NOT NULL,
    schema_version SMALLINT NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    retry_count SMALLINT NOT NULL,
    usage_metadata_status TEXT,
    usage_complete BOOLEAN,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    thinking_tokens INTEGER,
    latency_ms INTEGER,
    estimated_cost_usd NUMERIC(15, 12),
    finish_reason VARCHAR(64),
    terminal_payload_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    terminalized_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, operation_key, attempt),
    UNIQUE (reservation_token),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_ai_attempt_job_key_check CHECK (
        char_length(job_key) BETWEEN 1 AND 160
        AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_v2_ai_attempt_operation_key_check CHECK (
        public.analysis_v2_valid_ai_operation_key(operation_key)
    ),
    CONSTRAINT analysis_v2_ai_attempt_number_check CHECK (attempt BETWEEN 1 AND 4),
    CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
        status IN ('reserved', 'success', 'rate_limited', 'ambiguous', 'rejected')
    ),
    CONSTRAINT analysis_v2_ai_attempt_model_check CHECK (
        model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    ),
    CONSTRAINT analysis_v2_ai_attempt_location_check CHECK (
        location ~ '^[a-z][a-z0-9-]{0,62}$'
    ),
    CONSTRAINT analysis_v2_ai_attempt_stage_check CHECK (
        stage IN (
            'genderTriage', 'featureAnalysis', 'highRiskNarrative', 'privateAccountName',
            'partnerSafety'
        )
    ),
    CONSTRAINT analysis_v2_ai_attempt_thinking_check CHECK (
        thinking_level IS NULL OR thinking_level IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH')
    ),
    CONSTRAINT analysis_v2_ai_attempt_media_check CHECK (
        media_count BETWEEN 0 AND 11
        AND (media_resolution IS NULL OR media_resolution IN ('LOW', 'MEDIUM', 'HIGH'))
    ),
    CONSTRAINT analysis_v2_ai_attempt_prompt_check CHECK (
        char_length(prompt_version) BETWEEN 1 AND 64
        AND prompt_version ~ '^[A-Za-z0-9._:-]+$'
        AND schema_version BETWEEN 1 AND 9999
        AND max_output_tokens BETWEEN 1 AND 65536
        AND retry_count = attempt - 1
    ),
    CONSTRAINT analysis_v2_ai_attempt_usage_check CHECK (
        (
            usage_metadata_status = 'complete'
            AND usage_complete
            AND prompt_tokens BETWEEN 0 AND 100000000
            AND completion_tokens BETWEEN 0 AND 100000000
            AND total_tokens BETWEEN 0 AND 100000000
            AND thinking_tokens BETWEEN 0 AND 100000000
            AND total_tokens = prompt_tokens + completion_tokens + thinking_tokens
        )
        OR (
            usage_metadata_status IN ('missing', 'malformed')
            AND NOT usage_complete
            AND prompt_tokens IS NULL
            AND completion_tokens IS NULL
            AND total_tokens IS NULL
            AND thinking_tokens IS NULL
            AND estimated_cost_usd IS NULL
        )
        OR (
            usage_metadata_status IS NULL
            AND usage_complete IS NULL
            AND prompt_tokens IS NULL
            AND completion_tokens IS NULL
            AND total_tokens IS NULL
            AND thinking_tokens IS NULL
            AND estimated_cost_usd IS NULL
        )
    ),
    CONSTRAINT analysis_v2_ai_attempt_terminal_shape_check CHECK (
        (
            status = 'reserved'
            AND latency_ms IS NULL
            AND finish_reason IS NULL
            AND terminal_payload_hash IS NULL
            AND terminalized_at IS NULL
        )
        OR (
            status <> 'reserved'
            AND usage_metadata_status IS NOT NULL
            AND usage_complete IS NOT NULL
            AND latency_ms BETWEEN 0 AND 3600000
            AND terminal_payload_hash ~ '^[0-9a-f]{64}$'
            AND terminalized_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_v2_ai_attempt_generation_failure_check CHECK (
        status NOT IN ('rate_limited', 'ambiguous')
        OR (
            usage_metadata_status = 'missing'
            AND NOT usage_complete
            AND prompt_tokens IS NULL
            AND completion_tokens IS NULL
            AND total_tokens IS NULL
            AND thinking_tokens IS NULL
            AND estimated_cost_usd IS NULL
            AND finish_reason IS NULL
        )
    ),
    CONSTRAINT analysis_v2_ai_attempt_cost_check CHECK (
        estimated_cost_usd IS NULL
        OR estimated_cost_usd BETWEEN 0 AND 999.999999999999
    ),
    CONSTRAINT analysis_v2_ai_attempt_time_check CHECK (
        updated_at >= created_at
        AND (terminalized_at IS NULL OR terminalized_at >= created_at)
    )
);

COMMENT ON COLUMN public.analysis_v2_ai_attempts.operation_key IS
    'PII-free stage name plus a SHA-256 digest; usernames, captions, prompts, and evidence must never appear here.';
COMMENT ON TABLE public.analysis_v2_ai_attempts IS
    'Service-only V2 Gemini intent and terminal telemetry ledger. It intentionally stores no prompts, responses, usernames, image URLs, or evidence.';

ALTER TABLE public.analysis_v2_ai_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_ai_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_ai_attempts
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_attempt_json(
    p_attempt public.analysis_v2_ai_attempts
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_attempt.request_id,
        'jobKey', p_attempt.job_key,
        'operationKey', p_attempt.operation_key,
        'attempt', p_attempt.attempt,
        'reservationToken', p_attempt.reservation_token,
        'status', p_attempt.status,
        'modelName', p_attempt.model_name,
        'location', p_attempt.location,
        'stage', p_attempt.stage,
        'thinkingLevel', p_attempt.thinking_level,
        'mediaCount', p_attempt.media_count,
        'mediaResolution', p_attempt.media_resolution,
        'promptVersion', p_attempt.prompt_version,
        'schemaVersion', p_attempt.schema_version,
        'maxOutputTokens', p_attempt.max_output_tokens,
        'retryCount', p_attempt.retry_count,
        'usageMetadataStatus', p_attempt.usage_metadata_status,
        'usageComplete', p_attempt.usage_complete,
        'tokenUsage', CASE
            WHEN p_attempt.usage_metadata_status = 'complete' THEN
                pg_catalog.jsonb_build_object(
                    'promptTokens', p_attempt.prompt_tokens,
                    'completionTokens', p_attempt.completion_tokens,
                    'totalTokens', p_attempt.total_tokens,
                    'thinkingTokens', p_attempt.thinking_tokens
                )
            ELSE NULL
        END,
        'latencyMs', p_attempt.latency_ms,
        'estimatedCostUsd', p_attempt.estimated_cost_usd,
        'finishReason', p_attempt.finish_reason,
        'createdAt', p_attempt.created_at,
        'terminalizedAt', p_attempt.terminalized_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_attempt_json(public.analysis_v2_ai_attempts)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_ai_attempt(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_ai_attempts%ROWTYPE;
    v_previous public.analysis_v2_ai_attempts%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_reservation_token IS NULL
       OR p_operation_key IS NULL
       OR p_attempt IS NULL
       OR p_metadata IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT public.analysis_v2_valid_ai_reservation_metadata(p_metadata, p_attempt)
       OR NOT public.analysis_v2_ai_operation_matches_stage(
            p_operation_key,
            p_metadata->>'stage'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT ai_attempt.*
    INTO v_existing
    FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.request_id = p_request_id
      AND ai_attempt.operation_key = p_operation_key
      AND ai_attempt.attempt = p_attempt
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.job_claim_token IS DISTINCT FROM p_claim_token
           OR v_existing.model_name IS DISTINCT FROM p_metadata->>'model_name'
           OR v_existing.location IS DISTINCT FROM p_metadata->>'location'
           OR v_existing.stage IS DISTINCT FROM p_metadata->>'stage'
           OR v_existing.thinking_level IS DISTINCT FROM NULLIF(p_metadata->>'thinking_level', '')
           OR v_existing.media_count IS DISTINCT FROM (p_metadata->>'media_count')::SMALLINT
           OR v_existing.media_resolution IS DISTINCT FROM NULLIF(p_metadata->>'media_resolution', '')
           OR v_existing.prompt_version IS DISTINCT FROM p_metadata->>'prompt_version'
           OR v_existing.schema_version IS DISTINCT FROM (p_metadata->>'schema_version')::SMALLINT
           OR v_existing.max_output_tokens IS DISTINCT FROM
                (p_metadata->>'max_output_tokens')::INTEGER
           OR v_existing.retry_count IS DISTINCT FROM (p_metadata->>'retry_count')::SMALLINT THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_ai_attempt_json(v_existing)
            || pg_catalog.jsonb_build_object('created', FALSE);
    END IF;

    IF v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_JOB_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF p_attempt > 1 THEN
        SELECT ai_attempt.*
        INTO v_previous
        FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.operation_key = p_operation_key
          AND ai_attempt.attempt = p_attempt - 1
        FOR UPDATE;
        IF NOT FOUND
           OR v_previous.status <> 'rate_limited'
           OR v_previous.job_key IS DISTINCT FROM p_job_key
           OR v_previous.model_name IS DISTINCT FROM p_metadata->>'model_name'
           OR v_previous.location IS DISTINCT FROM p_metadata->>'location'
           OR v_previous.stage IS DISTINCT FROM p_metadata->>'stage'
           OR v_previous.thinking_level IS DISTINCT FROM NULLIF(p_metadata->>'thinking_level', '')
           OR v_previous.media_count IS DISTINCT FROM (p_metadata->>'media_count')::SMALLINT
           OR v_previous.media_resolution IS DISTINCT FROM NULLIF(p_metadata->>'media_resolution', '')
           OR v_previous.prompt_version IS DISTINCT FROM p_metadata->>'prompt_version'
           OR v_previous.schema_version IS DISTINCT FROM (p_metadata->>'schema_version')::SMALLINT
           OR v_previous.max_output_tokens IS DISTINCT FROM
                (p_metadata->>'max_output_tokens')::INTEGER THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_NOT_RETRYABLE',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO public.analysis_v2_ai_attempts (
        request_id,
        job_key,
        job_claim_token,
        operation_key,
        attempt,
        reservation_token,
        model_name,
        location,
        stage,
        thinking_level,
        media_count,
        media_resolution,
        prompt_version,
        schema_version,
        max_output_tokens,
        retry_count
    ) VALUES (
        p_request_id,
        p_job_key,
        p_claim_token,
        p_operation_key,
        p_attempt,
        p_reservation_token,
        p_metadata->>'model_name',
        p_metadata->>'location',
        p_metadata->>'stage',
        NULLIF(p_metadata->>'thinking_level', ''),
        (p_metadata->>'media_count')::SMALLINT,
        NULLIF(p_metadata->>'media_resolution', ''),
        p_metadata->>'prompt_version',
        (p_metadata->>'schema_version')::SMALLINT,
        (p_metadata->>'max_output_tokens')::INTEGER,
        (p_metadata->>'retry_count')::SMALLINT
    )
    RETURNING * INTO v_existing;

    RETURN public.analysis_v2_ai_attempt_json(v_existing)
        || pg_catalog.jsonb_build_object('created', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB
) TO service_role;

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
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_ai_attempts%ROWTYPE;
    v_payload_hash TEXT;
    v_terminalized_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_reservation_token IS NULL
       OR p_operation_key IS NULL
       OR p_attempt IS NULL
       OR p_telemetry IS NULL
       OR p_status IS NULL
       OR p_status NOT IN ('success', 'rate_limited', 'ambiguous', 'rejected')
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT public.analysis_v2_valid_ai_terminal_telemetry(p_telemetry, p_attempt)
       OR NOT public.analysis_v2_ai_operation_matches_stage(
            p_operation_key,
            p_telemetry->>'stage'
       )
       OR (
            p_status IN ('rate_limited', 'ambiguous')
            AND (
                p_telemetry->>'usage_metadata_status' <> 'missing'
                OR (p_telemetry->>'usage_complete')::BOOLEAN
                OR p_telemetry->'finish_reason' <> 'null'::JSONB
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT ai_attempt.*
    INTO v_existing
    FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.request_id = p_request_id
      AND ai_attempt.operation_key = p_operation_key
      AND ai_attempt.attempt = p_attempt
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF v_existing.job_key IS DISTINCT FROM p_job_key
       OR v_existing.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_existing.reservation_token <> p_reservation_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF v_existing.model_name IS DISTINCT FROM p_telemetry->>'model_name'
       OR v_existing.location IS DISTINCT FROM p_telemetry->>'location'
       OR v_existing.stage IS DISTINCT FROM p_telemetry->>'stage'
       OR v_existing.thinking_level IS DISTINCT FROM NULLIF(p_telemetry->>'thinking_level', '')
       OR v_existing.media_count IS DISTINCT FROM (p_telemetry->>'media_count')::SMALLINT
       OR v_existing.media_resolution IS DISTINCT FROM NULLIF(p_telemetry->>'media_resolution', '')
       OR v_existing.prompt_version IS DISTINCT FROM p_telemetry->>'prompt_version'
       OR v_existing.schema_version IS DISTINCT FROM (p_telemetry->>'schema_version')::SMALLINT
       OR v_existing.max_output_tokens IS DISTINCT FROM
            (p_telemetry->>'max_output_tokens')::INTEGER
       OR v_existing.retry_count IS DISTINCT FROM (p_telemetry->>'retry_count')::SMALLINT THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.jsonb_build_object(
                'status', p_status,
                'telemetry', p_telemetry
            )::TEXT,
            'sha256'
        ),
        'hex'
    );
    IF v_existing.status <> 'reserved' THEN
        IF v_existing.status <> p_status
           OR v_existing.terminal_payload_hash <> v_payload_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_ai_attempt_json(v_existing);
    END IF;

    v_terminalized_at := pg_catalog.clock_timestamp();
    UPDATE public.analysis_v2_ai_attempts AS ai_attempt
    SET status = p_status,
        usage_metadata_status = p_telemetry->>'usage_metadata_status',
        usage_complete = (p_telemetry->>'usage_complete')::BOOLEAN,
        prompt_tokens = CASE
            WHEN p_telemetry->'prompt_tokens' = 'null'::JSONB THEN NULL
            ELSE (p_telemetry->>'prompt_tokens')::INTEGER
        END,
        completion_tokens = CASE
            WHEN p_telemetry->'completion_tokens' = 'null'::JSONB THEN NULL
            ELSE (p_telemetry->>'completion_tokens')::INTEGER
        END,
        total_tokens = CASE
            WHEN p_telemetry->'total_tokens' = 'null'::JSONB THEN NULL
            ELSE (p_telemetry->>'total_tokens')::INTEGER
        END,
        thinking_tokens = CASE
            WHEN p_telemetry->'thinking_tokens' = 'null'::JSONB THEN NULL
            ELSE (p_telemetry->>'thinking_tokens')::INTEGER
        END,
        latency_ms = (p_telemetry->>'latency_ms')::INTEGER,
        estimated_cost_usd = CASE
            WHEN p_telemetry->'estimated_cost_usd' = 'null'::JSONB THEN NULL
            ELSE (p_telemetry->>'estimated_cost_usd')::NUMERIC
        END,
        finish_reason = NULLIF(p_telemetry->>'finish_reason', ''),
        terminal_payload_hash = v_payload_hash,
        terminalized_at = v_terminalized_at,
        updated_at = v_terminalized_at
    WHERE ai_attempt.request_id = p_request_id
      AND ai_attempt.operation_key = p_operation_key
      AND ai_attempt.attempt = p_attempt
      AND ai_attempt.reservation_token = p_reservation_token
      AND ai_attempt.status = 'reserved'
    RETURNING * INTO v_existing;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_ai_attempt_json(v_existing);
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_ai_operation(
    p_request_id UUID,
    p_operation_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_attempts JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.coalesce(
        pg_catalog.jsonb_agg(
            public.analysis_v2_ai_attempt_json(ai_attempt)
            ORDER BY ai_attempt.attempt
        ),
        '[]'::JSONB
    )
    INTO v_attempts
    FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.request_id = p_request_id
      AND ai_attempt.operation_key = p_operation_key;

    RETURN v_attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_ai_operation(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_ai_operation(UUID, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.reserve_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB
) IS 'Reserves one immutable Gemini generation intent. Exact metadata replay returns the existing attempt; attempts after the first require a terminal rate_limited predecessor.';
COMMENT ON FUNCTION public.terminalize_analysis_v2_ai_attempt(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, TEXT, JSONB
) IS 'Terminalizes an exact reservation fence with bounded PII-free telemetry; an identical terminal replay is idempotent and every conflict fails closed.';
COMMENT ON FUNCTION public.load_analysis_v2_ai_operation(UUID, TEXT) IS
    'Loads all bounded Gemini attempts for one opaque PII-free V2 operation in attempt order.';
