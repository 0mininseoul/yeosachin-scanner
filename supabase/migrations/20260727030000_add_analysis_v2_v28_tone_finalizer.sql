-- v2.8 is a forward-only presentation policy. Historical v2.6/v2.7 rows never enter this
-- function: their persisted copy remains byte-for-byte untouched.
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

REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge(
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
