-- Selfhosted target receipts use the authenticated receipt ledger. Do not run
-- the paid provider-run validator before either authenticated source loader.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
    v_liker_old CONSTANT TEXT := $liker_old$        IF NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_liker_source->>'provider_operation_key',
            p_liker_source->>'input_hash', p_liker_source->>'provider',
            p_liker_source->>'provider_run_id',
            p_liker_source->>'provider_credential_slot'
        ) THEN$liker_old$;
    v_liker_new CONSTANT TEXT := $liker_new$        IF p_liker_source->>'provider' <> 'selfhosted_auth'
           AND NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_liker_source->>'provider_operation_key',
            p_liker_source->>'input_hash', p_liker_source->>'provider',
            p_liker_source->>'provider_run_id',
            p_liker_source->>'provider_credential_slot'
        ) THEN$liker_new$;
    v_comment_old CONSTANT TEXT := $comment_old$        IF NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_comment_source->>'provider_operation_key',
            p_comment_source->>'input_hash', p_comment_source->>'provider',
            p_comment_source->>'provider_run_id',
            p_comment_source->>'provider_credential_slot'
        ) THEN$comment_old$;
    v_comment_new CONSTANT TEXT := $comment_new$        IF p_comment_source->>'provider' <> 'selfhosted_auth'
           AND NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_comment_source->>'provider_operation_key',
            p_comment_source->>'input_hash', p_comment_source->>'provider',
            p_comment_source->>'provider_run_id',
            p_comment_source->>'provider_credential_slot'
        ) THEN$comment_new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_target_evidence(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, $marker$IF p_liker_source->>'provider' <> 'selfhosted_auth'$marker$) > 0
       AND pg_catalog.strpos(v_definition, $marker$IF p_comment_source->>'provider' <> 'selfhosted_auth'$marker$) > 0 THEN
        RETURN;
    END IF;
    IF pg_catalog.strpos(v_definition, v_liker_old) = 0
       OR pg_catalog.strpos(v_definition, v_comment_old) = 0 THEN
        RAISE EXCEPTION 'SELFHOSTED_AUTH_TARGET_PRECHECK_PATCH_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_liker_old, v_liker_new);
    v_rewritten := pg_catalog.replace(v_rewritten, v_comment_old, v_comment_new);
    EXECUTE v_rewritten;
END;
$migration$;
