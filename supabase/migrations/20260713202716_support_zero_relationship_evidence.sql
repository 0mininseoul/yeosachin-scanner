-- Treat an exact preflight relationship count of zero as a first-class proof without
-- reserving or starting a provider run. Existing non-zero checkpoints remain bound to
-- the succeeded Apify run ledger created by the preceding evidence migration.

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_not_applicable_input_hash(
    p_side TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_side IN ('followers', 'following') THEN pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-relationship-not-applicable-v1'
                        || pg_catalog.chr(10)
                        || p_side
                        || pg_catalog.chr(10)
                        || '0',
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        )
        ELSE NULL
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_not_applicable_input_hash(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_relationship_sides
    ADD COLUMN source_status VARCHAR(24) NOT NULL DEFAULT 'collected',
    ALTER COLUMN provider DROP NOT NULL,
    ALTER COLUMN provider_run_id DROP NOT NULL,
    ALTER COLUMN provider_operation_key DROP NOT NULL,
    ALTER COLUMN provider_credential_slot DROP NOT NULL;

ALTER TABLE public.analysis_v2_relationship_sides
    ADD CONSTRAINT analysis_v2_relationship_sides_source_status_check CHECK (
        (
            source_status = 'not_applicable'
            AND declared_count = 0
            AND collected_count = 0
            AND coverage_bps = 10000
            AND input_hash = public.analysis_v2_relationship_not_applicable_input_hash(side)
            AND provider IS NULL
            AND provider_run_id IS NULL
            AND provider_operation_key IS NULL
            AND provider_credential_slot IS NULL
        )
        OR (
            source_status = 'collected'
            AND declared_count > 0
            AND provider = 'apify'
            AND provider_run_id IS NOT NULL
            AND provider_operation_key IS NOT NULL
            AND provider_credential_slot IS NOT NULL
        )
    );

COMMENT ON COLUMN public.analysis_v2_relationship_sides.source_status IS
    'collected requires a succeeded Apify run; not_applicable proves an exact preflight 0/0 side without any provider identity.';

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_side_json(
    p_side public.analysis_v2_relationship_sides
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'side', p_side.side,
        'sourceStatus', p_side.source_status,
        'revision', p_side.revision,
        'declaredCount', p_side.declared_count,
        'collectedCount', p_side.collected_count,
        'coverageBps', p_side.coverage_bps,
        'inputHash', p_side.input_hash,
        'resultHash', p_side.result_hash
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_side_json(
    public.analysis_v2_relationship_sides
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_relationship_side_not_applicable(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_side TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_side public.analysis_v2_relationship_sides%ROWTYPE;
    v_input_hash TEXT;
    v_result_hash TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_key <> 'track:relationships:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_side IS NULL
       OR p_side NOT IN ('followers', 'following') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_input_hash := public.analysis_v2_relationship_not_applicable_input_hash(p_side);
    v_result_hash := public.analysis_v2_relationship_rows_hash(p_side, '[]'::JSONB);

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.status <> 'consumed'
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR (CASE p_side
            WHEN 'followers' THEN v_preflight.target_followers_count
            ELSE v_preflight.target_following_count
       END) IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.analysis_scope_snapshot IS NULL
       OR v_request.analysis_scope_snapshot->'relationshipCapacity'->>p_side IS NULL
       OR (v_request.analysis_scope_snapshot->'relationshipCapacity'->>p_side)::INTEGER < 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.job_key <> 'track:relationships:collect'
       OR v_job.track <> 'relationships'
       OR v_job.kind <> 'collection'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_side.*
    INTO v_side
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = p_side
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND THEN
        IF v_side.source_status IS DISTINCT FROM 'not_applicable'
           OR v_side.provider IS NOT NULL
           OR v_side.provider_run_id IS NOT NULL
           OR v_side.provider_operation_key IS NOT NULL
           OR v_side.provider_credential_slot IS NOT NULL
           OR v_side.declared_count IS DISTINCT FROM 0
           OR v_side.collected_count IS DISTINCT FROM 0
           OR v_side.coverage_bps IS DISTINCT FROM 10000
           OR v_side.input_hash IS DISTINCT FROM v_input_hash
           OR v_side.result_hash IS DISTINCT FROM v_result_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_relationship_sides AS relationship_side
        SET job_claim_token = p_claim_token,
            updated_at = v_now
        WHERE relationship_side.request_id = p_request_id
          AND relationship_side.job_key = p_job_key
          AND relationship_side.side = p_side
        RETURNING relationship_side.* INTO v_side;
        RETURN public.analysis_v2_relationship_side_json(v_side);
    END IF;

    INSERT INTO public.analysis_v2_relationship_sides (
        request_id,
        job_key,
        side,
        job_claim_token,
        source_status,
        provider,
        provider_run_id,
        provider_operation_key,
        provider_credential_slot,
        declared_count,
        collected_count,
        coverage_bps,
        input_hash,
        result_hash,
        completed_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_side,
        p_claim_token,
        'not_applicable',
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        0,
        10000,
        v_input_hash,
        v_result_hash,
        v_now,
        v_now,
        v_now
    )
    RETURNING * INTO v_side;

    RETURN public.analysis_v2_relationship_side_json(v_side);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_relationship_side_not_applicable(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_relationship_side_not_applicable(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.checkpoint_analysis_v2_relationship_side_not_applicable(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Checkpoints an exact preflight-zero relationship side with deterministic empty hashes and no provider run or operation identity.';
