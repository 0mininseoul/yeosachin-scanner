-- Physical slots and provider admissions can be released at different times.
-- Rank free slots with no pending paid admission first. The admission RPC
-- still checks the current global and per-slot limits before any model call.
DO $migration$
DECLARE
    allocator regprocedure := 'public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)'::regprocedure;
    old_order constant text := $old$    WHERE lease.state = 'available'
    ORDER BY lease.slot
    LIMIT 1
    FOR UPDATE;$old$;
    new_order constant text := $new$    WHERE lease.state = 'available'
    ORDER BY EXISTS (
        SELECT 1 FROM public.analysis_provider_admission_leases AS admission
        WHERE admission.workload_role = 'paid' AND admission.logical_provider = 'gemini'
          AND admission.credential_slot = 'gemini-' || lease.slot::text
          AND admission.state IN ('leased', 'recovery_required')
    ), lease.slot
    LIMIT 1
    FOR UPDATE;$new$;
    body text;
    original text;
BEGIN
    SELECT prosrc INTO STRICT body FROM pg_catalog.pg_proc WHERE oid = allocator;
    original := pg_catalog.replace(body, new_order, old_order);
    IF pg_catalog.md5(original) <> 'c879d5c8cce5ad6bc1f71fe3de4d4bbe'
        OR pg_catalog.strpos(original, old_order) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_GEMINI_ALLOCATOR_DRIFT';
    END IF;
    IF body = original THEN
        EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(allocator), old_order, new_order);
    END IF;
END;
$migration$;
