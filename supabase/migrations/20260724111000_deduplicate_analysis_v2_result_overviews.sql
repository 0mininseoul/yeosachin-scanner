-- Preserve the AI-written overview while making repeated fallback copy
-- account-specific with the account identity and its actual rounded score.

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT :=
        'score.featured_rank, score.recent_mutual_rank, feature.one_line_overview,';
    v_new TEXT := $replacement$
score.featured_rank, score.recent_mutual_rank,
            CASE
                WHEN pg_catalog.count(*) OVER (
                    PARTITION BY feature.one_line_overview
                ) > 1 THEN
                    pg_catalog.left(feature.one_line_overview, 105)
                    || ' · ' || feature.instagram_id
                    || ' 계정은 위험도 '
                    || pg_catalog.round(score.display_score)::INTEGER::TEXT
                    || '점으로 판독됐어요.'
                ELSE feature.one_line_overview
            END AS one_line_overview,$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old)
                    + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_OVERVIEW_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

CREATE OR REPLACE FUNCTION public.repair_analysis_v2_duplicate_overviews(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_updated_count INTEGER;
    v_unique_count INTEGER;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_OVERVIEW_REPAIR_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2';
    IF NOT FOUND
       OR v_request.status <> 'completed'
       OR v_request.plan_access_mode_snapshot <> 'test_entitlement'
       OR v_request.completed_at IS NULL
       OR v_request.completed_at < v_now - INTERVAL '24 hours' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_OVERVIEW_REPAIR_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    WITH duplicates AS (
        SELECT female.one_line_overview
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
        GROUP BY female.one_line_overview
        HAVING pg_catalog.count(*) > 1
    )
    UPDATE public.analysis_v2_female_results AS female
    SET one_line_overview =
        pg_catalog.left(female.one_line_overview, 105)
        || ' · ' || female.instagram_id
        || ' 계정은 위험도 '
        || pg_catalog.round(female.display_score)::INTEGER::TEXT
        || '점으로 판독됐어요.'
    FROM duplicates
    WHERE female.request_id = p_request_id
      AND female.one_line_overview = duplicates.one_line_overview;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
        GROUP BY female.one_line_overview
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_OVERVIEW_REPAIR_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(DISTINCT female.one_line_overview)::INTEGER
    INTO v_unique_count
    FROM public.analysis_v2_female_results AS female
    WHERE female.request_id = p_request_id;

    RETURN pg_catalog.jsonb_build_object(
        'updatedCount', v_updated_count,
        'uniqueCount', v_unique_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.repair_analysis_v2_duplicate_overviews(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.repair_analysis_v2_duplicate_overviews(UUID)
    TO service_role;

COMMENT ON FUNCTION public.repair_analysis_v2_duplicate_overviews(UUID) IS
    'Idempotently repairs duplicate overview copy only for recent completed authorized test results.';
