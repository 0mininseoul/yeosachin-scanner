-- Keep producer topology hashes and consumer job hashes in their separate domains, and
-- require durable media bundles only for classifications that retain bundle-backed features.

DO $migration$
DECLARE
    v_definition TEXT;
    v_private_old TEXT := '      AND topology.input_hash = p_job_input_hash';
    v_private_new TEXT := '';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_private_names(uuid,text,uuid,text,integer,text,text,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_private_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_private_old)
                    + pg_catalog.char_length(v_private_old)
            ),
            v_private_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRIVATE_CHECKPOINT_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_private_old, v_private_new);
END;
$migration$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_candidate_old TEXT := $candidate_old$                    OR NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_media_artifacts AS artifact
                        WHERE artifact.request_id = p_request_id
                          AND artifact.artifact_kind = 'media_bundle'
                          AND artifact.artifact_key = pg_catalog.encode(
                              extensions.digest(
                                  pg_catalog.convert_to(
                                      'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10)
                                          || (item.value->'mediaContext'->>'bundleId'),
                                      'UTF8'
                                  ),
                                  'sha256'
                              ),
                              'hex'
                          )
                    )$candidate_old$;
    v_candidate_new TEXT := $candidate_new$                    OR (
                        item.value->>'classification' = 'verified_female'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM public.analysis_v2_media_artifacts AS artifact
                            WHERE artifact.request_id = p_request_id
                              AND artifact.artifact_kind = 'media_bundle'
                              AND artifact.artifact_key = pg_catalog.encode(
                                  extensions.digest(
                                      pg_catalog.convert_to(
                                          'analysis-v2-media-bundle-key:v1'
                                              || pg_catalog.chr(10)
                                              || (item.value->'mediaContext'->>'bundleId'),
                                          'UTF8'
                                      ),
                                      'sha256'
                                  ),
                                  'hex'
                              )
                        )
                    )$candidate_new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_candidate_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_candidate_old)
                    + pg_catalog.char_length(v_candidate_old)
            ),
            v_candidate_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_CANDIDATE_CHECKPOINT_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_candidate_old, v_candidate_new);
END;
$migration$;
