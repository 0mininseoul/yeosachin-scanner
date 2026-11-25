-- Local candidates for the shared-queue test. The baseline remains the installed Dev 8/6 configuration.
-- Only slot ranges, stage concurrency and the ranking of available credentials change.
BEGIN;
DO $capacity$
DECLARE
    slots int := current_setting('standard_shared.vertex_slots')::int;
    feature_cap int := current_setting('standard_shared.feature_slots')::int;
    credential_pattern text;
    allocator regprocedure := 'public.acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)'::regprocedure;
    existing_rank_end constant text := $original$          AND admission.state IN ('leased', 'recovery_required')
    ), lease.slot
    LIMIT 1
    FOR UPDATE;$original$;
    budget_rank_end constant text := $candidate$          AND admission.state IN ('leased', 'recovery_required')
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
    patch record;
    signature regprocedure;
    installed text;
    revised text;
BEGIN
    IF slots NOT IN (48,56,64) OR feature_cap <> slots-16
        OR current_setting('listen_addresses') <> '' OR inet_server_addr() IS NOT NULL
        OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR EXISTS (SELECT FROM public.analysis_requests)
        OR EXISTS (SELECT FROM public.analysis_provider_admission_leases)
        OR (SELECT count(*) FROM public.analysis_v2_gemini_leases WHERE state = 'available') <> 8
        OR (SELECT count(*) FROM public.analysis_v2_gemini_leases) <> 8 THEN
        RAISE EXCEPTION 'Expected a newly initialized local Standard fixture';
    END IF;
    credential_pattern := CASE slots WHEN 48 THEN '([1-9]|[1-3][0-9]|4[0-8])'
        WHEN 56 THEN '([1-9]|[1-4][0-9]|5[0-6])'
        WHEN 64 THEN '([1-9]|[1-5][0-9]|6[0-4])' END;

    FOR patch IN SELECT * FROM (VALUES
        ('acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)',
         '63f76c494b706cb302da6e7b02ded52caf85568456eef76bdde9a3cddb5ee787'),
        ('analysis_provider_admission_ledger_state(public.analysis_provider_admission_leases)',
         '57f6c59aa4f2e26f030bfa5191b04565102a1298d802b2e171351219931b85db'),
        ('assert_analysis_provider_admission_claim(text,text,text,uuid,text,text,uuid,uuid,bigint,timestamptz)',
         '1e287a5ea5eee7117eec0dd14620511accab5e8f95d777bb2fe670e10caaf815'),
        ('acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)',
         '9379d945549a738a97877e05959323e7843faa3e60993052cca19ddf4d50801d'),
        ('acquire_analysis_v2_gemini_lease_v2(uuid,text,text,text,integer,uuid,integer)',
         '8c98a69f61b63efc1b91a70fb5ad44aca73faad79acf56529497394426cf4472'),
        ('cutoff_analysis_v2_gender_resolution_attempt(uuid,text,uuid,text,smallint,uuid,jsonb,integer,uuid,bigint)',
         'e0e6161ac2d0ba2d96a85a3d78c6cf9b5a5e38aefe45c1dc9ff4facf9409d4ac'),
        ('release_analysis_v2_gemini_lease(integer,uuid,bigint)',
         '08bf285dc215a1e628b32ba35fe08a24d39e22de61e0bfa283a985c8bee7cc45'),
        ('renew_analysis_v2_gemini_lease(integer,uuid,bigint,integer)',
         '61c8debf7e713ac787976638b3841cae438668ebdc0787442a84078a8534f2e0'),
        ('renew_analysis_v2_gemini_lease_v2(integer,uuid,bigint,text,integer)',
         '3d9c5024d54fce9c75f9ce16ab358cca6ede84bb5ab6c64382a0b4ddda322dde'),
        ('resolve_analysis_v2_gemini_lease_quarantine(integer,bigint,text)',
         '1161c70d1f9275f287dd24d090f3dfca6aaf90c5116354cc37c2ddd0af2bfe17')
    ) AS sources(name, hash) LOOP
        signature := ('public.' || patch.name)::regprocedure;
        installed := pg_get_functiondef(signature);
        IF encode(sha256(convert_to(installed, 'UTF8')), 'hex') <> patch.hash THEN
            RAISE EXCEPTION 'Shared capacity fixture needs review for %', patch.name;
        END IF;
        revised := replace(installed, 'p_slot NOT BETWEEN 1 AND 8', 'p_slot NOT BETWEEN 1 AND ' || slots);
        revised := replace(revised, '^gemini-[1-8]$', '^gemini-' || credential_pattern || '$');
        revised := replace(revised, '^gemini-([1-8])$', '^gemini-' || credential_pattern || '$');
        revised := replace(revised, 'WHEN ''featureAnalysis'' THEN 6', 'WHEN ''featureAnalysis'' THEN ' || feature_cap);
        revised := replace(revised, 'WHEN ''genderTriage'' THEN 6', 'WHEN ''genderTriage'' THEN 12');
        revised := replace(revised, 'v_resolver_count >= 2', 'v_resolver_count >= 6');
        IF signature = allocator THEN
            IF pg_catalog.strpos(revised, existing_rank_end) = 0
               OR NOT pg_catalog.has_function_privilege('service_role', signature, 'EXECUTE')
               OR pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
               OR pg_catalog.has_function_privilege('authenticated', signature, 'EXECUTE') THEN
                RAISE EXCEPTION 'Unexpected physical allocator ranking or execution privileges';
            END IF;
            -- This is a read-only ranking hint. The provider RPC still locks the two
            -- budget rows and enforces all active leases, rate limits and fences.
            revised := pg_catalog.replace(revised, existing_rank_end, budget_rank_end);
        END IF;
        IF revised = installed THEN RAISE EXCEPTION 'Unchanged capacity fixture function %', patch.name; END IF;
        EXECUTE revised;
    END LOOP;

    ALTER TABLE public.analysis_v2_gemini_leases DROP CONSTRAINT analysis_v2_gemini_leases_slot_check;
    EXECUTE format('ALTER TABLE public.analysis_v2_gemini_leases ADD CONSTRAINT analysis_v2_gemini_leases_slot_check CHECK (slot BETWEEN 1 AND %s)', slots);
    INSERT INTO public.analysis_v2_gemini_leases(slot) SELECT generate_series(9, slots);
    UPDATE public.analysis_provider_admission_budgets SET max_active = slots, rate_limit_per_minute = 240
        WHERE budget_key = 'paid:gemini:global' AND max_active = 8 AND rate_limit_per_minute = 120;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unexpected global Gemini budget'; END IF;
    INSERT INTO public.analysis_provider_admission_budgets(budget_key, workload_role, logical_provider, credential_slot, max_active, rate_limit_per_minute)
        SELECT 'paid:gemini:gemini-' || n, 'paid', 'gemini', 'gemini-' || n, 1, 15 FROM generate_series(9, slots) n;
END;
$capacity$;
COMMIT;
