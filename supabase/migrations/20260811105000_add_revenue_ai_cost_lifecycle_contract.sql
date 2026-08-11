-- Forward-only AI cost lifecycle compatibility for the immutable revenue cost foundation.
-- This migration is intentionally after 20260810100000 and before the gender
-- routing contract so both fresh replays and already-migrated baselines acquire
-- the same durable AI authority before any routing caller can reference it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DROP FUNCTION IF EXISTS public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT);
CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_cost_operation_v2(
    p_request_id UUID, p_job_key TEXT, p_job_claim_token UUID, p_job_input_hash TEXT,
    p_source_kind TEXT, p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_runner_plan TEXT; v_source_hash TEXT; v_owner_hash TEXT; v_expected_krw INTEGER;
    v_operation_kind TEXT; v_now TIMESTAMPTZ;
    v_active_reserved INTEGER; v_settled_economic INTEGER; v_settled_billed INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_source_kind IS NULL OR p_source_kind NOT IN ('provider_run','ai_attempt') OR p_source_operation_key IS NULL
       OR p_source_attempt IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    -- This private provider implementation is reachable only through the
    -- provider dispatch wrapper below.
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;

    -- Canonical live order: consumed preflight -> request -> exact job -> exact
    -- provider/AI source -> parent -> exact child. Entitlement/policy are read as
    -- immutable request lineage between request and job without taking a new lock.
    SELECT * INTO v_preflight FROM public.analysis_preflights WHERE consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id = p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions WHERE request_id = p_request_id;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies WHERE request_id = p_request_id;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard')
       OR v_request.status IS NULL OR v_request.status NOT IN ('pending','processing')
       OR v_preflight.status IS DISTINCT FROM 'consumed' OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation IS DISTINCT FROM 1 OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split' OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR pg_catalog.lower(v_policy.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id)
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_job FROM public.analysis_pipeline_jobs
      WHERE request_id = p_request_id AND job_key = p_job_key FOR UPDATE;
    -- This must be after the job-row lock; transaction-start/current_timestamp
    -- can otherwise accept a lease that expired while waiting for that lock.
    v_now := pg_catalog.clock_timestamp();
    IF v_job.request_id IS NULL OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_job_claim_token OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now OR v_job.input_hash IS DISTINCT FROM p_job_input_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;

    IF p_source_attempt IS DISTINCT FROM 0 THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_provider FROM public.analysis_v2_provider_runs
      WHERE request_id = p_request_id AND job_key = p_job_key AND operation_key = p_source_operation_key FOR UPDATE;
    IF v_provider.request_id IS NULL OR v_provider.status IS DISTINCT FROM 'starting'
       OR v_provider.input_hash !~ '^[a-f0-9]{64}$'
       OR v_provider.job_claim_token IS DISTINCT FROM p_job_claim_token THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_operation_kind := CASE
        WHEN p_source_operation_key ~ '^target-profile:[a-f0-9]{64}$' THEN 'target_profile'
        WHEN p_source_operation_key ~ '^(profile-fallback|profile-repair):[a-f0-9]{64}$' THEN 'detail_profile'
        WHEN p_source_operation_key ~ '^relationship-followers:[a-f0-9]{64}$' THEN 'relationship_followers'
        WHEN p_source_operation_key ~ '^relationship-following:[a-f0-9]{64}$' THEN 'relationship_following'
        WHEN p_source_operation_key ~ '^(target-likers|target-comments|candidate-likers):[a-f0-9]{64}$' THEN 'detail_interaction'
        ELSE NULL END;
    IF v_operation_kind IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;

    v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key, 'UTF8'), 'sha256'), 'hex');
    v_owner_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'revenue-cost/live-provider-owner/v2:' || p_request_id::TEXT || ':' || p_job_key || ':' || p_source_operation_key || ':' || v_provider.input_hash,
        'UTF8'), 'sha256'), 'hex');
    v_expected_krw := public.analysis_revenue_cost_ceil_krw(v_provider.max_charge_usd);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF v_parent.request_id IS NULL OR v_parent.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_parent.user_id IS DISTINCT FROM v_request.user_id OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement' OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_parent.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1'
       OR v_parent.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
       OR v_parent.cost_cap_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 1808 ELSE 3634 END)
       OR v_parent.margin_target_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 904 ELSE 1817 END) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved','started') THEN reserved_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN economic_actual_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN billed_actual_krw ELSE 0 END), 0)::INTEGER
    INTO v_active_reserved, v_settled_economic, v_settled_billed
    FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id;
    IF v_parent.reserved_cost_krw IS DISTINCT FROM v_active_reserved
       OR v_parent.economic_actual_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.actual_cost_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.billed_actual_krw IS DISTINCT FROM v_settled_billed THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations
      WHERE request_id = p_request_id AND owner_kind = p_source_kind
        AND source_job_key = p_job_key AND source_operation_key_hash = v_source_hash AND source_attempt = p_source_attempt FOR UPDATE;
    IF FOUND THEN
        IF v_child.owner_key_hash IS DISTINCT FROM v_owner_hash OR v_child.attempt IS DISTINCT FROM 1
           OR v_child.operation_kind IS DISTINCT FROM v_operation_kind OR v_child.units IS DISTINCT FROM 1
           OR v_child.estimated_economic_usd IS DISTINCT FROM v_provider.max_charge_usd
           OR v_child.selected_manifest_scope_hash IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        IF v_child.status = 'denied' AND v_child.denial_reason = 'hard_cap'
           AND v_child.reserved_krw = 0 AND v_parent.status = 'manual_review'
           AND v_parent.manual_review_reason IN ('cost_denied','cost_overrun') THEN
            RETURN pg_catalog.jsonb_build_object('disposition','denied','created',FALSE,'replayed',TRUE,'operationId',v_child.id,'reason','hard_cap');
        END IF;
        IF v_child.status = 'reserved' AND v_child.reserved_krw = v_expected_krw
           AND v_child.denial_reason IS NULL AND v_child.started_at IS NULL AND v_child.terminal_at IS NULL
           AND v_parent.status = 'running' AND v_parent.manual_review_reason IS NULL THEN
            RETURN pg_catalog.jsonb_build_object('disposition','accepted','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
    END IF;
    IF v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    IF v_parent.economic_actual_krw + v_parent.reserved_cost_krw + v_expected_krw > v_parent.cost_cap_krw THEN
        INSERT INTO public.analysis_revenue_cost_operations (
            request_id, owner_kind, owner_key_hash, attempt, operation_kind, units, selected_manifest_scope_hash,
            source_job_key, source_operation_key_hash, source_attempt, estimated_economic_usd, reserved_krw,
            status, denial_reason, terminal_at
        ) VALUES (p_request_id, 'provider_run', v_owner_hash, 1, v_operation_kind, 1, NULL,
            p_job_key, v_source_hash, p_source_attempt, v_provider.max_charge_usd, 0, 'denied', 'hard_cap', v_now)
        RETURNING * INTO v_child;
        UPDATE public.analysis_revenue_run_ledgers SET status = 'manual_review', manual_review_reason = CASE
            WHEN manual_review_reason = 'cost_overrun' THEN 'cost_overrun'
            ELSE 'cost_denied' END
          WHERE request_id = p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','denied','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','hard_cap');
    END IF;
    INSERT INTO public.analysis_revenue_cost_operations (
        request_id, owner_kind, owner_key_hash, attempt, operation_kind, units, selected_manifest_scope_hash,
        source_job_key, source_operation_key_hash, source_attempt, estimated_economic_usd, reserved_krw
    ) VALUES (p_request_id, 'provider_run', v_owner_hash, 1, v_operation_kind, 1, NULL,
        p_job_key, v_source_hash, p_source_attempt, v_provider.max_charge_usd, v_expected_krw)
    RETURNING * INTO v_child;
    UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw = reserved_cost_krw + v_expected_krw
      WHERE request_id = p_request_id;
    RETURN pg_catalog.jsonb_build_object('disposition','accepted','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_cost_operation_started_v2(
    p_request_id UUID, p_job_key TEXT, p_job_claim_token UUID, p_job_input_hash TEXT,
    p_source_kind TEXT, p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE; v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE; v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE; v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE; v_source_hash TEXT; v_owner_hash TEXT;
    v_runner_plan TEXT; v_operation_kind TEXT; v_expected_krw INTEGER; v_now TIMESTAMPTZ;
    v_active_reserved INTEGER; v_settled_economic INTEGER; v_settled_billed INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL OR p_job_key IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' OR p_source_kind IS NULL OR p_source_kind NOT IN ('provider_run','ai_attempt') OR p_source_operation_key IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_preflight FROM public.analysis_preflights WHERE consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id = p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions WHERE request_id=p_request_id;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies WHERE request_id=p_request_id;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard') OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_request.status IS NULL OR v_request.status NOT IN ('pending','processing')
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement' OR v_preflight.admission_generation IS DISTINCT FROM 1
       OR v_preflight.admission_status IS DISTINCT FROM 'ready' OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split' OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR pg_catalog.lower(v_policy.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id)
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_job FROM public.analysis_pipeline_jobs WHERE request_id=p_request_id AND job_key=p_job_key FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.request_id IS NULL OR v_job.status IS DISTINCT FROM 'processing' OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now OR v_job.input_hash IS DISTINCT FROM p_job_input_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_source_attempt IS DISTINCT FROM 0 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_provider FROM public.analysis_v2_provider_runs WHERE request_id=p_request_id AND job_key=p_job_key AND operation_key=p_source_operation_key FOR UPDATE;
    IF v_provider.request_id IS NULL OR v_provider.status IS DISTINCT FROM 'starting'
       OR v_provider.input_hash !~ '^[a-f0-9]{64}$' OR v_provider.job_claim_token IS DISTINCT FROM p_job_claim_token THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_operation_kind := CASE
        WHEN p_source_operation_key ~ '^target-profile:[a-f0-9]{64}$' THEN 'target_profile'
        WHEN p_source_operation_key ~ '^(profile-fallback|profile-repair):[a-f0-9]{64}$' THEN 'detail_profile'
        WHEN p_source_operation_key ~ '^relationship-followers:[a-f0-9]{64}$' THEN 'relationship_followers'
        WHEN p_source_operation_key ~ '^relationship-following:[a-f0-9]{64}$' THEN 'relationship_following'
        WHEN p_source_operation_key ~ '^(target-likers|target-comments|candidate-likers):[a-f0-9]{64}$' THEN 'detail_interaction'
        ELSE NULL END;
    IF v_operation_kind IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key, 'UTF8'), 'sha256'), 'hex');
    v_owner_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/live-provider-owner/v2:' || p_request_id::TEXT || ':' || p_job_key || ':' || p_source_operation_key || ':' || v_provider.input_hash, 'UTF8'), 'sha256'), 'hex');
    v_expected_krw := public.analysis_revenue_cost_ceil_krw(v_provider.max_charge_usd);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    IF v_parent.request_id IS NULL OR v_parent.preflight_id IS DISTINCT FROM v_preflight.id OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_parent.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1' OR v_parent.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
       OR v_parent.cost_cap_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 1808 ELSE 3634 END)
       OR v_parent.margin_target_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 904 ELSE 1817 END)
       OR v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved','started') THEN reserved_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN economic_actual_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN billed_actual_krw ELSE 0 END), 0)::INTEGER
    INTO v_active_reserved, v_settled_economic, v_settled_billed
    FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id;
    IF v_parent.reserved_cost_krw IS DISTINCT FROM v_active_reserved
       OR v_parent.economic_actual_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.actual_cost_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.billed_actual_krw IS DISTINCT FROM v_settled_billed THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_source_kind AND source_job_key=p_job_key AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt FOR UPDATE;
    IF NOT FOUND OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash OR v_child.attempt IS DISTINCT FROM 1
       OR v_child.operation_kind IS DISTINCT FROM v_operation_kind OR v_child.units IS DISTINCT FROM 1
       OR v_child.selected_manifest_scope_hash IS NOT NULL OR v_child.estimated_economic_usd IS DISTINCT FROM v_provider.max_charge_usd
       OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw OR v_child.denial_reason IS NOT NULL
       OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL
       OR v_child.economic_actual_krw IS NOT NULL OR v_child.billed_actual_krw IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF v_child.status='started' AND v_child.started_at IS NOT NULL AND v_child.terminal_at IS NULL THEN RETURN pg_catalog.jsonb_build_object('disposition','started','created',FALSE,'replayed',TRUE,'operationId',v_child.id); END IF;
    IF v_child.status IS DISTINCT FROM 'reserved' OR v_child.started_at IS NOT NULL OR v_child.terminal_at IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    UPDATE public.analysis_revenue_cost_operations SET status='started', started_at=v_now WHERE id=v_child.id;
    RETURN pg_catalog.jsonb_build_object('disposition','started','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END; $$;

REVOKE ALL ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_analysis_revenue_cost_operation_started_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_revenue_cost_operation_started_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) TO service_role;

-- Terminal settlement intentionally does not accept a caller amount or live
-- job claim.  Provider reconciliation is the cost authority and commonly
-- arrives after the worker and request have both become terminal.
DROP FUNCTION IF EXISTS public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC);
DROP FUNCTION IF EXISTS public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT);
CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v2(
    p_request_id UUID, p_job_key TEXT, p_source_kind TEXT,
    p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE; v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE; v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE; v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE; v_runner_plan TEXT; v_source_hash TEXT; v_owner_hash TEXT;
    v_operation_kind TEXT; v_expected_krw INTEGER; v_actual_krw INTEGER; v_active_reserved INTEGER;
    v_settled_economic INTEGER; v_settled_billed INTEGER; v_unsettled INTEGER; v_denied INTEGER;
    v_ambiguous INTEGER; v_skipped_start INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_source_kind IS NULL OR p_source_kind NOT IN ('provider_run','ai_attempt') OR p_source_operation_key IS NULL
       OR p_source_attempt IS DISTINCT FROM 0 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;

    -- Canonical delayed-settlement order: preflight -> request -> exact job ->
    -- exact provider source -> parent -> child.  No clock-derived lease fence is
    -- used because terminal reconciliation must survive a missing/expired lease.
    -- analysis_v2_scrub_terminal_request_pii deliberately replaces both raw
    -- target_instagram_id values.  Terminal authority therefore relies on the
    -- immutable request/preflight IDs, entitlement and policy bindings,
    -- entitlement hash, parent target_username_hmac/preflight target_input_hash,
    -- parent timestamps, and source/child derived hashes below -- never the raw
    -- target fields that terminal PII retention intentionally destroys.
    SELECT * INTO v_preflight FROM public.analysis_preflights WHERE consumed_request_id=p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id=p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions WHERE request_id=p_request_id;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies WHERE request_id=p_request_id;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard')
       OR v_preflight.status IS DISTINCT FROM 'consumed' OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation IS DISTINCT FROM 1 OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split' OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_job FROM public.analysis_pipeline_jobs WHERE request_id=p_request_id AND job_key=p_job_key FOR UPDATE;
    IF v_job.request_id IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_provider FROM public.analysis_v2_provider_runs WHERE request_id=p_request_id AND job_key=p_job_key AND operation_key=p_source_operation_key FOR UPDATE;
    IF v_provider.request_id IS NULL OR v_provider.input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_operation_kind := CASE
        WHEN p_source_operation_key ~ '^target-profile:[a-f0-9]{64}$' THEN 'target_profile'
        WHEN p_source_operation_key ~ '^(profile-fallback|profile-repair):[a-f0-9]{64}$' THEN 'detail_profile'
        WHEN p_source_operation_key ~ '^relationship-followers:[a-f0-9]{64}$' THEN 'relationship_followers'
        WHEN p_source_operation_key ~ '^relationship-following:[a-f0-9]{64}$' THEN 'relationship_following'
        WHEN p_source_operation_key ~ '^(target-likers|target-comments|candidate-likers):[a-f0-9]{64}$' THEN 'detail_interaction'
        ELSE NULL END;
    IF v_operation_kind IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/live-provider-owner/v2:' || p_request_id::TEXT || ':' || p_job_key || ':' || p_source_operation_key || ':' || v_provider.input_hash,'UTF8'),'sha256'),'hex');
    v_expected_krw := public.analysis_revenue_cost_ceil_krw(v_provider.max_charge_usd);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    IF v_parent.request_id IS NULL OR v_parent.preflight_id IS DISTINCT FROM v_preflight.id OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_parent.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1' OR v_parent.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
       OR v_parent.cost_cap_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 1808 ELSE 3634 END)
       OR v_parent.margin_target_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 904 ELSE 1817 END)
       OR v_parent.status NOT IN ('running','manual_review') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved','started') THEN reserved_krw ELSE 0 END),0)::INTEGER,
           COALESCE(pg_catalog.sum(CASE WHEN status='settled' THEN economic_actual_krw ELSE 0 END),0)::INTEGER,
           COALESCE(pg_catalog.sum(CASE WHEN status='settled' THEN billed_actual_krw ELSE 0 END),0)::INTEGER
      INTO v_active_reserved,v_settled_economic,v_settled_billed FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id;
    IF v_parent.reserved_cost_krw IS DISTINCT FROM v_active_reserved OR v_parent.economic_actual_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.actual_cost_krw IS DISTINCT FROM v_settled_economic OR v_parent.billed_actual_krw IS DISTINCT FROM v_settled_billed THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT pg_catalog.count(*) FILTER (WHERE status='ambiguous')::INTEGER,
           pg_catalog.count(*) FILTER (WHERE lifecycle_anomaly='skipped_start')::INTEGER,
           pg_catalog.count(*) FILTER (WHERE status='denied')::INTEGER
      INTO v_ambiguous,v_skipped_start,v_denied
      FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id;
    -- Aggregate review state must retain every child fact before this terminal
    -- mutation.  A denial is durable cost evidence, so it requires
    -- cost_denied unless an already-recorded cost_overrun is stronger.
    IF (v_denied > 0
           AND (v_parent.status IS DISTINCT FROM 'manual_review'
             OR (v_parent.manual_review_reason IS DISTINCT FROM 'cost_overrun' AND v_parent.manual_review_reason IS DISTINCT FROM 'cost_denied')))
       OR (v_parent.manual_review_reason IS DISTINCT FROM 'cost_overrun' AND v_parent.manual_review_reason IS DISTINCT FROM 'cost_denied'
           AND ((v_ambiguous > 0 AND (v_parent.status IS DISTINCT FROM 'manual_review' OR v_parent.manual_review_reason IS DISTINCT FROM 'ambiguous_external_call'))
             OR (v_ambiguous = 0 AND v_skipped_start > 0 AND (v_parent.status IS DISTINCT FROM 'manual_review' OR v_parent.manual_review_reason IS DISTINCT FROM 'routing_failure')))) THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind='provider_run'
      AND source_job_key=p_job_key AND source_operation_key_hash=v_source_hash AND source_attempt=0 FOR UPDATE;
    IF NOT FOUND OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash OR v_child.attempt IS DISTINCT FROM 1
       OR v_child.operation_kind IS DISTINCT FROM v_operation_kind OR v_child.units IS DISTINCT FROM 1 OR v_child.selected_manifest_scope_hash IS NOT NULL
       OR v_child.estimated_economic_usd IS DISTINCT FROM v_provider.max_charge_usd OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw
       OR v_child.denial_reason IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;

    IF v_provider.status = 'rejected' THEN
        IF v_provider.run_id IS NOT NULL OR v_provider.run_started_at IS NOT NULL
           OR v_provider.actual_usage_usd IS DISTINCT FROM 0 OR v_provider.terminalized_at IS NULL OR v_provider.usage_reconciled_at IS NULL THEN
            RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
        -- A provider `rejected` row is authoritative proof that no external run
        -- was created (run_id/run_started_at NULL and actual usage zero).  It can
        -- safely release even a locally started child and clear that local marker.
        IF v_child.status='released' AND v_child.started_at IS NULL AND v_child.terminal_at IS NOT DISTINCT FROM v_provider.usage_reconciled_at
           AND v_child.economic_actual_usd IS NULL AND v_child.billed_actual_usd IS NULL
           AND v_child.economic_actual_krw IS NULL AND v_child.billed_actual_krw IS NULL THEN
            RETURN pg_catalog.jsonb_build_object('disposition','released','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
        END IF;
        IF v_child.status NOT IN ('reserved','started','ambiguous')
           OR (v_child.status IN ('reserved','started') AND v_child.terminal_at IS NOT NULL)
           OR (v_child.status = 'ambiguous' AND (v_child.started_at IS NULL OR v_child.terminal_at IS NULL))
           OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL
           OR v_child.economic_actual_krw IS NOT NULL OR v_child.billed_actual_krw IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
        UPDATE public.analysis_revenue_cost_operations SET status='released',started_at=NULL,terminal_at=v_provider.usage_reconciled_at WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers
           SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_child.status IN ('reserved','started') THEN v_child.reserved_krw ELSE 0 END
         WHERE request_id=p_request_id;
        SELECT pg_catalog.count(*) FILTER (WHERE status NOT IN ('settled','released'))::INTEGER, pg_catalog.count(*) FILTER (WHERE status='denied')::INTEGER,
               pg_catalog.count(*) FILTER (WHERE status='ambiguous')::INTEGER,
               pg_catalog.count(*) FILTER (WHERE lifecycle_anomaly='skipped_start')::INTEGER
          INTO v_unsettled,v_denied,v_ambiguous,v_skipped_start
          FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id;
        IF v_parent.manual_review_reason IS DISTINCT FROM 'cost_overrun' AND v_parent.manual_review_reason IS DISTINCT FROM 'cost_denied' AND v_ambiguous > 0 THEN
            UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='ambiguous_external_call' WHERE request_id=p_request_id;
        ELSIF v_parent.manual_review_reason IS DISTINCT FROM 'cost_overrun' AND v_parent.manual_review_reason IS DISTINCT FROM 'cost_denied' AND v_skipped_start > 0 THEN
            UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='routing_failure' WHERE request_id=p_request_id;
        ELSIF v_parent.status='manual_review' AND v_parent.manual_review_reason='ambiguous_external_call' AND v_unsettled=0 AND v_denied=0 THEN
            UPDATE public.analysis_revenue_run_ledgers SET status='running',manual_review_reason=NULL WHERE request_id=p_request_id;
        END IF;
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
    END IF;
    IF v_provider.status NOT IN ('succeeded','failed','aborted','timed_out') OR v_provider.run_id IS NULL OR v_provider.run_started_at IS NULL
       OR v_provider.terminalized_at IS NULL OR v_provider.actual_usage_usd IS NULL OR v_provider.usage_reconciled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_NOT_READY'; END IF;
    v_actual_krw := public.analysis_revenue_cost_ceil_krw(v_provider.actual_usage_usd);
    IF v_child.status='settled' THEN
        IF v_child.started_at IS NULL OR v_child.terminal_at IS DISTINCT FROM v_provider.usage_reconciled_at
           OR v_child.economic_actual_usd IS DISTINCT FROM v_provider.actual_usage_usd OR v_child.billed_actual_usd IS DISTINCT FROM 0
           OR v_child.economic_actual_krw IS DISTINCT FROM v_actual_krw OR v_child.billed_actual_krw IS DISTINCT FROM 0 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
        RETURN pg_catalog.jsonb_build_object('disposition','settled','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
    END IF;
    IF v_child.status NOT IN ('reserved','started','ambiguous') OR v_child.terminal_at IS NOT NULL AND v_child.status <> 'ambiguous'
       OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    UPDATE public.analysis_revenue_cost_operations
       SET status='settled',started_at=COALESCE(v_child.started_at,v_provider.run_started_at),terminal_at=v_provider.usage_reconciled_at,
           economic_actual_usd=v_provider.actual_usage_usd,billed_actual_usd=0,economic_actual_krw=v_actual_krw,billed_actual_krw=0,
           lifecycle_anomaly=CASE WHEN v_child.status='reserved' THEN 'skipped_start' ELSE lifecycle_anomaly END
     WHERE id=v_child.id;
    UPDATE public.analysis_revenue_run_ledgers
       SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_child.status IN ('reserved','started') THEN v_child.reserved_krw ELSE 0 END,
           economic_actual_krw=economic_actual_krw+v_actual_krw,actual_cost_krw=actual_cost_krw+v_actual_krw,billed_actual_krw=billed_actual_krw
     WHERE request_id=p_request_id;
    SELECT pg_catalog.count(*) FILTER (WHERE status NOT IN ('settled','released'))::INTEGER, pg_catalog.count(*) FILTER (WHERE status='denied')::INTEGER,
           pg_catalog.count(*) FILTER (WHERE status='ambiguous')::INTEGER,
           pg_catalog.count(*) FILTER (WHERE lifecycle_anomaly='skipped_start')::INTEGER
      INTO v_unsettled,v_denied,v_ambiguous,v_skipped_start
      FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id;
    IF v_provider.actual_usage_usd > v_provider.max_charge_usd OR v_parent.economic_actual_krw+v_actual_krw > v_parent.cost_cap_krw THEN
        UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_overrun' WHERE request_id=p_request_id;
    ELSIF v_parent.manual_review_reason IN ('cost_overrun','cost_denied') THEN
        NULL;
    ELSIF v_ambiguous > 0 THEN
        UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='ambiguous_external_call' WHERE request_id=p_request_id;
    ELSIF v_skipped_start > 0 THEN
        -- A terminal provider run with no recorded start is still cost truth,
        -- and its explicit child marker survives other-child ambiguity.
        UPDATE public.analysis_revenue_run_ledgers
           SET status='manual_review',manual_review_reason='routing_failure'
         WHERE request_id=p_request_id;
    ELSIF v_parent.status='manual_review' AND v_parent.manual_review_reason='ambiguous_external_call' AND v_unsettled=0 AND v_denied=0 THEN
        UPDATE public.analysis_revenue_run_ledgers SET status='running',manual_review_reason=NULL WHERE request_id=p_request_id;
    END IF;
    RETURN pg_catalog.jsonb_build_object('disposition','settled','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END; $$;

-- Release retains the reserve/start live identity.  A lease-holder may release
-- only a definitely non-started source; any observed provider run becomes an
-- ambiguity fence until terminal provider reconciliation settles it.
DROP FUNCTION IF EXISTS public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT,TEXT);
DROP FUNCTION IF EXISTS public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT);
CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2(
    p_request_id UUID,p_job_key TEXT,p_job_claim_token UUID,p_job_input_hash TEXT,
    p_source_kind TEXT,p_source_operation_key TEXT,p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE; v_request public.analysis_requests%ROWTYPE; v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE; v_parent public.analysis_revenue_run_ledgers%ROWTYPE; v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE; v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_runner_plan TEXT; v_operation_kind TEXT; v_source_hash TEXT; v_owner_hash TEXT; v_expected_krw INTEGER; v_now TIMESTAMPTZ;
    v_active_reserved INTEGER; v_settled_economic INTEGER; v_settled_billed INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL OR p_job_key IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' OR p_source_kind IS NULL OR p_source_kind NOT IN ('provider_run','ai_attempt')
       OR p_source_operation_key IS NULL OR p_source_attempt IS DISTINCT FROM 0 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_preflight FROM public.analysis_preflights WHERE consumed_request_id=p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id=p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions WHERE request_id=p_request_id;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies WHERE request_id=p_request_id;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard') OR v_request.status NOT IN ('pending','processing')
       OR v_preflight.status IS DISTINCT FROM 'consumed' OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation IS DISTINCT FROM 1 OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.request_id IS NULL OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.request_id IS NULL OR v_policy.mode IS DISTINCT FROM 'test_operation_split' OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR pg_catalog.lower(v_policy.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id)
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_job FROM public.analysis_pipeline_jobs WHERE request_id=p_request_id AND job_key=p_job_key FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();
    IF v_job.request_id IS NULL OR v_job.status IS DISTINCT FROM 'processing' OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at<=v_now THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_provider FROM public.analysis_v2_provider_runs WHERE request_id=p_request_id AND job_key=p_job_key AND operation_key=p_source_operation_key FOR UPDATE;
    IF v_provider.request_id IS NULL OR v_provider.input_hash !~ '^[a-f0-9]{64}$' OR v_provider.job_claim_token IS DISTINCT FROM p_job_claim_token THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_operation_kind := CASE
        WHEN p_source_operation_key ~ '^target-profile:[a-f0-9]{64}$' THEN 'target_profile'
        WHEN p_source_operation_key ~ '^(profile-fallback|profile-repair):[a-f0-9]{64}$' THEN 'detail_profile'
        WHEN p_source_operation_key ~ '^relationship-followers:[a-f0-9]{64}$' THEN 'relationship_followers'
        WHEN p_source_operation_key ~ '^relationship-following:[a-f0-9]{64}$' THEN 'relationship_following'
        WHEN p_source_operation_key ~ '^(target-likers|target-comments|candidate-likers):[a-f0-9]{64}$' THEN 'detail_interaction'
        ELSE NULL END;
    IF v_operation_kind IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_source_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/live-provider-owner/v2:' || p_request_id::TEXT || ':' || p_job_key || ':' || p_source_operation_key || ':' || v_provider.input_hash,'UTF8'),'sha256'),'hex');
    v_expected_krw:=public.analysis_revenue_cost_ceil_krw(v_provider.max_charge_usd);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    IF v_parent.request_id IS NULL OR v_parent.preflight_id IS DISTINCT FROM v_preflight.id OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at OR v_parent.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1'
       OR v_parent.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
       OR v_parent.cost_cap_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 1808 ELSE 3634 END)
       OR v_parent.margin_target_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot='basic' THEN 904 ELSE 1817 END)
       OR v_parent.status NOT IN ('running','manual_review') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved','started') THEN reserved_krw ELSE 0 END),0)::INTEGER,
           COALESCE(pg_catalog.sum(CASE WHEN status='settled' THEN economic_actual_krw ELSE 0 END),0)::INTEGER,
           COALESCE(pg_catalog.sum(CASE WHEN status='settled' THEN billed_actual_krw ELSE 0 END),0)::INTEGER
      INTO v_active_reserved,v_settled_economic,v_settled_billed FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id;
    IF v_parent.reserved_cost_krw IS DISTINCT FROM v_active_reserved OR v_parent.economic_actual_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.actual_cost_krw IS DISTINCT FROM v_settled_economic OR v_parent.billed_actual_krw IS DISTINCT FROM v_settled_billed THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind='provider_run' AND source_job_key=p_job_key
      AND source_operation_key_hash=v_source_hash AND source_attempt=0 FOR UPDATE;
    IF NOT FOUND OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash OR v_child.attempt IS DISTINCT FROM 1 OR v_child.operation_kind IS DISTINCT FROM v_operation_kind OR v_child.units IS DISTINCT FROM 1
       OR v_child.selected_manifest_scope_hash IS NOT NULL OR v_child.estimated_economic_usd IS DISTINCT FROM v_provider.max_charge_usd OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw
       OR v_child.denial_reason IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    IF v_child.status='released' AND v_child.started_at IS NULL AND v_child.economic_actual_usd IS NULL AND v_child.billed_actual_usd IS NULL
       AND v_child.economic_actual_krw IS NULL AND v_child.billed_actual_krw IS NULL AND v_child.denial_reason IS NULL
       AND ((v_provider.status='starting' AND v_provider.run_id IS NULL AND v_provider.run_started_at IS NULL
             AND v_provider.terminalized_at IS NULL AND v_provider.actual_usage_usd IS NULL AND v_provider.usage_reconciled_at IS NULL
             AND v_child.terminal_at IS NOT DISTINCT FROM GREATEST(v_provider.reserved_at,v_child.created_at))
            OR (v_provider.status='rejected' AND v_provider.run_id IS NULL AND v_provider.run_started_at IS NULL
             AND v_provider.actual_usage_usd IS NOT DISTINCT FROM 0 AND v_provider.terminalized_at IS NOT NULL AND v_provider.usage_reconciled_at IS NOT NULL
             AND v_child.terminal_at IS NOT DISTINCT FROM v_provider.usage_reconciled_at)) THEN
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
    END IF;
    IF v_child.status='ambiguous' AND v_child.started_at IS NOT NULL AND v_child.terminal_at IS NOT NULL
       AND ((v_provider.status='starting' AND v_provider.run_id IS NULL AND v_provider.run_started_at IS NULL
             AND v_provider.terminalized_at IS NULL AND v_provider.actual_usage_usd IS NULL AND v_provider.usage_reconciled_at IS NULL)
            OR (v_provider.status='running' AND v_provider.run_id IS NOT NULL AND v_provider.run_started_at IS NOT NULL
             AND v_provider.terminalized_at IS NULL AND v_provider.actual_usage_usd IS NULL AND v_provider.usage_reconciled_at IS NULL)) THEN
        RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',TRUE,'operationId',v_child.id,'reason','ambiguous_external_call');
    END IF;
    IF v_child.status NOT IN ('reserved','started') OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    -- Unlike a still-starting source, a rejected source is definitive provider
    -- truth: no run crossed the external boundary.  It may release a local
    -- started marker without manufacturing an ambiguity.
    IF v_provider.status='rejected' AND v_provider.run_id IS NULL AND v_provider.run_started_at IS NULL
       AND v_provider.actual_usage_usd IS NOT DISTINCT FROM 0 AND v_provider.terminalized_at IS NOT NULL AND v_provider.usage_reconciled_at IS NOT NULL THEN
        IF v_child.terminal_at IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
        UPDATE public.analysis_revenue_cost_operations SET status='released',started_at=NULL,terminal_at=v_provider.usage_reconciled_at WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_child.reserved_krw WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
    END IF;
    IF v_child.status='started' THEN
        -- The runtime marks this immediately before its provider call.  Even a
        -- still-starting provider row cannot prove that the call never crossed
        -- the external boundary, so it must remain recoverable ambiguity.
        UPDATE public.analysis_revenue_cost_operations SET status='ambiguous',terminal_at=v_now WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_child.reserved_krw,status='manual_review',manual_review_reason=CASE
            WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
            ELSE 'ambiguous_external_call' END WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
    END IF;
    IF v_provider.status = 'starting' AND v_provider.run_id IS NULL AND v_provider.run_started_at IS NULL
       AND v_provider.terminalized_at IS NULL AND v_provider.actual_usage_usd IS NULL AND v_provider.usage_reconciled_at IS NULL THEN
        IF v_child.status<>'reserved' OR v_child.started_at IS NOT NULL OR v_child.terminal_at IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
        UPDATE public.analysis_revenue_cost_operations SET status='released',terminal_at=GREATEST(v_provider.reserved_at,v_child.created_at) WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_child.reserved_krw WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
    END IF;
    IF v_provider.run_id IS NULL OR v_provider.run_started_at IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    UPDATE public.analysis_revenue_cost_operations SET status='ambiguous',started_at=COALESCE(started_at,v_provider.run_started_at),terminal_at=v_now WHERE id=v_child.id;
    UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_child.status IN ('reserved','started') THEN v_child.reserved_krw ELSE 0 END,status='manual_review',manual_review_reason=CASE
        WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
        ELSE 'ambiguous_external_call' END WHERE request_id=p_request_id;
    RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
END; $$;

REVOKE ALL ON FUNCTION public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) TO service_role;

-- Durable Gemini-attempt economic authority.  The existing v2 provider RPCs
-- remain the provider implementation; the public signatures below dispatch
-- provider calls unchanged and add the already-owned ai_attempt path.  No
-- caller can supply a price, usage amount, or owner identity for this path.

ALTER TABLE public.analysis_revenue_cost_operations
    DROP CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_check;
ALTER TABLE public.analysis_revenue_cost_operations
    ADD CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_check CHECK (
        lifecycle_anomaly IS NULL
        OR (
            lifecycle_anomaly = 'skipped_start'
            AND (
                (owner_kind = 'provider_run' AND source_job_key <> 'preflight'
                    AND source_attempt = 0 AND attempt = 1)
                OR (owner_kind = 'ai_attempt' AND source_job_key <> 'preflight'
                    AND source_attempt = attempt)
            )
            AND status = 'settled' AND denial_reason IS NULL
        )
    );

-- Snapshot of the Vertex Gemini list pricing used by the application on
-- 2026-08-10.  This intentionally mirrors gemini-cost.ts but lives in the
-- database so terminal reconciliation never trusts a process-local estimate.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_usd_v1(
    p_model_name TEXT,
    p_location TEXT,
    p_prompt_tokens INTEGER,
    p_completion_tokens INTEGER,
    p_thinking_tokens INTEGER
) RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
    v_input_rate NUMERIC;
    v_output_rate NUMERIC;
BEGIN
    IF p_prompt_tokens < 0 OR p_completion_tokens < 0 OR p_thinking_tokens < 0
       OR p_prompt_tokens > 100000000 OR p_completion_tokens > 100000000
       OR p_thinking_tokens > 100000000 THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_model_name IN ('gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview')
       OR p_model_name ~ '^gemini-3\\.1-flash-lite-[0-9]{3}$' THEN
        IF pg_catalog.lower(p_location) = 'global' THEN
            v_input_rate := 0.25::NUMERIC;
            v_output_rate := 1.5::NUMERIC;
        ELSE
            v_input_rate := 0.275::NUMERIC;
            v_output_rate := 1.65::NUMERIC;
        END IF;
    ELSIF p_model_name = 'gemini-3-flash-preview' THEN
        v_input_rate := 0.5::NUMERIC;
        v_output_rate := 3::NUMERIC;
    ELSE
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    RETURN pg_catalog.round(
        (p_prompt_tokens::NUMERIC * v_input_rate
         + (p_completion_tokens::NUMERIC + p_thinking_tokens::NUMERIC) * v_output_rate)
        / 1000000::NUMERIC,
        12
    );
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_usd_v1(TEXT,TEXT,INTEGER,INTEGER,INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

-- The pre-call reserve uses immutable stage-policy metadata and a bounded,
-- versioned input envelope.  Unknown policy bytes are fenced rather than
-- estimated.  The output reservation is the policy's maximum output count;
-- terminal settlement still derives the exact actual from persisted telemetry.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_max_usd_v1(
    p_model_name TEXT,
    p_location TEXT,
    p_stage TEXT,
    p_thinking_level TEXT,
    p_media_count SMALLINT,
    p_media_resolution TEXT,
    p_prompt_version TEXT,
    p_schema_version SMALLINT,
    p_max_output_tokens INTEGER
) RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_input_ceiling INTEGER;
BEGIN
    IF p_model_name IS NULL OR p_location IS NULL OR p_stage IS NULL
       OR p_thinking_level IS NULL OR p_media_count IS NULL
       OR p_media_resolution IS NULL OR p_prompt_version IS NULL
       OR p_schema_version IS NULL OR p_max_output_tokens IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_stage = 'genderTriage'
       AND p_model_name = 'gemini-3.1-flash-lite'
       AND p_thinking_level = 'MINIMAL' AND p_media_resolution = 'LOW'
       AND p_media_count BETWEEN 0 AND 10
       AND ((p_prompt_version IN ('gender-triage-v2', 'gender-triage-v3')
             AND p_schema_version = 2 AND p_max_output_tokens = 512)
            OR (p_prompt_version IN ('gender-triage-microbatch-v1', 'gender-triage-microbatch-v2')
                AND p_schema_version = 3 AND p_max_output_tokens = 1024)) THEN
        v_input_ceiling := 4096 + p_media_count * 2048;
    ELSIF p_stage = 'genderResolution'
       AND p_model_name = 'gemini-3-flash-preview'
       AND p_thinking_level = 'LOW' AND p_media_resolution = 'MEDIUM'
       AND p_media_count BETWEEN 0 AND 5
       AND p_prompt_version = 'gender-resolution-v1' AND p_schema_version = 1
       AND p_max_output_tokens = 512 THEN
        v_input_ceiling := 8192 + p_media_count * 2048;
    ELSIF p_stage = 'featureAnalysis'
       AND p_model_name = 'gemini-3.1-flash-lite'
       AND p_thinking_level = 'MEDIUM' AND p_media_resolution = 'MEDIUM'
       AND p_media_count BETWEEN 0 AND 11
       AND p_prompt_version IN ('feature-analysis-v3', 'feature-analysis-v4', 'feature-analysis-v5')
       AND p_schema_version = 3 AND p_max_output_tokens = 2048 THEN
        v_input_ceiling := 8192 + p_media_count * 2048;
    ELSIF p_stage = 'privateAccountName'
       AND p_model_name = 'gemini-3.1-flash-lite'
       AND p_thinking_level = 'MINIMAL' AND p_media_resolution = 'LOW'
       AND p_media_count = 0 AND p_prompt_version = 'private-account-name-v1'
       AND p_schema_version = 1 AND p_max_output_tokens = 8192 THEN
        v_input_ceiling := 8192;
    ELSIF p_stage = 'partnerSafety'
       AND p_model_name = 'gemini-3.1-flash-lite'
       AND p_thinking_level = 'MEDIUM' AND p_media_resolution = 'LOW'
       AND p_media_count BETWEEN 0 AND 1 AND p_prompt_version = 'partner-safety-v2'
       AND p_schema_version = 2 AND p_max_output_tokens = 768 THEN
        v_input_ceiling := 4096 + p_media_count * 2048;
    ELSIF p_stage = 'highRiskNarrative'
       AND p_model_name = 'gemini-3-flash-preview'
       AND p_thinking_level = 'HIGH' AND p_media_resolution = 'MEDIUM'
       AND p_media_count BETWEEN 0 AND 11
       AND p_prompt_version IN ('high-risk-narrative-v2', 'high-risk-narrative-v3')
       AND p_schema_version = 2 AND p_max_output_tokens = 4096 THEN
        v_input_ceiling := 8192 + p_media_count * 2048;
    ELSE
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    RETURN public.analysis_revenue_ai_cost_usd_v1(
        p_model_name, p_location, v_input_ceiling, p_max_output_tokens, 0
    );
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_max_usd_v1(TEXT,TEXT,TEXT,TEXT,SMALLINT,TEXT,TEXT,SMALLINT,INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_owner_hash_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_attempt SMALLINT,
    p_reservation_token UUID,
    p_model_name TEXT,
    p_location TEXT,
    p_stage TEXT,
    p_thinking_level TEXT,
    p_media_count SMALLINT,
    p_media_resolution TEXT,
    p_prompt_version TEXT,
    p_schema_version SMALLINT,
    p_max_output_tokens INTEGER,
    p_retry_count SMALLINT
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'revenue-cost/live-ai-owner/v1:' || p_request_id::TEXT || ':' || p_job_key || ':'
        || p_operation_key || ':' || p_attempt::TEXT || ':' || p_reservation_token::TEXT || ':'
        || p_model_name || ':' || p_location || ':' || p_stage || ':'
        || COALESCE(p_thinking_level, '') || ':' || p_media_count::TEXT || ':'
        || COALESCE(p_media_resolution, '') || ':' || p_prompt_version || ':'
        || p_schema_version::TEXT || ':' || p_max_output_tokens::TEXT || ':' || p_retry_count::TEXT,
        'UTF8'
    ), 'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_owner_hash_v1(UUID,TEXT,TEXT,SMALLINT,UUID,TEXT,TEXT,TEXT,TEXT,SMALLINT,TEXT,TEXT,SMALLINT,INTEGER,SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;

-- Locks only the live lineage through the job claim.  The exact source lock
-- intentionally remains in the caller immediately before the parent lock.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_assert_lineage_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_require_live_claim BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_runner_plan TEXT;
    v_now TIMESTAMPTZ;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_require_live_claim IS NULL
       OR (p_require_live_claim AND (
            p_job_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       )) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_preflight FROM public.analysis_preflights
      WHERE consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests
      WHERE id = p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_request.id IS NULL
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation IS DISTINCT FROM 1
       OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    SELECT * INTO v_job FROM public.analysis_pipeline_jobs
      WHERE request_id = p_request_id AND job_key = p_job_key FOR UPDATE;
    IF v_job.request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_require_live_claim THEN
        v_now := pg_catalog.clock_timestamp();
        IF v_request.status NOT IN ('pending', 'processing')
           OR pg_catalog.lower(v_preflight.target_instagram_id)
                IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
           OR pg_catalog.lower(v_policy.target_instagram_id)
                IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id)
           OR v_job.status IS DISTINCT FROM 'processing'
           OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
           OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
           OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_assert_lineage_v1(UUID,TEXT,UUID,TEXT,BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

-- This lock follows the exact source row.  It validates the immutable parent
-- pricing, entitlement fingerprint, and hard-cap lineage before any child
-- aggregate or mutation is read.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_assert_parent_v1(
    p_request_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
BEGIN
    SELECT * INTO v_preflight FROM public.analysis_preflights
      WHERE consumed_request_id = p_request_id;
    SELECT * INTO v_request FROM public.analysis_requests
      WHERE id = p_request_id;
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers
      WHERE request_id = p_request_id FOR UPDATE;
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_parent.request_id IS NULL
       OR v_parent.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_parent.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1'
       OR v_parent.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
       OR v_parent.cost_cap_krw IS DISTINCT FROM (
            CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 1808 ELSE 3634 END
       )
       OR v_parent.margin_target_krw IS DISTINCT FROM (
            CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 904 ELSE 1817 END
       )
       OR v_parent.status NOT IN ('running', 'manual_review') THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_assert_parent_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_assert_aggregates_v1(
    p_request_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_active_reserved INTEGER;
    v_settled_economic INTEGER;
    v_settled_billed INTEGER;
BEGIN
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT
        COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved', 'started') THEN reserved_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN economic_actual_krw ELSE 0 END), 0)::INTEGER,
        COALESCE(pg_catalog.sum(CASE WHEN status = 'settled' THEN billed_actual_krw ELSE 0 END), 0)::INTEGER
      INTO v_active_reserved, v_settled_economic, v_settled_billed
      FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id;
    IF v_parent.request_id IS NULL
       OR v_parent.reserved_cost_krw IS DISTINCT FROM v_active_reserved
       OR v_parent.economic_actual_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.actual_cost_krw IS DISTINCT FROM v_settled_economic
       OR v_parent.billed_actual_krw IS DISTINCT FROM v_settled_billed THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_assert_aggregates_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- Maps only known stage/job pairs from the approved v2 runtime.  In
-- particular, stage_one routing is proven only by the exact relationship job
-- and its immutable routing manifest; generic gender triage cannot claim it.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_operation_mapping_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_input_hash TEXT,
    p_plan_id TEXT,
    p_operation_key TEXT,
    p_source_attempt SMALLINT,
    p_stage TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_manifest_count INTEGER := 0;
BEGIN
    IF p_plan_id NOT IN ('basic', 'standard') OR p_source_attempt NOT BETWEEN 1 AND 4
       OR p_operation_key IS NULL OR p_stage IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_stage = 'genderTriage'
       AND p_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
       AND p_job_key = 'track:relationships:collect' THEN
        -- A relationship job can retain historical checkpoint manifests.  A
        -- cost reserve may use one only when its immutable job/input/plan
        -- evidence identifies exactly one current scope; choosing an
        -- arbitrary matching checkpoint would make the economic child drift.
        FOR v_manifest IN
            SELECT * FROM public.analysis_v2_gender_routing_manifests
             WHERE request_id = p_request_id
               AND relationship_job_key = p_job_key
               AND relationship_job_input_hash = p_job_input_hash
               AND policy_version = 'gender-routing-v1'
               AND plan_id = p_plan_id
               AND status IN ('building', 'complete')
             FOR UPDATE
        LOOP
            v_manifest_count := v_manifest_count + 1;
            IF v_manifest_count > 1 THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
        END LOOP;
        IF v_manifest_count <> 1 OR v_manifest.request_id IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'operation_kind', CASE WHEN p_source_attempt = 1
                THEN 'stage_one_routing' ELSE 'stage_one_routing_retry' END,
            'selected_manifest_scope_hash', v_manifest.canonical_input_hmac
        );
    ELSIF p_stage = 'genderTriage'
       AND p_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_profile');
    ELSIF p_stage = 'genderResolution'
       AND p_operation_key ~ '^gender-resolution:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'resolver');
    ELSIF p_stage = 'featureAnalysis'
       AND p_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_media');
    ELSIF p_stage = 'privateAccountName'
       AND p_operation_key ~ '^private-account-name:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:private-names:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_profile');
    ELSIF p_stage = 'partnerSafety'
       AND p_operation_key ~ '^partner-safety:[a-f0-9]{64}$'
       AND p_job_key = 'track:partner-safety:batch:0' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_interaction');
    ELSIF p_stage = 'highRiskNarrative'
       AND p_operation_key ~ '^high-risk-narrative:[a-f0-9]{64}$'
       AND p_job_key = 'track:narratives:batch:0' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_interaction');
    END IF;
    RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_operation_mapping_v1(UUID,TEXT,TEXT,TEXT,TEXT,SMALLINT,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_refresh_review_v1(
    p_request_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_unsettled INTEGER;
    v_denied INTEGER;
    v_ambiguous INTEGER;
    v_skipped_start INTEGER;
BEGIN
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT
        pg_catalog.count(*) FILTER (WHERE status NOT IN ('settled', 'released'))::INTEGER,
        pg_catalog.count(*) FILTER (WHERE status = 'denied')::INTEGER,
        pg_catalog.count(*) FILTER (WHERE status = 'ambiguous')::INTEGER,
        pg_catalog.count(*) FILTER (WHERE lifecycle_anomaly = 'skipped_start')::INTEGER
      INTO v_unsettled, v_denied, v_ambiguous, v_skipped_start
      FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id;
    IF v_parent.manual_review_reason IN ('cost_overrun','cost_denied') THEN
        RETURN;
    ELSIF v_denied > 0 THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status = 'manual_review', manual_review_reason = 'cost_denied'
         WHERE request_id = p_request_id;
    ELSIF v_ambiguous > 0 THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status = 'manual_review', manual_review_reason = 'ambiguous_external_call'
         WHERE request_id = p_request_id;
    ELSIF v_skipped_start > 0 THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status = 'manual_review', manual_review_reason = 'routing_failure'
         WHERE request_id = p_request_id;
    ELSIF v_unsettled = 0
       AND v_parent.status = 'manual_review'
       AND v_parent.manual_review_reason IN ('ambiguous_external_call', 'routing_failure') THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status = 'running', manual_review_reason = NULL
         WHERE request_id = p_request_id;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_refresh_review_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the provider implementation exactly, then expose a single public
-- dispatch signature.  The renamed helpers are private to the wrapper.
ALTER FUNCTION public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    RENAME TO reserve_analysis_revenue_cost_operation_provider_v2;
ALTER FUNCTION public.mark_analysis_revenue_cost_operation_started_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    RENAME TO mark_analysis_revenue_cost_operation_started_provider_v2;
ALTER FUNCTION public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT)
    RENAME TO settle_analysis_revenue_cost_operation_provider_v2;
ALTER FUNCTION public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    RENAME TO release_analysis_revenue_cost_operation_provider_v2;

CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_cost_operation_v2(
    p_request_id UUID, p_job_key TEXT, p_job_claim_token UUID, p_job_input_hash TEXT,
    p_source_kind TEXT, p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_ai public.analysis_v2_ai_attempts%ROWTYPE;
    v_previous public.analysis_v2_ai_attempts%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_previous_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_mapping JSONB;
    v_previous_mapping JSONB;
    v_source_hash TEXT;
    v_owner_hash TEXT;
    v_previous_owner_hash TEXT;
    v_operation_kind TEXT;
    v_scope_hash TEXT;
    v_expected_usd NUMERIC;
    v_expected_krw INTEGER;
    v_now TIMESTAMPTZ;
BEGIN
    IF p_source_kind = 'provider_run' THEN
        RETURN public.reserve_analysis_revenue_cost_operation_provider_v2(
            p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,
            p_source_kind,p_source_operation_key,p_source_attempt
        );
    END IF;
    IF p_source_kind IS DISTINCT FROM 'ai_attempt' OR p_source_attempt NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,TRUE
    );
    SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts
      WHERE request_id=p_request_id AND job_key=p_job_key
        AND operation_key=p_source_operation_key AND attempt=p_source_attempt FOR UPDATE;
    IF v_ai.request_id IS NULL OR v_ai.status IS DISTINCT FROM 'reserved'
       OR v_ai.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_ai.retry_count IS DISTINCT FROM p_source_attempt - 1
       OR v_ai.usage_metadata_status IS NOT NULL OR v_ai.usage_complete IS NOT NULL
       OR v_ai.prompt_tokens IS NOT NULL OR v_ai.completion_tokens IS NOT NULL
       OR v_ai.total_tokens IS NOT NULL OR v_ai.thinking_tokens IS NOT NULL
       OR v_ai.estimated_cost_usd IS NOT NULL OR v_ai.finish_reason IS NOT NULL
       OR v_ai.terminal_payload_hash IS NOT NULL OR v_ai.terminalized_at IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_expected_usd := public.analysis_revenue_ai_cost_max_usd_v1(
        v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,
        v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens
    );
    v_mapping := public.analysis_revenue_ai_cost_operation_mapping_v1(
        p_request_id,p_job_key,p_job_input_hash,
        (SELECT selected_plan_id_snapshot FROM public.analysis_requests WHERE id=p_request_id),
        p_source_operation_key,p_source_attempt,v_ai.stage
    );
    v_operation_kind := v_mapping->>'operation_kind';
    v_scope_hash := v_mapping->>'selected_manifest_scope_hash';
    IF v_operation_kind NOT IN ('target_profile','relationship_followers','relationship_following','stage_one_routing','stage_one_routing_retry','detail_profile','detail_media','detail_interaction','resolver')
       OR (v_scope_hash IS NOT NULL AND v_scope_hash !~ '^[a-f0-9]{64}$') THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash := public.analysis_revenue_ai_cost_owner_hash_v1(
        p_request_id,p_job_key,p_source_operation_key,p_source_attempt,v_ai.reservation_token,
        v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,
        v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens,v_ai.retry_count
    );
    v_expected_krw := public.analysis_revenue_cost_ceil_krw(v_expected_usd);

    -- A retry cannot sidestep a potentially billable predecessor.  The V2
    -- attempt ledger proves its rate-limit shape, and this ledger proves the
    -- exact previous reserve was released before one shared parent is charged.
    IF p_source_attempt > 1 THEN
        SELECT * INTO v_previous FROM public.analysis_v2_ai_attempts
          WHERE request_id=p_request_id AND operation_key=p_source_operation_key
            AND attempt=p_source_attempt-1 FOR UPDATE;
        IF v_previous.request_id IS NULL OR v_previous.status IS DISTINCT FROM 'rate_limited'
           OR v_previous.job_key IS DISTINCT FROM p_job_key
           OR v_previous.model_name IS DISTINCT FROM v_ai.model_name
           OR v_previous.location IS DISTINCT FROM v_ai.location
           OR v_previous.stage IS DISTINCT FROM v_ai.stage
           OR v_previous.thinking_level IS DISTINCT FROM v_ai.thinking_level
           OR v_previous.media_count IS DISTINCT FROM v_ai.media_count
           OR v_previous.media_resolution IS DISTINCT FROM v_ai.media_resolution
           OR v_previous.prompt_version IS DISTINCT FROM v_ai.prompt_version
           OR v_previous.schema_version IS DISTINCT FROM v_ai.schema_version
           OR v_previous.max_output_tokens IS DISTINCT FROM v_ai.max_output_tokens
           OR v_previous.retry_count IS DISTINCT FROM p_source_attempt-2
           OR v_previous.usage_metadata_status IS DISTINCT FROM 'missing'
           OR v_previous.usage_complete IS DISTINCT FROM FALSE
           OR v_previous.prompt_tokens IS NOT NULL OR v_previous.completion_tokens IS NOT NULL
           OR v_previous.total_tokens IS NOT NULL OR v_previous.thinking_tokens IS NOT NULL
           OR v_previous.estimated_cost_usd IS NOT NULL OR v_previous.finish_reason IS NOT NULL
           OR v_previous.terminalized_at IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        v_previous_mapping := public.analysis_revenue_ai_cost_operation_mapping_v1(
            p_request_id,p_job_key,p_job_input_hash,
            (SELECT selected_plan_id_snapshot FROM public.analysis_requests WHERE id=p_request_id),
            p_source_operation_key,((p_source_attempt - 1)::SMALLINT),v_previous.stage
        );
        v_previous_owner_hash := public.analysis_revenue_ai_cost_owner_hash_v1(
            p_request_id,p_job_key,p_source_operation_key,((p_source_attempt - 1)::SMALLINT),v_previous.reservation_token,
            v_previous.model_name,v_previous.location,v_previous.stage,v_previous.thinking_level,v_previous.media_count,
            v_previous.media_resolution,v_previous.prompt_version,v_previous.schema_version,v_previous.max_output_tokens,v_previous.retry_count
        );
        SELECT * INTO v_previous_child FROM public.analysis_revenue_cost_operations
          WHERE request_id=p_request_id AND owner_kind='ai_attempt' AND source_job_key=p_job_key
            AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt-1 FOR UPDATE;
        IF v_previous_child.id IS NULL OR v_previous_child.owner_key_hash IS DISTINCT FROM v_previous_owner_hash
           OR v_previous_child.attempt IS DISTINCT FROM p_source_attempt-1
           OR v_previous_child.operation_kind IS DISTINCT FROM (v_previous_mapping->>'operation_kind')
           OR v_previous_child.selected_manifest_scope_hash IS DISTINCT FROM (v_previous_mapping->>'selected_manifest_scope_hash')
           OR v_previous_child.units IS DISTINCT FROM 1
           OR v_previous_child.estimated_economic_usd IS DISTINCT FROM v_expected_usd
           OR v_previous_child.reserved_krw IS DISTINCT FROM v_expected_krw
           OR v_previous_child.status IS DISTINCT FROM 'released'
           OR v_previous_child.started_at IS NOT NULL
           OR v_previous_child.terminal_at IS DISTINCT FROM v_previous.terminalized_at
           OR v_previous_child.economic_actual_usd IS NOT NULL OR v_previous_child.billed_actual_usd IS NOT NULL
           OR v_previous_child.denial_reason IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
    END IF;

    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    PERFORM public.analysis_revenue_ai_cost_assert_aggregates_v1(p_request_id);
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations
      WHERE request_id=p_request_id AND owner_kind='ai_attempt' AND source_job_key=p_job_key
        AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt FOR UPDATE;
    IF v_child.id IS NOT NULL THEN
        IF v_child.owner_key_hash IS DISTINCT FROM v_owner_hash OR v_child.attempt IS DISTINCT FROM p_source_attempt
           OR v_child.operation_kind IS DISTINCT FROM v_operation_kind OR v_child.units IS DISTINCT FROM 1
           OR v_child.selected_manifest_scope_hash IS DISTINCT FROM v_scope_hash
           OR v_child.estimated_economic_usd IS DISTINCT FROM v_expected_usd
           OR v_child.reserved_krw IS DISTINCT FROM (CASE WHEN v_child.status='denied' THEN 0 ELSE v_expected_krw END) THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        IF v_child.status='denied' AND v_child.denial_reason='hard_cap'
           AND v_parent.status='manual_review' AND v_parent.manual_review_reason IN ('cost_denied','cost_overrun') THEN
            RETURN pg_catalog.jsonb_build_object('disposition','denied','created',FALSE,'replayed',TRUE,'operationId',v_child.id,'reason','hard_cap');
        END IF;
        IF v_child.status='reserved' AND v_child.denial_reason IS NULL
           AND v_child.started_at IS NULL AND v_child.terminal_at IS NULL
           AND v_parent.status='running' AND v_parent.manual_review_reason IS NULL THEN
            RETURN pg_catalog.jsonb_build_object('disposition','accepted','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
    END IF;
    IF v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_parent.economic_actual_krw + v_parent.reserved_cost_krw + v_expected_krw > v_parent.cost_cap_krw THEN
        INSERT INTO public.analysis_revenue_cost_operations(
            request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,
            source_job_key,source_operation_key_hash,source_attempt,estimated_economic_usd,reserved_krw,
            status,denial_reason,terminal_at
        ) VALUES (
            p_request_id,'ai_attempt',v_owner_hash,p_source_attempt,v_operation_kind,1,v_scope_hash,
            p_job_key,v_source_hash,p_source_attempt,v_expected_usd,0,'denied','hard_cap',v_now
        ) RETURNING * INTO v_child;
        UPDATE public.analysis_revenue_run_ledgers
           SET status='manual_review',manual_review_reason=CASE WHEN manual_review_reason='cost_overrun'
               THEN 'cost_overrun' ELSE 'cost_denied' END
         WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','denied','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','hard_cap');
    END IF;
    INSERT INTO public.analysis_revenue_cost_operations(
        request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,
        source_job_key,source_operation_key_hash,source_attempt,estimated_economic_usd,reserved_krw
    ) VALUES (
        p_request_id,'ai_attempt',v_owner_hash,p_source_attempt,v_operation_kind,1,v_scope_hash,
        p_job_key,v_source_hash,p_source_attempt,v_expected_usd,v_expected_krw
    ) RETURNING * INTO v_child;
    UPDATE public.analysis_revenue_run_ledgers
       SET reserved_cost_krw=reserved_cost_krw+v_expected_krw WHERE request_id=p_request_id;
    RETURN pg_catalog.jsonb_build_object('disposition','accepted','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_cost_operation_started_v2(
    p_request_id UUID, p_job_key TEXT, p_job_claim_token UUID, p_job_input_hash TEXT,
    p_source_kind TEXT, p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_ai public.analysis_v2_ai_attempts%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_mapping JSONB;
    v_source_hash TEXT;
    v_owner_hash TEXT;
    v_expected_usd NUMERIC;
    v_expected_krw INTEGER;
    v_now TIMESTAMPTZ;
BEGIN
    IF p_source_kind='provider_run' THEN
        RETURN public.mark_analysis_revenue_cost_operation_started_provider_v2(
            p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,
            p_source_kind,p_source_operation_key,p_source_attempt
        );
    END IF;
    IF p_source_kind IS DISTINCT FROM 'ai_attempt' OR p_source_attempt NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,TRUE
    );
    SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts
      WHERE request_id=p_request_id AND job_key=p_job_key
        AND operation_key=p_source_operation_key AND attempt=p_source_attempt FOR UPDATE;
    IF v_ai.request_id IS NULL OR v_ai.status IS DISTINCT FROM 'reserved'
       OR v_ai.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_ai.retry_count IS DISTINCT FROM p_source_attempt-1 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_expected_usd:=public.analysis_revenue_ai_cost_max_usd_v1(v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens);
    v_mapping:=public.analysis_revenue_ai_cost_operation_mapping_v1(
        p_request_id,p_job_key,p_job_input_hash,(SELECT selected_plan_id_snapshot FROM public.analysis_requests WHERE id=p_request_id),p_source_operation_key,p_source_attempt,v_ai.stage
    );
    v_source_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash:=public.analysis_revenue_ai_cost_owner_hash_v1(p_request_id,p_job_key,p_source_operation_key,p_source_attempt,v_ai.reservation_token,v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens,v_ai.retry_count);
    v_expected_krw:=public.analysis_revenue_cost_ceil_krw(v_expected_usd);
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    PERFORM public.analysis_revenue_ai_cost_assert_aggregates_v1(p_request_id);
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations
      WHERE request_id=p_request_id AND owner_kind='ai_attempt' AND source_job_key=p_job_key
        AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt FOR UPDATE;
    IF v_child.id IS NULL OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash
       OR v_child.attempt IS DISTINCT FROM p_source_attempt OR v_child.operation_kind IS DISTINCT FROM (v_mapping->>'operation_kind')
       OR v_child.selected_manifest_scope_hash IS DISTINCT FROM (v_mapping->>'selected_manifest_scope_hash')
       OR v_child.units IS DISTINCT FROM 1 OR v_child.estimated_economic_usd IS DISTINCT FROM v_expected_usd
       OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw OR v_child.denial_reason IS NOT NULL
       OR v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF v_child.status='started' AND v_child.started_at IS NOT NULL AND v_child.terminal_at IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition','started','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
    END IF;
    IF v_child.status IS DISTINCT FROM 'reserved' OR v_child.started_at IS NOT NULL OR v_child.terminal_at IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_now:=pg_catalog.clock_timestamp();
    UPDATE public.analysis_revenue_cost_operations SET status='started',started_at=v_now WHERE id=v_child.id;
    RETURN pg_catalog.jsonb_build_object('disposition','started','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v2(
    p_request_id UUID, p_job_key TEXT, p_source_kind TEXT,
    p_source_operation_key TEXT, p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_ai public.analysis_v2_ai_attempts%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_mapping JSONB;
    v_source_hash TEXT;
    v_owner_hash TEXT;
    v_expected_usd NUMERIC;
    v_expected_krw INTEGER;
    v_actual_usd NUMERIC;
    v_actual_krw INTEGER;
    v_was_active BOOLEAN;
    v_start_at TIMESTAMPTZ;
    v_no_bill BOOLEAN;
BEGIN
    IF p_source_kind='provider_run' THEN
        RETURN public.settle_analysis_revenue_cost_operation_provider_v2(
            p_request_id,p_job_key,p_source_kind,p_source_operation_key,p_source_attempt
        );
    END IF;
    IF p_source_kind IS DISTINCT FROM 'ai_attempt' OR p_source_attempt NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    -- Delayed settlement deliberately has no current lease requirement: the
    -- exact terminal attempt is authoritative after the worker has exited.
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(p_request_id,p_job_key,NULL,NULL,FALSE);
    SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts
      WHERE request_id=p_request_id AND job_key=p_job_key
        AND operation_key=p_source_operation_key AND attempt=p_source_attempt FOR UPDATE;
    IF v_ai.request_id IS NULL OR v_ai.retry_count IS DISTINCT FROM p_source_attempt-1 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_expected_usd:=public.analysis_revenue_ai_cost_max_usd_v1(v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens);
    v_mapping:=public.analysis_revenue_ai_cost_operation_mapping_v1(
        p_request_id,p_job_key,(SELECT input_hash FROM public.analysis_pipeline_jobs WHERE request_id=p_request_id AND job_key=p_job_key),
        (SELECT selected_plan_id_snapshot FROM public.analysis_requests WHERE id=p_request_id),p_source_operation_key,p_source_attempt,v_ai.stage
    );
    v_source_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash:=public.analysis_revenue_ai_cost_owner_hash_v1(p_request_id,p_job_key,p_source_operation_key,p_source_attempt,v_ai.reservation_token,v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens,v_ai.retry_count);
    v_expected_krw:=public.analysis_revenue_cost_ceil_krw(v_expected_usd);
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    PERFORM public.analysis_revenue_ai_cost_assert_aggregates_v1(p_request_id);
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations
      WHERE request_id=p_request_id AND owner_kind='ai_attempt' AND source_job_key=p_job_key
        AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt FOR UPDATE;
    IF v_child.id IS NULL OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash
       OR v_child.attempt IS DISTINCT FROM p_source_attempt OR v_child.operation_kind IS DISTINCT FROM (v_mapping->>'operation_kind')
       OR v_child.selected_manifest_scope_hash IS DISTINCT FROM (v_mapping->>'selected_manifest_scope_hash')
       OR v_child.units IS DISTINCT FROM 1 OR v_child.estimated_economic_usd IS DISTINCT FROM v_expected_usd
       OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw OR v_child.denial_reason IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF v_ai.status='reserved' THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_NOT_READY';
    END IF;
    v_no_bill := v_ai.status IN ('rate_limited','rejected')
        AND v_ai.usage_metadata_status='missing' AND v_ai.usage_complete=FALSE
        AND v_ai.prompt_tokens IS NULL AND v_ai.completion_tokens IS NULL
        AND v_ai.total_tokens IS NULL AND v_ai.thinking_tokens IS NULL
        AND v_ai.estimated_cost_usd IS NULL AND v_ai.finish_reason IS NULL
        AND v_ai.terminalized_at IS NOT NULL;
    IF v_no_bill THEN
        IF v_child.status='released' AND v_child.started_at IS NULL THEN
            IF v_child.terminal_at IS DISTINCT FROM v_ai.terminalized_at
               OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL
               OR v_child.economic_actual_krw IS NOT NULL OR v_child.billed_actual_krw IS NOT NULL THEN
                RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
            END IF;
            RETURN pg_catalog.jsonb_build_object('disposition','released','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
        END IF;
        IF v_child.status NOT IN ('reserved','started','ambiguous')
           OR v_child.economic_actual_usd IS NOT NULL OR v_child.billed_actual_usd IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
        END IF;
        v_was_active:=v_child.status IN ('reserved','started');
        UPDATE public.analysis_revenue_cost_operations
           SET status='released',started_at=NULL,terminal_at=v_ai.terminalized_at
         WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers
           SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_was_active THEN v_child.reserved_krw ELSE 0 END
         WHERE request_id=p_request_id;
        PERFORM public.analysis_revenue_ai_cost_refresh_review_v1(p_request_id);
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
    END IF;

    IF v_ai.usage_metadata_status='complete' AND v_ai.usage_complete=TRUE
       AND v_ai.prompt_tokens IS NOT NULL AND v_ai.completion_tokens IS NOT NULL
       AND v_ai.total_tokens IS NOT NULL AND v_ai.thinking_tokens IS NOT NULL
       AND v_ai.total_tokens=v_ai.prompt_tokens+v_ai.completion_tokens+v_ai.thinking_tokens
       AND v_ai.estimated_cost_usd IS NOT NULL AND v_ai.terminalized_at IS NOT NULL THEN
        v_actual_usd:=public.analysis_revenue_ai_cost_usd_v1(v_ai.model_name,v_ai.location,v_ai.prompt_tokens,v_ai.completion_tokens,v_ai.thinking_tokens);
        IF v_ai.estimated_cost_usd IS DISTINCT FROM v_actual_usd THEN
            v_actual_usd:=NULL;
        END IF;
    ELSE
        v_actual_usd:=NULL;
    END IF;

    -- Missing, malformed, or price-drifted terminal usage is never converted
    -- to zero.  It consumes no further automatic budget and becomes durable
    -- manual-review evidence with the source terminal timestamp.
    IF v_actual_usd IS NULL THEN
        IF v_child.status='ambiguous' AND v_child.started_at IS NOT NULL
           AND v_child.terminal_at IS NOT DISTINCT FROM v_ai.terminalized_at
           AND v_child.economic_actual_usd IS NULL AND v_child.billed_actual_usd IS NULL THEN
            RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',TRUE,'operationId',v_child.id,'reason','ambiguous_external_call');
        END IF;
        IF v_child.status NOT IN ('reserved','started','ambiguous') THEN
            UPDATE public.analysis_revenue_run_ledgers
               SET status='manual_review',manual_review_reason=CASE
                   WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
                   ELSE 'ambiguous_external_call' END
             WHERE request_id=p_request_id;
            RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
        END IF;
        v_was_active:=v_child.status IN ('reserved','started');
        v_start_at:=COALESCE(v_child.started_at,v_ai.created_at);
        IF v_ai.terminalized_at IS NULL OR v_ai.terminalized_at < v_start_at THEN
            RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
        END IF;
        UPDATE public.analysis_revenue_cost_operations
           SET status='ambiguous',started_at=v_start_at,terminal_at=v_ai.terminalized_at
         WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers
           SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_was_active THEN v_child.reserved_krw ELSE 0 END,
               status='manual_review',manual_review_reason=CASE
                   WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
                   ELSE 'ambiguous_external_call' END
         WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
    END IF;

    v_actual_krw:=public.analysis_revenue_cost_ceil_krw(v_actual_usd);
    IF v_child.status='settled' THEN
        IF v_child.started_at IS NULL OR v_child.terminal_at IS DISTINCT FROM v_ai.terminalized_at
           OR v_child.economic_actual_usd IS DISTINCT FROM v_actual_usd OR v_child.billed_actual_usd IS DISTINCT FROM 0
           OR v_child.economic_actual_krw IS DISTINCT FROM v_actual_krw OR v_child.billed_actual_krw IS DISTINCT FROM 0 THEN
            UPDATE public.analysis_revenue_run_ledgers
               SET status='manual_review',manual_review_reason=CASE
                   WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
                   ELSE 'ambiguous_external_call' END
             WHERE request_id=p_request_id;
            RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
        END IF;
        RETURN pg_catalog.jsonb_build_object('disposition','settled','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
    END IF;
    IF v_child.status NOT IN ('reserved','started','ambiguous') THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status='manual_review',manual_review_reason=CASE
               WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
               ELSE 'ambiguous_external_call' END
         WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
    END IF;
    v_was_active:=v_child.status IN ('reserved','started');
    v_start_at:=COALESCE(v_child.started_at,v_ai.created_at);
    IF v_ai.terminalized_at < v_start_at THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    UPDATE public.analysis_revenue_cost_operations
       SET status='settled',started_at=v_start_at,terminal_at=v_ai.terminalized_at,
           economic_actual_usd=v_actual_usd,billed_actual_usd=0,
           economic_actual_krw=v_actual_krw,billed_actual_krw=0,
           lifecycle_anomaly=CASE WHEN v_child.status='reserved' THEN 'skipped_start' ELSE lifecycle_anomaly END
     WHERE id=v_child.id;
    UPDATE public.analysis_revenue_run_ledgers
       SET reserved_cost_krw=reserved_cost_krw-CASE WHEN v_was_active THEN v_child.reserved_krw ELSE 0 END,
           economic_actual_krw=economic_actual_krw+v_actual_krw,
           actual_cost_krw=actual_cost_krw+v_actual_krw
     WHERE request_id=p_request_id;
    IF v_actual_usd > v_expected_usd OR v_parent.economic_actual_krw+v_actual_krw > v_parent.cost_cap_krw THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status='manual_review',manual_review_reason='cost_overrun'
         WHERE request_id=p_request_id;
    ELSE
        PERFORM public.analysis_revenue_ai_cost_refresh_review_v1(p_request_id);
    END IF;
    RETURN pg_catalog.jsonb_build_object('disposition','settled','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2(
    p_request_id UUID,p_job_key TEXT,p_job_claim_token UUID,p_job_input_hash TEXT,
    p_source_kind TEXT,p_source_operation_key TEXT,p_source_attempt SMALLINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_ai public.analysis_v2_ai_attempts%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_mapping JSONB;
    v_source_hash TEXT;
    v_owner_hash TEXT;
    v_expected_usd NUMERIC;
    v_expected_krw INTEGER;
    v_now TIMESTAMPTZ;
    v_terminal_at TIMESTAMPTZ;
BEGIN
    IF p_source_kind='provider_run' THEN
        RETURN public.release_analysis_revenue_cost_operation_provider_v2(
            p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,
            p_source_kind,p_source_operation_key,p_source_attempt
        );
    END IF;
    IF p_source_kind IS DISTINCT FROM 'ai_attempt' OR p_source_attempt NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,TRUE);
    SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts
      WHERE request_id=p_request_id AND job_key=p_job_key AND operation_key=p_source_operation_key
        AND attempt=p_source_attempt FOR UPDATE;
    IF v_ai.request_id IS NULL OR v_ai.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_ai.retry_count IS DISTINCT FROM p_source_attempt-1 THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF v_ai.status <> 'reserved' THEN
        -- A terminal source has more authority than a local pre-dispatch
        -- cleanup.  Delegate to terminal settlement; it can release only a
        -- proven no-bill outcome or record manual-review ambiguity.
        RETURN public.settle_analysis_revenue_cost_operation_v2(
            p_request_id,p_job_key,'ai_attempt',p_source_operation_key,p_source_attempt
        );
    END IF;
    v_expected_usd:=public.analysis_revenue_ai_cost_max_usd_v1(v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens);
    v_mapping:=public.analysis_revenue_ai_cost_operation_mapping_v1(p_request_id,p_job_key,p_job_input_hash,(SELECT selected_plan_id_snapshot FROM public.analysis_requests WHERE id=p_request_id),p_source_operation_key,p_source_attempt,v_ai.stage);
    v_source_hash:=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_source_operation_key,'UTF8'),'sha256'),'hex');
    v_owner_hash:=public.analysis_revenue_ai_cost_owner_hash_v1(p_request_id,p_job_key,p_source_operation_key,p_source_attempt,v_ai.reservation_token,v_ai.model_name,v_ai.location,v_ai.stage,v_ai.thinking_level,v_ai.media_count,v_ai.media_resolution,v_ai.prompt_version,v_ai.schema_version,v_ai.max_output_tokens,v_ai.retry_count);
    v_expected_krw:=public.analysis_revenue_cost_ceil_krw(v_expected_usd);
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
    PERFORM public.analysis_revenue_ai_cost_assert_aggregates_v1(p_request_id);
    SELECT * INTO v_child FROM public.analysis_revenue_cost_operations
      WHERE request_id=p_request_id AND owner_kind='ai_attempt' AND source_job_key=p_job_key
        AND source_operation_key_hash=v_source_hash AND source_attempt=p_source_attempt FOR UPDATE;
    IF v_child.id IS NULL OR v_child.owner_key_hash IS DISTINCT FROM v_owner_hash
       OR v_child.attempt IS DISTINCT FROM p_source_attempt OR v_child.operation_kind IS DISTINCT FROM (v_mapping->>'operation_kind')
       OR v_child.selected_manifest_scope_hash IS DISTINCT FROM (v_mapping->>'selected_manifest_scope_hash')
       OR v_child.units IS DISTINCT FROM 1 OR v_child.estimated_economic_usd IS DISTINCT FROM v_expected_usd
       OR v_child.reserved_krw IS DISTINCT FROM v_expected_krw OR v_child.denial_reason IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_terminal_at:=GREATEST(v_ai.created_at,v_child.created_at);
    IF v_child.status='released' AND v_child.started_at IS NULL
       AND v_child.terminal_at IS NOT DISTINCT FROM v_terminal_at
       AND v_child.economic_actual_usd IS NULL AND v_child.billed_actual_usd IS NULL
       AND v_child.economic_actual_krw IS NULL AND v_child.billed_actual_krw IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',FALSE,'replayed',TRUE,'operationId',v_child.id);
    END IF;
    IF v_child.status='ambiguous' AND v_child.started_at IS NOT NULL AND v_child.terminal_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',FALSE,'replayed',TRUE,'operationId',v_child.id,'reason','ambiguous_external_call');
    END IF;
    IF v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL
       OR v_child.status NOT IN ('reserved','started') THEN
        RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF v_child.status='reserved' THEN
        UPDATE public.analysis_revenue_cost_operations
           SET status='released',terminal_at=v_terminal_at WHERE id=v_child.id;
        UPDATE public.analysis_revenue_run_ledgers
           SET reserved_cost_krw=reserved_cost_krw-v_child.reserved_krw WHERE request_id=p_request_id;
        RETURN pg_catalog.jsonb_build_object('disposition','released','created',TRUE,'replayed',FALSE,'operationId',v_child.id);
    END IF;
    -- A started child is the durable mark immediately before Gemini.  A still
    -- reserved source cannot prove the call was never sent, so it is ambiguity,
    -- not an invented zero-cost release.
    v_now:=pg_catalog.clock_timestamp();
    UPDATE public.analysis_revenue_cost_operations
       SET status='ambiguous',terminal_at=v_now WHERE id=v_child.id;
    UPDATE public.analysis_revenue_run_ledgers
       SET reserved_cost_krw=reserved_cost_krw-v_child.reserved_krw,
           status='manual_review',manual_review_reason=CASE
               WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason
               ELSE 'ambiguous_external_call' END
     WHERE request_id=p_request_id;
    RETURN pg_catalog.jsonb_build_object('disposition','ambiguous','created',TRUE,'replayed',FALSE,'operationId',v_child.id,'reason','ambiguous_external_call');
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_revenue_cost_operation_provider_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.mark_analysis_revenue_cost_operation_started_provider_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.settle_analysis_revenue_cost_operation_provider_v2(UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.release_analysis_revenue_cost_operation_provider_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.mark_analysis_revenue_cost_operation_started_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.mark_analysis_revenue_cost_operation_started_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT),
    public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT)
    TO service_role;
