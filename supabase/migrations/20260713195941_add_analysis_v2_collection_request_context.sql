-- Phase F collection jobs read one immutable request/preflight snapshot only while
-- holding the exact live job claim. The result is bounded and never client-readable.

CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_request_context(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_detailed_limit INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

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
    IF v_preflight.id IS NULL
       OR v_preflight.status <> 'consumed'
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM
            pg_catalog.lower(v_request.target_instagram_id)
       OR v_preflight.excluded_instagram_id IS DISTINCT FROM
            v_request.excluded_instagram_id
       OR v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.analysis_scope_snapshot IS NULL
       OR v_job.request_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_detailed_limit := (
        v_request.analysis_scope_snapshot->>'detailedMutualLimit'
    )::INTEGER;
    IF v_detailed_limit NOT IN (300, 600, 900)
       OR v_preflight.target_followers_count > (
            v_request.analysis_scope_snapshot->'relationshipCapacity'->>'followers'
       )::INTEGER
       OR v_preflight.target_following_count > (
            v_request.analysis_scope_snapshot->'relationshipCapacity'->>'following'
       )::INTEGER THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'targetUsername', pg_catalog.lower(v_request.target_instagram_id),
        'excludedUsername', v_request.excluded_instagram_id,
        'planId', v_request.selected_plan_id_snapshot,
        'followersDeclaredCount', v_preflight.target_followers_count,
        'followingDeclaredCount', v_preflight.target_following_count,
        'detailedMutualLimit', v_detailed_limit
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_request_context(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_request_context(
    UUID, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_collection_request_context(
    UUID, TEXT, UUID, TEXT
) IS 'Returns the immutable V2 target, exclusion, selected plan, and exact preflight relationship counts only for the exact live collection job claim.';
