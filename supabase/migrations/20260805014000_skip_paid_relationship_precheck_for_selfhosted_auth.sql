-- Selfhosted Auth relationship evidence has its own receipt ledger and loader.
-- Do not run the paid-provider validator before that branch; it only accepts
-- the paid ledger providers and rejects an otherwise valid auth receipt.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
    v_old TEXT := $old$    IF NOT public.analysis_v2_valid_provider_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
        p_input_hash, p_provider, p_provider_run_id, NULL
    ) THEN$old$;
    v_new TEXT := $new$    IF p_provider <> 'selfhosted_auth'
       AND NOT public.analysis_v2_valid_provider_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
        p_input_hash, p_provider, p_provider_run_id, NULL
    ) THEN$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_relationship_side(uuid,text,uuid,text,text,integer,text,text,text,text,text,jsonb)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_definition, $marker$IF p_provider <> 'selfhosted_auth'$marker$) > 0 THEN
        RETURN;
    END IF;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_RELATIONSHIP_PRECHECK_PATCH_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF pg_catalog.strpos(v_rewritten, v_old) > 0
       OR pg_catalog.strpos(v_rewritten, v_new) = 0 THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_RELATIONSHIP_PRECHECK_PATCH_NOT_EXACT';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;
