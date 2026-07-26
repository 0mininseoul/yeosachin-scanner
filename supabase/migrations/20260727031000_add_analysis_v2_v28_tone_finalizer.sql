-- v2.8 is a forward-only presentation policy. Historical v2.6/v2.7 rows never enter this
-- function: their persisted copy remains byte-for-byte untouched.
CREATE OR REPLACE FUNCTION public.analysis_v2_v28_safe_overview_fallback(
    p_sort_ordinal INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_prefixes CONSTANT TEXT[] := ARRAY[
        '확인된 공개 단서가 제한적이고, ',
        '공개된 소개와 피드만으로는 맥락이 부족하고, ',
        '수집된 공개 범위에서는 정보가 많지 않고, ',
        '현재 보이는 공개 자료에는 빈칸이 남고, ',
        '소개와 피드에서 확인되는 내용이 제한적이고, ',
        '공개 화면에 드러난 단서만으로는 정보가 부족하고, ',
        '확인 가능한 공개 기록의 범위가 좁고, ',
        '지금 확보된 공개 자료에는 설명이 적고, ',
        '공개 프로필과 피드만 보면 단서가 많지 않고, ',
        '확인된 공개 정보 사이에 빈칸이 남고, '
    ];
    v_middles CONSTANT TEXT[] := ARRAY[
        '계정 성격을 더 단정하기 어렵습니다. ',
        '세부 맥락까지 확정하기는 어렵습니다. ',
        '구체적인 배경을 읽어 내기 어렵습니다. ',
        '보이지 않는 사정까지 알 수는 없습니다. ',
        '확실한 특징을 더 붙이기 어렵습니다. ',
        '하나의 성격으로 묶기에는 근거가 부족합니다. ',
        '공개되지 않은 맥락은 판단할 수 없습니다. ',
        '뚜렷한 결론까지 가기에는 근거가 모자랍니다. ',
        '세부적인 해석을 더하기에는 자료가 부족합니다. ',
        '확인되지 않은 이야기를 보탤 수는 없습니다. '
    ];
    v_suffixes CONSTANT TEXT[] := ARRAY[
        '보이는 범위까지만 확인하는 편이 낫겠네요.',
        '빈칸을 추측으로 채울 이유는 없겠네요.',
        '없는 디테일까지 만들어 낼 필요는 없습니다.',
        '확인된 내용만 두고 보는 것이 안전합니다.',
        '공개 자료가 더 생기기 전에는 여기까지입니다.',
        '지금은 확인 가능한 내용만 남기는 편이 낫습니다.',
        '근거가 없는 해석은 붙이지 않는 게 맞겠네요.',
        '현재 자료만으로는 이 정도가 가장 정확합니다.',
        '보이지 않는 부분은 그대로 남겨 두는 게 낫습니다.'
    ];
    v_zero_based INTEGER;
BEGIN
    IF p_sort_ordinal IS NULL OR p_sort_ordinal NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_V28_SAFE_OVERVIEW_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_zero_based := p_sort_ordinal - 1;
    RETURN
        v_prefixes[1 + (v_zero_based % 10)]
        || v_middles[1 + ((v_zero_based / 10) % 10)]
        || v_suffixes[1 + ((v_zero_based / 100) % 9)];
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_v28_safe_overview_fallback(INTEGER)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_apply_v28_summary_tone(
    p_request_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_total INTEGER;
    v_budget INTEGER;
    v_kept INTEGER := 0;
    v_previous_kept_ordinal SMALLINT := NULL;
    v_normalized TEXT;
    v_first_laugh_position INTEGER;
    v_row RECORD;
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.8'
    ) THEN
        RETURN;
    END IF;

    -- The predecessor finalizer made duplicate copy unique by appending an Instagram
    -- identity/risk label, and a later predecessor used examiner-style generated fallbacks.
    -- Repair those values after the predecessor has completed. Exact duplicates are also
    -- assigned a stable identifier-free variant based only on the already-public ordering.
    WITH analyzed AS (
        SELECT
            female.candidate_id,
            female.sort_ordinal,
            female.one_line_overview,
            pg_catalog.count(*) OVER (
                PARTITION BY female.one_line_overview
            ) AS duplicate_count
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
    ),
    repair AS (
        SELECT analyzed.candidate_id, analyzed.sort_ordinal
        FROM analyzed
        WHERE analyzed.duplicate_count > 1
           OR analyzed.one_line_overview ~ '[[:digit:]@]'
           OR analyzed.one_line_overview ~* (
                'risk[-_ ]?(?:policy|band)|score|스코어|점수|위험도|'
                || '(?:일반|주의|고위험)[[:space:]]*단계|정책[[:space:]]*버전|'
                || '계정[[:space:]]*(?:ID|아이디)'
           )
           OR analyzed.one_line_overview ~ (
                '판독관|내[[:space:]]*눈(?:엔|에는)|제가[[:space:]]*보기(?:엔|에는)|저라면'
           )
           OR analyzed.one_line_overview ~ (
                '^(피드가 말을 아끼는 편이네요|사진 배치가 지나치게 단정하네요|'
                || '전체 분위기가 묘하게 계산돼 있네요|첫인상은 얌전한데 여운이 길게 남네요|'
                || '취향을 슬쩍만 보여 주는 구성이네요|일상 기록이 의외로 빈틈없이 이어지네요|'
                || '꾸민 듯 안 꾸민 듯한 장면이 많네요|프로필이 정답을 쉽게 주지 않네요|'
                || '피드의 온도가 은근히 사람을 붙잡네요|설명보다 분위기가 먼저 말을 거네요)'
           )
           OR analyzed.one_line_overview ~ (
                '^(확인된 공개 단서가 제한적이고|공개된 소개와 피드만으로는 맥락이 부족하고|'
                || '수집된 공개 범위에서는 정보가 많지 않고|현재 보이는 공개 자료에는 빈칸이 남고|'
                || '소개와 피드에서 확인되는 내용이 제한적이고|'
                || '공개 화면에 드러난 단서만으로는 정보가 부족하고|'
                || '확인 가능한 공개 기록의 범위가 좁고|지금 확보된 공개 자료에는 설명이 적고|'
                || '공개 프로필과 피드만 보면 단서가 많지 않고|'
                || '확인된 공개 정보 사이에 빈칸이 남고)'
           )
    )
    UPDATE public.analysis_v2_female_results AS female
    SET one_line_overview =
        public.analysis_v2_v28_safe_overview_fallback(repair.sort_ordinal)
    FROM repair
    WHERE female.request_id = p_request_id
      AND female.candidate_id = repair.candidate_id;

    SELECT pg_catalog.count(*)::INTEGER INTO v_total
    FROM public.analysis_v2_female_results AS female
    WHERE female.request_id = p_request_id;
    v_budget := pg_catalog.floor(v_total / 20.0)::INTEGER;

    FOR v_row IN
        SELECT female.candidate_id, female.sort_ordinal, female.one_line_overview
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
        ORDER BY female.sort_ordinal, female.candidate_id
    LOOP
        -- Replace legacy self-referential DB fallback text only for new v2.8 results.
        IF v_row.one_line_overview ~ '판독관' THEN
            v_normalized := '소개와 피드 구성이 같은 방향을 가리킵니다. 무엇을 보여주려는지는 꽤 분명하네요.';
        ELSE
            v_normalized := pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(v_row.one_line_overview, 'ㅋ+', 'ㅋㅋ', 'g'),
                '[[:space:]]{2,}', ' ', 'g'
            );
        END IF;

        IF pg_catalog.strpos(v_normalized, 'ㅋㅋ') > 0
           AND v_kept < v_budget
           AND (
                v_previous_kept_ordinal IS NULL
                OR v_row.sort_ordinal <> v_previous_kept_ordinal + 1
           ) THEN
            -- At most one token in a kept summary. Keep the first; remove later occurrences.
            v_first_laugh_position := pg_catalog.strpos(v_normalized, 'ㅋㅋ');
            v_normalized := pg_catalog.left(v_normalized, v_first_laugh_position + 1)
                || pg_catalog.regexp_replace(
                    pg_catalog.substr(v_normalized, v_first_laugh_position + 2),
                    'ㅋ+',
                    '',
                    'g'
                );
            v_kept := v_kept + 1;
            v_previous_kept_ordinal := v_row.sort_ordinal;
        ELSE
            v_normalized := pg_catalog.regexp_replace(v_normalized, 'ㅋ+', '', 'g');
        END IF;

        v_normalized := pg_catalog.regexp_replace(v_normalized, '[[:space:]]{2,}', ' ', 'g');

        UPDATE public.analysis_v2_female_results AS female
        SET one_line_overview = pg_catalog.btrim(v_normalized)
        WHERE female.request_id = p_request_id
          AND female.candidate_id = v_row.candidate_id;
    END LOOP;

    -- High-risk narrative is evidence-led copy, not playful general commentary.
    UPDATE public.analysis_v2_female_results AS female
    SET narrative_line_one = CASE
            WHEN female.narrative_line_one IS NULL THEN NULL
            ELSE pg_catalog.btrim(pg_catalog.regexp_replace(
                female.narrative_line_one, 'ㅋ+', '', 'g'
            ))
        END,
        narrative_line_two = CASE
            WHEN female.narrative_line_two IS NULL THEN NULL
            ELSE pg_catalog.btrim(pg_catalog.regexp_replace(
                female.narrative_line_two, 'ㅋ+', '', 'g'
            ))
        END
    WHERE female.request_id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apply_v28_summary_tone(UUID)
FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the existing, audited finalizer body and wrap it rather than rewriting history.
ALTER FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) RENAME TO analysis_v2_complete_result_and_purge_before_v28_tone;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result JSONB;
BEGIN
    v_result := public.analysis_v2_complete_result_and_purge_before_v28_tone(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_target_profile_image_url
    );
    PERFORM public.analysis_v2_apply_v28_summary_tone(p_request_id);
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- Rebind the production image-sealing entry point to the wrapper above. SQL function references
-- are resolved to OIDs when compiled, so this replacement must accompany the finalizer rename.
CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT,
    p_image_manifest_hash TEXT,
    p_image_expected_rows INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_result_image_manifests%ROWTYPE;
BEGIN
    SELECT manifest.* INTO v_manifest
    FROM public.analysis_v2_result_image_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_manifest.producer_job_key IS DISTINCT FROM p_job_key
       OR v_manifest.producer_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_manifest.producer_claim_token IS DISTINCT FROM p_claim_token
       OR v_manifest.ordered_manifest_hash IS DISTINCT FROM p_image_manifest_hash
       OR v_manifest.expected_rows IS DISTINCT FROM p_image_expected_rows
       OR v_manifest.sealed_at IS NULL
       OR NOT public.analysis_v2_result_image_coverage_ok(
            v_manifest.expected_rows,
            v_manifest.durable_rows,
            v_manifest.sourced_images,
            v_manifest.ready_images,
            v_manifest.capture_failed_images
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.is_mandatory
              AND image_object.status <> 'ready'
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.status = 'ready'
              AND image_object.expires_at <= pg_catalog.clock_timestamp()
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY', ERRCODE = 'P0001';
    END IF;
    RETURN public.complete_analysis_v2_result_and_purge(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash, p_target_profile_image_url
    );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge_before_v28_tone(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
