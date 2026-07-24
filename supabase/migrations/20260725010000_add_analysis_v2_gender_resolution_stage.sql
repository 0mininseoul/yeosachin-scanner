-- MIGRATION_PREDECESSOR=20260724230000
-- Forward-only resolver support. Required migration-history predicate:
-- version = '20260724230000'
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260724230000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

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
       AND p_operation_key ~ '^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$';
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
        WHEN 'genderResolution' THEN p_operation_key LIKE 'gender-resolution:%'
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
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
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
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
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
       AND p_identity->>'cache_scope' = 'request';
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_result_identity(JSONB)
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
        WHEN 'genderResolution' THEN 'gender-resolution:'
        WHEN 'featureAnalysis' THEN 'feature-analysis:'
        WHEN 'highRiskNarrative' THEN 'high-risk-narrative:'
        WHEN 'privateAccountName' THEN 'private-account-name:'
        WHEN 'partnerSafety' THEN 'partner-safety:'
    END || public.analysis_v2_ai_result_cache_key(p_identity);
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_result_operation_key(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_ai_attempts
    DROP CONSTRAINT analysis_v2_ai_attempt_stage_check,
    DROP CONSTRAINT analysis_v2_ai_attempt_status_check;
ALTER TABLE public.analysis_v2_ai_attempts
    ADD CONSTRAINT analysis_v2_ai_attempt_stage_check CHECK (
        stage IN (
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
        )
    ),
    ADD CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
        status IN (
            'reserved', 'success', 'rate_limited', 'ambiguous', 'rejected',
            'response_rejected', 'cutoff'
        )
    );

ALTER TABLE public.analysis_v2_ai_result_checkpoints
    DROP CONSTRAINT analysis_v2_ai_result_checkpoint_stage_check;
ALTER TABLE public.analysis_v2_ai_result_checkpoints
    ADD CONSTRAINT analysis_v2_ai_result_checkpoint_stage_check CHECK (
        stage IN (
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
        )
    );

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT :=
        'p_status NOT IN (''success'', ''rate_limited'', ''ambiguous'', ''rejected'', ''response_rejected'')';
    v_new TEXT :=
        'p_status NOT IN (''success'', ''rate_limited'', ''ambiguous'', ''rejected'', ''response_rejected'', ''cutoff'')';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_ATTEMPT_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

ALTER TABLE public.analysis_v2_gemini_leases
    -- The predecessor table retains its physical shared-pool guard:
    -- CHECK (slot BETWEEN 1 AND 8)
    ADD COLUMN operation_key VARCHAR(86),
    ADD COLUMN stage TEXT,
    ADD CONSTRAINT analysis_v2_gemini_leases_operation_key_check CHECK (
        operation_key IS NULL
        OR public.analysis_v2_valid_ai_operation_key(operation_key)
    ),
    ADD CONSTRAINT analysis_v2_gemini_leases_stage_check CHECK (
        stage IS NULL
        OR stage IN (
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
        )
    ),
    ADD CONSTRAINT analysis_v2_gemini_leases_operation_identity_check CHECK (
        (operation_key IS NULL AND stage IS NULL)
        OR (
            operation_key IS NOT NULL
            AND stage IS NOT NULL
            AND public.analysis_v2_ai_operation_matches_stage(operation_key, stage)
        )
    );

CREATE FUNCTION public.acquire_analysis_v2_gemini_lease_v2(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_stage TEXT,
    p_attempt INTEGER,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 240
)
RETURNS TABLE(
    outcome TEXT,
    slot SMALLINT,
    lease_claim_token UUID,
    fence BIGINT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
    v_resolver_count INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 4
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 225 AND 300
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR p_stage NOT IN (
            'genderTriage', 'genderResolution', 'featureAnalysis',
            'highRiskNarrative', 'privateAccountName', 'partnerSafety'
       )
       OR NOT public.analysis_v2_ai_operation_matches_stage(p_operation_key, p_stage) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );

    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'quarantined',
        quarantined_at = v_now,
        updated_at = v_now
    WHERE lease.state = 'leased'
      AND lease.expires_at <= v_now;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.request_id = p_request_id
      AND lease.job_key = p_job_key
      AND lease.operation_key = p_operation_key
      AND lease.attempt = p_attempt
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_lease.state = 'leased'
           AND v_lease.lease_claim_token = p_claim_token
           AND v_lease.expires_at > v_now THEN
            RETURN QUERY SELECT
                'acquired'::TEXT,
                v_lease.slot,
                v_lease.lease_claim_token,
                v_lease.fence,
                v_lease.expires_at;
            RETURN;
        END IF;
        IF v_lease.state = 'leased' THEN
            UPDATE public.analysis_v2_gemini_leases AS lease
            SET state = 'quarantined',
                quarantined_at = v_now,
                updated_at = v_now
            WHERE lease.slot = v_lease.slot
            RETURNING lease.* INTO v_lease;
        END IF;
        RETURN QUERY SELECT
            'quarantine_active'::TEXT,
            v_lease.slot,
            NULL::UUID,
            v_lease.fence,
            v_lease.expires_at;
        RETURN;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_resolver_count
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.state IN ('leased', 'quarantined')
      AND lease.stage = 'genderResolution';
    IF p_stage = 'genderResolution' AND v_resolver_count >= 2 THEN
        RETURN QUERY SELECT
            'resolver_capacity_pending'::TEXT,
            NULL::SMALLINT,
            NULL::UUID,
            NULL::BIGINT,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.state = 'available'
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            'capacity_pending'::TEXT,
            NULL::SMALLINT,
            NULL::UUID,
            NULL::BIGINT,
            NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'leased',
        fence = lease.fence + 1,
        request_id = p_request_id,
        job_key = p_job_key,
        operation_key = p_operation_key,
        stage = p_stage,
        attempt = p_attempt,
        lease_claim_token = p_claim_token,
        acquired_at = v_now,
        expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
        quarantined_at = NULL,
        updated_at = v_now
    WHERE lease.slot = v_lease.slot
      AND lease.state = 'available'
    RETURNING lease.* INTO v_lease;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_AMBIGUOUS',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        'acquired'::TEXT,
        v_lease.slot,
        v_lease.lease_claim_token,
        v_lease.fence,
        v_lease.expires_at;
END;
$$;

CREATE FUNCTION public.renew_analysis_v2_gemini_lease_v2(
    p_slot INTEGER,
    p_claim_token UUID,
    p_fence BIGINT,
    p_operation_key TEXT,
    p_lease_seconds INTEGER DEFAULT 240
)
RETURNS TABLE(
    renewed BOOLEAN,
    lease_state TEXT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    IF p_slot IS NULL OR p_slot NOT BETWEEN 1 AND 8
       OR p_claim_token IS NULL
       OR p_fence IS NULL OR p_fence < 1
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 225 AND 300 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.slot = p_slot
    FOR UPDATE;
    IF v_lease.state = 'leased'
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence
       AND v_lease.operation_key = p_operation_key
       AND v_lease.expires_at > v_now THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
        RETURN QUERY SELECT TRUE, v_lease.state::TEXT, v_lease.expires_at;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v_lease.state::TEXT, v_lease.expires_at;
END;
$$;

CREATE FUNCTION public.release_analysis_v2_gemini_lease_v2(
    p_slot INTEGER,
    p_claim_token UUID,
    p_fence BIGINT,
    p_operation_key TEXT
)
RETURNS TABLE(released BOOLEAN, lease_state TEXT, fence BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.slot = p_slot
    FOR UPDATE;
    IF v_lease.state IN ('leased', 'quarantined')
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence
       AND v_lease.operation_key = p_operation_key THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'available',
            request_id = NULL,
            job_key = NULL,
            operation_key = NULL,
            stage = NULL,
            attempt = NULL,
            lease_claim_token = NULL,
            acquired_at = NULL,
            expires_at = NULL,
            quarantined_at = NULL,
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
        RETURN QUERY SELECT TRUE, v_lease.state::TEXT, v_lease.fence;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v_lease.state::TEXT, v_lease.fence;
END;
$$;

CREATE FUNCTION public.cutoff_analysis_v2_gemini_lease_v2(
    p_slot INTEGER,
    p_claim_token UUID,
    p_fence BIGINT,
    p_operation_key TEXT
)
RETURNS TABLE(
    cutoff BOOLEAN,
    lease_state TEXT,
    fence BIGINT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease public.analysis_v2_gemini_leases%ROWTYPE;
BEGIN
    SELECT lease.* INTO v_lease
    FROM public.analysis_v2_gemini_leases AS lease
    WHERE lease.slot = p_slot
    FOR UPDATE;
    IF v_lease.state = 'leased'
       AND v_lease.stage = 'genderResolution'
       AND v_lease.lease_claim_token = p_claim_token
       AND v_lease.fence = p_fence
       AND v_lease.operation_key = p_operation_key THEN
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'quarantined',
            quarantined_at = v_now,
            updated_at = v_now
        WHERE lease.slot = p_slot
        RETURNING lease.* INTO v_lease;
        RETURN QUERY SELECT
            TRUE, v_lease.state::TEXT, v_lease.fence, v_lease.expires_at;
        RETURN;
    END IF;
    RETURN QUERY SELECT
        FALSE, v_lease.state::TEXT, v_lease.fence, v_lease.expires_at;
END;
$$;

CREATE FUNCTION public.reap_analysis_v2_gemini_cutoff_leases_v2(
    p_limit INTEGER DEFAULT 8
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_reaped INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );
    WITH expired AS (
        SELECT lease.slot
        FROM public.analysis_v2_gemini_leases AS lease
        WHERE lease.state = 'quarantined'
          AND lease.stage = 'genderResolution'
          AND lease.expires_at <= v_now
        ORDER BY lease.slot
        LIMIT p_limit
        FOR UPDATE
    )
    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'available',
        request_id = NULL,
        job_key = NULL,
        operation_key = NULL,
        stage = NULL,
        attempt = NULL,
        lease_claim_token = NULL,
        acquired_at = NULL,
        expires_at = NULL,
        quarantined_at = NULL,
        updated_at = v_now
    FROM expired
    WHERE lease.slot = expired.slot;
    GET DIAGNOSTICS v_reaped = ROW_COUNT;
    RETURN v_reaped;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_analysis_v2_gemini_lease_v2(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.renew_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cutoff_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reap_analysis_v2_gemini_cutoff_leases_v2(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.acquire_analysis_v2_gemini_lease_v2(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.cutoff_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_analysis_v2_gemini_cutoff_leases_v2(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.acquire_analysis_v2_gemini_lease_v2(
    UUID, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER
) IS 'Operation-aware admission: shared Gemini limit 8 and non-queue gender resolver limit 2.';
COMMENT ON FUNCTION public.cutoff_analysis_v2_gemini_lease_v2(
    INTEGER, UUID, BIGINT, TEXT
) IS 'Fences a resolver cutoff in quarantine until explicit SDK completion or TTL reaping.';
