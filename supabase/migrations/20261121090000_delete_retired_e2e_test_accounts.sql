-- Permanently delete the 17 retired e2e_test accounts that only made pre-launch
-- test payments (their orders were removed by 20261120130000). Their auth.users
-- rows are already gone; the only remaining reference is one append-only
-- account_classification_audit row each. Aborts unless the manifest matches.
DO $delete_e2e_accounts$
DECLARE
    v_accounts INTEGER;
    v_auth INTEGER;
    v_refs INTEGER;
    v_audit INTEGER;
    v_users INTEGER;
BEGIN
    CREATE TEMP TABLE admin_e2e_accounts ON COMMIT DROP AS
    SELECT u.id
    FROM public.users AS u
    WHERE u.account_class = 'e2e_test'
      AND u.traffic_class = 'e2e_test'
      AND u.lifecycle = 'retired'
      AND u.provider = 'kakao'
      AND u.first_paid_at IS NULL
      AND COALESCE(u.is_paid_user, false) = false;

    SELECT count(*) INTO v_accounts FROM admin_e2e_accounts;
    IF v_accounts = 0 THEN
        RAISE NOTICE 'E2E_ACCOUNT_CLEANUP_SKIPPED: nothing to delete';
        RETURN;
    END IF;
    IF v_accounts <> 17 THEN
        RAISE EXCEPTION 'E2E_ACCOUNT_MANIFEST_MISMATCH accounts=%', v_accounts;
    END IF;

    SELECT count(*) INTO v_auth FROM auth.users WHERE id IN (SELECT id FROM admin_e2e_accounts);
    SELECT
        (SELECT count(*) FROM public.earlybird_orders WHERE user_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.analysis_requests WHERE user_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.analysis_preflights WHERE user_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.account_paid_evidence WHERE account_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.account_lifecycle WHERE account_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.account_e2e_test_runners WHERE account_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.account_deletion_jobs WHERE account_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.analysis_beta_pool_allocations WHERE user_id IN (SELECT id FROM admin_e2e_accounts))
      + (SELECT count(*) FROM public.landing_leads WHERE auth_user_id IN (SELECT id FROM admin_e2e_accounts))
    INTO v_refs;
    IF v_auth <> 0 OR v_refs <> 0 THEN
        RAISE EXCEPTION 'E2E_ACCOUNT_STILL_REFERENCED auth=% refs=%', v_auth, v_refs;
    END IF;

    ALTER TABLE public.account_classification_audit DISABLE TRIGGER reject_account_classification_audit_mutation_before_write;
    DELETE FROM public.account_classification_audit WHERE account_id IN (SELECT id FROM admin_e2e_accounts);
    GET DIAGNOSTICS v_audit = ROW_COUNT;
    ALTER TABLE public.account_classification_audit ENABLE TRIGGER reject_account_classification_audit_mutation_before_write;

    DELETE FROM public.users WHERE id IN (SELECT id FROM admin_e2e_accounts);
    GET DIAGNOSTICS v_users = ROW_COUNT;
    IF v_users <> 17 THEN
        RAISE EXCEPTION 'E2E_ACCOUNT_CLEANUP_INCOMPLETE users=%', v_users;
    END IF;
    RAISE NOTICE 'E2E_ACCOUNT_CLEANUP_DONE users=% classification_audit=%', v_users, v_audit;
END;
$delete_e2e_accounts$;
