-- v2.9/v2.10 gender triage stores one durable scheduler envelope per microbatch,
-- while candidate rows retain the canonical hash of their own assessment.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.analysis_v2_ai_canonical_json_text(
    p_value JSONB,
    p_depth INTEGER DEFAULT 0
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
    v_result TEXT;
BEGIN
    IF p_depth NOT BETWEEN 0 AND 32
       OR pg_catalog.octet_length(p_value::TEXT) > 262144 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_CANONICAL_JSON_INVALID',
            ERRCODE = 'P0001';
    END IF;

    CASE pg_catalog.jsonb_typeof(p_value)
        WHEN 'object' THEN
            SELECT '{' || COALESCE(pg_catalog.string_agg(
                pg_catalog.to_jsonb(entry.key)::TEXT || ':'
                    || public.analysis_v2_ai_canonical_json_text(
                        entry.value,
                        p_depth + 1
                    ),
                ',' ORDER BY entry.key
            ), '') || '}'
            INTO v_result
            FROM pg_catalog.jsonb_each(p_value) AS entry(key, value);
        WHEN 'array' THEN
            SELECT '[' || COALESCE(pg_catalog.string_agg(
                public.analysis_v2_ai_canonical_json_text(
                    entry.value,
                    p_depth + 1
                ),
                ',' ORDER BY entry.ordinality
            ), '') || ']'
            INTO v_result
            FROM pg_catalog.jsonb_array_elements(p_value)
                WITH ORDINALITY AS entry(value, ordinality);
        ELSE
            v_result := p_value::TEXT;
    END CASE;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_canonical_json_text(JSONB, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_gender_scheduler_contains_hash(
    p_result JSONB,
    p_expected_operation_key TEXT,
    p_result_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
BEGIN
    IF p_expected_operation_key !~ '^gender-triage:[a-f0-9]{64}$'
       OR p_result_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_result) <> 'object'
       OR NOT p_result ?& ARRAY['operationKey', 'results']
       OR (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(p_result)
       ) <> 2
       OR pg_catalog.jsonb_typeof(p_result->'operationKey') <> 'string'
       OR p_result->>'operationKey' IS DISTINCT FROM p_expected_operation_key
       OR pg_catalog.jsonb_typeof(p_result->'results') <> 'array'
       OR pg_catalog.jsonb_array_length(p_result->'results') NOT BETWEEN 1 AND 64
       OR pg_catalog.octet_length(p_result::TEXT) > 524288 THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_result->'results') AS item(value)
        WHERE item.value->>'source' IN ('checkpoint', 'safe_fallback')
          AND pg_catalog.jsonb_typeof(item.value->'result'->'assessment') = 'object'
          AND pg_catalog.encode(
                extensions.digest(
                    pg_catalog.convert_to(
                        'analysis-v2-ai-result-content:v1',
                        'UTF8'
                    )
                        || pg_catalog.decode('00', 'hex')
                        || pg_catalog.convert_to(
                            public.analysis_v2_ai_canonical_json_text(
                                item.value->'result'->'assessment'
                            ),
                            'UTF8'
                        ),
                    'sha256'
                ),
                'hex'
          ) = p_result_hash
    );
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_gender_scheduler_contains_hash(JSONB, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_function pg_catalog.regprocedure;
    v_definition TEXT;
    v_rewritten TEXT;
    v_alias TEXT;
    v_select_indent TEXT;
    v_and_indent TEXT;
    v_old TEXT;
    v_new TEXT;
BEGIN
    FOREACH v_function IN ARRAY ARRAY[
        'public.analysis_v2_checkpoint_candidate_features_complete_v26(uuid,text,uuid,text,integer,integer,jsonb)'::pg_catalog.regprocedure,
        'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'::pg_catalog.regprocedure
    ] LOOP
        SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
        v_alias := CASE
            WHEN v_function::TEXT LIKE '%_v26(%' THEN 'ai_result'
            ELSE 'result'
        END;
        v_select_indent := CASE WHEN v_alias = 'ai_result'
            THEN '                        ' ELSE '                ' END;
        v_and_indent := CASE WHEN v_alias = 'ai_result'
            THEN '                          ' ELSE '                  ' END;
        v_old := 'NOT EXISTS (' || pg_catalog.chr(10)
            || v_select_indent || 'SELECT 1'
            || CASE WHEN v_alias = 'ai_result' THEN ' FROM' ELSE pg_catalog.chr(10)
                || v_select_indent || 'FROM' END
            || ' public.analysis_v2_ai_result_checkpoints AS ' || v_alias
            || pg_catalog.chr(10)
            || v_select_indent || 'WHERE ' || v_alias || '.request_id = p_request_id'
            || pg_catalog.chr(10)
            || v_and_indent || 'AND ' || v_alias || '.job_key = p_job_key'
            || pg_catalog.chr(10)
            || v_and_indent || 'AND ' || v_alias
            || '.operation_key = item.value->>''genderOperationKey'''
            || pg_catalog.chr(10)
            || v_and_indent || 'AND ' || v_alias || '.stage = ''genderTriage'''
            || pg_catalog.chr(10)
            || v_and_indent || 'AND ' || v_alias
            || '.result_hash = item.value->>''genderResultHash'''
            || pg_catalog.chr(10)
            || CASE WHEN v_alias = 'ai_result'
                THEN '                    ' ELSE '          ' END || ')';
        v_new := '(' || v_old || pg_catalog.chr(10)
            || '                    AND NOT EXISTS (' || pg_catalog.chr(10)
            || '                        SELECT 1' || pg_catalog.chr(10)
            || '                        FROM public.analysis_v2_scheduler_operations AS scheduler'
            || pg_catalog.chr(10)
            || '                        WHERE scheduler.request_id = p_request_id'
            || pg_catalog.chr(10)
            || '                          AND scheduler.job_key = p_job_key'
            || pg_catalog.chr(10)
            || '                          AND scheduler.operation_key'
            || pg_catalog.chr(10)
            || '                              = item.value->>''genderOperationKey'''
            || pg_catalog.chr(10)
            || '                          AND scheduler.stage = ''genderTriage'''
            || pg_catalog.chr(10)
            || '                          AND scheduler.status = ''ready'''
            || pg_catalog.chr(10)
            || '                          AND public.analysis_v2_gender_scheduler_contains_hash('
            || pg_catalog.chr(10)
            || '                              scheduler.result_json,' || pg_catalog.chr(10)
            || '                              item.value->>''genderOperationKey'',' || pg_catalog.chr(10)
            || '                              item.value->>''genderResultHash''' || pg_catalog.chr(10)
            || '                          )' || pg_catalog.chr(10)
            || '                    ))';
        v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
        IF v_rewritten = v_definition THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_GENDER_MICROBATCH_LINEAGE_MIGRATION_DRIFT_' || v_alias,
                ERRCODE = 'P0001';
        END IF;
        EXECUTE v_rewritten;
    END LOOP;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_checkpoint_candidate_features_complete_v26(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
