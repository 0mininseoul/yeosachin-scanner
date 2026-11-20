-- Operator-approved (2026-11-20) permanent deletion of the test payments made
-- before the first real order (8/8), with everything that depends on them.
-- Guarded: runs only when the manifest matches exactly (27 orders, 18 users,
-- 25 analysis requests); skips when the reference order or test rows are absent
-- (fresh/local databases). Groble webhook rows are kept with their order link
-- nulled. Append-only guards are disabled only inside this transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $delete_test_orders$
DECLARE
    v_cutoff TIMESTAMPTZ;
    v_orders INTEGER;
    v_users INTEGER;
    v_requests INTEGER;
    v_counts TEXT := '';
    v_n INTEGER;
    v_table TEXT;
BEGIN
    SELECT o.paid_at INTO v_cutoff
    FROM public.earlybird_orders AS o
    JOIN public.users AS u ON u.id = o.user_id
    WHERE u.name = '김가윤' AND o.paid_at IS NOT NULL
    ORDER BY o.paid_at
    LIMIT 1;
    IF v_cutoff IS NULL THEN
        RAISE NOTICE 'TEST_ORDER_CLEANUP_SKIPPED: reference order not present';
        RETURN;
    END IF;

    CREATE TEMP TABLE admin_test_orders ON COMMIT DROP AS
    SELECT o.id, o.user_id, o.preflight_id, o.result_request_id
    FROM public.earlybird_orders AS o
    WHERE o.paid_at IS NOT NULL AND o.paid_at < v_cutoff;

    CREATE TEMP TABLE admin_test_requests ON COMMIT DROP AS
    SELECT result_request_id AS id FROM admin_test_orders WHERE result_request_id IS NOT NULL
    UNION
    SELECT r.id FROM public.analysis_requests AS r
    WHERE r.preflight_id IN (SELECT preflight_id FROM admin_test_orders);

    SELECT count(*), count(DISTINCT user_id) INTO v_orders, v_users FROM admin_test_orders;
    SELECT count(*) INTO v_requests FROM admin_test_requests;
    IF v_orders = 0 THEN
        RAISE NOTICE 'TEST_ORDER_CLEANUP_SKIPPED: nothing to delete';
        RETURN;
    END IF;
    IF v_orders <> 27 OR v_users <> 18 OR v_requests <> 25 THEN
        RAISE EXCEPTION 'TEST_ORDER_MANIFEST_MISMATCH orders=% users=% requests=%', v_orders, v_users, v_requests;
    END IF;

    -- Append-only guards on rows the operator explicitly approved for deletion.
    ALTER TABLE public.account_paid_evidence DISABLE TRIGGER reject_account_paid_evidence_mutation_before_write;
    ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions DISABLE TRIGGER prevent_analysis_v2_provider_run_adoption_mutation;
    ALTER TABLE public.analysis_order_audit_bundles DISABLE TRIGGER prevent_analysis_order_audit_bundle_mutation;
    ALTER TABLE public.analysis_order_audit_candidates DISABLE TRIGGER prevent_analysis_order_audit_candidate_mutation;
    ALTER TABLE public.analysis_order_audit_interactions DISABLE TRIGGER prevent_analysis_order_audit_interaction_mutation;

    DELETE FROM public.account_paid_evidence WHERE order_id IN (SELECT id FROM admin_test_orders);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' paid_evidence=' || v_n;
    DELETE FROM public.earlybird_fulfillments
     WHERE order_id IN (SELECT id FROM admin_test_orders) OR request_id IN (SELECT id FROM admin_test_requests);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' fulfillments=' || v_n;
    DELETE FROM public.analysis_v2_recovery_provider_run_adoptions
     WHERE request_id IN (SELECT id FROM admin_test_requests) OR source_request_id IN (SELECT id FROM admin_test_requests);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' adoptions=' || v_n;
    DELETE FROM public.analysis_order_audit_interactions WHERE request_id IN (SELECT id FROM admin_test_requests);
    DELETE FROM public.analysis_order_audit_candidates WHERE request_id IN (SELECT id FROM admin_test_requests);
    DELETE FROM public.analysis_order_audit_bundles
     WHERE request_id IN (SELECT id FROM admin_test_requests) OR order_id IN (SELECT id FROM admin_test_orders);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' audit_bundles=' || v_n;

    -- Pipeline tables that reference each other without ON DELETE CASCADE:
    -- remove them child-first so the request cascade below never trips a NO ACTION key.
    FOREACH v_table IN ARRAY ARRAY[
        'analysis_v2_reverse_like_rows', 'analysis_v2_partner_safety_rows',
        'analysis_v2_candidate_score_rows', 'analysis_v2_preliminary_score_rows',
        'analysis_v2_candidate_feature_manifests', 'analysis_v2_candidate_score_manifests',
        'analysis_v2_dag_batch_results', 'analysis_v2_dag_batch_topology', 'analysis_v2_dag_stage_manifests',
        'analysis_v2_failure_receipts', 'analysis_v2_narrative_manifests', 'analysis_v2_partner_safety_manifests',
        'analysis_v2_preliminary_score_manifests', 'analysis_v2_private_name_manifests',
        'analysis_v2_provider_cleanup_intents', 'analysis_v2_result_image_manifests',
        'analysis_v2_reverse_like_manifests', 'analysis_lifecycle_events'
    ] LOOP
        EXECUTE pg_catalog.format('DELETE FROM public.%I WHERE request_id IN (SELECT id FROM admin_test_requests)', v_table);
    END LOOP;

    DELETE FROM public.earlybird_orders WHERE id IN (SELECT id FROM admin_test_orders);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' orders=' || v_n;
    DELETE FROM public.analysis_requests WHERE id IN (SELECT id FROM admin_test_requests);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' requests=' || v_n;
    DELETE FROM public.analysis_preflights WHERE id IN (SELECT preflight_id FROM admin_test_orders);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' preflights=' || v_n;
    -- Request/preflight delete triggers re-capture cost snapshots, so remove them last.
    DELETE FROM public.analysis_v2_cost_rollup_snapshots
     WHERE request_id IN (SELECT id FROM admin_test_requests) OR order_id IN (SELECT id FROM admin_test_orders);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || ' cost_snapshots=' || v_n;

    ALTER TABLE public.account_paid_evidence ENABLE TRIGGER reject_account_paid_evidence_mutation_before_write;
    ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions ENABLE TRIGGER prevent_analysis_v2_provider_run_adoption_mutation;
    ALTER TABLE public.analysis_order_audit_bundles ENABLE TRIGGER prevent_analysis_order_audit_bundle_mutation;
    ALTER TABLE public.analysis_order_audit_candidates ENABLE TRIGGER prevent_analysis_order_audit_candidate_mutation;
    ALTER TABLE public.analysis_order_audit_interactions ENABLE TRIGGER prevent_analysis_order_audit_interaction_mutation;

    IF EXISTS (SELECT 1 FROM public.earlybird_orders WHERE paid_at IS NOT NULL AND paid_at < v_cutoff) THEN
        RAISE EXCEPTION 'TEST_ORDER_CLEANUP_INCOMPLETE';
    END IF;
    PERFORM pg_catalog.set_config('admin_console.cleanup_counts', v_counts, true);
    RAISE NOTICE 'TEST_ORDER_CLEANUP_DONE%', v_counts;
END;
$delete_test_orders$;

COMMIT;
