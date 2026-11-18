-- Apply only to the registered Dev database, after the Standard owner policy schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
DECLARE
    admission_signature constant text :=
        'public.reserve_analysis_v2_preflight_admission(uuid,uuid,text,text,uuid,uuid)';
    original_source_hash constant text := '8884fb52467921a47f5019a1585f4fd8';
    patched_source_hash constant text := 'e90372d73b18a1b7b456460992c1ac71';
    early_plan_guard constant text := $guard$
       OR p_selected_plan_id NOT IN ('basic', 'standard')$guard$;
    original_guard constant text := $guard$    IF NOT FOUND
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation < 1 THEN$guard$;
    patched_guard constant text := $guard$    -- A Standard Dev grant is separate from the Basic runner registration.
    IF FOUND AND v_preflight.idempotency_key LIKE 'dev-live:owner:standard:%' THEN
        IF v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
           OR v_preflight.beta_entry_provenance IS NOT NULL
           OR p_selected_plan_id IS DISTINCT FROM 'standard'
           OR v_preflight.idempotency_key !~ '^dev-live:owner:standard:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR p_entitlement_jti_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               'analysis-test-entitlement-jti-v1' || pg_catalog.chr(10) || 'dev-live-'
               || pg_catalog.split_part(v_preflight.idempotency_key, ':', 4), 'UTF8'
           )), 'hex')
           OR (v_preflight.admission_generation >= 1 AND (
               v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
               OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM p_entitlement_jti_hash
           )) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE', ERRCODE = 'P0001';
        END IF;

        IF public.dev_live_owner_start_lookup_v2(
            pg_catalog.split_part(v_preflight.idempotency_key, ':', 4)::UUID, p_user_id, v_preflight.target_instagram_id
        ) IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE', ERRCODE = 'P0001';
        END IF;

        RETURN QUERY
        SELECT * FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id, p_user_id, p_selected_plan_id, p_entitlement_jti_hash,
            p_admission_token, p_dispatch_token
        );
        RETURN;
    END IF;

    IF NOT FOUND
       OR p_selected_plan_id NOT IN ('basic', 'standard')
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation < 1 THEN$guard$;
    before_function pg_catalog.pg_proc%ROWTYPE;
    after_function pg_catalog.pg_proc%ROWTYPE;
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
        OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
        OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_lookup_v2(uuid,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_ADMISSION_WRONG_DATABASE';
    END IF;

    SELECT * INTO before_function FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure(admission_signature);
    IF NOT FOUND OR NOT before_function.prosecdef
        OR pg_catalog.md5(before_function.prosrc) NOT IN (original_source_hash, patched_source_hash)
        OR NOT pg_catalog.has_function_privilege('service_role', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('anon', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', before_function.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_ADMISSION_BASELINE_MISMATCH';
    END IF;

    IF pg_catalog.md5(before_function.prosrc) = original_source_hash THEN
        EXECUTE pg_catalog.replace(
            pg_catalog.replace(pg_catalog.pg_get_functiondef(before_function.oid), early_plan_guard, ''),
            original_guard, patched_guard
        );
    END IF;

    SELECT * INTO after_function FROM pg_catalog.pg_proc WHERE oid = before_function.oid;
    IF NOT FOUND OR NOT after_function.prosecdef
        OR pg_catalog.md5(after_function.prosrc) <> patched_source_hash
        OR after_function.proowner IS DISTINCT FROM before_function.proowner
        OR after_function.proacl IS DISTINCT FROM before_function.proacl
        OR after_function.proconfig IS DISTINCT FROM before_function.proconfig THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_ADMISSION_PATCH_UNVERIFIED';
    END IF;
END;
$dev_live$;

COMMIT;
