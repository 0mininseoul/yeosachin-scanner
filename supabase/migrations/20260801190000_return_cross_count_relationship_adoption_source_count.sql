-- The relationship adapter may only truncate a previously reconciled Dataset
-- when the cross-count resolver proves its exact source declared count. The
-- exact-identity resolver continues to return no such key and stays fail-closed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $resolver_patch$
DECLARE
    v_signature TEXT :=
        'public.resolve_analysis_v2_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old_return TEXT :=
        '        ''actualUsageUsd'', v_source.actual_usage_usd,' || pg_catalog.chr(10)
        || '        ''usageReconciledAt'', v_source.usage_reconciled_at' || pg_catalog.chr(10)
        || '    );';
    v_new_return TEXT :=
        '        ''actualUsageUsd'', v_source.actual_usage_usd,' || pg_catalog.chr(10)
        || '        ''usageReconciledAt'', v_source.usage_reconciled_at,' || pg_catalog.chr(10)
        || '        ''relationshipSourceDeclaredCount'', v_source_count' || pg_catalog.chr(10)
        || '    );';
    v_security_definer BOOLEAN;
    v_safe_search_path BOOLEAN;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(proc.oid), proc.prosecdef,
        COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
    INTO v_definition, v_security_definer, v_safe_search_path
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;

    IF NOT COALESCE(v_security_definer, FALSE)
       OR NOT COALESCE(v_safe_search_path, FALSE)
       OR pg_catalog.strpos(v_definition, 'RETURN v_exact;') = 0
       OR pg_catalog.strpos(v_definition, 'v_source_count := CASE v_side') = 0
       OR pg_catalog.strpos(v_definition, 'IF v_source_count = v_current_count THEN') = 0
       OR pg_catalog.strpos(v_definition, v_old_return) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_SHAPE_MISMATCH';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_old_return, v_new_return);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, v_old_return) > 0
       OR pg_catalog.strpos(v_rewritten, v_new_return) = 0
       OR pg_catalog.strpos(v_rewritten, 'RETURN v_exact;') = 0
       OR pg_catalog.strpos(v_rewritten, 'v_source_count := CASE v_side') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$resolver_patch$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

COMMIT;
