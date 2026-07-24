-- Relative-risk policy v2.3 persistence contract.
-- Raw/public evidence scores remain unchanged. Only the owner-facing display score and
-- band are calibrated after ranking the strong-partner-eligible rows.

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

CREATE OR REPLACE FUNCTION public.analysis_v2_relative_overview_fallback(
    p_duplicate_ordinal INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_prefixes CONSTANT TEXT[] := ARRAY[
        '피드가 말을 아끼는 편이네요, ',
        '사진 배치가 지나치게 단정하네요, ',
        '전체 분위기가 묘하게 계산돼 있네요, ',
        '첫인상은 얌전한데 여운이 길게 남네요, ',
        '취향을 슬쩍만 보여 주는 구성이네요, ',
        '일상 기록이 의외로 빈틈없이 이어지네요, ',
        '꾸민 듯 안 꾸민 듯한 장면이 많네요, ',
        '프로필이 정답을 쉽게 주지 않네요, ',
        '피드의 온도가 은근히 사람을 붙잡네요, ',
        '설명보다 분위기가 먼저 말을 거네요, '
    ];
    v_middles CONSTANT TEXT[] := ARRAY[
        '판독관은 괜히 숨은 취향부터 살피게 되고 ',
        '이 정도 여백이면 사소한 단서도 크게 보이고 ',
        '무심한 척한 연출까지 한 번 더 보게 되고 ',
        '평범한 장면 뒤의 선택이 자꾸 궁금해지고 ',
        '사진 사이의 온도 차를 괜히 재보게 되고 ',
        '말하지 않은 부분에 눈길이 더 오래 머물고 ',
        '취향의 방향을 혼자 추리해 보게 되고 ',
        '캡션보다 표정과 구도를 먼저 의심하게 되고 ',
        '단정한 화면 속 작은 변화를 찾게 되고 ',
        '별일 없어 보여도 촉이 한 번 더 움직이고 '
    ];
    v_suffixes CONSTANT TEXT[] := ARRAY[
        '마지막까지 묘한 여운이 남습니다.',
        '쉽게 지나치기에는 제법 신경이 쓰입니다.',
        '괜한 상상력이 조용히 발동합니다.',
        '한 번 본 뒤에도 은근히 기억에 남습니다.',
        '판독관의 참견 본능이 슬쩍 깨어납니다.',
        '차분한 화면보다 뒷이야기가 더 궁금합니다.',
        '평범하다고 넘기기엔 분위기가 선명합니다.',
        '조용한 피드치고는 존재감이 꽤 큽니다.',
        '결국 한 장씩 다시 들여다보게 됩니다.'
    ];
    v_zero_based INTEGER;
BEGIN
    IF p_duplicate_ordinal IS NULL OR p_duplicate_ordinal NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_OVERVIEW_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_zero_based := p_duplicate_ordinal - 1;
    RETURN
        v_prefixes[1 + (v_zero_based % 10)]
        || v_middles[1 + ((v_zero_based / 10) % 10)]
        || v_suffixes[1 + ((v_zero_based / 100) % 9)];
END;
$$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old_display_check TEXT := $old$
           OR pg_catalog.abs(
                (item.value->>'displayScore')::NUMERIC
                - pg_catalog.round((item.value->>'publicScore')::NUMERIC, 1)
           ) > 0.0001$old$;
    v_old_band_check TEXT := $old$
           OR item.value->>'riskBand' IS DISTINCT FROM CASE
                WHEN (item.value->>'publicScore')::NUMERIC < 4.2 THEN 'normal'
                WHEN (item.value->>'publicScore')::NUMERIC < 6.8 THEN 'caution'
                ELSE 'high_risk'
              END$old$;
    v_hash_marker TEXT :=
        '    v_hash := public.analysis_v2_result_staging_hash('
        || quote_literal('candidate_scores_v2')
        || ', NULL, v_rows);';
    v_relative_validation TEXT := $replacement$
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        JOIN public.analysis_v2_expected_relative_risk_rows(
            v_rows,
            ARRAY(
                SELECT partner.candidate_id
                FROM public.analysis_v2_partner_safety_rows AS partner
                WHERE partner.request_id = p_request_id
                  AND partner.has_strong_partner_evidence
                ORDER BY partner.candidate_id
            )
        ) AS expected
          ON expected.candidate_id = item.value->>'candidateId'
        WHERE pg_catalog.abs(
                (item.value->>'displayScore')::NUMERIC - expected.display_score
              ) > 0.0001
           OR item.value->>'riskBand' IS DISTINCT FROM expected.risk_band
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old_display_check) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_RISK_DISPLAY_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.strpos(v_definition, v_old_band_check) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_RISK_BAND_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.strpos(v_definition, v_hash_marker) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_RISK_HASH_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.strpos(v_definition, 'risk-policy-v2.2') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_RISK_VERSION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(v_definition, v_old_display_check, '');
    v_definition := pg_catalog.replace(v_definition, v_old_band_check, '');
    v_definition := pg_catalog.replace(
        v_definition,
        'risk-policy-v2.2',
        'risk-policy-v2.3'
    );
    v_definition := pg_catalog.replace(
        v_definition,
        v_hash_marker,
        v_relative_validation || v_hash_marker
    );
    EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_start_marker TEXT := $start$WHEN pg_catalog.count(*) OVER (
                    PARTITION BY feature.one_line_overview
                ) > 1 THEN$start$;
    v_else_marker TEXT := $else$
                ELSE feature.one_line_overview$else$;
    v_replacement TEXT := $replacement$WHEN pg_catalog.count(*) OVER (
                    PARTITION BY feature.one_line_overview
                ) > 1 THEN
                    public.analysis_v2_relative_overview_fallback(
                        pg_catalog.row_number() OVER (
                            PARTITION BY feature.one_line_overview
                            ORDER BY feature.candidate_id
                        )::INTEGER
                    )$replacement$;
    v_start INTEGER;
    v_else INTEGER;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    v_start := pg_catalog.strpos(v_definition, v_start_marker);
    IF v_start = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_OVERVIEW_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_else := pg_catalog.strpos(
        pg_catalog.substr(v_definition, v_start),
        v_else_marker
    );
    IF v_else = 0 OR pg_catalog.strpos(v_definition, 'risk-policy-v2.2') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIVE_OVERVIEW_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_else := v_start + v_else - 1;
    v_definition :=
        pg_catalog.substr(v_definition, 1, v_start - 1)
        || v_replacement
        || pg_catalog.substr(v_definition, v_else);
    v_definition := pg_catalog.replace(
        v_definition,
        'risk-policy-v2.2',
        'risk-policy-v2.3'
    );
    EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_relative_overview_fallback(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[]) IS
    'Deterministically derives owner-facing relative tiers while preserving natural evidence scores.';
COMMENT ON FUNCTION public.analysis_v2_relative_overview_fallback(INTEGER) IS
    'Produces up to 900 distinct identifier-free examiner fallbacks for duplicate overview copy.';
