-- Risk-policy v2.4: directional tag evidence and personal-relative tier replay.
-- This is deliberately forward-only: v2.2/v2.3 manifests remain readable.

ALTER TABLE public.analysis_v2_candidate_score_manifests
    DROP CONSTRAINT IF EXISTS analysis_v2_candidate_score_manifests_risk_policy_version_check;

ALTER TABLE public.analysis_v2_candidate_score_manifests
    ADD CONSTRAINT analysis_v2_candidate_score_manifests_risk_policy_version_check
    CHECK (risk_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3', 'risk-policy-v2.4'));

ALTER TABLE public.analysis_v2_result_summaries
    DROP CONSTRAINT IF EXISTS analysis_v2_result_summaries_score_policy_version_check;

ALTER TABLE public.analysis_v2_result_summaries
    ADD CONSTRAINT analysis_v2_result_summaries_score_policy_version_check
    CHECK (score_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3', 'risk-policy-v2.4'));

ALTER TABLE public.analysis_v2_preliminary_score_rows
    DROP CONSTRAINT IF EXISTS analysis_v2_preliminary_score_rows_possible_upper_bound_check;

ALTER TABLE public.analysis_v2_preliminary_score_rows
    ADD CONSTRAINT analysis_v2_preliminary_score_rows_possible_upper_bound_check
    CHECK (
        possible_upper_bound BETWEEN pre_score AND pre_score + 5
        AND possible_upper_bound <= 100
    );

ALTER TABLE public.analysis_v2_reverse_like_rows
    DROP CONSTRAINT IF EXISTS analysis_v2_reverse_like_rows_component_score_check;

ALTER TABLE public.analysis_v2_reverse_like_rows
    ADD CONSTRAINT analysis_v2_reverse_like_rows_component_score_check
    -- Expand-safe: v2.3 workers and in-flight rows legitimately use observed=3.
    -- A later gated contraction may remove 3 only after those requests have drained.
    CHECK (component_score IN (0, 3, 5));

ALTER TABLE public.analysis_v2_reverse_like_rows
    DROP CONSTRAINT IF EXISTS analysis_v2_reverse_like_evidence_check;

ALTER TABLE public.analysis_v2_reverse_like_rows
    ADD CONSTRAINT analysis_v2_reverse_like_evidence_check CHECK (
        public.analysis_v2_result_valid_ref_list(evidence_ref_ids, 8)
        AND (
            (reverse_like_status = 'observed' AND component_score IN (3, 5)
                AND pg_catalog.cardinality(evidence_ref_ids) > 0)
            OR (reverse_like_status <> 'observed' AND component_score = 0
                AND pg_catalog.cardinality(evidence_ref_ids) = 0)
        )
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_score_components(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_value IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_value) = 'object'
       AND (
            -- The candidate checkpoint fences requests by risk-policy snapshot. Keep this
            -- legacy shape valid only long enough for a v2.3 finalizer to drain.
            (
                p_value ?& ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'targetToCandidateLike', 'tagOrCaptionMention',
                    'recentMutual', 'appearanceExposure'
                ]
                AND p_value - ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'targetToCandidateLike', 'tagOrCaptionMention',
                    'recentMutual', 'appearanceExposure'
                ] = '{}'::JSONB
                AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetLikes') = 'number'
                AND (p_value->>'candidateToTargetLikes')::NUMERIC BETWEEN 0 AND 20
                AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetComments') = 'number'
                AND (p_value->>'candidateToTargetComments')::NUMERIC BETWEEN 0 AND 26
                AND pg_catalog.jsonb_typeof(p_value->'targetToCandidateLike') = 'number'
                AND (p_value->>'targetToCandidateLike')::NUMERIC BETWEEN 0 AND 3
                AND pg_catalog.jsonb_typeof(p_value->'tagOrCaptionMention') = 'number'
                AND (p_value->>'tagOrCaptionMention')::NUMERIC BETWEEN 0 AND 14
                AND pg_catalog.jsonb_typeof(p_value->'recentMutual') = 'number'
                AND (p_value->>'recentMutual')::NUMERIC BETWEEN 0 AND 17
                AND pg_catalog.jsonb_typeof(p_value->'appearanceExposure') = 'number'
                AND (p_value->>'appearanceExposure')::NUMERIC BETWEEN 0 AND 20
            )
            OR (
                p_value ?& ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'candidateToTargetTagOrCaptionMention',
                    'targetToCandidateTagOrCaptionMention',
                    'targetToCandidateLike', 'recentMutual', 'appearanceExposure'
                ]
                AND p_value - ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'candidateToTargetTagOrCaptionMention',
                    'targetToCandidateTagOrCaptionMention',
                    'targetToCandidateLike', 'recentMutual', 'appearanceExposure'
                ] = '{}'::JSONB
                AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetLikes') = 'number'
                AND (p_value->>'candidateToTargetLikes')::NUMERIC BETWEEN 0 AND 24
                AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetComments') = 'number'
                AND (p_value->>'candidateToTargetComments')::NUMERIC BETWEEN 0 AND 30
                AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetTagOrCaptionMention') = 'number'
                AND (p_value->>'candidateToTargetTagOrCaptionMention')::NUMERIC BETWEEN 0 AND 12
                AND pg_catalog.jsonb_typeof(p_value->'targetToCandidateTagOrCaptionMention') = 'number'
                AND (p_value->>'targetToCandidateTagOrCaptionMention')::NUMERIC BETWEEN 0 AND 8
                AND pg_catalog.jsonb_typeof(p_value->'targetToCandidateLike') = 'number'
                AND (p_value->>'targetToCandidateLike')::NUMERIC BETWEEN 0 AND 5
                AND pg_catalog.jsonb_typeof(p_value->'recentMutual') = 'number'
                AND (p_value->>'recentMutual')::NUMERIC BETWEEN 0 AND 5
                AND pg_catalog.jsonb_typeof(p_value->'appearanceExposure') = 'number'
                AND (p_value->>'appearanceExposure')::NUMERIC BETWEEN 0 AND 16
            )
        );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows(
    p_rows JSONB,
    p_strong_partner_candidate_ids TEXT[]
)
RETURNS TABLE (
    candidate_id TEXT,
    display_score NUMERIC,
    risk_band TEXT,
    relative_tier_applied BOOLEAN
)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
WITH source_rows AS (
    SELECT
        item.value->>'candidateId' AS candidate_id,
        (item.value->>'publicScore')::NUMERIC AS public_score,
        COALESCE(item.value->>'accountContext', 'personal') = 'official_group_or_brand'
            AS official_group_or_brand,
        COALESCE((item.value->'components'->>'candidateToTargetLikes')::NUMERIC, 0) > 0
            OR COALESCE((item.value->'components'->>'candidateToTargetComments')::NUMERIC, 0) > 0
            OR COALESCE(
                (item.value->'components'->>'candidateToTargetTagOrCaptionMention')::NUMERIC,
                0
            ) > 0 AS inbound,
        (item.value->>'candidateId') = ANY(
            COALESCE(p_strong_partner_candidate_ids, ARRAY[]::TEXT[])
        ) AS strong_partner
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
),
natural_rows AS (
    SELECT
        source.*,
        pg_catalog.round(source.public_score, 1) AS natural_display_score,
        CASE
            WHEN source.public_score < 4.2 THEN 'normal'
            WHEN source.public_score < 6.8 THEN 'caution'
            ELSE 'high_risk'
        END AS natural_risk_band
    FROM source_rows AS source
),
eligible_rows AS (
    SELECT
        natural_row.*,
        pg_catalog.row_number() OVER (
            ORDER BY natural_row.public_score DESC, natural_row.candidate_id
        )::INTEGER AS eligible_rank,
        pg_catalog.count(*) OVER ()::INTEGER AS eligible_count,
        pg_catalog.count(*) FILTER (WHERE natural_row.inbound) OVER ()::INTEGER AS inbound_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band = 'high_risk'
        ) OVER ()::INTEGER AS natural_high_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band <> 'normal'
        ) OVER ()::INTEGER AS natural_non_normal_count
    FROM natural_rows AS natural_row
    WHERE NOT natural_row.strong_partner
      AND NOT natural_row.official_group_or_brand
),
high_counts AS (
    SELECT eligible.*,
        CASE WHEN eligible.eligible_count < 3 THEN 0 ELSE GREATEST(
            1, LEAST(3, eligible.eligible_count - 2, eligible.natural_high_count)
        ) END AS requested_high_count
    FROM eligible_rows AS eligible
),
high_pool AS (
    SELECT counted.*,
        pg_catalog.row_number() OVER (
            ORDER BY counted.public_score DESC, counted.candidate_id
        )::INTEGER AS high_pool_rank
    FROM high_counts AS counted
    WHERE counted.inbound_count = 0 OR counted.inbound
),
high_selected AS (
    SELECT counted.*, COALESCE(
        pool.high_pool_rank <= counted.requested_high_count, FALSE
    ) AS selected_high
    FROM high_counts AS counted
    LEFT JOIN high_pool AS pool ON pool.candidate_id = counted.candidate_id
),
selected_counts AS (
    SELECT selected.*,
        pg_catalog.count(*) FILTER (WHERE selected.selected_high) OVER ()::INTEGER
            AS actual_high_count
    FROM high_selected AS selected
),
remaining_rows AS (
    SELECT selected.*,
        pg_catalog.row_number() OVER (
            ORDER BY selected.public_score DESC, selected.candidate_id
        )::INTEGER AS remaining_rank,
        pg_catalog.count(*) OVER ()::INTEGER AS remaining_count
    FROM selected_counts AS selected
    WHERE NOT selected.selected_high
),
eligible_tiers AS (
    SELECT selected.*,
        CASE
            WHEN selected.eligible_count < 3 THEN selected.natural_risk_band
            WHEN selected.selected_high THEN 'high_risk'
            WHEN remaining.remaining_rank <= LEAST(
                10, remaining.remaining_count,
                GREATEST(2, selected.natural_non_normal_count - selected.actual_high_count)
            ) THEN 'caution'
            ELSE 'normal'
        END AS expected_risk_band
    FROM selected_counts AS selected
    LEFT JOIN remaining_rows AS remaining ON remaining.candidate_id = selected.candidate_id
),
expected_eligible AS (
    SELECT tiered.candidate_id,
        CASE tiered.expected_risk_band
            WHEN 'high_risk' THEN LEAST(10.0, GREATEST(6.8, tiered.natural_display_score))
            WHEN 'caution' THEN LEAST(6.7, GREATEST(4.2, tiered.natural_display_score))
            ELSE LEAST(4.1, GREATEST(1.0, tiered.natural_display_score))
        END::NUMERIC AS display_score,
        tiered.expected_risk_band AS risk_band,
        tiered.eligible_count >= 3 AS relative_tier_applied
    FROM eligible_tiers AS tiered
),
expected_excluded AS (
    SELECT natural_row.candidate_id,
        CASE WHEN natural_row.official_group_or_brand
            THEN LEAST(4.1, GREATEST(1.0, natural_row.natural_display_score))
            ELSE natural_row.natural_display_score
        END::NUMERIC AS display_score,
        CASE WHEN natural_row.official_group_or_brand THEN 'normal'
            ELSE natural_row.natural_risk_band END AS risk_band,
        FALSE AS relative_tier_applied
    FROM natural_rows AS natural_row
    WHERE natural_row.strong_partner OR natural_row.official_group_or_brand
)
SELECT * FROM expected_eligible
UNION ALL
SELECT * FROM expected_excluded
ORDER BY candidate_id;
$$;

-- Keep the exact v2.3 replay separate from the directional v2.4 helper. The
-- candidate checkpoint supplies the request snapshot version; missing fields
-- never select a policy.
CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows_v23(
    p_rows JSONB,
    p_strong_partner_candidate_ids TEXT[]
)
RETURNS TABLE (
    candidate_id TEXT,
    display_score NUMERIC,
    risk_band TEXT,
    relative_tier_applied BOOLEAN
)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
WITH source_rows AS (
    SELECT
        item.value->>'candidateId' AS candidate_id,
        (item.value->>'publicScore')::NUMERIC AS public_score,
        (item.value->>'candidateId') = ANY(
            COALESCE(p_strong_partner_candidate_ids, ARRAY[]::TEXT[])
        ) AS strong_partner
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
),
natural_rows AS (
    SELECT
        source.candidate_id,
        source.public_score,
        pg_catalog.round(source.public_score, 1) AS natural_display_score,
        CASE
            WHEN source.public_score < 4.2 THEN 'normal'
            WHEN source.public_score < 6.8 THEN 'caution'
            ELSE 'high_risk'
        END AS natural_risk_band,
        source.strong_partner
    FROM source_rows AS source
),
eligible_rows AS (
    SELECT
        natural_row.*,
        pg_catalog.row_number() OVER (
            ORDER BY natural_row.public_score DESC, natural_row.candidate_id
        )::INTEGER AS eligible_rank,
        pg_catalog.count(*) OVER ()::INTEGER AS eligible_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band = 'high_risk'
        ) OVER ()::INTEGER AS natural_high_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band <> 'normal'
        ) OVER ()::INTEGER AS natural_non_normal_count
    FROM natural_rows AS natural_row
    WHERE NOT natural_row.strong_partner
),
eligible_counts AS (
    SELECT
        eligible.*,
        CASE
            WHEN eligible.eligible_count < 3 THEN 0
            ELSE GREATEST(
                1,
                LEAST(
                    eligible.eligible_count - 2,
                    eligible.natural_high_count
                )
            )
        END AS high_count
    FROM eligible_rows AS eligible
),
eligible_tiers AS (
    SELECT
        counted.*,
        CASE
            WHEN counted.eligible_count < 3 THEN counted.natural_risk_band
            WHEN counted.eligible_rank <= counted.high_count THEN 'high_risk'
            WHEN counted.eligible_rank <= counted.high_count + LEAST(
                counted.eligible_count - counted.high_count,
                GREATEST(
                    2,
                    counted.natural_non_normal_count - counted.high_count
                )
            ) THEN 'caution'
            ELSE 'normal'
        END AS expected_risk_band
    FROM eligible_counts AS counted
),
expected_eligible AS (
    SELECT
        tiered.candidate_id,
        CASE tiered.expected_risk_band
            WHEN 'high_risk' THEN
                LEAST(10.0, GREATEST(6.8, tiered.natural_display_score))
            WHEN 'caution' THEN
                LEAST(6.7, GREATEST(4.2, tiered.natural_display_score))
            ELSE LEAST(4.1, GREATEST(1.0, tiered.natural_display_score))
        END::NUMERIC AS display_score,
        tiered.expected_risk_band AS risk_band,
        tiered.eligible_count >= 3 AS relative_tier_applied
    FROM eligible_tiers AS tiered
),
expected_strong_partner AS (
    SELECT
        natural_row.candidate_id,
        natural_row.natural_display_score AS display_score,
        natural_row.natural_risk_band AS risk_band,
        FALSE AS relative_tier_applied
    FROM natural_rows AS natural_row
    WHERE natural_row.strong_partner
)
SELECT * FROM expected_eligible
UNION ALL
SELECT * FROM expected_strong_partner
ORDER BY candidate_id;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows(
    p_rows JSONB,
    p_strong_partner_candidate_ids TEXT[],
    p_risk_policy_version TEXT
)
RETURNS TABLE (
    candidate_id TEXT,
    display_score NUMERIC,
    risk_band TEXT,
    relative_tier_applied BOOLEAN
)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT *
    FROM public.analysis_v2_expected_relative_risk_rows_v23(
        p_rows, p_strong_partner_candidate_ids
    )
    WHERE p_risk_policy_version = 'risk-policy-v2.3'
    UNION ALL
    SELECT *
    FROM public.analysis_v2_expected_relative_risk_rows(
        p_rows, p_strong_partner_candidate_ids
    )
    WHERE p_risk_policy_version = 'risk-policy-v2.4'
    ORDER BY candidate_id;
$$;

DO $migration$
DECLARE v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_reverse_likes(uuid,text,uuid,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(
            v_definition, $reverse$componentScore' NOT IN ('0', '3')$reverse$
       ) = 0
       OR pg_catalog.strpos(v_definition, $reverse$componentScore' <> '3'$reverse$) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V24_REVERSE_LIKE_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition,
        $reverse$componentScore' NOT IN ('0', '3')$reverse$,
        $reverse$componentScore' NOT IN ('0', '3', '5')$reverse$
    );
    v_definition := pg_catalog.replace(
        v_definition, $reverse$componentScore' <> '3'$reverse$,
        $reverse$componentScore' NOT IN ('3', '5')$reverse$
    );
    EXECUTE v_definition;
END;
$migration$;

-- The five-argument predecessor is intentionally left untouched: in-flight v2.3
-- workers still submit its legacy component shape. v2.4 uses this separately named,
-- policy-fenced checkpoint rather than relying on overload resolution.
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB,
    p_risk_policy_version TEXT
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
    IF p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
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
               OR NOT (item.value->'components' ?& ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'candidateToTargetTagOrCaptionMention',
                    'targetToCandidateTagOrCaptionMention', 'targetToCandidateLike',
                    'recentMutual', 'appearanceExposure'
               ])
               OR (item.value->'components') - ARRAY[
                    'candidateToTargetLikes', 'candidateToTargetComments',
                    'candidateToTargetTagOrCaptionMention',
                    'targetToCandidateTagOrCaptionMention', 'targetToCandidateLike',
                    'recentMutual', 'appearanceExposure'
               ] <> '{}'::JSONB
               OR (item.value->'components'->>'targetToCandidateLike')::NUMERIC <> 0
               OR pg_catalog.jsonb_typeof(item.value->'preScore') <> 'number'
               OR (item.value->>'preScore')::NUMERIC NOT BETWEEN 0 AND 95
               OR pg_catalog.jsonb_typeof(item.value->'possibleUpperBound') <> 'number'
               OR (item.value->>'possibleUpperBound')::NUMERIC
                    NOT BETWEEN (item.value->>'preScore')::NUMERIC
                        AND LEAST((item.value->>'preScore')::NUMERIC + 5, 100)
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE pg_catalog.abs(
                (item.value->>'preScore')::NUMERIC - (
                    (item.value->'components'->>'candidateToTargetLikes')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetComments')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetTagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'targetToCandidateTagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'appearanceExposure')::NUMERIC
                )
              ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'possibleUpperBound')::NUMERIC
                - LEAST((item.value->>'preScore')::NUMERIC + 5, 100)
              ) > 0.0001
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'coordinator:candidate-screening'
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'screening'
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
              AND analysis_request.policy_versions_snapshot->>'risk' = p_risk_policy_version
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
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
    SELECT manifest.* INTO v_existing FROM public.analysis_v2_preliminary_score_manifests AS manifest
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
        (item.value->>'preScore')::NUMERIC, (item.value->>'possibleUpperBound')::NUMERIC,
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

DO $migration$
DECLARE
    v_definition TEXT;
    v_tag_component_pattern TEXT := $pattern$\(item\.value->'components'->>'tagOrCaptionMention'\)::NUMERIC$pattern$;
    v_expected_pre_score_pattern TEXT := $pattern$GREATEST\(\s*0\s*,\s*LEAST\(\s*component_sum\.preliminary_component_total\s*\+\s*\(item\.value->>'weakPartnerAdjustment'\)::NUMERIC\s*,\s*97\s*\)\s*\)\s+AS\s+expected_pre_score$pattern$;
    v_possible_upper_pattern TEXT := $pattern$expected_score\.expected_pre_score\s*\+\s*3\s*,\s*100$pattern$;
    v_caution_pattern TEXT := $pattern$ranked\.risk_band\s*=\s*'caution'\s+AND\s+ranked\.expected_rank\s*<=\s*15$pattern$;
    v_reverse_component_pattern TEXT := $pattern$pg_catalog\.jsonb_set\(\s*preliminary\.components\s*,\s*ARRAY\['targetToCandidateLike'\]\s*,\s*pg_catalog\.to_jsonb\(reverse_like\.component_score\)\s*,\s*TRUE\s*\)$pattern$;
    v_policy_guard_pattern TEXT := $pattern$p_risk_policy_version\s+IS\s+DISTINCT\s+FROM\s+'risk-policy-v2\.3'$pattern$;
    v_legacy_row_shape_pattern TEXT := $pattern$OR\s+NOT\s+\(item\.value\s+\?&\s+ARRAY\[[^\]]*'partnerEvidenceSelectionIds'\s*\]\s*\)\s+OR\s+item\.value\s*-\s*ARRAY\[[^\]]*'partnerEvidenceSelectionIds'\s*\]\s*<>\s*'\{\}'::JSONB$pattern$;
    v_row_count_marker TEXT := '    v_count := pg_catalog.jsonb_array_length(v_rows);';
    v_relative_helper_marker TEXT := 'JOIN public.analysis_v2_expected_relative_risk_rows(';
    v_relative_helper_close_marker TEXT := '        ) AS expected';
    v_policy_row_shape TEXT := $replacement$OR NOT (
                    (
                        p_risk_policy_version = 'risk-policy-v2.3'
                        AND item.value ?& ARRAY[
                            'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                            'recentMutualRank', 'verificationShortlistRank',
                            'partnerSafetySource', 'partnerSafetyOperationKey',
                            'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                            'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                            'weakPartnerAdjustment', 'partnerCapApplied',
                            'partnerEvidenceSelectionIds'
                        ]
                        AND item.value - ARRAY[
                            'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                            'recentMutualRank', 'verificationShortlistRank',
                            'partnerSafetySource', 'partnerSafetyOperationKey',
                            'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                            'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                            'weakPartnerAdjustment', 'partnerCapApplied',
                            'partnerEvidenceSelectionIds'
                        ] = '{}'::JSONB
                        AND item.value->'components' ?& ARRAY[
                            'candidateToTargetLikes', 'candidateToTargetComments',
                            'targetToCandidateLike', 'tagOrCaptionMention',
                            'recentMutual', 'appearanceExposure'
                        ]
                        AND (item.value->'components') - ARRAY[
                            'candidateToTargetLikes', 'candidateToTargetComments',
                            'targetToCandidateLike', 'tagOrCaptionMention',
                            'recentMutual', 'appearanceExposure'
                        ] = '{}'::JSONB
                    ) OR (
                        p_risk_policy_version = 'risk-policy-v2.4'
                        AND item.value ?& ARRAY[
                            'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                            'recentMutualRank', 'verificationShortlistRank',
                            'partnerSafetySource', 'partnerSafetyOperationKey',
                            'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                            'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                            'weakPartnerAdjustment', 'partnerCapApplied',
                            'partnerEvidenceSelectionIds', 'accountContext'
                        ]
                        AND item.value - ARRAY[
                            'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                            'recentMutualRank', 'verificationShortlistRank',
                            'partnerSafetySource', 'partnerSafetyOperationKey',
                            'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                            'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                            'weakPartnerAdjustment', 'partnerCapApplied',
                            'partnerEvidenceSelectionIds', 'accountContext'
                        ] = '{}'::JSONB
                        AND pg_catalog.jsonb_typeof(item.value->'accountContext') = 'string'
                        AND item.value->>'accountContext' IN (
                            'personal', 'individual_creator', 'official_group_or_brand', 'uncertain'
                        )
                        AND item.value->'components' ?& ARRAY[
                            'candidateToTargetLikes', 'candidateToTargetComments',
                            'candidateToTargetTagOrCaptionMention',
                            'targetToCandidateTagOrCaptionMention',
                            'targetToCandidateLike', 'recentMutual', 'appearanceExposure'
                        ]
                        AND (item.value->'components') - ARRAY[
                            'candidateToTargetLikes', 'candidateToTargetComments',
                            'candidateToTargetTagOrCaptionMention',
                            'targetToCandidateTagOrCaptionMention',
                            'targetToCandidateLike', 'recentMutual', 'appearanceExposure'
                        ] = '{}'::JSONB
                    )
                )$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'risk-policy-v2.3') = 0
       OR v_definition !~ v_tag_component_pattern
       OR v_definition !~ v_expected_pre_score_pattern
       OR v_definition !~ v_possible_upper_pattern
       OR v_definition !~ v_caution_pattern
       OR v_definition !~ v_reverse_component_pattern
       OR v_definition !~ v_policy_guard_pattern
       OR v_definition !~ v_legacy_row_shape_pattern
       OR pg_catalog.strpos(v_definition, v_row_count_marker) = 0
       OR pg_catalog.strpos(v_definition, v_relative_helper_marker) = 0
       OR pg_catalog.strpos(v_definition, v_relative_helper_close_marker) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V24_FINAL_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_tag_component_pattern,
        $replacement$CASE
                        WHEN p_risk_policy_version = 'risk-policy-v2.3'
                            THEN (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                        ELSE (item.value->'components'->>'candidateToTargetTagOrCaptionMention')::NUMERIC
                            + (item.value->'components'->>'targetToCandidateTagOrCaptionMention')::NUMERIC
                    END$replacement$,
        'g'
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_expected_pre_score_pattern,
        $replacement$GREATEST(0, LEAST(
                    component_sum.preliminary_component_total
                        + (item.value->>'weakPartnerAdjustment')::NUMERIC,
                    CASE WHEN p_risk_policy_version = 'risk-policy-v2.3'
                        THEN 97 ELSE 95 END
                )) AS expected_pre_score$replacement$
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_possible_upper_pattern,
        $replacement$expected_score.expected_pre_score
                    + CASE WHEN p_risk_policy_version = 'risk-policy-v2.3'
                        THEN 3 ELSE 5 END, 100$replacement$
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_reverse_component_pattern,
        $replacement$pg_catalog.jsonb_set(
                preliminary.components,
                ARRAY['targetToCandidateLike'],
                pg_catalog.to_jsonb(
                    CASE
                        WHEN p_risk_policy_version = 'risk-policy-v2.4'
                            AND reverse_like.reverse_like_status = 'observed'
                            AND reverse_like.component_score = 3
                        THEN 5::NUMERIC
                        ELSE reverse_like.component_score
                    END
                ),
                TRUE
            )$replacement$
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_policy_guard_pattern,
        $replacement$p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4')$replacement$
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        v_legacy_row_shape_pattern,
        v_policy_row_shape
    );
    v_definition := pg_catalog.replace(
        v_definition,
        v_relative_helper_close_marker,
        $replacement$        , p_risk_policy_version
        ) AS expected$replacement$
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition, v_caution_pattern,
        $replacement$ranked.risk_band = 'caution'
                            AND ranked.expected_rank <= CASE
                                WHEN p_risk_policy_version = 'risk-policy-v2.3' THEN 15
                                ELSE 10
                            END$replacement$
    );
    EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[], TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows_v23(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_score_components(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[]) IS
    'Derives v2.4 personal-relative tiers with directional inbound evidence.';
