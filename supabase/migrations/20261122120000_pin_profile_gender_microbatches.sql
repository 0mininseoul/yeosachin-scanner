-- The plan contains only content-addressed operation and account IDs. It is immutable for
-- the lifetime of the existing profile-ai job, including after a handler is redelivered.
CREATE TABLE public.analysis_v2_profile_gender_plans (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    groups JSONB NOT NULL,
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key) REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE
);
ALTER TABLE public.analysis_v2_profile_gender_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_gender_plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_v2_profile_gender_plans FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.pin_analysis_v2_profile_gender_plan(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_input_hash TEXT, p_groups JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_groups JSONB;
    v_history JSONB;
    v_member_count INTEGER;
    v_distinct_count INTEGER;
    v_status TEXT;
    v_pipeline TEXT;
    v_plan TEXT;
    v_snapshot JSONB;
BEGIN
    IF p_claim_token IS NULL OR p_job_key IS NULL OR p_job_key !~ '^track:profile-ai:batch:(0|[1-9][0-9]*)$'
       OR p_input_hash IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
    END IF;
    -- The scheduler acquires the same two row locks in this order. An old worker that
    -- already claimed its operation is part of the history below before a plan is pinned.
    SELECT r.status, r.pipeline_version, r.selected_plan_id_snapshot, r.policy_versions_snapshot
      INTO v_status, v_pipeline, v_plan, v_snapshot FROM public.analysis_requests r
     WHERE r.id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_status NOT IN ('pending','processing') THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH';
    END IF;
    IF v_pipeline IS DISTINCT FROM 'v2' OR v_plan IS DISTINCT FROM 'standard'
       OR v_snapshot IS NULL OR v_snapshot NOT IN (
           '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.11","scheduler":"ai-scheduler-v1"}'::JSONB,
           '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.11","scheduler":"ai-scheduler-v1"}'::JSONB
       ) THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_POLICY_MISMATCH'; END IF;
    PERFORM 1 FROM public.analysis_pipeline_jobs j
     WHERE j.request_id = p_request_id AND j.job_key = p_job_key AND j.track = 'profile_ai'
       AND j.kind = 'ai' AND j.job_key = 'track:profile-ai:batch:' || j.batch::TEXT
       AND j.status = 'processing' AND j.input_hash = p_input_hash AND j.lease_token = p_claim_token
       AND j.lease_expires_at > pg_catalog.clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH'; END IF;
    SELECT p.groups INTO v_groups FROM public.analysis_v2_profile_gender_plans p
     WHERE p.request_id = p_request_id AND p.job_key = p_job_key AND p.input_hash = p_input_hash;
    IF FOUND THEN RETURN pg_catalog.jsonb_build_object('kind','pinned','groups',v_groups); END IF;

    IF p_groups IS NULL OR pg_catalog.jsonb_typeof(p_groups) <> 'array' OR pg_catalog.jsonb_array_length(p_groups) > 30 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_groups) g
         WHERE pg_catalog.jsonb_typeof(g) <> 'object' OR NOT (g ?& ARRAY['operationKey','accountIds'])
            OR g - 'operationKey' - 'accountIds' <> '{}'::JSONB
            OR pg_catalog.jsonb_typeof(g->'operationKey') <> 'string'
            OR g->>'operationKey' !~ '^gender-triage:[0-9a-f]{64}$'
            OR pg_catalog.jsonb_typeof(g->'accountIds') <> 'array'
            OR pg_catalog.jsonb_array_length(g->'accountIds') NOT BETWEEN 1 AND 2
    ) OR EXISTS (
        SELECT g->>'operationKey' FROM pg_catalog.jsonb_array_elements(p_groups) g
         GROUP BY 1 HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_groups) g,
            pg_catalog.jsonb_array_elements(g->'accountIds') a
         WHERE pg_catalog.jsonb_typeof(a) <> 'string' OR a #>> '{}' !~ '^account:[0-9a-f]{64}$'
    ) THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID'; END IF;
    SELECT count(*), count(DISTINCT a) INTO v_member_count, v_distinct_count
      FROM pg_catalog.jsonb_array_elements(p_groups) g, pg_catalog.jsonb_array_elements_text(g->'accountIds') a;
    IF v_member_count > 30 OR v_member_count <> v_distinct_count THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
    END IF;

    WITH keys AS (
        SELECT operation_key FROM public.analysis_v2_scheduler_operations
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'genderTriage'
        UNION SELECT operation_key FROM public.analysis_v2_ai_attempts
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'genderTriage'
        UNION SELECT operation_key FROM public.analysis_v2_ai_result_checkpoints
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'genderTriage'
    )
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'operationKey', k.operation_key,
        'accountIds', CASE WHEN s.status = 'ready' THEN (
            SELECT pg_catalog.jsonb_agg(entry->'accountId' ORDER BY ordinal)
            FROM pg_catalog.jsonb_array_elements(s.result_json->'results') WITH ORDINALITY AS e(entry,ordinal)
        ) END
    ) ORDER BY k.operation_key), '[]'::JSONB) INTO v_history
      FROM keys k LEFT JOIN public.analysis_v2_scheduler_operations s
        ON s.request_id = p_request_id AND s.job_key = p_job_key AND s.operation_key = k.operation_key;
    IF pg_catalog.jsonb_array_length(v_history) > 30 THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT'; END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_history) h WHERE NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_groups) g
             WHERE g->>'operationKey' = h->>'operationKey'
               AND ((h->'accountIds') = 'null'::JSONB OR
                    (g->'accountIds') @> (h->'accountIds') AND (h->'accountIds') @> (g->'accountIds'))
        )
    ) THEN RETURN pg_catalog.jsonb_build_object('kind','history','groups',v_history); END IF;

    INSERT INTO public.analysis_v2_profile_gender_plans VALUES (p_request_id,p_job_key,p_input_hash,p_groups);
    RETURN pg_catalog.jsonb_build_object('kind','pinned','groups',p_groups);
END;
$$;
REVOKE ALL ON FUNCTION public.pin_analysis_v2_profile_gender_plan(UUID,TEXT,UUID,TEXT,JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pin_analysis_v2_profile_gender_plan(UUID,TEXT,UUID,TEXT,JSONB) TO service_role;

-- An older deployment may reclaim the same job. It may run a pinned operation, but it
-- cannot establish a differently shaped scheduler claim or reserve a different paid attempt.
CREATE FUNCTION public.analysis_v2_enforce_profile_gender_plan() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.analysis_v2_profile_gender_plans p
        WHERE p.request_id = NEW.request_id AND p.job_key = NEW.job_key AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p.groups) g WHERE g->>'operationKey' = NEW.operation_key
        )
    ) THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT'; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_enforce_profile_gender_plan() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER analysis_v2_enforce_profile_gender_plan BEFORE INSERT ON public.analysis_v2_scheduler_operations
FOR EACH ROW WHEN (NEW.stage = 'genderTriage') EXECUTE FUNCTION public.analysis_v2_enforce_profile_gender_plan();
CREATE TRIGGER analysis_v2_enforce_profile_gender_plan BEFORE INSERT ON public.analysis_v2_ai_attempts
FOR EACH ROW WHEN (NEW.stage = 'genderTriage') EXECUTE FUNCTION public.analysis_v2_enforce_profile_gender_plan();
