-- MIGRATION_PREDECESSOR=20260808280000
-- Correct the one-shot concierge publisher to use the paid Basic request's
-- frozen 300-account detail limit. All 134 public mutuals are screened; five
-- have terminal profile-fetch-unavailable evidence and are counted as unknown.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
    v_signature REGPROCEDURE :=
        'public.publish_earlybird_v211_first_payment_concierge(text,text,jsonb)'::pg_catalog.regprocedure;
    v_original_definition TEXT;
    v_corrected_definition TEXT;
    v_marker TEXT;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260808280000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_COVERAGE_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.pg_get_functiondef(v_signature)
    INTO v_original_definition;
    IF v_original_definition IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLISHER_MISSING',
            ERRCODE = 'P0001';
    END IF;

    FOREACH v_marker IN ARRAY ARRAY[
        'OR v_screened_mutuals <> 130',
        'OR v_not_screened_mutuals <> 4',
        'OR v_fetch_unavailable <> 0',
        'OR v_media_unavailable NOT BETWEEN 0 AND 130',
        'OR v_analysis_unavailable NOT BETWEEN 0 AND 130',
        'OR v_male NOT BETWEEN 0 AND 130',
        'OR v_female NOT BETWEEN 0 AND 130',
        'OR v_unknown NOT BETWEEN 0 AND 130',
        'OR v_male + v_female + v_unknown <> 130',
        'OR v_media_unavailable + v_analysis_unavailable > v_unknown'
    ] LOOP
        IF pg_catalog.strpos(v_original_definition, v_marker) = 0 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLISHER_DEFINITION_DRIFT',
                ERRCODE = 'P0001';
        END IF;
    END LOOP;

    v_corrected_definition := v_original_definition;
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_screened_mutuals <> 130',
        'OR v_screened_mutuals <> 134'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_not_screened_mutuals <> 4',
        'OR v_not_screened_mutuals <> 0'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_fetch_unavailable <> 0',
        'OR v_fetch_unavailable <> 5'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_media_unavailable NOT BETWEEN 0 AND 130',
        'OR v_media_unavailable NOT BETWEEN 0 AND 129'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_analysis_unavailable NOT BETWEEN 0 AND 130',
        'OR v_analysis_unavailable NOT BETWEEN 0 AND 129'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_male NOT BETWEEN 0 AND 130',
        'OR v_male NOT BETWEEN 0 AND 129'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_female NOT BETWEEN 0 AND 130',
        'OR v_female NOT BETWEEN 0 AND 129'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_unknown NOT BETWEEN 0 AND 130',
        'OR v_unknown NOT BETWEEN 5 AND 134'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_male + v_female + v_unknown <> 130',
        'OR v_male + v_female + v_unknown <> 134'
    );
    v_corrected_definition := pg_catalog.replace(
        v_corrected_definition,
        'OR v_media_unavailable + v_analysis_unavailable > v_unknown',
        'OR v_fetch_unavailable + v_media_unavailable
            + v_analysis_unavailable > v_unknown'
    );

    IF v_corrected_definition = v_original_definition
       OR pg_catalog.strpos(
            v_corrected_definition,
            'OR v_screened_mutuals <> 130'
       ) > 0
       OR pg_catalog.strpos(
            v_corrected_definition,
            'OR v_media_unavailable + v_analysis_unavailable > v_unknown'
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_COVERAGE_REWRITE_FAILED',
            ERRCODE = 'P0001';
    END IF;

    EXECUTE v_corrected_definition;
END;
$migration$;

COMMENT ON FUNCTION public.publish_earlybird_v211_first_payment_concierge(
    TEXT, TEXT, JSONB
) IS
    'One-shot service-only first-paid Basic concierge publisher; all 134 frozen public mutuals are screened and five terminal profile-fetch failures remain unknown.';

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.publish_earlybird_v211_first_payment_concierge(text,text,jsonb)';
    v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure)
    INTO v_definition;
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR pg_catalog.strpos(v_definition, 'OR v_screened_mutuals <> 134') = 0
       OR pg_catalog.strpos(v_definition, 'OR v_not_screened_mutuals <> 0') = 0
       OR pg_catalog.strpos(v_definition, 'OR v_fetch_unavailable <> 5') = 0
       OR pg_catalog.strpos(v_definition, 'OR v_unknown NOT BETWEEN 5 AND 134') = 0
       OR pg_catalog.strpos(
            v_definition,
            'OR v_male + v_female + v_unknown <> 134'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_COVERAGE_FINAL_GUARD_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$final_guard$;

COMMIT;
