-- JavaScript score sums can serialize a mathematically exact upper bound a few
-- quadrillionths above preScore + 5. The checkpoint already replays this math
-- with a 0.0001 tolerance; make the earlier shape/range guard consistent while
-- retaining the absolute 0..100 bound.
DO $migration$
DECLARE
    v_function CONSTANT pg_catalog.regprocedure :=
        'public.checkpoint_analysis_v2_preliminary_scores_v24(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure;
    v_definition TEXT;
    v_old_pattern TEXT := $pattern$OR \(item\.value->>'possibleUpperBound'\)::NUMERIC[[:space:]]+NOT BETWEEN \(item\.value->>'preScore'\)::NUMERIC[[:space:]]+AND LEAST\(\(item\.value->>'preScore'\)::NUMERIC \+ 5, 100\)$pattern$;
    v_new TEXT := $new$OR (item.value->>'possibleUpperBound')::NUMERIC NOT BETWEEN 0 AND 100$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;

    IF pg_catalog.regexp_count(v_definition, v_old_pattern) <> 1
       OR pg_catalog.strpos(v_definition, v_new) > 0
       OR pg_catalog.strpos(v_definition, ') > 0.0001') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRELIMINARY_UPPER_BOUND_TOLERANCE_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_definition := pg_catalog.regexp_replace(v_definition, v_old_pattern, v_new);
    EXECUTE v_definition;

    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    IF pg_catalog.regexp_count(v_definition, v_old_pattern) <> 0
       OR pg_catalog.strpos(v_definition, v_new) = 0
       OR pg_catalog.strpos(v_definition, ') > 0.0001') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRELIMINARY_UPPER_BOUND_TOLERANCE_DRIFT',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;
