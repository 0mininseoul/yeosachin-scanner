-- 06000 widened evidence validation to immutable adopted provider runs, but its
-- boolean replacement removed the SELECT INTO that populated the provider-run
-- composite used later by both evidence writers. Reload and lock the exact row
-- after validation so all existing credential-slot and provenance checks retain
-- their original semantics.
CREATE FUNCTION public.analysis_v2_load_provider_evidence_source(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_provider TEXT,
    p_run_id TEXT,
    p_credential_slot TEXT DEFAULT NULL
)
RETURNS public.analysis_v2_provider_runs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.analysis_v2_provider_runs%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    SELECT job.* INTO STRICT v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_source
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
      AND provider_run.job_claim_token = p_claim_token
      AND provider_run.input_hash = p_input_hash
      AND provider_run.logical_provider = p_provider
      AND provider_run.run_id = p_run_id
      AND provider_run.status = 'succeeded'
      AND (
          p_credential_slot IS NULL
          OR provider_run.credential_slot = p_credential_slot
      )
    FOR UPDATE OF provider_run;
    IF FOUND THEN
        IF EXISTS (
            SELECT 1
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = p_request_id
              AND adoption.job_key = p_job_key
              AND adoption.operation_key = p_operation_key
              AND adoption.destination_input_hash = p_input_hash
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID',
                ERRCODE = 'P0001';
        END IF;
        RETURN v_source;
    END IF;

    SELECT provider_run.* INTO STRICT v_source
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    JOIN public.analysis_v2_provider_runs AS provider_run
      ON provider_run.request_id = adoption.source_request_id
     AND provider_run.job_key = adoption.source_job_key
     AND provider_run.operation_key = adoption.source_operation_key
     AND provider_run.run_id = adoption.source_run_id
    WHERE adoption.request_id = p_request_id
      AND adoption.job_key = p_job_key
      AND adoption.operation_key = p_operation_key
      AND adoption.destination_input_hash = p_input_hash
      AND provider_run.logical_provider = p_provider
      AND provider_run.run_id = p_run_id
      AND provider_run.status = 'succeeded'
      AND provider_run.actual_usage_usd IS NOT NULL
      AND provider_run.usage_reconciled_at IS NOT NULL
      AND (
          p_credential_slot IS NULL
          OR provider_run.credential_slot = p_credential_slot
      )
    FOR UPDATE OF provider_run;
    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS direct_run
        WHERE direct_run.request_id = p_request_id
          AND direct_run.job_key = p_job_key
          AND direct_run.operation_key = p_operation_key
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    RETURN v_source;
EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID',
            ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_load_provider_evidence_source(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
    v_marker INTEGER;
    v_end INTEGER;
    v_injection TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_relationship_side(uuid,text,uuid,text,text,integer,text,text,text,text,text,jsonb)'::pg_catalog.regprocedure
    );
    v_marker := pg_catalog.strpos(
        v_definition, 'IF NOT public.analysis_v2_valid_provider_evidence_source('
    );
    IF v_marker = 0 OR pg_catalog.strpos(
        pg_catalog.substr(v_definition, v_marker + 1),
        'IF NOT public.analysis_v2_valid_provider_evidence_source('
    ) > 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_RELATIONSHIP_MARKER_MISMATCH';
    END IF;
    v_end := v_marker - 1 + pg_catalog.strpos(
        pg_catalog.substr(v_definition, v_marker), '    END IF;'
    ) + pg_catalog.length('    END IF;');
    IF v_end <= v_marker THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_RELATIONSHIP_END_MISMATCH';
    END IF;
    v_injection := pg_catalog.chr(10) || $sql$
    SELECT source.* INTO STRICT v_provider_run
    FROM public.analysis_v2_load_provider_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
        p_input_hash, p_provider, p_provider_run_id, NULL
    ) AS source;$sql$;
    v_rewritten := pg_catalog.substr(v_definition, 1, v_end)
        || v_injection || pg_catalog.substr(v_definition, v_end + 1);
    IF pg_catalog.strpos(
        v_rewritten, 'INTO STRICT v_provider_run'
    ) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_RELATIONSHIP_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;

    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_target_evidence(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure
    );
    v_rewritten := v_definition;
    IF (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
            v_definition,
            'IF NOT public.analysis_v2_valid_provider_evidence_source(',
            ''
        ))
    ) / pg_catalog.length(
        'IF NOT public.analysis_v2_valid_provider_evidence_source('
    ) <> 2 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_TARGET_MARKER_COUNT_MISMATCH';
    END IF;

    v_marker := pg_catalog.strpos(
        v_rewritten,
        'IF NOT public.analysis_v2_valid_provider_evidence_source('
    );
    v_end := v_marker - 1 + pg_catalog.strpos(
        pg_catalog.substr(v_rewritten, v_marker), '        END IF;'
    ) + pg_catalog.length('        END IF;');
    IF v_marker = 0 OR v_end <= v_marker THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_LIKER_MARKER_MISMATCH';
    END IF;
    v_injection := pg_catalog.chr(10) || $sql$
        SELECT source.* INTO STRICT v_liker_provider_run
        FROM public.analysis_v2_load_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_liker_source->>'provider_operation_key',
            p_liker_source->>'input_hash', p_liker_source->>'provider',
            p_liker_source->>'provider_run_id',
            p_liker_source->>'provider_credential_slot'
        ) AS source;$sql$;
    v_rewritten := pg_catalog.substr(v_rewritten, 1, v_end)
        || v_injection || pg_catalog.substr(v_rewritten, v_end + 1);

    v_marker := pg_catalog.strpos(
        pg_catalog.substr(v_rewritten, v_end + pg_catalog.length(v_injection)),
        'IF NOT public.analysis_v2_valid_provider_evidence_source('
    ) + v_end + pg_catalog.length(v_injection) - 1;
    v_end := v_marker - 1 + pg_catalog.strpos(
        pg_catalog.substr(v_rewritten, v_marker), '        END IF;'
    ) + pg_catalog.length('        END IF;');
    IF v_marker <= 0 OR v_end <= v_marker THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_COMMENT_MARKER_MISMATCH';
    END IF;
    v_injection := pg_catalog.chr(10) || $sql$
        SELECT source.* INTO STRICT v_comment_provider_run
        FROM public.analysis_v2_load_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_comment_source->>'provider_operation_key',
            p_comment_source->>'input_hash', p_comment_source->>'provider',
            p_comment_source->>'provider_run_id',
            p_comment_source->>'provider_credential_slot'
        ) AS source;$sql$;
    v_rewritten := pg_catalog.substr(v_rewritten, 1, v_end)
        || v_injection || pg_catalog.substr(v_rewritten, v_end + 1);
    IF pg_catalog.strpos(v_rewritten, 'INTO STRICT v_liker_provider_run') = 0
       OR pg_catalog.strpos(v_rewritten, 'INTO STRICT v_comment_provider_run') = 0
       OR (
            pg_catalog.length(v_rewritten)
            - pg_catalog.length(pg_catalog.replace(
                v_rewritten, 'INTO STRICT v_liker_provider_run', ''
            ))
       ) / pg_catalog.length('INTO STRICT v_liker_provider_run') <> 1
       OR (
            pg_catalog.length(v_rewritten)
            - pg_catalog.length(pg_catalog.replace(
                v_rewritten, 'INTO STRICT v_comment_provider_run', ''
            ))
       ) / pg_catalog.length('INTO STRICT v_comment_provider_run') <> 1 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_COMPOSITE_TARGET_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
), public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
), public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) TO service_role;
