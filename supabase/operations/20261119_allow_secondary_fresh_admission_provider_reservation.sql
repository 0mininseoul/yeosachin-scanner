-- Apply this file only to the verified production database via scoped SQL.
-- Permit the explicit paid secondary credential through the fresh-admission
-- wrapper. The private implementation still validates ownership, the live
-- admission claim, and the held beta slot. The automatic pool remains free-only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $fresh_admission$
DECLARE
    outer_signature constant text :=
        'public.reserve_analysis_v2_fresh_admission_provider_run(uuid,integer,uuid,text,text,numeric)';
    inner_signature constant text :=
        'public.reserve_analysis_v2_fresh_admission_provider_run_fixed_20260904(uuid,integer,uuid,text,text,numeric)';
    original_source_hash constant text := '3f3238be473c58fddad3a96ddd03180d';
    fixed_source_hash constant text := 'c9854e376e4c703355d900e0c97ed7cd';
    inner_source_hash constant text := '73fdf00040c47d090a547da9ffa0ec7e';
    original_guard constant text :=
        'OR NOT public.analysis_beta_valid_apify_credential_slot(v_slot) THEN';
    fixed_guard constant text := $guard$OR (p_credential_slot IS DISTINCT FROM 'secondary'
           AND NOT public.analysis_beta_valid_apify_credential_slot(v_slot)) THEN$guard$;
    before_function pg_catalog.pg_proc%ROWTYPE;
    after_function pg_catalog.pg_proc%ROWTYPE;
BEGIN
    SELECT * INTO before_function FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure(outer_signature);
    IF NOT FOUND OR NOT before_function.prosecdef
        OR before_function.proowner <> pg_catalog.to_regrole('postgres')
        OR before_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR pg_catalog.md5(before_function.prosrc) NOT IN (original_source_hash, fixed_source_hash)
        OR NOT pg_catalog.has_function_privilege('service_role', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('anon', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', before_function.oid, 'EXECUTE')
        OR EXISTS (
            SELECT FROM pg_catalog.aclexplode(before_function.proacl) AS grant_row
            WHERE grant_row.grantee NOT IN (before_function.proowner, pg_catalog.to_regrole('service_role'))
        )
        OR NOT EXISTS (
            SELECT FROM pg_catalog.pg_proc AS inner_function
            WHERE inner_function.oid = pg_catalog.to_regprocedure(inner_signature)
              AND inner_function.prosecdef
              AND inner_function.proowner = before_function.proowner
              AND inner_function.proconfig = ARRAY['search_path=""', 'lock_timeout=5s', 'statement_timeout=2min']
              AND pg_catalog.md5(inner_function.prosrc) = inner_source_hash
              AND NOT pg_catalog.has_function_privilege('service_role', inner_function.oid, 'EXECUTE')
              AND NOT pg_catalog.has_function_privilege('anon', inner_function.oid, 'EXECUTE')
              AND NOT pg_catalog.has_function_privilege('authenticated', inner_function.oid, 'EXECUTE')
              AND NOT EXISTS (
                  SELECT FROM pg_catalog.aclexplode(inner_function.proacl) AS grant_row
                  WHERE grant_row.grantee <> inner_function.proowner
              )
        ) THEN
        RAISE EXCEPTION 'FRESH_ADMISSION_SECONDARY_BASELINE_MISMATCH';
    END IF;

    IF pg_catalog.md5(before_function.prosrc) = original_source_hash THEN
        EXECUTE pg_catalog.replace(
            pg_catalog.pg_get_functiondef(before_function.oid),
            original_guard,
            fixed_guard
        );
    END IF;

    SELECT * INTO after_function FROM pg_catalog.pg_proc WHERE oid = before_function.oid;
    IF NOT FOUND OR NOT after_function.prosecdef
        OR pg_catalog.md5(after_function.prosrc) <> fixed_source_hash
        OR after_function.proowner IS DISTINCT FROM before_function.proowner
        OR after_function.proacl IS DISTINCT FROM before_function.proacl
        OR after_function.proconfig IS DISTINCT FROM before_function.proconfig THEN
        RAISE EXCEPTION 'FRESH_ADMISSION_SECONDARY_PATCH_UNVERIFIED';
    END IF;
END;
$fresh_admission$;

COMMIT;
