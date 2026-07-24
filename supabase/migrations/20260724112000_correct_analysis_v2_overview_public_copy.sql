-- Public overview copy must not expose numeric metrics or raw numeric handles.
-- Keep the account-specific suffix while expressing the actual risk band in words.

DO $migration$
DECLARE
    v_definition TEXT;
    v_old_identity TEXT := $old$|| ' · ' || feature.instagram_id$old$;
    v_new_identity TEXT := $new$|| ' · ' || COALESCE(
                        NULLIF(
                            pg_catalog.regexp_replace(
                                feature.instagram_id, '[0-9]', '', 'g'
                            ),
                            ''
                        ),
                        '해당'
                    )$new$;
    v_old_label TEXT := $old$' 계정은 위험도 '$old$;
    v_new_label TEXT := $new$' 계정은 '$new$;
    v_old_score TEXT :=
        'pg_catalog.round(score.display_score)::INTEGER::TEXT';
    v_new_score TEXT := $new$CASE score.risk_band
                        WHEN 'normal' THEN '일반'
                        WHEN 'caution' THEN '주의'
                        WHEN 'high_risk' THEN '고위험'
                    END$new$;
    v_old_suffix TEXT := $old$'점으로 판독됐어요.'$old$;
    v_new_suffix TEXT := $new$' 단계로 판독됐어요.'$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old_identity) = 0
       OR pg_catalog.strpos(v_definition, v_old_label) = 0
       OR pg_catalog.strpos(v_definition, v_old_score) = 0
       OR pg_catalog.strpos(v_definition, v_old_suffix) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_OVERVIEW_COPY_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition, v_old_identity, v_new_identity
    );
    v_definition := pg_catalog.replace(
        v_definition, v_old_label, v_new_label
    );
    v_definition := pg_catalog.replace(
        v_definition, v_old_score, v_new_score
    );
    v_definition := pg_catalog.replace(
        v_definition, v_old_suffix, v_new_suffix
    );
    EXECUTE v_definition;
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
    ),
    candidates AS (
        SELECT
            female.candidate_id,
            CASE
                WHEN female.one_line_overview LIKE
                    '% · ' || female.instagram_id
                    || ' 계정은 위험도 %점으로 판독됐어요.'
                THEN pg_catalog.split_part(
                    female.one_line_overview, ' · ', 1
                )
                ELSE female.one_line_overview
            END AS base_overview
        FROM public.analysis_v2_female_results AS female
        LEFT JOIN duplicates
          ON duplicates.one_line_overview = female.one_line_overview
        WHERE female.request_id = p_request_id
          AND (
            duplicates.one_line_overview IS NOT NULL
            OR female.one_line_overview LIKE
                '% · ' || female.instagram_id
                || ' 계정은 위험도 %점으로 판독됐어요.'
          )
    )
    UPDATE public.analysis_v2_female_results AS female
    SET one_line_overview =
        pg_catalog.left(candidates.base_overview, 105)
        || ' · ' || COALESCE(
            NULLIF(
                pg_catalog.regexp_replace(
                    female.instagram_id, '[0-9]', '', 'g'
                ),
                ''
            ),
            '해당'
        )
        || ' 계정은 '
        || CASE female.risk_band
            WHEN 'normal' THEN '일반'
            WHEN 'caution' THEN '주의'
            WHEN 'high_risk' THEN '고위험'
        END
        || ' 단계로 판독됐어요.'
    FROM candidates
    WHERE female.request_id = p_request_id
      AND female.candidate_id = candidates.candidate_id;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
        GROUP BY female.one_line_overview
        HAVING pg_catalog.count(*) > 1
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
          AND female.one_line_overview ~ '[[:digit:]@]'
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
