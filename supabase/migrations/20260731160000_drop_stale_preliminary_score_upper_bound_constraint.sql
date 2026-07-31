-- Remove the original unnamed three-point preliminary-score bound left behind
-- when risk-policy v2.4 introduced the named five-point bound. Validate both
-- catalog expressions before changing anything so schema drift fails closed.

DO $migration$
DECLARE
    legacy_constraint_expression TEXT;
    current_constraint_expression TEXT;
    expected_legacy_expression CONSTANT TEXT :=
        '(((possible_upper_bound >= pre_score) AND (possible_upper_bound <= (pre_score + (3)::numeric))) AND (possible_upper_bound <= (100)::numeric))';
    expected_current_expression CONSTANT TEXT :=
        '(((possible_upper_bound >= pre_score) AND (possible_upper_bound <= (pre_score + (5)::numeric))) AND (possible_upper_bound <= (100)::numeric))';
BEGIN
    SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO legacy_constraint_expression
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
            'public.analysis_v2_preliminary_score_rows'::pg_catalog.regclass
      AND constraint_row.conname = 'analysis_v2_preliminary_score_rows_check'
      AND constraint_row.contype = 'c';

    IF legacy_constraint_expression IS DISTINCT FROM expected_legacy_expression THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRELIMINARY_LEGACY_BOUND_SCHEMA_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO current_constraint_expression
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
            'public.analysis_v2_preliminary_score_rows'::pg_catalog.regclass
      AND constraint_row.conname =
            'analysis_v2_preliminary_score_rows_possible_upper_bound_check'
      AND constraint_row.contype = 'c';

    IF current_constraint_expression IS DISTINCT FROM expected_current_expression THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRELIMINARY_CURRENT_BOUND_SCHEMA_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    ALTER TABLE public.analysis_v2_preliminary_score_rows
        DROP CONSTRAINT analysis_v2_preliminary_score_rows_check;
END;
$migration$;
