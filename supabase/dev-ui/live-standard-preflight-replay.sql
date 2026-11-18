-- Apply only in the registered Dev database, after live-owner-start-standard.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
DECLARE
    preflight_signature constant text :=
        'public.create_or_replay_analysis_v2_preflight(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)';
    original_source_hash constant text := '089d428776295f16d17c1623080f9530';
    patched_source_hash constant text := 'c4a0cb8e8937fe08e611d207e37346ac';
    original_guard constant text := $guard$      AND preflight.beta_entry_provenance IS NULL
      AND preflight.status IN ('pending', 'processing', 'ready')$guard$;
    patched_guard constant text := $guard$      AND preflight.beta_entry_provenance IS NULL
      AND p_idempotency_key NOT LIKE 'dev-live:owner:standard:%'
      AND preflight.idempotency_key NOT LIKE 'dev-live:owner:standard:%'
      AND preflight.status IN ('pending', 'processing', 'ready')$guard$;
    before_function pg_catalog.pg_proc%ROWTYPE;
    after_function pg_catalog.pg_proc%ROWTYPE;
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
        OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
        OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_REPLAY_WRONG_DATABASE';
    END IF;

    SELECT * INTO before_function FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure(preflight_signature);
    IF NOT FOUND OR NOT before_function.prosecdef
        OR pg_catalog.md5(before_function.prosrc) NOT IN (original_source_hash, patched_source_hash)
        OR NOT pg_catalog.has_function_privilege('service_role', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('anon', before_function.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', before_function.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_REPLAY_BASELINE_MISMATCH';
    END IF;

    -- The earlier exact-key replay remains available with its original grant.
    -- An active same-target row with a different key cannot stand in for a
    -- Standard start. Existing per-user admission rules apply to each new key.
    IF pg_catalog.md5(before_function.prosrc) = original_source_hash THEN
        EXECUTE pg_catalog.replace(
            pg_catalog.pg_get_functiondef(before_function.oid), original_guard, patched_guard
        );
    END IF;

    SELECT * INTO after_function FROM pg_catalog.pg_proc WHERE oid = before_function.oid;
    IF NOT FOUND OR NOT after_function.prosecdef
        OR pg_catalog.md5(after_function.prosrc) <> patched_source_hash
        OR after_function.proowner IS DISTINCT FROM before_function.proowner
        OR after_function.proacl IS DISTINCT FROM before_function.proacl
        OR after_function.proconfig IS DISTINCT FROM before_function.proconfig THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_REPLAY_PATCH_UNVERIFIED';
    END IF;
END;
$dev_live$;

COMMIT;
