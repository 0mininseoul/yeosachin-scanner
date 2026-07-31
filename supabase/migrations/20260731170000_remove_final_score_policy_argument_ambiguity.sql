-- risk-policy v2.4 added the policy argument to every text fragment ending in
-- `) AS expected`. One of those fragments is the relative-risk helper call,
-- but the other is the expected-score lateral SELECT. Remove only the latter
-- output column so the helper's unqualified policy argument is no longer
-- ambiguous inside PL/pgSQL.

DO $migration$
DECLARE
    v_function CONSTANT pg_catalog.regprocedure :=
        'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure;
    v_definition TEXT;
    v_stray_fragment CONSTANT TEXT := $fragment$)) AS expected_raw_score
        , p_risk_policy_version
        ) AS expected_score$fragment$;
    v_repaired_fragment CONSTANT TEXT := $fragment$)) AS expected_raw_score
        ) AS expected_score$fragment$;
    v_policy_argument_close CONSTANT TEXT := $fragment$, p_risk_policy_version
        ) AS expected$fragment$;
    v_helper_marker CONSTANT TEXT :=
        'JOIN public.analysis_v2_expected_relative_risk_rows(';
    v_helper_close_marker CONSTANT TEXT := ') AS expected';
    v_policy_gate CONSTANT TEXT :=
        $fragment$p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5')$fragment$;
    v_stray_count INTEGER;
    v_policy_argument_count INTEGER;
    v_helper_start INTEGER;
    v_helper_close INTEGER;
    v_helper_call TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;

    v_stray_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_stray_fragment, ''))
    ) / pg_catalog.length(v_stray_fragment);
    v_policy_argument_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_policy_argument_close, ''))
    ) / pg_catalog.length(v_policy_argument_close);
    v_helper_start := pg_catalog.strpos(v_definition, v_helper_marker);
    IF v_helper_start > 0 THEN
        v_helper_close := pg_catalog.strpos(
            pg_catalog.substr(v_definition, v_helper_start),
            v_helper_close_marker
        );
        IF v_helper_close > 0 THEN
            v_helper_call := pg_catalog.substr(
                v_definition,
                v_helper_start,
                v_helper_close + pg_catalog.length(v_helper_close_marker) - 1
            );
        END IF;
    END IF;

    IF v_stray_count <> 1
       OR v_policy_argument_count <> 3
       OR v_helper_call IS NULL
       OR pg_catalog.strpos(v_helper_call, 'p_risk_policy_version') = 0
       OR pg_catalog.strpos(v_definition, v_repaired_fragment) > 0
       OR pg_catalog.strpos(v_definition, v_policy_gate) = 0
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, $fragment$SET search_path TO ''$fragment$) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINAL_SCORE_POLICY_ARGUMENT_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_definition := pg_catalog.replace(
        v_definition,
        v_stray_fragment,
        v_repaired_fragment
    );
    EXECUTE v_definition;

    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_stray_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_stray_fragment, ''))
    ) / pg_catalog.length(v_stray_fragment);
    v_policy_argument_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_policy_argument_close, ''))
    ) / pg_catalog.length(v_policy_argument_close);
    v_helper_start := pg_catalog.strpos(v_definition, v_helper_marker);
    v_helper_close := CASE WHEN v_helper_start > 0 THEN pg_catalog.strpos(
        pg_catalog.substr(v_definition, v_helper_start),
        v_helper_close_marker
    ) ELSE 0 END;
    v_helper_call := CASE WHEN v_helper_close > 0 THEN pg_catalog.substr(
        v_definition,
        v_helper_start,
        v_helper_close + pg_catalog.length(v_helper_close_marker) - 1
    ) ELSE NULL END;

    IF v_stray_count <> 0
       OR v_policy_argument_count <> 2
       OR v_helper_call IS NULL
       OR pg_catalog.strpos(v_helper_call, 'p_risk_policy_version') = 0
       OR pg_catalog.strpos(v_definition, v_repaired_fragment) = 0
       OR pg_catalog.strpos(v_definition, v_policy_gate) = 0
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, $fragment$SET search_path TO ''$fragment$) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINAL_SCORE_POLICY_ARGUMENT_DRIFT',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;
