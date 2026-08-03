-- Forward-only text-only maintenance path.  It delegates source eligibility and
-- atomic publication to the already-applied v2.11 revision RPC.
SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE FUNCTION public.read_analysis_v2_test_entitlement_v211_legacy_secondary_text_only_source(
    p_request_id UUID
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_source JSONB; v_summary public.analysis_v2_result_summaries%ROWTYPE;
BEGIN
    v_source := public.read_analysis_v2_test_entitlement_v211_legacy_secondary_source(p_request_id);
    SELECT summary.* INTO v_summary FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    IF v_summary.request_id IS NULL
       OR v_summary.male_count IS NULL OR v_summary.female_count IS NULL OR v_summary.unknown_count IS NULL
       OR v_summary.male_count + v_summary.female_count + v_summary.unknown_count <> v_summary.screened_mutuals THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_TEXT_ONLY_COUNTS_INVALID', ERRCODE = 'P0001';
    END IF;
    RETURN v_source || pg_catalog.jsonb_build_object('canonicalCounts', pg_catalog.jsonb_build_object(
        'male', v_summary.male_count, 'female', v_summary.female_count, 'unknown', v_summary.unknown_count
    ));
END; $$;
REVOKE ALL ON FUNCTION public.read_analysis_v2_test_entitlement_v211_legacy_secondary_text_only_source(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_test_entitlement_v211_legacy_secondary_text_only_source(UUID) TO service_role;

CREATE FUNCTION public.apply_analysis_v2_v211_legacy_secondary_text_only_revision(
    p_request_id UUID, p_source_fingerprint TEXT, p_semantic_input_fingerprint TEXT, p_idempotency_key TEXT,
    p_expected_current_revision INTEGER, p_male_count SMALLINT, p_female_count SMALLINT, p_unknown_count SMALLINT,
    p_female_rows JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_source JSONB; v_expected JSONB; v_actual JSONB;
BEGIN
    v_source := public.read_analysis_v2_test_entitlement_v211_legacy_secondary_text_only_source(p_request_id);
    IF (v_source->'canonicalCounts') <> pg_catalog.jsonb_build_object('male', p_male_count, 'female', p_female_count, 'unknown', p_unknown_count)
       OR p_female_count <> pg_catalog.jsonb_array_length(p_female_rows) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_TEXT_ONLY_COUNT_DRIFT', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.jsonb_agg(item.value - 'oneLineOverview' ORDER BY item.value->>'candidateId') INTO v_expected
    FROM pg_catalog.jsonb_array_elements(v_source->'originalFemaleRows') AS item(value);
    SELECT pg_catalog.jsonb_agg(item.value - 'oneLineOverview' ORDER BY item.value->>'candidateId') INTO v_actual
    FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value);
    IF v_expected IS DISTINCT FROM v_actual THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_TEXT_ONLY_IMMUTABLE_ROW_DRIFT', ERRCODE = 'P0001';
    END IF;
    RETURN public.apply_analysis_v2_v211_result_revision(p_request_id, p_source_fingerprint,
        p_semantic_input_fingerprint, p_idempotency_key, p_expected_current_revision,
        p_male_count, p_female_count, p_unknown_count, p_female_rows);
END; $$;
REVOKE ALL ON FUNCTION public.apply_analysis_v2_v211_legacy_secondary_text_only_revision(UUID,TEXT,TEXT,TEXT,INTEGER,SMALLINT,SMALLINT,SMALLINT,JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_analysis_v2_v211_legacy_secondary_text_only_revision(UUID,TEXT,TEXT,TEXT,INTEGER,SMALLINT,SMALLINT,SMALLINT,JSONB) TO service_role;
