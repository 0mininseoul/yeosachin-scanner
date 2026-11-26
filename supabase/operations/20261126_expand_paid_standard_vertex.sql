-- One-time operator action after a matching real-topology capacity test and an idle paid queue.
-- The web/worker release alone never applies this operation. All writes commit together.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public,extensions;
LOCK TABLE public.analysis_requests, public.analysis_pipeline_jobs, public.analysis_provider_admission_budgets,
    public.analysis_provider_admission_leases, public.analysis_v2_gemini_leases IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
    IF to_regnamespace('dev_live_budget') IS NOT NULL OR to_regnamespace('paid_standard_capacity') IS NOT NULL THEN
        RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_INSTALL_SCOPE_MISMATCH';
    END IF;
    IF EXISTS (SELECT FROM public.analysis_v2_gemini_leases WHERE state <> 'available')
       OR EXISTS (SELECT FROM public.analysis_requests WHERE pipeline_version='v2' AND status IN ('pending','processing'))
       OR EXISTS (SELECT FROM public.analysis_provider_admission_leases WHERE workload_role='paid' AND state IN ('leased','recovery_required'))
       OR EXISTS (SELECT FROM public.analysis_pipeline_jobs WHERE status='processing') THEN
        RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_REQUIRES_IDLE_WORKERS';
    END IF;
    IF (SELECT array_agg(slot::integer ORDER BY slot) FROM public.analysis_v2_gemini_leases) IS DISTINCT FROM ARRAY[1,2,3,4,5,6,7,8]
       OR (SELECT count(*) FROM public.analysis_provider_admission_budgets WHERE workload_role='paid' AND logical_provider='gemini') <> 9
       OR NOT EXISTS (SELECT FROM public.analysis_provider_admission_budgets WHERE budget_key='paid:gemini:global'
           AND workload_role='paid' AND logical_provider='gemini' AND credential_slot IS NULL AND max_active=8 AND rate_limit_per_minute=120)
       OR EXISTS (SELECT FROM generate_series(1,8) n WHERE NOT EXISTS (
           SELECT FROM public.analysis_provider_admission_budgets WHERE budget_key='paid:gemini:gemini-'||n AND workload_role='paid'
             AND logical_provider='gemini' AND credential_slot='gemini-'||n AND max_active=1 AND rate_limit_per_minute=15
       )) THEN RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_BASELINE_DRIFT'; END IF;
END;
$preflight$;
CREATE SCHEMA paid_standard_capacity;
REVOKE ALL ON SCHEMA paid_standard_capacity FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.paid_standard_capacity_approved_v1(p_request_id uuid,p_job_key text,p_job_claim_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    -- Each recheck must see a transaction that committed while the guard waited.
    SELECT current_setting('transaction_isolation') IN ('read committed','read uncommitted') AND EXISTS (
        SELECT FROM public.analysis_requests r
        JOIN public.analysis_pipeline_jobs j ON j.request_id=r.id AND j.job_key=p_job_key
        JOIN public.analysis_preflights p ON p.id=r.preflight_id AND p.consumed_request_id=r.id
        JOIN public.earlybird_fulfillments f ON f.request_id=r.id AND f.status='analysis_in_progress'
        JOIN public.earlybird_orders o ON o.id=f.order_id AND o.result_request_id=r.id AND o.preflight_id=p.id
        JOIN public.users u ON u.id=r.user_id
        WHERE r.id=p_request_id AND j.status='processing' AND j.lease_token=p_job_claim_token AND j.lease_expires_at>clock_timestamp()
          AND r.status IN ('pending','processing') AND r.pipeline_version='v2' AND r.plan_access_mode_snapshot='production'
          AND r.selected_plan_id_snapshot='standard' AND r.policy_versions_snapshot->>'aiStage'='ai-stage-policy-v2.11'
          AND r.policy_versions_snapshot->>'scheduler'='ai-scheduler-v1' AND r.test_entitlement_jti_hash IS NULL
          AND p.user_id=r.user_id AND p.target_instagram_id=r.target_instagram_id AND p.access_mode='production'
          AND p.status='consumed' AND p.admission_selected_plan_id='standard' AND p.policy_versions_snapshot=r.policy_versions_snapshot
          AND p.admission_entitlement_jti_hash=encode(sha256(convert_to('earlybird-fulfillment-admission-v1'||chr(10)||o.id::text,'UTF8')),'hex')
          AND o.user_id=r.user_id AND o.target_instagram_id=r.target_instagram_id AND o.plan_id='standard'
          AND o.status='analysis_in_progress' AND o.payment_id IS NOT NULL AND o.paid_at IS NOT NULL
          AND o.seller_reference_confirmed_at IS NOT NULL AND o.actual_groble_product_id=o.expected_groble_product_id
          AND o.actual_amount_krw>0 AND o.actual_amount_krw<=o.expected_amount_krw
          AND f.operator_admitted_at IS NOT NULL AND u.account_class='production' AND u.traffic_class='external' AND u.lifecycle='active'
    );
$$;
REVOKE ALL ON FUNCTION public.paid_standard_capacity_approved_v1(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.paid_standard_capacity_approved_v1(uuid,text,uuid) TO service_role;

-- Routing survives a refund, an expired claim or removal of a mutable owner link.
-- The trusted request snapshot is also retained for recovered earlybird generations.
CREATE FUNCTION public.paid_standard_capacity_lineage_v1(p_request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS (SELECT FROM public.analysis_requests r WHERE r.id=p_request_id
        AND r.pipeline_version='v2' AND r.plan_access_mode_snapshot='production'
        AND r.selected_plan_id_snapshot='standard' AND r.test_entitlement_jti_hash IS NULL
        AND r.policy_versions_snapshot->>'aiStage'='ai-stage-policy-v2.11'
        AND r.policy_versions_snapshot->>'scheduler'='ai-scheduler-v1'
        AND (r.idempotency_key ~ '^earlybird:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.]r[0-9]{1,3})?$'
            OR EXISTS (SELECT FROM public.earlybird_fulfillments f WHERE f.request_id=r.id)));
$$;
REVOKE ALL ON FUNCTION public.paid_standard_capacity_lineage_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.paid_standard_capacity_lineage_v1(uuid) TO service_role;

-- Transform only release-pinned functions. Legacy entry points stay limited to eight
-- physical slots and preserve their original stage limits, including mixed-version traffic.
DO $install$
DECLARE
    source record;
    func pg_proc%ROWTYPE;
    installed text;
    wide text;
    revised text;
    high_guard text;
    source_owner oid := (SELECT proowner FROM pg_proc WHERE oid='public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)'::regprocedure);
    legacy_stage_count constant text := $stage$SELECT CASE WHEN count(*) >= CASE p_stage WHEN 'genderTriage' THEN 12 WHEN 'featureAnalysis' THEN 80 ELSE 2 END
        THEN v_stage_limit ELSE count(*) FILTER (WHERE lease.slot <= 8) END::integer INTO v_stage_count$stage$;
    legacy_resolver_count constant text := $resolver$    IF p_stage IN ('featureAnalysis','genderTriage','privateAccountName') AND EXISTS (
        SELECT FROM public.analysis_v2_gemini_leases AS active
        WHERE active.state IN ('leased','quarantined') AND active.stage = p_stage
        HAVING count(*) >= CASE p_stage WHEN 'featureAnalysis' THEN 80 WHEN 'genderTriage' THEN 12 ELSE 2 END
           AND bool_or(active.slot > 8)
    ) THEN
        RETURN QUERY SELECT 'capacity_pending'::text, NULL::smallint, NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    SELECT CASE WHEN count(*) >= 48 THEN 2 ELSE count(*) FILTER (WHERE lease.slot <= 8) END::integer INTO v_resolver_count$resolver$;
    rank_before constant text := $original$          AND admission.state IN ('leased', 'recovery_required')
    ), lease.slot
    LIMIT 1
    FOR UPDATE;$original$;
    rank_after constant text := $candidate$          AND admission.state IN ('leased', 'recovery_required')
    ), NOT EXISTS (
        SELECT 1 FROM public.analysis_provider_admission_budgets AS budget
        WHERE budget.budget_key = 'paid:gemini:gemini-' || lease.slot::text
          AND budget.workload_role = 'paid' AND budget.logical_provider = 'gemini'
          AND budget.credential_slot = 'gemini-' || lease.slot::text
          AND (budget.window_started_at + INTERVAL '1 minute' <= v_now
               OR budget.window_count < budget.rate_limit_per_minute)
    ), lease.slot
    LIMIT 1
    FOR UPDATE;$candidate$;
BEGIN
    FOR source IN SELECT * FROM (VALUES
        ('public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)','63f76c494b706cb302da6e7b02ded52caf85568456eef76bdde9a3cddb5ee787',true),
        ('public.analysis_provider_admission_ledger_state(public.analysis_provider_admission_leases)','57f6c59aa4f2e26f030bfa5191b04565102a1298d802b2e171351219931b85db',false),
        ('public.assert_analysis_provider_admission_claim(text,text,text,uuid,text,text,uuid,uuid,bigint,timestamptz)','1e287a5ea5eee7117eec0dd14620511accab5e8f95d777bb2fe670e10caaf815',false),
        ('public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)','e91deaea73d60cd98cd13878394434717e4be7fb5525c64f418a82914392bcce',true),
        ('public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)','8c98a69f61b63efc1b91a70fb5ad44aca73faad79acf56529497394426cf4472',true),
        ('public.cutoff_analysis_v2_gender_resolution_attempt(uuid,text,uuid,text,smallint,uuid,jsonb,integer,uuid,bigint)','e0e6161ac2d0ba2d96a85a3d78c6cf9b5a5e38aefe45c1dc9ff4facf9409d4ac',true),
        ('public.release_analysis_v2_gemini_lease(integer,uuid,bigint)','08bf285dc215a1e628b32ba35fe08a24d39e22de61e0bfa283a985c8bee7cc45',true),
        ('public.renew_analysis_v2_gemini_lease(integer,uuid,bigint,integer)','61c8debf7e713ac787976638b3841cae438668ebdc0787442a84078a8534f2e0',true),
        ('public.renew_analysis_v2_gemini_lease_v2(integer,uuid,bigint,text,integer)','3d9c5024d54fce9c75f9ce16ab358cca6ede84bb5ab6c64382a0b4ddda322dde',true),
        ('public.resolve_analysis_v2_gemini_lease_quarantine(integer,bigint,text)','1161c70d1f9275f287dd24d090f3dfca6aaf90c5116354cc37c2ddd0af2bfe17',false),
        ('public.acquire_analysis_v2_gemini_lease(uuid,text,integer,uuid,integer)','ca49a51bc37c68c3fffb9d87c9cda948b9f884adbca50c00cea2525777127bdb',true)
    ) pinned(signature,sha,service_execute) LOOP
        SELECT * INTO STRICT func FROM pg_proc WHERE oid=to_regprocedure(source.signature);
        installed := pg_get_functiondef(func.oid);
        IF encode(sha256(convert_to(installed,'UTF8')),'hex') <> source.sha OR func.proowner <> source_owner
           OR has_function_privilege('service_role',func.oid,'EXECUTE') <> source.service_execute
           OR EXISTS (SELECT FROM aclexplode(coalesce(func.proacl,acldefault('f',func.proowner))) acl
               WHERE acl.grantee <> source_owner AND (NOT source.service_execute OR acl.grantee <> 'service_role'::regrole OR acl.is_grantable)) THEN
            RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_SOURCE_DRIFT %',func.proname;
        END IF;
        wide := replace(installed,'p_slot NOT BETWEEN 1 AND 8','p_slot NOT BETWEEN 1 AND 128');
        wide := replace(wide,'^gemini-[1-8]$','^gemini-([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$');
        wide := replace(wide,'^gemini-([1-8])$','^gemini-([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$');
        wide := replace(wide,'WHEN ''featureAnalysis'' THEN 3','WHEN ''featureAnalysis'' THEN 80');
        wide := replace(wide,'WHEN ''genderTriage'' THEN 6','WHEN ''genderTriage'' THEN 12');
        wide := replace(wide,'v_resolver_count >= 2','v_resolver_count >= 48');
        wide := replace(wide,rank_before,rank_after);
        IF func.proname='acquire_analysis_v2_gemini_lease_v2' THEN
            EXECUTE replace(wide,'public.acquire_analysis_v2_gemini_lease_v2','paid_standard_capacity.acquire_direct');
        ELSIF func.proname='acquire_analysis_v2_scheduler_gemini_lease_v1' THEN
            wide := replace(wide,'public.acquire_analysis_v2_scheduler_gemini_lease_v1','paid_standard_capacity.acquire_scheduled');
            EXECUTE replace(wide,'public.acquire_analysis_v2_gemini_lease_v2','paid_standard_capacity.acquire_direct');
        END IF;
        IF func.proname IN ('acquire_analysis_v2_gemini_lease','acquire_analysis_v2_gemini_lease_v2','acquire_analysis_v2_scheduler_gemini_lease_v1') THEN
            -- Keep the original eight-slot pool, including legacy same-attempt lookup.
            -- An old worker must not return, quarantine, or duplicate an in-flight expanded lease.
            revised := replace(installed,'WHERE lease.state =','WHERE lease.slot <= 8 AND lease.state =');
            high_guard := format($body$    IF FOUND AND %s.slot > 8 THEN
        RETURN QUERY SELECT 'capacity_pending'::text, NULL::smallint, NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
$body$,CASE WHEN func.proname='acquire_analysis_v2_scheduler_gemini_lease_v1' THEN 'v_existing' ELSE 'v_lease' END);
            revised := replace(revised,'SELECT pg_catalog.count(*)::INTEGER INTO v_stage_count',legacy_stage_count);
            revised := replace(revised,'    SELECT pg_catalog.count(*)::INTEGER INTO v_resolver_count',legacy_resolver_count);
            revised := replace(revised,'    IF FOUND THEN',high_guard || '    IF FOUND THEN');
        ELSE revised := wide;
        END IF;
        EXECUTE revised;
    END LOOP;
END;
$install$;
REVOKE ALL ON FUNCTION paid_standard_capacity.acquire_direct(uuid,text,text,text,integer,uuid,integer),
    paid_standard_capacity.acquire_scheduled(uuid,text,text,text,integer,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

-- The grant decision serializes with changes to its authority. Routine progress,
-- heartbeats extending a live lease, and unrelated profile checkpoint writes do not revoke it.
-- These keys exist only as transaction-scoped locks; no identifying data is persisted.
CREATE FUNCTION paid_standard_capacity.lock_key(scope text, id uuid, job_key text DEFAULT '')
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
    SELECT hashtextextended('paid-standard-capacity-v1/' || scope || '/' || id::text || '/' || job_key,0);
$$;
REVOKE ALL ON FUNCTION paid_standard_capacity.lock_key(text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION paid_standard_capacity.serialize_revocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    key bigint;
BEGIN
    -- The OLD association is the grant this mutation could invalidate. Creating
    -- a new association cannot revoke a positive approval for a different owner.
    CASE TG_TABLE_NAME
        WHEN 'earlybird_orders' THEN key := paid_standard_capacity.lock_key('request',OLD.result_request_id);
        WHEN 'earlybird_fulfillments' THEN key := paid_standard_capacity.lock_key('request',OLD.request_id);
        WHEN 'analysis_preflights' THEN key := paid_standard_capacity.lock_key('request',OLD.consumed_request_id);
        WHEN 'analysis_requests' THEN key := paid_standard_capacity.lock_key('request',OLD.id);
        WHEN 'analysis_pipeline_jobs' THEN key := paid_standard_capacity.lock_key('job',OLD.request_id,OLD.job_key);
        WHEN 'users' THEN key := paid_standard_capacity.lock_key('owner',OLD.id);
    END CASE;
    IF key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(key); END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION paid_standard_capacity.serialize_revocation() FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    id, result_request_id, preflight_id, user_id, target_instagram_id, plan_id, status, payment_id,
    paid_at, seller_reference_confirmed_at, actual_groble_product_id, expected_groble_product_id,
    actual_amount_krw, expected_amount_krw
ON public.earlybird_orders FOR EACH ROW WHEN (OLD.status='analysis_in_progress' AND OLD.result_request_id IS NOT NULL AND
    ROW(OLD.id, OLD.result_request_id, OLD.preflight_id, OLD.user_id, OLD.target_instagram_id, OLD.plan_id,
    OLD.status, OLD.payment_id, OLD.paid_at, OLD.seller_reference_confirmed_at,
    OLD.actual_groble_product_id, OLD.expected_groble_product_id, OLD.actual_amount_krw,
    OLD.expected_amount_krw)
    IS DISTINCT FROM ROW(NEW.id, NEW.result_request_id, NEW.preflight_id, NEW.user_id, NEW.target_instagram_id, NEW.plan_id,
    NEW.status, NEW.payment_id, NEW.paid_at, NEW.seller_reference_confirmed_at,
    NEW.actual_groble_product_id, NEW.expected_groble_product_id, NEW.actual_amount_krw,
    NEW.expected_amount_krw)) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.earlybird_orders
FOR EACH ROW WHEN (OLD.status='analysis_in_progress' AND OLD.result_request_id IS NOT NULL) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    order_id, request_id, status, operator_admitted_at
ON public.earlybird_fulfillments FOR EACH ROW WHEN (OLD.status='analysis_in_progress' AND OLD.request_id IS NOT NULL AND
    ROW(OLD.order_id, OLD.request_id, OLD.status, OLD.operator_admitted_at)
    IS DISTINCT FROM ROW(NEW.order_id, NEW.request_id, NEW.status, NEW.operator_admitted_at)) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.earlybird_fulfillments
FOR EACH ROW WHEN (OLD.status='analysis_in_progress' AND OLD.request_id IS NOT NULL) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    id, consumed_request_id, user_id, target_instagram_id, access_mode, status,
    admission_selected_plan_id, policy_versions_snapshot, admission_entitlement_jti_hash
ON public.analysis_preflights FOR EACH ROW WHEN (OLD.status='consumed' AND OLD.consumed_request_id IS NOT NULL AND
    ROW(OLD.id, OLD.consumed_request_id, OLD.user_id, OLD.target_instagram_id, OLD.access_mode, OLD.status,
    OLD.admission_selected_plan_id, OLD.policy_versions_snapshot, OLD.admission_entitlement_jti_hash)
    IS DISTINCT FROM ROW(NEW.id, NEW.consumed_request_id, NEW.user_id, NEW.target_instagram_id, NEW.access_mode, NEW.status,
    NEW.admission_selected_plan_id, NEW.policy_versions_snapshot, NEW.admission_entitlement_jti_hash)) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.analysis_preflights
FOR EACH ROW WHEN (OLD.status='consumed' AND OLD.consumed_request_id IS NOT NULL) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    id, user_id, target_instagram_id, preflight_id, status, pipeline_version, plan_access_mode_snapshot,
    selected_plan_id_snapshot, policy_versions_snapshot, test_entitlement_jti_hash
ON public.analysis_requests FOR EACH ROW WHEN (OLD.pipeline_version='v2' AND OLD.plan_access_mode_snapshot='production' AND OLD.status IN ('pending','processing') AND
    ROW(OLD.id, OLD.user_id, OLD.target_instagram_id, OLD.preflight_id, OLD.status, OLD.pipeline_version,
    OLD.plan_access_mode_snapshot, OLD.selected_plan_id_snapshot, OLD.policy_versions_snapshot,
    OLD.test_entitlement_jti_hash)
    IS DISTINCT FROM ROW(NEW.id, NEW.user_id, NEW.target_instagram_id, NEW.preflight_id, NEW.status, NEW.pipeline_version,
    NEW.plan_access_mode_snapshot, NEW.selected_plan_id_snapshot, NEW.policy_versions_snapshot,
    NEW.test_entitlement_jti_hash)) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.analysis_requests
FOR EACH ROW WHEN (OLD.pipeline_version='v2' AND OLD.plan_access_mode_snapshot='production' AND OLD.status IN ('pending','processing')) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    request_id, job_key, input_hash, status, lease_token, lease_expires_at
ON public.analysis_pipeline_jobs FOR EACH ROW WHEN (OLD.status='processing' AND
    (ROW(OLD.request_id, OLD.job_key, OLD.input_hash, OLD.status, OLD.lease_token)
    IS DISTINCT FROM ROW(NEW.request_id, NEW.job_key, NEW.input_hash, NEW.status, NEW.lease_token) OR (OLD.lease_expires_at IS NOT NULL
        AND (NEW.lease_expires_at IS NULL OR NEW.lease_expires_at < OLD.lease_expires_at)))) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.analysis_pipeline_jobs
FOR EACH ROW WHEN (OLD.status='processing') EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE TRIGGER paid_standard_capacity_update AFTER UPDATE OF
    id, account_class, traffic_class, lifecycle
ON public.users FOR EACH ROW WHEN (OLD.account_class='production' AND OLD.traffic_class='external' AND OLD.lifecycle='active' AND
    ROW(OLD.id, OLD.account_class, OLD.traffic_class, OLD.lifecycle)
    IS DISTINCT FROM ROW(NEW.id, NEW.account_class, NEW.traffic_class, NEW.lifecycle)) EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();
CREATE TRIGGER paid_standard_capacity_delete AFTER DELETE ON public.users
FOR EACH ROW WHEN (OLD.account_class='production' AND OLD.traffic_class='external' AND OLD.lifecycle='active') EXECUTE FUNCTION paid_standard_capacity.serialize_revocation();

CREATE FUNCTION paid_standard_capacity.lock_approved(p_request_id uuid,p_job_key text,p_job_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE
    owner_id uuid;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(paid_standard_capacity.lock_key('request',p_request_id));
    SELECT r.user_id INTO owner_id FROM public.analysis_requests r WHERE r.id=p_request_id;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock_shared(paid_standard_capacity.lock_key('owner',owner_id));
    PERFORM pg_advisory_xact_lock_shared(paid_standard_capacity.lock_key('job',p_request_id,p_job_key));
    -- This distinct READ COMMITTED statement observes any relevant mutation that
    -- committed while we waited; the shared locks then protect the decision to commit.
    RETURN public.paid_standard_capacity_approved_v1(p_request_id,p_job_key,p_job_claim_token);
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='PAID_STANDARD_CAPACITY_LOCK_BUSY';
END;
$$;
REVOKE ALL ON FUNCTION paid_standard_capacity.lock_approved(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.acquire_paid_standard_gemini_lease_v1(p_request_id uuid,p_job_key text,p_operation_key text,
    p_stage text,p_attempt integer,p_claim_token uuid,p_lease_seconds integer,p_job_claim_token uuid)
RETURNS TABLE(outcome text,slot smallint,lease_claim_token uuid,fence bigint,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT public.paid_standard_capacity_approved_v1(p_request_id,p_job_key,p_job_claim_token) THEN
        RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_APPROVAL_REQUIRED';
    END IF;
    IF p_stage IN ('featureAnalysis','genderTriage','privateAccountName') THEN
        RETURN QUERY SELECT * FROM paid_standard_capacity.acquire_scheduled(p_request_id,p_job_key,p_operation_key,
            p_stage,p_attempt,p_claim_token,p_lease_seconds);
    ELSIF p_stage IN ('genderResolution','partnerSafety','highRiskNarrative') THEN
        RETURN QUERY SELECT * FROM paid_standard_capacity.acquire_direct(p_request_id,p_job_key,p_operation_key,
            p_stage,p_attempt,p_claim_token,p_lease_seconds);
    ELSE RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_STAGE_INVALID'; END IF;

    IF NOT paid_standard_capacity.lock_approved(p_request_id,p_job_key,p_job_claim_token) THEN
        RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_APPROVAL_REQUIRED';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.acquire_paid_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acquire_paid_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer,uuid) TO service_role;
-- The physical slot and provider budget are separate transactions. Revalidate
-- both, preserving committed/uncertain logical reservations for their recovery.
DO $provider$
DECLARE
    base regprocedure := 'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure;
    installed text := pg_get_functiondef(base);
BEGIN
    EXECUTE replace(installed,'public.acquire_analysis_provider_admission','paid_standard_capacity.acquire_provider');
END;
$provider$;
REVOKE ALL ON FUNCTION paid_standard_capacity.acquire_provider(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.acquire_paid_standard_provider_admission_v1(p_admission_id text,p_workload_role text,p_logical_provider text,
    p_credential_slot text,p_budget_key text,p_request_id uuid,p_job_key text,p_operation_key text,p_job_claim_token uuid,
    p_claim_token uuid,p_provider_fence bigint,p_lease_token uuid,p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    receipt jsonb;
    approved boolean;
BEGIN
    IF p_workload_role IS DISTINCT FROM 'paid' OR p_logical_provider IS DISTINCT FROM 'gemini' THEN
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    IF NOT public.paid_standard_capacity_approved_v1(p_request_id,p_job_key,p_job_claim_token) THEN
        IF EXISTS (SELECT FROM public.analysis_provider_admission_leases l WHERE l.admission_id=p_admission_id
            AND l.state IN ('leased','recovery_required')) THEN RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING'; END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    receipt := paid_standard_capacity.acquire_provider(p_admission_id,p_workload_role,p_logical_provider,p_credential_slot,
        p_budget_key,p_request_id,p_job_key,p_operation_key,p_job_claim_token,p_claim_token,p_provider_fence,p_lease_token,p_lease_seconds);
    IF receipt->>'outcome'='capacity_pending' THEN RETURN receipt; END IF;
    BEGIN
        approved := paid_standard_capacity.lock_approved(p_request_id,p_job_key,p_job_claim_token);
    EXCEPTION WHEN lock_not_available THEN
        IF receipt->>'outcome' IN ('already_acquired','adopted') THEN
            RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING';
        END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING';
    END;
    IF NOT approved THEN
        IF receipt->>'outcome' IN ('already_acquired','adopted') THEN
            RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING';
        END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.acquire_paid_standard_provider_admission_v1(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.acquire_paid_standard_provider_admission_v1(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)
    TO service_role;
-- Existing callers may retain their low-slot admission RPC. Route any request
-- for a high credential through the same checked purchase path at the DB boundary.
DO $legacy_provider$
DECLARE
    base regprocedure := 'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure;
    installed text := pg_get_functiondef(base);
    original text;
    revised text;
BEGIN
    SELECT prosrc INTO STRICT original FROM pg_proc WHERE oid=base;
    revised := regexp_replace(original,'(^|\n)BEGIN\n',E'\\1BEGIN\n' || $guard$    IF p_workload_role='paid' AND p_logical_provider='gemini'
        AND p_credential_slot ~ '^gemini-[0-9]+$' AND p_credential_slot !~ '^gemini-[1-8]$' THEN
        RETURN public.acquire_paid_standard_provider_admission_v1(p_admission_id,p_workload_role,p_logical_provider,p_credential_slot,
            p_budget_key,p_request_id,p_job_key,p_operation_key,p_job_claim_token,p_claim_token,p_provider_fence,p_lease_token,p_lease_seconds);
    END IF;
$guard$);
    IF original=revised THEN RAISE EXCEPTION 'PAID_STANDARD_CAPACITY_PROVIDER_SHAPE_DRIFT'; END IF;
    EXECUTE replace(installed,original,revised);
END;
$legacy_provider$;

CREATE FUNCTION public.authorize_paid_standard_vertex_dispatch_v1(p_request_id uuid,p_job_key text,p_claim_token uuid,p_job_input_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT public.authorize_analysis_v2_vertex_dispatch_v1(p_request_id,p_job_key,p_claim_token,p_job_input_hash) THEN
        RETURN false;
    END IF;
    RETURN paid_standard_capacity.lock_approved(p_request_id,p_job_key,p_claim_token);
END;
$$;
REVOKE ALL ON FUNCTION public.authorize_paid_standard_vertex_dispatch_v1(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.authorize_paid_standard_vertex_dispatch_v1(uuid,text,uuid,text) TO service_role;
-- Called as the last asynchronous step inside the SDK fetch hook. An order can
-- be revoked while the existing attempt reservation waits for a row lock.
-- Keep the insertion and the final approval in one transaction so that a denial
-- leaves no newly reserved attempt, and an unacknowledged commit remains held.
CREATE FUNCTION public.reserve_paid_standard_ai_attempt_v1(
    p_request_id uuid, p_job_key text, p_claim_token uuid, p_operation_key text, p_attempt smallint,
    p_reservation_token uuid, p_metadata jsonb, p_job_input_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt jsonb;
BEGIN
    receipt := public.reserve_analysis_v2_ai_attempt(p_request_id,p_job_key,p_claim_token,p_operation_key,
        p_attempt,p_reservation_token,p_metadata);
    IF (receipt->>'created')::boolean AND NOT public.authorize_paid_standard_vertex_dispatch_v1(
        p_request_id,p_job_key,p_claim_token,p_job_input_hash) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ANALYSIS_V2_VERTEX_DISPATCH_STOPPED';
    END IF;
    RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_paid_standard_ai_attempt_v1(uuid,text,uuid,text,smallint,uuid,jsonb,text)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_paid_standard_ai_attempt_v1(uuid,text,uuid,text,smallint,uuid,jsonb,text)
    TO service_role;
ALTER TABLE public.analysis_v2_gemini_leases DROP CONSTRAINT analysis_v2_gemini_leases_slot_check;
ALTER TABLE public.analysis_v2_gemini_leases ADD CONSTRAINT analysis_v2_gemini_leases_slot_check CHECK (slot BETWEEN 1 AND 128);
INSERT INTO public.analysis_v2_gemini_leases(slot) SELECT generate_series(9,128);
UPDATE public.analysis_provider_admission_budgets SET max_active=128, rate_limit_per_minute=240
    WHERE budget_key='paid:gemini:global';
INSERT INTO public.analysis_provider_admission_budgets
    (budget_key,workload_role,logical_provider,credential_slot,max_active,rate_limit_per_minute)
    SELECT 'paid:gemini:gemini-' || n,'paid','gemini','gemini-' || n,1,15 FROM generate_series(9,128) n;
COMMIT;
