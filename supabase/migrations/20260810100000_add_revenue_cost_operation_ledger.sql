-- Durable revenue-cost authority. This is additive and intentionally does not
-- start providers, alter request completion, or modify payment_pending.

ALTER TABLE public.analysis_revenue_run_ledgers
    ADD COLUMN pricing_snapshot_version TEXT NOT NULL DEFAULT 'revenue-e2e-cost-2026-08-10-v1'
        CHECK (pricing_snapshot_version = 'revenue-e2e-cost-2026-08-10-v1'),
    ADD COLUMN buffered_fx_krw_per_usd INTEGER NOT NULL DEFAULT 1450
        CHECK (buffered_fx_krw_per_usd = 1450),
    ADD COLUMN margin_target_krw INTEGER NOT NULL DEFAULT 904
        CHECK (margin_target_krw IN (904, 1817)),
    ADD COLUMN economic_actual_krw INTEGER NOT NULL DEFAULT 0 CHECK (economic_actual_krw >= 0),
    ADD COLUMN billed_actual_krw INTEGER NOT NULL DEFAULT 0 CHECK (billed_actual_krw >= 0),
    ADD COLUMN selected_manifest_scope_hash TEXT CHECK (selected_manifest_scope_hash ~ '^[a-f0-9]{64}$'),
    ADD COLUMN manual_review_reason TEXT CHECK (manual_review_reason IN (
        'cost_denied', 'cost_overrun', 'ambiguous_external_call', 'routing_failure'
    ));

ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_plan_pricing_check CHECK (
        (plan_id = 'basic' AND cost_cap_krw = 1808 AND margin_target_krw = 904)
        OR (plan_id = 'standard' AND cost_cap_krw = 3634 AND margin_target_krw = 1817)
    );

CREATE TABLE public.analysis_revenue_cost_operations (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN (
        'target_profile', 'relationship', 'routing', 'profile', 'media', 'interaction', 'resolver'
    )),
    owner_key_hash TEXT NOT NULL CHECK (owner_key_hash ~ '^[a-f0-9]{64}$'),
    attempt SMALLINT NOT NULL CHECK (attempt BETWEEN 1 AND 2),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
        'target_profile', 'relationship_followers', 'relationship_following',
        'stage_one_routing', 'stage_one_routing_retry', 'detail_profile',
        'detail_media', 'detail_interaction', 'resolver'
    )),
    units INTEGER NOT NULL CHECK (units > 0),
    selected_manifest_scope_hash TEXT CHECK (selected_manifest_scope_hash ~ '^[a-f0-9]{64}$'),
    estimated_economic_usd NUMERIC(18, 12) NOT NULL CHECK (estimated_economic_usd BETWEEN 0 AND 100000),
    economic_actual_usd NUMERIC(18, 12) CHECK (economic_actual_usd BETWEEN 0 AND 100000),
    billed_actual_usd NUMERIC(18, 12) CHECK (billed_actual_usd BETWEEN 0 AND 100000),
    reserved_krw INTEGER NOT NULL CHECK (reserved_krw >= 0),
    economic_actual_krw INTEGER CHECK (economic_actual_krw >= 0),
    billed_actual_krw INTEGER CHECK (billed_actual_krw >= 0),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'started', 'settled', 'released', 'ambiguous', 'denied')),
    denial_reason TEXT CHECK (denial_reason IN ('hard_cap', 'unit_cap', 'authority_fence')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    started_at TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ,
    UNIQUE (request_id, owner_kind, owner_key_hash, attempt),
    CONSTRAINT analysis_revenue_cost_operations_lifecycle_check CHECK (
        (status = 'reserved' AND started_at IS NULL AND terminal_at IS NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL)
        OR (status = 'started' AND started_at IS NOT NULL AND terminal_at IS NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL)
        OR (status = 'settled' AND started_at IS NOT NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NOT NULL AND billed_actual_usd IS NOT NULL)
        OR (status = 'released' AND started_at IS NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL)
        OR (status = 'ambiguous' AND started_at IS NOT NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL)
        OR (status = 'denied' AND started_at IS NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL)
    )
);

CREATE INDEX analysis_revenue_cost_operations_request_status_idx
    ON public.analysis_revenue_cost_operations(request_id, status, created_at);

ALTER TABLE public.analysis_revenue_cost_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_cost_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_cost_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_cost_operations TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_cost_ceil_krw(p_usd NUMERIC)
RETURNS INTEGER LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
    SELECT pg_catalog.ceil(p_usd * 1450)::INTEGER
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_cost_ceil_krw(NUMERIC) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_analysis_revenue_cost_ledger_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_entitlement public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_account public.users%ROWTYPE;
    v_runner_plan TEXT;
    v_existing public.analysis_revenue_run_ledgers%ROWTYPE;
    v_target_hash TEXT;
    v_exposure_count INTEGER;
BEGIN
    IF p_request_id IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_INVALID'; END IF;
    -- Global lock order: request -> preflight -> policy -> parent ledger -> child operation.
    SELECT * INTO v_request FROM public.analysis_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE'; END IF;
    SELECT * INTO v_preflight FROM public.analysis_preflights
      WHERE id = v_request.preflight_id AND consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_account FROM public.users WHERE id = v_request.user_id FOR UPDATE;
    SELECT runner_plan INTO v_runner_plan FROM public.account_e2e_test_runners
      WHERE account_id = v_request.user_id FOR SHARE;
    IF v_preflight.id IS NULL OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_account.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR pg_catalog.lower(v_policy.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_account.account_class IS DISTINCT FROM 'e2e_test'
       OR v_account.traffic_class IS DISTINCT FROM 'e2e_test'
       OR v_account.lifecycle IS DISTINCT FROM 'active'
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE';
    END IF;
    -- This E2E accepts only the original fallback and fresh admission generation one.
    SELECT pg_catalog.count(*)::INTEGER INTO v_exposure_count
      FROM public.analysis_preflight_provider_runs
      WHERE preflight_id = v_preflight.id
        AND operation_key IN ('target-profile-fallback', 'target-profile-fresh-admission:g1');
    IF v_exposure_count < 1 OR v_exposure_count > 2
       OR EXISTS (SELECT 1 FROM public.analysis_preflight_provider_runs
                  WHERE preflight_id = v_preflight.id
                    AND operation_key NOT IN ('target-profile-fallback', 'target-profile-fresh-admission:g1')) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_TARGET_LINEAGE';
    END IF;
    SELECT encode(extensions.digest(convert_to(lower(v_request.target_instagram_id), 'UTF8'), 'sha256'), 'hex') INTO v_target_hash;
    SELECT * INTO v_existing FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.preflight_id IS DISTINCT FROM v_preflight.id OR v_existing.user_id IS DISTINCT FROM v_request.user_id
           OR v_existing.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_existing.target_username_hmac IS DISTINCT FROM v_target_hash
           OR v_existing.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1' THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_DRIFT';
        END IF;
        RETURN jsonb_build_object('disposition', 'accepted', 'requestId', p_request_id);
    END IF;
    INSERT INTO public.analysis_revenue_run_ledgers (
        request_id, preflight_id, user_id, plan_id, access_mode, target_username_hmac,
        preflight_refreshed_at, request_started_at, cost_cap_krw, margin_target_krw
    ) VALUES (
        p_request_id, v_preflight.id, v_request.user_id, v_request.selected_plan_id_snapshot,
        'test_entitlement', v_target_hash, v_preflight.updated_at, v_request.created_at,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 1808 ELSE 3634 END,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 904 ELSE 1817 END
    );
    RETURN jsonb_build_object('disposition', 'accepted', 'requestId', p_request_id);
END; $$;

CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_cost_operation_v1(
    p_request_id UUID, p_owner_kind TEXT, p_owner_key_hash TEXT, p_attempt SMALLINT,
    p_operation_kind TEXT, p_units INTEGER, p_estimated_economic_usd NUMERIC,
    p_selected_manifest_scope_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_existing public.analysis_revenue_cost_operations%ROWTYPE;
    v_limit INTEGER; v_used INTEGER; v_reserved INTEGER; v_scope TEXT; v_krw INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_owner_kind NOT IN ('target_profile','relationship','routing','profile','media','interaction','resolver')
       OR p_owner_key_hash !~ '^[a-f0-9]{64}$' OR p_attempt NOT BETWEEN 1 AND 2
       OR p_operation_kind NOT IN ('target_profile','relationship_followers','relationship_following','stage_one_routing','stage_one_routing_retry','detail_profile','detail_media','detail_interaction','resolver')
       OR p_units IS NULL OR p_units < 1 OR p_estimated_economic_usd IS NULL OR p_estimated_economic_usd NOT BETWEEN 0 AND 100000
       OR (p_selected_manifest_scope_hash IS NOT NULL AND p_selected_manifest_scope_hash !~ '^[a-f0-9]{64}$') THEN
       RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_INVALID';
    END IF;
    SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_ledger.status <> 'running' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_existing FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
    IF FOUND THEN
      IF v_existing.operation_kind IS DISTINCT FROM p_operation_kind OR v_existing.units IS DISTINCT FROM p_units OR v_existing.estimated_economic_usd IS DISTINCT FROM p_estimated_economic_usd OR v_existing.selected_manifest_scope_hash IS DISTINCT FROM p_selected_manifest_scope_hash THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_DRIFT'; END IF;
      RETURN jsonb_build_object('disposition', CASE WHEN v_existing.status='denied' THEN 'denied' ELSE 'accepted' END, 'operationId', v_existing.id, 'reason', v_existing.denial_reason);
    END IF;
    IF (p_operation_kind = 'target_profile' AND p_owner_kind <> 'target_profile')
       OR (p_operation_kind IN ('relationship_followers','relationship_following') AND p_owner_kind <> 'relationship')
       OR (p_operation_kind IN ('stage_one_routing','stage_one_routing_retry') AND p_owner_kind <> 'routing')
       OR (p_operation_kind = 'detail_profile' AND p_owner_kind <> 'profile')
       OR (p_operation_kind = 'detail_media' AND p_owner_kind <> 'media')
       OR (p_operation_kind = 'detail_interaction' AND p_owner_kind <> 'interaction')
       OR (p_operation_kind = 'resolver' AND p_owner_kind <> 'resolver')
       OR (p_operation_kind = 'stage_one_routing_retry' AND p_attempt <> 2)
       OR (p_operation_kind <> 'stage_one_routing_retry' AND p_attempt <> 1) THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
    v_limit := CASE p_operation_kind WHEN 'target_profile' THEN 2 WHEN 'relationship_followers' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'relationship_following' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'stage_one_routing' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'stage_one_routing_retry' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'detail_profile' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END WHEN 'detail_media' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END WHEN 'detail_interaction' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END ELSE CASE WHEN v_ledger.plan_id='basic' THEN 20 ELSE 40 END END;
    IF p_operation_kind IN ('detail_profile','detail_media','detail_interaction','resolver') THEN
      IF p_selected_manifest_scope_hash IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE'; END IF;
      v_scope := COALESCE(v_ledger.selected_manifest_scope_hash, p_selected_manifest_scope_hash);
      IF v_scope IS DISTINCT FROM p_selected_manifest_scope_hash THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE'; END IF;
      UPDATE public.analysis_revenue_run_ledgers SET selected_manifest_scope_hash=v_scope WHERE request_id=p_request_id;
    ELSIF p_selected_manifest_scope_hash IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE'; END IF;
    SELECT COALESCE(sum(units),0)::INTEGER INTO v_used FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND operation_kind=p_operation_kind AND status <> 'denied';
    v_krw := public.analysis_revenue_cost_ceil_krw(p_estimated_economic_usd);
    IF v_used + p_units > v_limit THEN
      INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,estimated_economic_usd,reserved_krw,status,denial_reason,terminal_at) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_estimated_economic_usd,v_krw,'denied','unit_cap',clock_timestamp()) RETURNING * INTO v_existing;
      UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_denied' WHERE request_id=p_request_id;
      RETURN jsonb_build_object('disposition','denied','operationId',v_existing.id,'reason','unit_cap');
    END IF;
    v_reserved := v_ledger.economic_actual_krw + v_ledger.reserved_cost_krw;
    IF v_reserved + v_krw > v_ledger.cost_cap_krw THEN
      INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,estimated_economic_usd,reserved_krw,status,denial_reason,terminal_at) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_estimated_economic_usd,v_krw,'denied','hard_cap',clock_timestamp()) RETURNING * INTO v_existing;
      UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_denied' WHERE request_id=p_request_id;
      RETURN jsonb_build_object('disposition','denied','operationId',v_existing.id,'reason','hard_cap');
    END IF;
    INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,estimated_economic_usd,reserved_krw) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_estimated_economic_usd,v_krw) RETURNING * INTO v_existing;
    UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw+v_krw WHERE request_id=p_request_id;
    RETURN jsonb_build_object('disposition','accepted','operationId',v_existing.id);
END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_cost_operation_started_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; BEGIN
 SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND OR v_row.status IN ('denied','released','ambiguous') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='reserved' THEN UPDATE public.analysis_revenue_cost_operations SET status='started',started_at=clock_timestamp() WHERE id=v_row.id; END IF;
 RETURN jsonb_build_object('disposition','started','operationId',v_row.id); END; $$;

CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT,p_economic_actual_usd NUMERIC,p_billed_actual_usd NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_economic INTEGER; v_billed INTEGER; BEGIN
 IF p_economic_actual_usd IS NULL OR p_billed_actual_usd IS NULL OR p_economic_actual_usd NOT BETWEEN 0 AND 100000 OR p_billed_actual_usd NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_INVALID'; END IF;
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE; SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND OR v_row.status NOT IN ('started','settled') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='settled' THEN IF v_row.economic_actual_usd IS DISTINCT FROM p_economic_actual_usd OR v_row.billed_actual_usd IS DISTINCT FROM p_billed_actual_usd THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_DRIFT'; END IF; RETURN jsonb_build_object('disposition','settled','operationId',v_row.id); END IF;
 v_economic:=public.analysis_revenue_cost_ceil_krw(p_economic_actual_usd); v_billed:=public.analysis_revenue_cost_ceil_krw(p_billed_actual_usd);
 UPDATE public.analysis_revenue_cost_operations SET status='settled',economic_actual_usd=p_economic_actual_usd,billed_actual_usd=p_billed_actual_usd,economic_actual_krw=v_economic,billed_actual_krw=v_billed,terminal_at=clock_timestamp() WHERE id=v_row.id;
 UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_row.reserved_krw,economic_actual_krw=economic_actual_krw+v_economic,billed_actual_krw=billed_actual_krw+v_billed,actual_cost_krw=economic_actual_krw+v_economic,status=CASE WHEN economic_actual_krw+v_economic>cost_cap_krw THEN 'manual_review' ELSE status END,manual_review_reason=CASE WHEN economic_actual_krw+v_economic>cost_cap_krw THEN 'cost_overrun' ELSE manual_review_reason END WHERE request_id=p_request_id;
 RETURN jsonb_build_object('disposition','settled','operationId',v_row.id); END; $$;

CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; BEGIN
 SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='reserved' THEN UPDATE public.analysis_revenue_cost_operations SET status='released',terminal_at=clock_timestamp() WHERE id=v_row.id; UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_row.reserved_krw WHERE request_id=p_request_id; RETURN jsonb_build_object('disposition','released','operationId',v_row.id); END IF;
 IF v_row.status='started' THEN UPDATE public.analysis_revenue_cost_operations SET status='ambiguous',terminal_at=clock_timestamp() WHERE id=v_row.id; UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='ambiguous_external_call' WHERE request_id=p_request_id; RETURN jsonb_build_object('disposition','ambiguous','operationId',v_row.id); END IF;
 RETURN jsonb_build_object('disposition',CASE WHEN v_row.status='ambiguous' THEN 'ambiguous' ELSE 'released' END,'operationId',v_row.id); END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_manual_review_v1(p_request_id UUID,p_reason_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN
 IF p_reason_code NOT IN ('routing_failure','ambiguous_external_call','cost_overrun') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_MANUAL_REVIEW_INVALID'; END IF;
 UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason=p_reason_code WHERE request_id=p_request_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 RETURN jsonb_build_object('disposition','manual_review'); END; $$;

CREATE OR REPLACE FUNCTION public.read_analysis_revenue_cost_reconciliation_v1(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_nonterminal BOOLEAN; v_coverage BOOLEAN; v_disposition TEXT; BEGIN
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id; IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND status IN ('reserved','started','ambiguous')) INTO v_nonterminal;
 v_coverage := v_ledger.public_mutual_count IS NOT NULL AND v_ledger.screened_count IS NOT NULL AND v_ledger.not_screened_count IS NOT NULL AND v_ledger.unknown_burden_count IS NOT NULL AND v_ledger.screened_count+v_ledger.not_screened_count=v_ledger.public_mutual_count AND v_ledger.unknown_burden_count<=v_ledger.screened_count AND (v_ledger.public_mutual_count=0 OR v_ledger.screened_count>0) AND v_ledger.unknown_burden_count*10<=v_ledger.screened_count*3;
 v_disposition := CASE WHEN v_ledger.economic_actual_krw>v_ledger.cost_cap_krw THEN 'hard_cap_exceeded' WHEN v_ledger.economic_actual_krw>v_ledger.margin_target_krw THEN 'negative_margin_pilot' ELSE 'within_margin_target' END;
 RETURN jsonb_build_object('finalizable',NOT v_nonterminal AND v_coverage AND v_ledger.reserved_cost_krw=0,'reason',CASE WHEN v_nonterminal THEN 'nonterminal_or_ambiguous' WHEN NOT v_coverage THEN 'coverage_gate_absent' WHEN v_ledger.reserved_cost_krw<>0 THEN 'costs_incomplete' ELSE 'ready' END,'economicDisposition',v_disposition,'economicActualKrw',v_ledger.economic_actual_krw,'billedActualKrw',v_ledger.billed_actual_krw); END; $$;

REVOKE ALL ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID) TO service_role;
