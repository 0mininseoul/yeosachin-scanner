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

-- The snapshot already contains the candidate and selection order. Keep just the
-- ordinal, normalized coverage and the digest of the existing private archive.
CREATE TABLE public.analysis_v2_profile_media_inputs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    input JSONB NOT NULL,
    ordinal SMALLINT GENERATED ALWAYS AS ((input->>'ordinal')::SMALLINT) STORED,
    stage TEXT GENERATED ALWAYS AS (input->>'stage') STORED,
    PRIMARY KEY (request_id, job_key, ordinal, stage),
    FOREIGN KEY (request_id, job_key) REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE
);
ALTER TABLE public.analysis_v2_profile_media_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_media_inputs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_v2_profile_media_inputs FROM PUBLIC, anon, authenticated, service_role;

-- Every reader and writer uses the same request -> job lock order and checks the
-- actual time after acquiring the job lock.
CREATE FUNCTION public.lock_analysis_v2_profile_plan_job(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_input_hash TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_status TEXT;
    v_pipeline TEXT;
    v_plan TEXT;
    v_snapshot JSONB;
    v_lease_expires_at TIMESTAMPTZ;
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
    SELECT j.lease_expires_at INTO v_lease_expires_at FROM public.analysis_pipeline_jobs j
     WHERE j.request_id = p_request_id AND j.job_key = p_job_key AND j.track = 'profile_ai'
       AND j.kind = 'ai' AND j.job_key = 'track:profile-ai:batch:' || j.batch::TEXT
       AND j.status = 'processing' AND j.input_hash = p_input_hash AND j.lease_token = p_claim_token FOR UPDATE;
    -- A job may expire while waiting to acquire the row lock.
    IF NOT FOUND OR v_lease_expires_at IS NULL OR v_lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH';
    END IF;
    IF EXISTS (SELECT 1 FROM public.analysis_v2_profile_gender_plans
                WHERE request_id=p_request_id AND job_key=p_job_key AND input_hash<>p_input_hash)
       OR EXISTS (SELECT 1 FROM public.analysis_v2_profile_media_inputs
                   WHERE request_id=p_request_id AND job_key=p_job_key AND input_hash<>p_input_hash) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_analysis_v2_profile_plan_job(UUID,TEXT,UUID,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.pin_analysis_v2_profile_gender_plan(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_input_hash TEXT, p_groups JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_groups JSONB;
    v_history JSONB;
    v_member_count INTEGER;
    v_distinct_count INTEGER;
BEGIN
    PERFORM public.lock_analysis_v2_profile_plan_job(p_request_id, p_job_key, p_claim_token, p_input_hash);
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

-- Legacy feature operations have a content hash but no ordinal. Only an exact
-- match with a stored input links one of those operations to a candidate.
CREATE FUNCTION public.unowned_analysis_v2_profile_feature_keys(p_request_id UUID, p_job_key TEXT)
RETURNS TEXT[] LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT pg_catalog.array_agg(h.operation_key) FROM (
        SELECT operation_key FROM public.analysis_v2_scheduler_operations
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'featureAnalysis'
        UNION SELECT operation_key FROM public.analysis_v2_ai_attempts
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'featureAnalysis'
        UNION SELECT operation_key FROM public.analysis_v2_ai_result_checkpoints
         WHERE request_id = p_request_id AND job_key = p_job_key AND stage = 'featureAnalysis'
    ) AS h WHERE NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_media_inputs m
         WHERE m.request_id = p_request_id AND m.job_key = p_job_key
           AND m.stage = 'feature_remainder' AND m.input->>'operationKey' = h.operation_key
    );
$$;
REVOKE ALL ON FUNCTION public.unowned_analysis_v2_profile_feature_keys(UUID,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.load_analysis_v2_profile_media_inputs(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_input_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_inputs JSONB;
    v_has_history BOOLEAN;
BEGIN
    PERFORM public.lock_analysis_v2_profile_plan_job(p_request_id, p_job_key, p_claim_token, p_input_hash);
    SELECT coalesce(pg_catalog.jsonb_agg(m.input ORDER BY m.ordinal, m.stage), '[]'::JSONB)
      INTO v_inputs FROM public.analysis_v2_profile_media_inputs m
     WHERE m.request_id = p_request_id AND m.job_key = p_job_key AND m.input_hash = p_input_hash;
    SELECT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_gender_plans WHERE request_id=p_request_id AND job_key=p_job_key
        UNION ALL SELECT 1 FROM public.analysis_v2_scheduler_operations WHERE request_id=p_request_id AND job_key=p_job_key AND stage='genderTriage'
        UNION ALL SELECT 1 FROM public.analysis_v2_ai_attempts WHERE request_id=p_request_id AND job_key=p_job_key AND stage='genderTriage'
        UNION ALL SELECT 1 FROM public.analysis_v2_ai_result_checkpoints WHERE request_id=p_request_id AND job_key=p_job_key AND stage='genderTriage'
    ) INTO v_has_history;
    RETURN pg_catalog.jsonb_build_object(
        'inputs',v_inputs,'hasGenderHistory',v_has_history,
        'hasUnownedFeatureHistory',public.unowned_analysis_v2_profile_feature_keys(p_request_id,p_job_key) IS NOT NULL
    );
END;
$$;

CREATE FUNCTION public.pin_analysis_v2_profile_media_inputs(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_input_hash TEXT, p_inputs JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_input JSONB;
    v_fail JSONB;
    v_count INTEGER;
    v_stage TEXT;
    v_key TEXT;
    v_fail_count INTEGER;
    v_previous_index INTEGER;
    v_existing JSONB;
    v_unowned_keys TEXT[];
BEGIN
    PERFORM public.lock_analysis_v2_profile_plan_job(p_request_id, p_job_key, p_claim_token, p_input_hash);
    IF pg_catalog.jsonb_typeof(p_inputs) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
    END IF;
    IF pg_catalog.jsonb_array_length(p_inputs) > 60 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
    END IF;
    -- A legacy feature receipt may have only an operation key, with no proof of
    -- which candidate owned it. Adopt an exact key before admitting unrelated work.
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_inputs) i WHERE i->>'stage' = 'feature_remainder') THEN
        v_unowned_keys := public.unowned_analysis_v2_profile_feature_keys(p_request_id,p_job_key);
    END IF;
    FOR v_input IN SELECT value FROM pg_catalog.jsonb_array_elements(p_inputs) LOOP
        IF pg_catalog.jsonb_typeof(v_input) IS DISTINCT FROM 'object'
           OR NOT (v_input ?& ARRAY['ordinal','stage','selectedCount','failures','archiveSha256','operationKey'])
           OR v_input - ARRAY['ordinal','stage','selectedCount','failures','archiveSha256','operationKey'] <> '{}'::JSONB
           OR pg_catalog.jsonb_typeof(v_input->'ordinal') <> 'number' OR v_input->>'ordinal' !~ '^([0-9]|[12][0-9])$'
           OR pg_catalog.jsonb_typeof(v_input->'stage') <> 'string' OR v_input->>'stage' NOT IN ('triage','feature_remainder')
           OR pg_catalog.jsonb_typeof(v_input->'selectedCount') <> 'number' OR v_input->>'selectedCount' !~ '^([0-9]|1[01])$'
           OR pg_catalog.jsonb_typeof(v_input->'failures') <> 'array' THEN
            RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
        END IF;
        v_stage := v_input->>'stage';
        v_key := v_input->>'operationKey';
        v_count := (v_input->>'selectedCount')::INTEGER;
        v_fail_count := pg_catalog.jsonb_array_length(v_input->'failures');
        IF (v_stage = 'triage' AND (v_count > 5 OR v_key IS NOT NULL))
           OR (v_key IS NOT NULL AND (pg_catalog.jsonb_typeof(v_input->'operationKey') <> 'string' OR v_key !~ '^feature-analysis:[0-9a-f]{64}$'))
           OR v_fail_count > v_count
           OR (v_fail_count = v_count AND v_input->'archiveSha256' <> 'null'::JSONB)
           OR (v_fail_count < v_count AND (pg_catalog.jsonb_typeof(v_input->'archiveSha256') <> 'string' OR v_input->>'archiveSha256' !~ '^[0-9a-f]{64}$')) THEN
            RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
        END IF;
        v_previous_index := -1;
        FOR v_fail IN SELECT value FROM pg_catalog.jsonb_array_elements(v_input->'failures') LOOP
            IF pg_catalog.jsonb_typeof(v_fail) IS DISTINCT FROM 'object'
               OR NOT (v_fail ?& ARRAY['index','reason','disposition'])
               OR v_fail - ARRAY['index','reason','disposition'] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(v_fail->'index') <> 'number' OR v_fail->>'index' !~ '^([0-9]|10)$'
               OR pg_catalog.jsonb_typeof(v_fail->'reason') <> 'string'
               OR v_fail->>'reason' NOT IN ('invalid_source','blocked_source','source_missing','source_rejected',
                    'rate_limited','upstream_unavailable','network_failure','timeout','response_too_large',
                    'unsupported_content','invalid_response','decode_failed','empty_output')
               OR pg_catalog.jsonb_typeof(v_fail->'disposition') <> 'string'
               OR v_fail->>'disposition' NOT IN ('transient','permanent') THEN
                RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
            END IF;
            IF (v_fail->>'index')::INTEGER <= v_previous_index OR (v_fail->>'index')::INTEGER >= v_count THEN
                RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID';
            END IF;
            v_previous_index := (v_fail->>'index')::INTEGER;
        END LOOP;
        SELECT m.input INTO v_existing FROM public.analysis_v2_profile_media_inputs m
         WHERE m.request_id = p_request_id AND m.job_key = p_job_key
           AND m.ordinal = (v_input->>'ordinal')::SMALLINT AND m.stage = v_stage;
        IF FOUND THEN
            IF v_existing IS DISTINCT FROM v_input THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT'; END IF;
            CONTINUE;
        END IF;
        IF v_stage = 'feature_remainder' AND v_unowned_keys IS NOT NULL
           AND (v_key IS NULL OR NOT (v_key = ANY(v_unowned_keys))) THEN
            RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_FEATURE_HISTORY_PENDING';
        END IF;
        INSERT INTO public.analysis_v2_profile_media_inputs(request_id,job_key,input_hash,input)
        VALUES (p_request_id,p_job_key,p_input_hash,v_input);
    END LOOP;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_media_inputs(UUID,TEXT,UUID,TEXT),
    public.pin_analysis_v2_profile_media_inputs(UUID,TEXT,UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_media_inputs(UUID,TEXT,UUID,TEXT),
    public.pin_analysis_v2_profile_media_inputs(UUID,TEXT,UUID,TEXT,JSONB) TO service_role;

-- An older deployment may reclaim the same job. It may run a pinned operation, but it
-- cannot establish a differently shaped scheduler claim or reserve a different paid attempt.
CREATE FUNCTION public.analysis_v2_enforce_profile_gender_plan() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.stage = 'featureAnalysis' THEN
        IF (EXISTS (
                SELECT 1 FROM public.analysis_v2_profile_gender_plans p
                 WHERE p.request_id = NEW.request_id AND p.job_key = NEW.job_key
            ) OR EXISTS (
                SELECT 1 FROM public.analysis_v2_profile_media_inputs m
                 WHERE m.request_id = NEW.request_id AND m.job_key = NEW.job_key
            )) AND NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_profile_media_inputs m
                 WHERE m.request_id = NEW.request_id AND m.job_key = NEW.job_key
                   AND m.stage = 'feature_remainder' AND m.input->>'operationKey' = NEW.operation_key
            ) THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT'; END IF;
        RETURN NEW;
    END IF;
    -- A fresh worker stores the images before pinning the groups. An older
    -- worker cannot insert a claim between those writes, even after a crash.
    IF (EXISTS (SELECT 1 FROM public.analysis_v2_profile_gender_plans p
                WHERE p.request_id = NEW.request_id AND p.job_key = NEW.job_key)
        OR EXISTS (SELECT 1 FROM public.analysis_v2_profile_media_inputs m
                   WHERE m.request_id = NEW.request_id AND m.job_key = NEW.job_key AND m.stage = 'triage'))
       AND NOT EXISTS (
           SELECT 1 FROM public.analysis_v2_profile_gender_plans p, pg_catalog.jsonb_array_elements(p.groups) g
            WHERE p.request_id = NEW.request_id AND p.job_key = NEW.job_key AND g->>'operationKey' = NEW.operation_key
       ) THEN RAISE EXCEPTION 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT'; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_enforce_profile_gender_plan() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER analysis_v2_enforce_profile_gender_plan BEFORE INSERT ON public.analysis_v2_scheduler_operations
FOR EACH ROW WHEN (NEW.stage IN ('genderTriage','featureAnalysis')) EXECUTE FUNCTION public.analysis_v2_enforce_profile_gender_plan();
CREATE TRIGGER analysis_v2_enforce_profile_gender_plan BEFORE INSERT ON public.analysis_v2_ai_attempts
FOR EACH ROW WHEN (NEW.stage IN ('genderTriage','featureAnalysis')) EXECUTE FUNCTION public.analysis_v2_enforce_profile_gender_plan();
