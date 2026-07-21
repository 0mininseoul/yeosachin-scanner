-- JavaScript serializes some repeating binary-float scores a few decimal places on either
-- side of the exact NUMERIC `preScore + 3` value. The semantic check below already allows
-- 0.0001 drift, so the structural guard must only enforce the public 0..100 range.
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_shortlist INTEGER;
    v_hash TEXT;
    v_existing RECORD;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 2097152
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'components', 'preScore', 'possibleUpperBound',
                    'recentMutualRank', 'verificationShortlistRank'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'components', 'preScore', 'possibleUpperBound',
                    'recentMutualRank', 'verificationShortlistRank'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR NOT public.analysis_v2_result_valid_score_components(item.value->'components')
               OR (item.value->'components'->>'targetToCandidateLike')::NUMERIC <> 0
               OR pg_catalog.jsonb_typeof(item.value->'preScore') <> 'number'
               OR (item.value->>'preScore')::NUMERIC NOT BETWEEN 0 AND 97
               OR pg_catalog.jsonb_typeof(item.value->'possibleUpperBound') <> 'number'
               OR (item.value->>'possibleUpperBound')::NUMERIC NOT BETWEEN 0 AND 100
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE pg_catalog.abs(
                (item.value->>'preScore')::NUMERIC
                - (
                    (item.value->'components'->>'candidateToTargetLikes')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetComments')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'appearanceExposure')::NUMERIC
                )
              ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'possibleUpperBound')::NUMERIC
                - LEAST((item.value->>'preScore')::NUMERIC + 3, 100)
              ) > 0.0001
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'coordinator:candidate-screening'
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'screening' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'), '[]')
    INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    v_shortlist := LEAST(v_count, 10);
    IF v_count <> (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
          AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
              WHERE item.value->>'candidateId' = feature.candidate_id
          )
    ) OR (
        SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE item.value->'verificationShortlistRank' <> 'null'::JSONB
    ) <> v_shortlist OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE (
                item.value->'recentMutualRank' <> 'null'::JSONB
                AND item.value->>'recentMutualRank' !~ '^(?:[1-9]|10)$'
              )
           OR (
                item.value->'verificationShortlistRank' <> 'null'::JSONB
                AND item.value->>'verificationShortlistRank' !~ '^(?:[1-9]|10)$'
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    v_hash := public.analysis_v2_result_staging_hash('preliminary_scores', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_preliminary_score_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;
    INSERT INTO public.analysis_v2_preliminary_score_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, result_hash
    ) VALUES (p_request_id, p_job_key, p_job_input_hash, p_claim_token, v_count, v_hash);
    INSERT INTO public.analysis_v2_preliminary_score_rows (
        request_id, candidate_id, components, pre_score, possible_upper_bound,
        recent_mutual_rank, verification_shortlist_rank
    )
    SELECT p_request_id, item.value->>'candidateId', item.value->'components',
        (item.value->>'preScore')::NUMERIC,
        (item.value->>'possibleUpperBound')::NUMERIC,
        CASE WHEN item.value->'recentMutualRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'recentMutualRank')::SMALLINT END,
        CASE WHEN item.value->'verificationShortlistRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'verificationShortlistRank')::SMALLINT END
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
