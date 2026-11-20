BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_definition TEXT := pg_catalog.pg_get_functiondef(
        'public.materialize_analysis_v2_score_audit(uuid,uuid)'::pg_catalog.regprocedure
    );
    v_component_sum CONSTANT TEXT := $sum$GREATEST(0, LEAST(
                    (source.components->>'candidateToTargetLikes')::NUMERIC
                    + (source.components->>'candidateToTargetComments')::NUMERIC
                    + (source.components->>'candidateToTargetTagOrCaptionMention')::NUMERIC
                    + (source.components->>'targetToCandidateTagOrCaptionMention')::NUMERIC
                    + (source.components->>'recentMutual')::NUMERIC
                    + (source.components->>'appearanceExposure')::NUMERIC
                    + source.weak_partner_adjustment, 95
                ))$sum$;
    v_old_check CONSTANT TEXT := 'AND source.pre_score = ' || v_component_sum;
BEGIN
    IF pg_catalog.cardinality(pg_catalog.string_to_array(v_definition, v_old_check)) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'SCORE_AUDIT_PRE_SCORE_DEFINITION_DRIFT';
    END IF;

    -- The component JSON keeps its original precision. The pre-score column stores four decimal places.
    EXECUTE pg_catalog.replace(
        v_definition, v_old_check,
        'AND source.pre_score = pg_catalog.round(' || v_component_sum || ', 4)'
    );
END;
$migration$;

COMMIT;
