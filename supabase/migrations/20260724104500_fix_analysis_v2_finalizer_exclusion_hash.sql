-- The DAG scope and relationship manifest intentionally hash the same exclusion
-- decision under different domains. Comparing those hashes wedges every otherwise
-- complete result at ANALYSIS_V2_RESULT_NOT_READY. Validate the DAG scope against
-- its own canonical request-snapshot hash instead.

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT :=
        'scope.exclusion_decision_hash = v_relationship.exclusion_decision_hash';
    v_new TEXT := $replacement$
scope.exclusion_decision_hash = public.analysis_v2_dag_hash_json(
                    pg_catalog.jsonb_build_object(
                        'domain', 'analysis-v2-exclusion-decision-v1',
                        'requestId', p_request_id,
                        'decision', v_request.exclusion_decision_snapshot,
                        'excludedInstagramId', v_request.excluded_instagram_id
                    )
              )$replacement$;
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
            MESSAGE = 'ANALYSIS_V2_FINALIZER_EXCLUSION_HASH_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT :=
        'relationship.exclusion_decision_hash';
    v_new TEXT := $replacement$
public.analysis_v2_dag_hash_json(
                                pg_catalog.jsonb_build_object(
                                    'domain', 'analysis-v2-exclusion-decision-v1',
                                    'requestId', p_request_id,
                                    'decision',
                                        request_row.exclusion_decision_snapshot,
                                    'excludedInstagramId',
                                        request_row.excluded_instagram_id
                                )
                          )$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_finalizer_readiness(uuid)'
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
            MESSAGE = 'ANALYSIS_V2_FINALIZER_EXCLUSION_HASH_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;
