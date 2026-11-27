-- Apply only to the registered Dev database after the Standard owner policy and fresh admission patches.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
       OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
       OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.owner_starts') IS NULL
       OR pg_catalog.to_regprocedure('public.dev_live_owner_start_lookup_v2(uuid,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_PROFILE_WRONG_DATABASE';
    END IF;
END;
$dev_live$;

-- Called only by the existing worker RPCs with the preflight and request locked.
CREATE OR REPLACE FUNCTION dev_live_budget.valid_standard_profile_lineage(
    p_preflight public.analysis_preflights,
    p_request public.analysis_requests
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $lineage$
DECLARE
    grant_id uuid;
    entitlement_hash text;
BEGIN
    IF p_preflight.id IS NULL
       OR p_request.id IS NULL
       OR p_preflight.consumed_request_id IS DISTINCT FROM p_request.id
       OR p_request.preflight_id IS DISTINCT FROM p_preflight.id
       OR p_preflight.user_id IS NULL
       OR p_preflight.user_id IS DISTINCT FROM p_request.user_id
       OR p_preflight.target_instagram_id IS DISTINCT FROM p_request.target_instagram_id
       OR p_preflight.status IS DISTINCT FROM 'consumed'
       OR p_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR p_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR p_request.pipeline_version IS DISTINCT FROM 'v2'
       OR p_request.status IS DISTINCT FROM 'processing'
       OR p_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR p_request.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR p_preflight.beta_entry_provenance IS NOT NULL
       OR p_preflight.idempotency_key !~ '^dev-live:owner:standard:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR p_preflight.admission_status IS DISTINCT FROM 'ready'
       OR p_preflight.admission_generation < 1
       OR p_preflight.admission_selected_plan_id IS DISTINCT FROM 'standard'
       OR p_request.selected_plan_id_snapshot IS DISTINCT FROM 'standard'
       -- The matching consumption already checked how fresh this snapshot was.
       OR p_preflight.admission_refreshed_at IS NULL
       OR p_preflight.consumed_at IS NULL
       OR p_preflight.target_followers_count IS NULL
       OR p_preflight.target_following_count IS NULL
       OR p_preflight.admission_target_followers_count IS DISTINCT FROM p_preflight.target_followers_count
       OR p_preflight.admission_target_following_count IS DISTINCT FROM p_preflight.target_following_count
       OR p_preflight.required_plan_id IS NULL
       OR p_preflight.required_plan_id NOT IN ('basic', 'standard')
       OR p_preflight.capacity_required_plan_id IS NULL
       OR p_preflight.capacity_required_plan_id NOT IN ('basic', 'standard')
       OR (p_preflight.capacity_required_plan_id = 'standard' AND p_preflight.required_plan_id <> 'standard')
       OR p_preflight.admission_required_plan_id IS DISTINCT FROM p_preflight.required_plan_id
       OR p_preflight.admission_capacity_required_plan_id IS DISTINCT FROM p_preflight.capacity_required_plan_id
       OR p_preflight.required_plan_id IS DISTINCT FROM p_request.required_plan_id_snapshot
       OR p_preflight.capacity_required_plan_id IS DISTINCT FROM p_request.capacity_required_plan_id_snapshot
       OR p_preflight.plan_cards_snapshot IS NULL
       OR p_preflight.admission_plan_cards_snapshot IS DISTINCT FROM p_preflight.plan_cards_snapshot
       OR p_preflight.plan_cards_snapshot IS DISTINCT FROM p_request.plan_cards_snapshot
       OR p_preflight.exclusion_decision IS DISTINCT FROM p_request.exclusion_decision_snapshot
       OR p_preflight.excluded_instagram_id IS DISTINCT FROM p_request.excluded_instagram_id
       OR EXISTS (
           SELECT 1 FROM public.earlybird_fulfillments AS fulfillment
           WHERE fulfillment.request_id = p_request.id
       )
       OR EXISTS (
           SELECT 1 FROM public.earlybird_orders AS orders
           WHERE orders.preflight_id = p_preflight.id OR orders.result_request_id = p_request.id
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_v2_provider_execution_policies AS policy
           WHERE policy.request_id = p_request.id
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_revenue_run_ledgers AS ledger
           WHERE ledger.request_id = p_request.id
       ) THEN
        RETURN false;
    END IF;

    grant_id := pg_catalog.split_part(p_preflight.idempotency_key, ':', 4)::uuid;
    entitlement_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'analysis-test-entitlement-jti-v1' || pg_catalog.chr(10) || 'dev-live-' || grant_id::text,
        'UTF8'
    )), 'hex');

    RETURN public.dev_live_owner_start_lookup_v2(
        grant_id, p_request.user_id, p_request.target_instagram_id
    ) IS NOT NULL
       AND p_preflight.admission_entitlement_jti_hash IS NOT DISTINCT FROM entitlement_hash
       AND p_request.test_entitlement_jti_hash IS NOT DISTINCT FROM entitlement_hash
       AND EXISTS (
           SELECT 1 FROM public.analysis_v2_test_entitlement_consumptions AS consumption
           WHERE consumption.request_id = p_request.id
             AND consumption.preflight_id = p_preflight.id
             AND consumption.user_id = p_request.user_id
             AND consumption.selected_plan_id = 'standard'
             AND consumption.entitlement_jti_hash = entitlement_hash
       );
END;
$lineage$;

REVOKE ALL ON FUNCTION dev_live_budget.valid_standard_profile_lineage(
    public.analysis_preflights, public.analysis_requests
) FROM PUBLIC, anon, authenticated, service_role;

DO $dev_live$
DECLARE
    retry_signature constant text :=
        'public.load_analysis_v2_profile_fetch_checkpoint_for_retry(uuid,text,uuid,text,text,text)';
    writer_signature constant text :=
        'public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(uuid,text,uuid,text,text[],jsonb,text,text)';
    signature text;
    original_hash text;
    patched_hash text;
    base pg_catalog.pg_proc%ROWTYPE;
    updated pg_catalog.pg_proc%ROWTYPE;
    body text;
    block_start integer;
    block_end integer;
    paid_locks text;
    lock_request constant text := '    SELECT analysis_request.*';
    paid_lock_first_line constant text := '    SELECT fulfillment.*';
    helper_signature constant text :=
        'dev_live_budget.valid_standard_profile_lineage(public.analysis_preflights,public.analysis_requests)';
    dev_preflight_lock constant text := $fragment$    IF v_order_id IS NULL THEN
        SELECT preflight.* INTO v_preflight
        FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    ELSE
$fragment$;
    retry_no_order constant text := $fragment$    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

$fragment$;
    writer_no_order constant text := $fragment$    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

$fragment$;
    dev_check constant text := $fragment$    IF v_order_id IS NULL
       AND dev_live_budget.valid_standard_profile_lineage(v_preflight, v_request) IS NOT TRUE THEN
        RAISE EXCEPTION USING MESSAGE = '%s', ERRCODE = 'P0001';
    END IF;
$fragment$;
BEGIN
    IF pg_catalog.has_function_privilege('service_role', helper_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', helper_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', helper_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_PROFILE_HELPER_ACL_MISMATCH';
    END IF;

    FOREACH signature IN ARRAY ARRAY[retry_signature, writer_signature] LOOP
        SELECT * INTO base FROM pg_catalog.pg_proc
        WHERE oid = pg_catalog.to_regprocedure(signature);

        IF signature = retry_signature THEN
            original_hash := '130b5ae08d7a7cdce89c4f7d4ce3c305';
            patched_hash := 'b7d23df4ba3afdefa07f67e5cd98f1b1';
            IF pg_catalog.md5(base.prosrc) IN ('70e6120ed8661e86c772d7680b78379b', '686706f272053ee40afa5b0cfa296611') THEN
                original_hash := '70e6120ed8661e86c772d7680b78379b';
                patched_hash := '686706f272053ee40afa5b0cfa296611';
            END IF;
        ELSE
            original_hash := 'a6bf9c3e052c880d3d5da6152cafc063';
            patched_hash := 'd574dd70c33a4344d1740b2ec9226a54';
        END IF;

        IF NOT FOUND OR NOT base.prosecdef
           OR pg_catalog.pg_get_userbyid(base.proowner) IS DISTINCT FROM 'postgres'
           OR base.proconfig IS DISTINCT FROM ARRAY['search_path=""']
           OR pg_catalog.md5(base.prosrc) NOT IN (original_hash, patched_hash)
           OR NOT pg_catalog.has_function_privilege('service_role', base.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('anon', base.oid, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', base.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'DEV_LIVE_STANDARD_PROFILE_BASELINE_MISMATCH';
        END IF;

        IF pg_catalog.md5(base.prosrc) = original_hash THEN
            body := pg_catalog.replace(base.prosrc,
                CASE WHEN signature = retry_signature THEN retry_no_order ELSE writer_no_order END, '');
            block_start := pg_catalog.strpos(body, paid_lock_first_line);
            block_end := pg_catalog.strpos(body, lock_request);
            paid_locks := pg_catalog.substring(body, block_start, block_end - block_start);
            body := pg_catalog.replace(body, paid_locks,
                dev_preflight_lock || '    ' ||
                pg_catalog.replace(pg_catalog.rtrim(paid_locks, E'\n'), E'\n', E'\n    ') ||
                E'\n    END IF;\n');

            IF signature = retry_signature THEN
                body := pg_catalog.replace(body, '    IF v_request.id IS NULL',
                    pg_catalog.format(dev_check, 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_FENCE_MISMATCH') ||
                    E'\n    IF v_request.id IS NULL');
                body := pg_catalog.replace(body, '    IF v_fulfillment.order_id IS NULL',
                    E'    IF v_order_id IS NOT NULL AND (\n        v_fulfillment.order_id IS NULL');
                body := pg_catalog.replace(body,
                    '       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id THEN',
                    E'       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id\n    ) THEN');
            ELSE
                body := pg_catalog.replace(body,
                    E'    IF v_order.id IS NULL\n       OR v_fulfillment.order_id IS NULL\n       OR v_preflight.id IS NULL',
                    pg_catalog.format(dev_check, 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH') ||
                    E'\n    IF v_preflight.id IS NULL\n       OR (v_order_id IS NOT NULL AND (v_order.id IS NULL OR v_fulfillment.order_id IS NULL))');
                body := pg_catalog.replace(body, '    IF v_order.status IS DISTINCT FROM',
                    E'    IF v_order_id IS NOT NULL AND (\n        v_order.status IS DISTINCT FROM');
                body := pg_catalog.replace(body,
                    E'            FROM public.analysis_revenue_run_ledgers AS ledger\n            WHERE ledger.request_id = p_request_id\n       ) THEN',
                    E'            FROM public.analysis_revenue_run_ledgers AS ledger\n            WHERE ledger.request_id = p_request_id\n       )\n    ) THEN');
                body := pg_catalog.replace(body, 'v_preflight.plan_cards_snapshot->v_order.plan_id',
                    'v_preflight.plan_cards_snapshot->COALESCE(v_order.plan_id, v_preflight.admission_selected_plan_id)');
                body := pg_catalog.replace(body,
                    E'       OR v_order.target_followers_count IS NULL\n       OR v_order.target_followers_count < 0\n       OR v_order.target_following_count IS NULL\n       OR v_order.target_following_count < 0',
                    E'       OR (v_order_id IS NOT NULL AND (\n            v_order.target_followers_count IS NULL OR v_order.target_followers_count < 0\n            OR v_order.target_following_count IS NULL OR v_order.target_following_count < 0\n       ))');
                body := pg_catalog.replace(body,
                    E'       OR v_order.target_followers_count\n            > (v_selected_card->''relationshipCapacity''->>''followers'')::INTEGER\n       OR v_order.target_following_count\n            > (v_selected_card->''relationshipCapacity''->>''following'')::INTEGER',
                    E'       OR (v_order_id IS NOT NULL AND (\n            v_order.target_followers_count > (v_selected_card->''relationshipCapacity''->>''followers'')::INTEGER\n            OR v_order.target_following_count > (v_selected_card->''relationshipCapacity''->>''following'')::INTEGER\n       ))');
            END IF;

            IF pg_catalog.md5(body) <> patched_hash THEN
                RAISE EXCEPTION 'DEV_LIVE_STANDARD_PROFILE_SOURCE_PATCH_MISMATCH';
            END IF;
            EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(base.oid), base.prosrc, body);
        END IF;

        SELECT * INTO updated FROM pg_catalog.pg_proc WHERE oid = base.oid;
        IF NOT FOUND OR NOT updated.prosecdef
           OR pg_catalog.md5(updated.prosrc) <> patched_hash
           OR updated.proowner IS DISTINCT FROM base.proowner
           OR updated.proacl IS DISTINCT FROM base.proacl
           OR updated.proconfig IS DISTINCT FROM base.proconfig THEN
            RAISE EXCEPTION 'DEV_LIVE_STANDARD_PROFILE_PATCH_UNVERIFIED';
        END IF;
    END LOOP;
END;
$dev_live$;

COMMIT;
