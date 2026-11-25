-- Apply only to registered Dev after live-standard-profile-media-ready.sql (#709).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $install$
DECLARE
    args constant text := '(uuid,text,uuid,text)';
    worker constant oid := 'service_role'::regrole;
    api_owner oid;
    patch record;
    source pg_catalog.pg_proc%ROWTYPE;
    target pg_catalog.pg_proc%ROWTYPE;
    definition text;
    expected text;
    digest text;
BEGIN
    IF pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR pg_catalog.to_regprocedure('dev_live_budget.valid_standard_profile_lineage(public.analysis_preflights,public.analysis_requests)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_PROFILE_SHARED_WRONG_DATABASE';
    END IF;
    SELECT proowner INTO api_owner FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure('public.load_dev_standard_profile_media_ready_v1' || args);

    -- Copy the installed canonical implementations. Every resulting function definition
    -- is pinned, including its signature, SECURITY DEFINER, search_path and complete body.
    -- Only the opt-in reader calls the copies. Pinning writers keep the canonical fence.
    FOR patch IN SELECT * FROM (VALUES
        (1, 'public.lock_analysis_v2_profile_plan_job', 'dev_live_budget.lock_standard_profile_reader_v1',
         'WHERE r.id = p_request_id FOR UPDATE;', 'WHERE r.id = p_request_id FOR SHARE;',
         '5239a616eb02fe594ee069de4f46145b8e8fdb1715254d05da1a21ed8dd0d127',
         'eb04a14e6bb727a6b35aa1e70550a631c45599597e541e79bf10e40d593a58b9', false),
        (2, 'public.load_analysis_v2_profile_media_inputs', 'dev_live_budget.load_standard_profile_media_inputs_v1',
         'PERFORM public.lock_analysis_v2_profile_plan_job(', 'PERFORM dev_live_budget.lock_standard_profile_reader_v1(',
         '95920be40a801085f27089d354e45d471cfcb2b8278c64c8de2b99d76d82eabc',
         '2d3d23f030b06c2745b616516efaaaca8f2dde93b3459a9f43573f4809038f87', true),
        (3, 'public.load_dev_standard_profile_media_ready_v1', 'public.load_dev_standard_profile_media_ready_v1',
         'media := public.load_analysis_v2_profile_media_inputs(', 'media := dev_live_budget.load_standard_profile_media_inputs_v1(',
         'c351feb45067f1a5a41ba538d1a99cb341c22db26ff665acf67bac7172b7e3e6',
         '36f5b263d67651b44abd7e84ab1155abccbcbb66dc39d70e3436a985fcabdc87', true)
    ) AS patches(step, src, dst, old_text, new_text, before_sha, after_sha, source_worker) ORDER BY step LOOP
        SELECT * INTO source FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(patch.src || args);
        IF NOT FOUND OR source.proowner IS DISTINCT FROM api_owner OR NOT source.prosecdef
           OR NOT pg_catalog.has_function_privilege(api_owner, source.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('anon', source.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', source.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege(worker, source.oid, 'EXECUTE') <> patch.source_worker
           OR EXISTS (
               SELECT FROM pg_catalog.aclexplode(coalesce(source.proacl, pg_catalog.acldefault('f', source.proowner))) acl
               WHERE acl.grantee <> source.proowner
                 AND (acl.grantee <> worker OR NOT patch.source_worker OR acl.is_grantable)
           ) THEN
            RAISE EXCEPTION 'DEV_STANDARD_PROFILE_SHARED_SOURCE_DRIFT';
        END IF;
        definition := pg_catalog.pg_get_functiondef(source.oid);
        digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(definition, 'UTF8')), 'hex');
        IF digest <> patch.before_sha AND NOT (patch.src = patch.dst AND digest = patch.after_sha) THEN
            RAISE EXCEPTION 'DEV_STANDARD_PROFILE_SHARED_SOURCE_DRIFT';
        END IF;
        expected := pg_catalog.replace(pg_catalog.replace(definition,
            'FUNCTION ' || patch.src || '(', 'FUNCTION ' || patch.dst || '('), patch.old_text, patch.new_text);
        IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(expected, 'UTF8')), 'hex') <> patch.after_sha THEN
            RAISE EXCEPTION 'DEV_STANDARD_PROFILE_SHARED_PATCH_DRIFT';
        END IF;

        SELECT * INTO target FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(patch.dst || args);
        IF NOT FOUND THEN
            EXECUTE pg_catalog.replace(expected, 'CREATE OR REPLACE FUNCTION ', 'CREATE FUNCTION ');
            EXECUTE 'REVOKE ALL ON FUNCTION ' || patch.dst || args || ' FROM PUBLIC, anon, authenticated, service_role';
        ELSIF patch.src = patch.dst AND digest = patch.before_sha THEN
            EXECUTE expected; -- CREATE OR REPLACE preserves the public reader's OID, owner and ACL.
        END IF;
        SELECT * INTO target FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(patch.dst || args);
        IF target.proowner IS DISTINCT FROM api_owner OR pg_catalog.pg_get_functiondef(target.oid) IS DISTINCT FROM expected
           OR NOT pg_catalog.has_function_privilege(api_owner, target.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('anon', target.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', target.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege(worker, target.oid, 'EXECUTE') <> (patch.src = patch.dst)
           OR (patch.src = patch.dst AND target.proacl IS DISTINCT FROM source.proacl)
           OR (patch.src <> patch.dst AND EXISTS (
               SELECT FROM pg_catalog.aclexplode(coalesce(target.proacl, pg_catalog.acldefault('f', target.proowner))) acl
               WHERE acl.grantee <> target.proowner
           )) THEN
            RAISE EXCEPTION 'DEV_STANDARD_PROFILE_SHARED_TARGET_DRIFT';
        END IF;
    END LOOP;
END;
$install$;

COMMIT;
