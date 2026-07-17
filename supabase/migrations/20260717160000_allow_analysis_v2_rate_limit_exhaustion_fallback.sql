-- Keep deterministic fallback persistence aligned with the worker's four-attempt Gemini policy.
-- A generated-response rejection remains sufficient. Rate-limit exhaustion is accepted only when
-- the durable ledger contains attempts 1..4, every attempt is terminal rate_limited, and immutable
-- generation metadata did not drift between attempts.

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_fallback_evidence_matches(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_stage TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_attempts AS rejected_attempt
        WHERE rejected_attempt.request_id = p_request_id
          AND rejected_attempt.job_key = p_job_key
          AND rejected_attempt.operation_key = p_operation_key
          AND rejected_attempt.stage = p_stage
          AND rejected_attempt.status = 'response_rejected'
    ) OR COALESCE((
        SELECT pg_catalog.count(*) = 4
           AND pg_catalog.count(DISTINCT exhausted_attempt.attempt) = 4
           AND pg_catalog.min(exhausted_attempt.attempt) = 1
           AND pg_catalog.max(exhausted_attempt.attempt) = 4
           AND pg_catalog.bool_and(
                exhausted_attempt.status = 'rate_limited'
                AND exhausted_attempt.terminalized_at IS NOT NULL
                AND exhausted_attempt.retry_count = exhausted_attempt.attempt - 1
           )
           AND pg_catalog.count(DISTINCT ROW(
                exhausted_attempt.model_name,
                exhausted_attempt.location,
                exhausted_attempt.thinking_level,
                exhausted_attempt.media_count,
                exhausted_attempt.media_resolution,
                exhausted_attempt.prompt_version,
                exhausted_attempt.schema_version,
                exhausted_attempt.max_output_tokens
           )) = 1
        FROM public.analysis_v2_ai_attempts AS exhausted_attempt
        WHERE exhausted_attempt.request_id = p_request_id
          AND exhausted_attempt.job_key = p_job_key
          AND exhausted_attempt.operation_key = p_operation_key
          AND exhausted_attempt.stage = p_stage
    ), FALSE);
$$;

COMMENT ON FUNCTION public.analysis_v2_ai_fallback_evidence_matches(UUID, TEXT, TEXT, TEXT)
    IS 'Internal evidence gate for deterministic V2 AI fallbacks; accepts response rejection or exact terminal 4x429 exhaustion.';

REVOKE ALL ON FUNCTION public.analysis_v2_ai_fallback_evidence_matches(
    UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := 'ai_attempt.status = ''response_rejected''';
    v_new TEXT := $replacement$public.analysis_v2_ai_fallback_evidence_matches(
                      p_request_id,
                      p_job_key,
                      p_operation_key,
                      'privateAccountName'
                  )$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_private_names(uuid,text,uuid,text,integer,text,text,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PRIVATE_RATE_LIMIT_FALLBACK_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := 'ai_attempt.status = ''response_rejected''';
    v_new TEXT := $replacement$public.analysis_v2_ai_fallback_evidence_matches(
                      p_request_id,
                      p_job_key,
                      item.value->>'operationKey',
                      'highRiskNarrative'
                  )$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_narratives(uuid,text,uuid,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_NARRATIVE_RATE_LIMIT_FALLBACK_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := 'ai_attempt.status = ''response_rejected''';
    v_new TEXT := $replacement$public.analysis_v2_ai_fallback_evidence_matches(
                      p_request_id,
                      p_partner_job_key,
                      p_value->>'operationKey',
                      'partnerSafety'
                  )$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_result_partner_safety_row_matches(uuid,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PARTNER_RATE_LIMIT_FALLBACK_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;
