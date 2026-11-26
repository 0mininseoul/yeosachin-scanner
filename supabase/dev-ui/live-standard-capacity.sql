-- Registered Dev only. The original allocators retain eight slots for older clients and Basic.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, extensions;

CREATE TEMP TABLE capacity_sources (
    signature text PRIMARY KEY, before_sha text, wide_sha text, after_sha text, service_execute boolean
) ON COMMIT DROP;
INSERT INTO pg_temp.capacity_sources VALUES
    ('public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)', '63f76c494b706cb302da6e7b02ded52caf85568456eef76bdde9a3cddb5ee787', '6110fcc9fe81d2a371197db6dd6056df65841f6cdaf4cb5f5fb5a8489476e418', '6110fcc9fe81d2a371197db6dd6056df65841f6cdaf4cb5f5fb5a8489476e418', true),
    ('public.analysis_provider_admission_ledger_state(public.analysis_provider_admission_leases)', '57f6c59aa4f2e26f030bfa5191b04565102a1298d802b2e171351219931b85db', 'c996f11becc2f60b82cf3dc7ffdb8cfceb2a5107377c48c8a031c3873b4b0121', 'c996f11becc2f60b82cf3dc7ffdb8cfceb2a5107377c48c8a031c3873b4b0121', false),
    ('public.assert_analysis_provider_admission_claim(text,text,text,uuid,text,text,uuid,uuid,bigint,timestamptz)', '1e287a5ea5eee7117eec0dd14620511accab5e8f95d777bb2fe670e10caaf815', 'cc84e2f01e29c50b50ff15676e1a374f59ca084b36010e6ca8ef2f9b7f9ce1d7', 'cc84e2f01e29c50b50ff15676e1a374f59ca084b36010e6ca8ef2f9b7f9ce1d7', false),
    ('public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)', '9379d945549a738a97877e05959323e7843faa3e60993052cca19ddf4d50801d', '3c86ab5134ebd33e7cfb847e57cac40882f8df2a14ece127def15c2f8d674e9a', '49d8918c614c81197af6619f664a92004ea632acc3402ee493be7baa21ab5569', true),
    ('public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)', '8c98a69f61b63efc1b91a70fb5ad44aca73faad79acf56529497394426cf4472', '24b0206c7192198b2f069cae2fd72652e1c51d4e2d1e4b78e503c2805a58c3d5', '01b20a13eee00b8fb813cc5ee204944e6c5f46a0610af534a0ab0a0d67695e74', true),
    ('public.cutoff_analysis_v2_gender_resolution_attempt(uuid,text,uuid,text,smallint,uuid,jsonb,integer,uuid,bigint)', 'e0e6161ac2d0ba2d96a85a3d78c6cf9b5a5e38aefe45c1dc9ff4facf9409d4ac', 'b5e848a89782424f84dd5005da01ad2373ff6cc0a87795192c73f5c0d24116e0', 'b5e848a89782424f84dd5005da01ad2373ff6cc0a87795192c73f5c0d24116e0', true),
    ('public.release_analysis_v2_gemini_lease(integer,uuid,bigint)', '08bf285dc215a1e628b32ba35fe08a24d39e22de61e0bfa283a985c8bee7cc45', 'c6a72891d591042fe3dcea6eebff5646bcacf48c5013ab8a75945212fe0ccfe8', 'c6a72891d591042fe3dcea6eebff5646bcacf48c5013ab8a75945212fe0ccfe8', true),
    ('public.renew_analysis_v2_gemini_lease(integer,uuid,bigint,integer)', '61c8debf7e713ac787976638b3841cae438668ebdc0787442a84078a8534f2e0', '6b0ee48001da05a18c3a05ce68c019251cf87a145647e6bf77be1e5ba35e578e', '6b0ee48001da05a18c3a05ce68c019251cf87a145647e6bf77be1e5ba35e578e', true),
    ('public.renew_analysis_v2_gemini_lease_v2(integer,uuid,bigint,text,integer)', '3d9c5024d54fce9c75f9ce16ab358cca6ede84bb5ab6c64382a0b4ddda322dde', '7babdabaebf3d19f43fd0bddb415bf0e646f6860537dcd2c73c3f3a197278b77', '7babdabaebf3d19f43fd0bddb415bf0e646f6860537dcd2c73c3f3a197278b77', true),
    ('public.resolve_analysis_v2_gemini_lease_quarantine(integer,bigint,text)', '1161c70d1f9275f287dd24d090f3dfca6aaf90c5116354cc37c2ddd0af2bfe17', 'f2aa30919a590a156e9d96d15107525e4470b677c04622d4a4002e6758203a4d', 'f2aa30919a590a156e9d96d15107525e4470b677c04622d4a4002e6758203a4d', false),
    ('public.acquire_analysis_v2_gemini_lease(uuid,text,integer,uuid,integer)', 'ca49a51bc37c68c3fffb9d87c9cda948b9f884adbca50c00cea2525777127bdb', 'ca49a51bc37c68c3fffb9d87c9cda948b9f884adbca50c00cea2525777127bdb', '05e5d2a9282e1436221fb93b21faf1430daf10983e33f8d077b479c00e7f589d', true);

CREATE TEMP TABLE capacity_functions (signature text PRIMARY KEY, sha text, service_execute boolean) ON COMMIT DROP;
INSERT INTO pg_temp.capacity_functions VALUES
    ('dev_live_budget.acquire_standard_gemini_lease(uuid,text,text,text,integer,uuid,integer)', '98e8e6a07f801710a322d569ede8ac8c362956eff5d6c758c3ed4fa014cab034', false),
    ('public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)', '0c08a1c93c692c86421f37bf2a17ee959e5ef09bc0cf7bb732065cf98b25bf3d', true),
    ('public.acquire_dev_standard_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)', '3bf19ebbdda0bd66e5b10cebfe79d15390598d1c083bb8eeb5cf931efd49db28', true);

DO $install$
DECLARE
    base constant regprocedure := 'public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)'::regprocedure;
    source_owner oid;
    source record;
    func pg_catalog.pg_proc%ROWTYPE;
    old_acl aclitem[];
    first_install boolean;
    current_size integer;
    actual_sha text;
    installed text;
    wide text;
    revised text;
    high_guard text;
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
    grant_guard constant text := $guard$    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        JOIN public.analysis_preflights AS preflight ON preflight.id = request.preflight_id
        JOIN public.analysis_pipeline_jobs AS job ON job.request_id = request.id AND job.job_key = p_job_key
        JOIN dev_live_budget.grants AS grant_row
          ON preflight.idempotency_key = 'dev-live:owner:standard:' || grant_row.grant_id::text
        WHERE request.id = p_request_id AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'
          AND job.status = 'processing' AND job.lease_expires_at > pg_catalog.clock_timestamp()
          AND grant_row.plan_id = 'standard' AND grant_row.expires_at = 'infinity'::timestamptz
          AND grant_row.apify_limit_micros = 6000000 AND grant_row.ai_limit_micros = 18000000
          AND dev_live_budget.valid_standard_profile_lineage(preflight, request)
    ) THEN
        RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_APPROVAL_REQUIRED';
    END IF;$guard$;
    delegate constant text := $delegate$    IF p_stage IS NULL OR p_stage NOT IN ('genderResolution','partnerSafety','highRiskNarrative') THEN
        RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_STAGE_MISMATCH';
    END IF;
    RETURN QUERY SELECT * FROM dev_live_budget.acquire_standard_gemini_lease(
        p_request_id, p_job_key, p_operation_key, p_stage, p_attempt, p_claim_token, p_lease_seconds
    );$delegate$;
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
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL
       OR to_regprocedure('dev_live_budget.valid_standard_profile_lineage(public.analysis_preflights,public.analysis_requests)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_WRONG_DATABASE';
    END IF;
    SELECT proowner INTO STRICT source_owner FROM pg_proc WHERE oid = base;
    IF source_owner <> current_user::regrole THEN RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_OWNER_MISMATCH'; END IF;

    -- Block new admissions and physical acquisitions until the installation commits.
    LOCK TABLE public.analysis_requests, public.analysis_pipeline_jobs IN SHARE MODE;
    PERFORM pg_advisory_xact_lock(hashtextextended('analysis-v2-gemini-leases', 0));
    LOCK TABLE public.analysis_v2_gemini_leases, public.analysis_provider_admission_budgets,
        public.analysis_provider_admission_leases IN SHARE ROW EXCLUSIVE MODE;
    SELECT count(*) INTO current_size FROM public.analysis_v2_gemini_leases;
    first_install := current_size = 8;
    IF current_size NOT IN (8,128) OR EXISTS (
        SELECT FROM public.analysis_v2_gemini_leases WHERE slot NOT BETWEEN 1 AND current_size OR state <> 'available'
    ) OR EXISTS (SELECT FROM public.analysis_requests WHERE pipeline_version = 'v2' AND status IN ('pending','processing'))
      OR EXISTS (SELECT FROM public.analysis_provider_admission_leases WHERE workload_role = 'paid' AND state IN ('leased','recovery_required'))
      OR EXISTS (SELECT FROM public.analysis_pipeline_jobs WHERE status = 'processing') THEN
        RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_REQUIRES_IDLE_WORKERS';
    END IF;
    IF (SELECT count(*) FROM public.analysis_provider_admission_budgets WHERE workload_role='paid' AND logical_provider='gemini'
            AND credential_slot IS NOT NULL) <> current_size OR EXISTS (
        SELECT FROM generate_series(1,current_size) n WHERE NOT EXISTS (
            SELECT FROM public.analysis_provider_admission_budgets WHERE budget_key='paid:gemini:gemini-' || n
              AND workload_role='paid' AND logical_provider='gemini' AND credential_slot='gemini-' || n
              AND max_active=1 AND rate_limit_per_minute=15
        )
    ) OR NOT EXISTS (
        SELECT FROM public.analysis_provider_admission_budgets WHERE budget_key='paid:gemini:global' AND workload_role='paid'
          AND logical_provider='gemini' AND credential_slot IS NULL AND max_active=current_size
          AND rate_limit_per_minute=CASE WHEN first_install THEN 120 ELSE 240 END
    ) OR NOT EXISTS (
        SELECT FROM pg_constraint WHERE conrelid='public.analysis_v2_gemini_leases'::regclass
          AND conname='analysis_v2_gemini_leases_slot_check' AND convalidated
          AND pg_get_constraintdef(oid) = format('CHECK (((slot >= 1) AND (slot <= %s)))',current_size)
    ) THEN RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_BUDGET_OR_SLOT_DRIFT'; END IF;

    IF first_install AND EXISTS (SELECT FROM pg_temp.capacity_functions WHERE to_regprocedure(signature) IS NOT NULL) THEN
        RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_FUNCTION_CONFLICT';
    END IF;
    FOR source IN SELECT * FROM pg_temp.capacity_sources ORDER BY signature LOOP
        SELECT * INTO STRICT func FROM pg_proc WHERE oid=to_regprocedure(source.signature);
        installed := pg_get_functiondef(func.oid);
        IF encode(sha256(convert_to(installed,'UTF8')),'hex') <>
               (CASE WHEN first_install THEN source.before_sha ELSE source.after_sha END)
           OR func.proowner <> source_owner OR has_function_privilege('service_role',func.oid,'EXECUTE') <> source.service_execute
           OR EXISTS (SELECT FROM aclexplode(coalesce(func.proacl,acldefault('f',func.proowner))) acl
               WHERE acl.grantee <> source_owner AND (NOT source.service_execute OR acl.grantee <> 'service_role'::regrole OR acl.is_grantable)) THEN
            RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_SOURCE_DRIFT %',func.proname;
        END IF;
        IF NOT first_install THEN CONTINUE; END IF;
        old_acl := func.proacl;
        wide := replace(installed,'p_slot NOT BETWEEN 1 AND 8','p_slot NOT BETWEEN 1 AND 128');
        wide := replace(wide,'^gemini-[1-8]$','^gemini-([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$');
        wide := replace(wide,'^gemini-([1-8])$','^gemini-([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$');
        wide := replace(wide,'WHEN ''featureAnalysis'' THEN 6','WHEN ''featureAnalysis'' THEN 80');
        wide := replace(wide,'WHEN ''genderTriage'' THEN 6','WHEN ''genderTriage'' THEN 12');
        wide := replace(wide,'v_resolver_count >= 2','v_resolver_count >= 48');
        wide := replace(wide,rank_before,rank_after);
        IF encode(sha256(convert_to(wide,'UTF8')),'hex') <> source.wide_sha THEN
            RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_EXPANSION_DRIFT %',func.proname;
        END IF;
        IF func.oid = base THEN
            -- The isolated scheduler and the direct entry point reuse the same checked allocator.
            EXECUTE replace(wide,'public.acquire_analysis_v2_gemini_lease_v2','dev_live_budget.acquire_standard_gemini_lease');
            revised := replace(installed,'public.acquire_analysis_v2_gemini_lease_v2','public.acquire_dev_standard_gemini_lease_v1');
            EXECUTE replace(revised,func.prosrc,E'\nBEGIN\n' || grant_guard || E'\n' || delegate || E'\nEND;\n');
        ELSIF func.proname='acquire_analysis_v2_scheduler_gemini_lease_v1' THEN
            revised := replace(wide,'public.acquire_analysis_v2_scheduler_gemini_lease_v1','public.acquire_dev_standard_scheduler_gemini_lease_v1');
            revised := replace(revised,'public.acquire_analysis_v2_gemini_lease_v2','dev_live_budget.acquire_standard_gemini_lease');
            EXECUTE replace(revised,E'BEGIN\n    IF p_request_id',E'BEGIN\n' || grant_guard || E'\n    IF p_request_id');
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
        IF (SELECT proacl FROM pg_proc WHERE oid=func.oid) IS DISTINCT FROM old_acl
           OR encode(sha256(convert_to(pg_get_functiondef(func.oid),'UTF8')),'hex') <> source.after_sha THEN
            RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_INSTALL_VERIFICATION_FAILED %',func.proname;
        END IF;
    END LOOP;
    FOR source IN SELECT * FROM pg_temp.capacity_functions LOOP
        SELECT * INTO STRICT func FROM pg_proc WHERE oid=to_regprocedure(source.signature);
        IF first_install THEN
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',func.oid::regprocedure);
            IF source.service_execute THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',func.oid::regprocedure);
            END IF;
        END IF;
        actual_sha := encode(sha256(convert_to(pg_get_functiondef(func.oid),'UTF8')),'hex');
        IF actual_sha <> source.sha OR func.proowner <> source_owner
          OR has_function_privilege('service_role',func.oid,'EXECUTE') <> source.service_execute
          OR EXISTS (SELECT FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
              WHERE p.oid=func.oid AND acl.grantee <> source_owner
                AND (NOT source.service_execute OR acl.grantee <> 'service_role'::regrole OR acl.is_grantable)) THEN
            RAISE EXCEPTION 'DEV_STANDARD_CAPACITY_SCOPED_RPC_DRIFT %',func.proname;
        END IF;
    END LOOP;
    IF first_install THEN
        ALTER TABLE public.analysis_v2_gemini_leases DROP CONSTRAINT analysis_v2_gemini_leases_slot_check;
        ALTER TABLE public.analysis_v2_gemini_leases ADD CONSTRAINT analysis_v2_gemini_leases_slot_check CHECK (slot BETWEEN 1 AND 128);
        INSERT INTO public.analysis_v2_gemini_leases(slot) SELECT generate_series(9,128);
        UPDATE public.analysis_provider_admission_budgets SET max_active=128, rate_limit_per_minute=240
            WHERE budget_key='paid:gemini:global';
        INSERT INTO public.analysis_provider_admission_budgets
            (budget_key,workload_role,logical_provider,credential_slot,max_active,rate_limit_per_minute)
            SELECT 'paid:gemini:gemini-' || n,'paid','gemini','gemini-' || n,1,15 FROM generate_series(9,128) n;
    END IF;
END;
$install$;
COMMIT;
