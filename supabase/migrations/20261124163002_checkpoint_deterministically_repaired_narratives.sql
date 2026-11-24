BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.analysis_v2_ai_result_checkpoints
    DROP CONSTRAINT analysis_v2_ai_result_checkpoint_source_check,
    ADD CONSTRAINT analysis_v2_ai_result_checkpoint_source_check CHECK (
        (source = 'generated' AND attempt BETWEEN 1 AND 4 AND reservation_token IS NOT NULL)
        OR (source = 'global_cache' AND cache_scope = 'global_ttl'
            AND stage IN ('genderTriage', 'featureAnalysis')
            AND attempt IS NULL AND reservation_token IS NULL)
        OR (source = 'deterministic_repair' AND cache_scope = 'request'
            AND stage = 'highRiskNarrative' AND job_key = 'track:narratives:batch:0'
            AND attempt BETWEEN 1 AND 4 AND reservation_token IS NOT NULL)
    );

-- Preserve the existing attempt/result lock order and fenced telemetry-only
-- outcome in both callers. Only the approved request-local narrative repair
-- may store a checkpoint from a rejected provider attempt.
DO $migration$
DECLARE
    v_terminalizer CONSTANT REGPROCEDURE :=
        'public.terminalize_analysis_v2_ai_attempt_with_result(uuid,text,uuid,text,smallint,uuid,jsonb,jsonb,jsonb,text,text)';
    v_serializer CONSTANT REGPROCEDURE :=
        'public.analysis_v2_ai_result_checkpoint_json(public.analysis_v2_ai_result_checkpoints)';
    v_generated CONSTANT TEXT := $anchor$'generated'$anchor$;
    v_success CONSTANT TEXT := $anchor$'success'$anchor$;
    v_serialize_join CONSTANT TEXT := $anchor$ON p_checkpoint.source = 'generated'$anchor$;
    v_terminalizer_name CONSTANT TEXT := 'public.terminalize_analysis_v2_ai_attempt_with_result';
    v_args TEXT := pg_catalog.pg_get_function_arguments(v_terminalizer);
    v_definition TEXT;
    v_body TEXT;
BEGIN
    SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_terminalizer;
    IF pg_catalog.length(v_body) - pg_catalog.length(pg_catalog.replace(v_body, v_generated, ''))
            <> 2 * pg_catalog.length(v_generated)
       OR pg_catalog.length(v_body) - pg_catalog.length(pg_catalog.replace(v_body, v_success, ''))
            <> pg_catalog.length(v_success)
       OR pg_catalog.strpos(v_body, 'v_attempt := public.analysis_v2_terminalize_ai_attempt_internal(') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_NARRATIVE_REPAIR_TERMINALIZER_DRIFT';
    END IF;
    v_definition := pg_catalog.pg_get_functiondef(v_terminalizer);
    IF pg_catalog.strpos(v_definition, v_terminalizer_name || '(' || v_args || ')') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_NARRATIVE_REPAIR_SIGNATURE_DRIFT';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition, v_terminalizer_name || '(' || v_args || ')',
        'public.analysis_v2_terminalize_ai_result_with_source(' || v_args || ', p_checkpoint_source text)'
    );
    v_definition := pg_catalog.replace(v_definition, v_generated, 'p_checkpoint_source');
    v_definition := pg_catalog.replace(v_definition, v_success,
        $source$CASE WHEN p_checkpoint_source = 'deterministic_repair' THEN 'response_rejected' ELSE 'success' END$source$);
    EXECUTE v_definition;

    SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_serializer;
    IF pg_catalog.length(v_body) - pg_catalog.length(pg_catalog.replace(v_body, v_serialize_join, ''))
            <> pg_catalog.length(v_serialize_join) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_NARRATIVE_REPAIR_SERIALIZER_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_serializer), v_serialize_join,
        $source$ON p_checkpoint.source IN ('generated', 'deterministic_repair')$source$);
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_terminalize_ai_result_with_source(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.terminalize_analysis_v2_ai_attempt_with_result(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_telemetry JSONB,
    p_result_identity JSONB,
    p_result JSONB,
    p_result_canonical TEXT,
    p_result_hash TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_terminalize_ai_result_with_source(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_attempt, p_reservation_token,
        p_telemetry, p_result_identity, p_result, p_result_canonical, p_result_hash, 'generated'
    );
$$;

CREATE FUNCTION public.terminalize_analysis_v2_repaired_narrative(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_telemetry JSONB,
    p_result_identity JSONB,
    p_result JSONB,
    p_result_canonical TEXT,
    p_result_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_job_key IS DISTINCT FROM 'track:narratives:batch:0'
       OR p_result_identity->>'stage' IS DISTINCT FROM 'highRiskNarrative'
       OR p_result_identity->>'cache_scope' IS DISTINCT FROM 'request'
       OR NOT EXISTS (
           SELECT 1 FROM public.analysis_requests AS request
           WHERE request.id = p_request_id
             AND request.pipeline_version = 'v2'
             AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_AI_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_terminalize_ai_result_with_source(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_attempt, p_reservation_token,
        p_telemetry, p_result_identity, p_result, p_result_canonical, p_result_hash, 'deterministic_repair'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_repaired_narrative(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_repaired_narrative(
    UUID, TEXT, UUID, TEXT, SMALLINT, UUID, JSONB, JSONB, JSONB, TEXT, TEXT
) TO service_role;

COMMENT ON TABLE public.analysis_v2_ai_result_checkpoints IS
    'Service-only request result snapshots. Generated results and explicit deterministic repairs are committed atomically with the original Gemini attempt disposition.';

COMMIT;
