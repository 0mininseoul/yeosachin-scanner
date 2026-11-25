-- Take the destination request before either delegated resolver can lock its job.
-- The PFE successor shortcuts run before this private wrapper.
-- The two delegated resolvers retain every identity, source and claim fence.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

DO $parent_fence$
DECLARE
    signature regprocedure := 'public.resolve_analysis_v2_recovery_provider_run_pre_pfe(uuid,text,uuid,text,text,text,text,text,numeric)'::regprocedure;
    baseline_hash constant text := '01f3e448e77ff8bec96c8ed79227d9648f70b941be9001c895602d986c00b3bd';
    before_call constant text := 'BEGIN
    v_existing := public.resolve_analysis_v2_recovery_provider_run_pre_first15(';
    with_parent_fence constant text := 'BEGIN
    PERFORM 1 FROM public.analysis_requests AS request WHERE request.id = p_request_id FOR UPDATE;
    v_existing := public.resolve_analysis_v2_recovery_provider_run_pre_first15(';
    body text;
BEGIN
    IF pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', signature, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Unexpected recovery resolver access';
    END IF;
    SELECT prosrc INTO STRICT body FROM pg_catalog.pg_proc
    WHERE oid = signature AND prosecdef AND proconfig = ARRAY['search_path=""'];
    IF strpos(body, with_parent_fence) <> 0 AND
        encode(sha256(convert_to(replace(body, with_parent_fence, before_call), 'UTF8')), 'hex') = baseline_hash THEN
        RETURN;
    END IF;
    IF encode(sha256(convert_to(body, 'UTF8')), 'hex') <> baseline_hash OR strpos(body, before_call) = 0 THEN
        RAISE EXCEPTION 'Unexpected recovery resolver definition';
    END IF;
    EXECUTE replace(pg_get_functiondef(signature), before_call, with_parent_fence);
END;
$parent_fence$;

COMMIT;
