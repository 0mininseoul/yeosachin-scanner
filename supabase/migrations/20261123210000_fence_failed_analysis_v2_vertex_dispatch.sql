BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The cleanup-intent writers take FOR UPDATE on the request before inserting
-- their intent. KEY SHARE serializes admission with that boundary, without
-- making sibling attempts or non-key progress updates exclusive.
CREATE FUNCTION public.analysis_v2_vertex_request_admission_open(p_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM 1 FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
      AND request.status IN ('pending', 'processing')
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    RETURN NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_vertex_request_admission_open(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.authorize_analysis_v2_vertex_dispatch_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
AS $$
DECLARE
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF p_request_id IS NULL OR p_claim_token IS NULL
       OR p_job_key IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_input_hash IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RETURN FALSE;
    END IF;
    IF NOT public.analysis_v2_vertex_request_admission_open(p_request_id) THEN
        RETURN FALSE;
    END IF;

    SELECT job.lease_expires_at INTO v_expires_at
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
      AND job.status = 'processing' AND job.lease_token = p_claim_token
      AND job.input_hash = p_job_input_hash
    FOR SHARE;
    RETURN FOUND AND v_expires_at IS NOT NULL
        AND v_expires_at > pg_catalog.clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_analysis_v2_vertex_dispatch_v1(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_analysis_v2_vertex_dispatch_v1(UUID, TEXT, UUID, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.authorize_analysis_v2_vertex_dispatch_v1(UUID, TEXT, UUID, TEXT)
IS 'Last Vertex wire admission for a fenced V2 worker. A committed pending cleanup intent rejects new authorization; previously authorized requests may still settle.';

DO $migration$
DECLARE
    v_ai_reserve CONSTANT REGPROCEDURE :=
        'public.reserve_analysis_v2_ai_attempt(uuid,text,uuid,text,smallint,uuid,jsonb)';
    v_dev_reserve CONSTANT REGPROCEDURE := pg_catalog.to_regprocedure(
        'dev_live_budget.reserve(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer,uuid,integer)'
    );
    v_ai_anchor CONSTANT TEXT := E'    SELECT job.*\n    INTO v_job\n';
    v_ai_guard CONSTANT TEXT := $guard$    -- The existing shared request lock fences this read against intent creation.
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED', ERRCODE = 'P0001';
    END IF;

$guard$;
    v_dev_declare CONSTANT TEXT := '    grant_plan text;';
    v_dev_anchor CONSTANT TEXT := $anchor$    IF grant_plan = 'standard' THEN
        -- Standard grants and their owner binding are issued atomically.$anchor$;
    v_dev_guard CONSTANT TEXT := $guard$    -- Resolve the current owner-backed grant through its indexed preflight key.
    -- Before consumption there is no formal request, so B-lite/fresh admission stays unchanged.
    -- Acquire the request fence before touching any approval or reservation row.
    IF p_provider = 'vertex' AND pg_catalog.to_regprocedure(
        'public.analysis_v2_vertex_request_admission_open(uuid)'
    ) IS NOT NULL THEN
        SELECT preflight.consumed_request_id INTO v_vertex_request_id
        FROM dev_live_budget.owner_starts AS owner_start
        JOIN public.analysis_preflights AS preflight
          ON preflight.user_id = owner_start.user_id
         AND preflight.idempotency_key = CASE grant_plan
               WHEN 'standard' THEN 'dev-live:owner:standard:'
               ELSE 'dev-live:owner:'
             END || p_grant_id::TEXT
        WHERE owner_start.grant_id = p_grant_id;
        IF v_vertex_request_id IS NOT NULL
           AND NOT public.analysis_v2_vertex_request_admission_open(v_vertex_request_id) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED', ERRCODE = 'P0001';
        END IF;
    END IF;
$guard$;
    v_definition TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(v_ai_reserve);
    IF pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_ai_anchor, ''))
            <> pg_catalog.length(v_ai_anchor)
       OR pg_catalog.strpos(v_definition, 'FOR SHARE;') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_VERTEX_ATTEMPT_FENCE_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_ai_anchor, v_ai_guard || v_ai_anchor);

    -- Production does not install the private Dev approval schema.
    IF v_dev_reserve IS NOT NULL THEN
        v_definition := pg_catalog.pg_get_functiondef(v_dev_reserve);
        IF pg_catalog.strpos(v_definition, v_dev_guard) > 0 THEN
            RETURN;
        END IF;
        IF pg_catalog.strpos(v_definition, v_dev_declare) = 0
           OR pg_catalog.strpos(v_definition, v_dev_anchor) = 0 THEN
            RAISE EXCEPTION 'DEV_LIVE_VERTEX_ATTEMPT_FENCE_DRIFT';
        END IF;
        v_definition := pg_catalog.replace(
            v_definition, v_dev_declare, v_dev_declare || E'\n    v_vertex_request_id UUID;'
        );
        EXECUTE pg_catalog.replace(v_definition, v_dev_anchor, v_dev_guard || v_dev_anchor);
    END IF;
END;
$migration$;

COMMIT;
