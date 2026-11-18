-- Apply only to the registered Dev database through the isolated linked checkout.
-- The reviewed baseline's wrapper rejects paid secondary before the inner
-- function can verify live admission ownership. Keep the inner function and ACLs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
DECLARE
    outer_signature constant text :=
        'public.reserve_analysis_v2_fresh_admission_provider_run(uuid,integer,uuid,text,text,numeric)';
    inner_signature constant text :=
        'public.reserve_analysis_v2_fresh_admission_provider_run_fixed_20260904(uuid,integer,uuid,text,text,numeric)';
    original_source_hash constant text := '3f3238be473c58fddad3a96ddd03180d';
    fixed_source_hash constant text := '24c4ac88d23248e07b34733cccc02be9';
    inner_source_hash constant text := '73fdf00040c47d090a547da9ffa0ec7e';
    original_guard constant text :=
        'OR NOT public.analysis_beta_valid_apify_credential_slot(v_slot) THEN';
    fixed_guard constant text := $guard$OR NOT public.analysis_v2_valid_apify_credential_slot(v_slot)
       OR (p_credential_slot IS NULL AND NOT public.analysis_beta_valid_apify_credential_slot(v_slot)) THEN$guard$;
    before_function pg_catalog.pg_proc%ROWTYPE;
    after_function pg_catalog.pg_proc%ROWTYPE;
    existing_definition text;
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
        OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
        OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.grants') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.reservations') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_FRESH_ADMISSION_WRONG_DATABASE';
    END IF;

    SELECT * INTO before_function FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure(outer_signature);
    IF NOT FOUND OR NOT before_function.prosecdef
        OR pg_catalog.md5(before_function.prosrc) NOT IN (original_source_hash, fixed_source_hash)
        OR NOT pg_catalog.has_function_privilege('service_role', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('anon', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', before_function.oid, 'EXECUTE')
        OR NOT EXISTS (
            SELECT FROM pg_catalog.pg_proc AS inner_function
            WHERE inner_function.oid = pg_catalog.to_regprocedure(inner_signature)
              AND inner_function.prosecdef
              AND pg_catalog.md5(inner_function.prosrc) = inner_source_hash
              AND NOT pg_catalog.has_function_privilege('service_role', inner_function.oid, 'EXECUTE')
              AND NOT pg_catalog.has_function_privilege('anon', inner_function.oid, 'EXECUTE')
              AND NOT pg_catalog.has_function_privilege('authenticated', inner_function.oid, 'EXECUTE')
        ) THEN
        RAISE EXCEPTION 'DEV_LIVE_FRESH_ADMISSION_BASELINE_MISMATCH';
    END IF;

    IF pg_catalog.md5(before_function.prosrc) = original_source_hash THEN
        existing_definition := pg_catalog.pg_get_functiondef(before_function.oid);
        -- The private inner function accepts any valid explicit slot for
        -- ordinary paid admission and requires the held free slot for beta.
        -- Automatic allocation still requires a free slot before delegation.
        EXECUTE pg_catalog.replace(existing_definition, original_guard, fixed_guard);
    END IF;

    SELECT * INTO after_function FROM pg_catalog.pg_proc WHERE oid = before_function.oid;
    IF NOT FOUND OR NOT after_function.prosecdef
        OR pg_catalog.md5(after_function.prosrc) <> fixed_source_hash
        OR after_function.proowner IS DISTINCT FROM before_function.proowner
        OR after_function.proacl IS DISTINCT FROM before_function.proacl
        OR after_function.proconfig IS DISTINCT FROM before_function.proconfig THEN
        RAISE EXCEPTION 'DEV_LIVE_FRESH_ADMISSION_PATCH_UNVERIFIED';
    END IF;
END;
$dev_live$;

COMMIT;
