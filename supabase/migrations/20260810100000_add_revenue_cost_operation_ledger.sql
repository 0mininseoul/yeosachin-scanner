-- Durable revenue-cost authority. This is additive and intentionally does not
-- start providers, alter request completion, or modify payment_pending.

ALTER TABLE public.analysis_revenue_run_ledgers
    ADD COLUMN pricing_snapshot_version TEXT NOT NULL DEFAULT 'revenue-e2e-cost-2026-08-10-v1'
        CHECK (pricing_snapshot_version = 'revenue-e2e-cost-2026-08-10-v1'),
    ADD COLUMN buffered_fx_krw_per_usd INTEGER NOT NULL DEFAULT 1450
        CHECK (buffered_fx_krw_per_usd = 1450),
    ADD COLUMN economic_actual_krw INTEGER NOT NULL DEFAULT 0 CHECK (economic_actual_krw >= 0),
    ADD COLUMN billed_actual_krw INTEGER NOT NULL DEFAULT 0 CHECK (billed_actual_krw >= 0),
    ADD COLUMN selected_manifest_scope_hash TEXT CHECK (selected_manifest_scope_hash ~ '^[a-f0-9]{64}$'),
    ADD COLUMN manual_review_reason TEXT CHECK (manual_review_reason IN (
        'cost_denied', 'cost_overrun', 'ambiguous_external_call', 'routing_failure'
    ));

-- This table already has rows from the observability migration.  A Basic
-- default would violate Standard rows while the column is added, so backfill
-- by immutable plan before making the additive field required.
ALTER TABLE public.analysis_revenue_run_ledgers
    ADD COLUMN margin_target_krw INTEGER;
UPDATE public.analysis_revenue_run_ledgers
SET margin_target_krw = CASE plan_id WHEN 'basic' THEN 904 WHEN 'standard' THEN 1817 END
WHERE margin_target_krw IS NULL;
ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_margin_target_check CHECK (margin_target_krw IN (904, 1817)) NOT VALID;
ALTER TABLE public.analysis_revenue_run_ledgers
    VALIDATE CONSTRAINT analysis_revenue_run_ledgers_margin_target_check;
ALTER TABLE public.analysis_revenue_run_ledgers
    ALTER COLUMN margin_target_krw SET NOT NULL;
ALTER TABLE public.analysis_revenue_run_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_run_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_run_ledgers TO service_role;

ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_plan_pricing_check CHECK (
        (plan_id = 'basic' AND cost_cap_krw = 1808 AND margin_target_krw = 904)
        OR (plan_id = 'standard' AND cost_cap_krw = 3634 AND margin_target_krw = 1817)
    );

CREATE TABLE public.analysis_revenue_cost_operations (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN (
        'preflight_provider_run', 'provider_run', 'ai_attempt'
    )),
    owner_key_hash TEXT NOT NULL CHECK (owner_key_hash ~ '^[a-f0-9]{64}$'),
    attempt SMALLINT NOT NULL CHECK (attempt BETWEEN 1 AND 4),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
        'target_profile', 'relationship_followers', 'relationship_following',
        'stage_one_routing', 'stage_one_routing_retry', 'detail_profile',
        'detail_media', 'detail_interaction', 'resolver'
    )),
    units INTEGER NOT NULL CHECK (units > 0),
    selected_manifest_scope_hash TEXT CHECK (selected_manifest_scope_hash ~ '^[a-f0-9]{64}$'),
    source_job_key TEXT,
    source_operation_key_hash TEXT NOT NULL CHECK (source_operation_key_hash ~ '^[a-f0-9]{64}$'),
    source_attempt SMALLINT NOT NULL CHECK (source_attempt BETWEEN 0 AND 4),
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
    UNIQUE (request_id, owner_kind, source_job_key, source_operation_key_hash, source_attempt),
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
    v_runner_plan TEXT;
    v_existing public.analysis_revenue_run_ledgers%ROWTYPE;
    v_target_hash TEXT;
    v_exposure_count INTEGER;
    v_imported_economic INTEGER;
BEGIN
    IF p_request_id IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_INVALID'; END IF;
    -- Global lock order: preflight -> request -> exact job -> authority/source -> parent -> child.
    -- The consumed-request index makes this initial preflight fence possible without
    -- reading target material or taking a child lock first.
    SELECT * INTO v_preflight FROM public.analysis_preflights
      WHERE consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id = p_request_id FOR UPDATE;
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE';
    END IF;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies
      WHERE request_id = p_request_id FOR UPDATE;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_preflight.id IS NULL OR v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
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
       OR v_preflight.admission_target_followers_count IS NULL
       OR v_preflight.admission_target_following_count IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id
       OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE';
    END IF;
    -- This E2E accepts only the original fallback and fresh admission generation one.
    SELECT pg_catalog.count(*)::INTEGER INTO v_exposure_count
      FROM public.analysis_preflight_provider_runs
      WHERE preflight_id = v_preflight.id
        AND operation_key IN ('target-profile-fallback', 'target-profile-fresh-admission:g1');
    IF v_exposure_count <> 2
       OR EXISTS (SELECT 1 FROM public.analysis_preflight_provider_runs
                  WHERE preflight_id = v_preflight.id
                    AND (operation_key NOT IN ('target-profile-fallback', 'target-profile-fresh-admission:g1')
                         OR status IS DISTINCT FROM 'succeeded'
                         OR actual_usage_usd IS NULL OR usage_reconciled_at IS NULL)) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_TARGET_LINEAGE';
    END IF;
    v_target_hash := v_preflight.target_input_hash;
    IF v_target_hash IS NULL OR v_target_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_TARGET_LINEAGE';
    END IF;
    SELECT * INTO v_existing FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.preflight_id IS DISTINCT FROM v_preflight.id OR v_existing.user_id IS DISTINCT FROM v_request.user_id
           OR v_existing.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_existing.target_username_hmac IS DISTINCT FROM v_target_hash
           OR v_existing.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1' THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_DRIFT';
        END IF;
        RETURN jsonb_build_object('disposition', 'begun', 'requestId', p_request_id);
    END IF;
    INSERT INTO public.analysis_revenue_run_ledgers (
        request_id, preflight_id, user_id, plan_id, access_mode, target_username_hmac,
        preflight_refreshed_at, request_started_at, cost_cap_krw, margin_target_krw
    ) VALUES (
        p_request_id, v_preflight.id, v_request.user_id, v_request.selected_plan_id_snapshot,
        'test_entitlement', v_target_hash, v_preflight.admission_refreshed_at, v_request.created_at,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 1808 ELSE 3634 END,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 904 ELSE 1817 END
    );
    -- The only preflight costs admitted by this ledger are already terminal
    -- provider truth.  Source identities are domain-separated digests, never
    -- provider run ids, datasets, URLs, credentials, or target text.
    INSERT INTO public.analysis_revenue_cost_operations (
        request_id, owner_kind, owner_key_hash, attempt, operation_kind, units,
        source_job_key, source_operation_key_hash, source_attempt,
        estimated_economic_usd, reserved_krw, economic_actual_usd, billed_actual_usd,
        economic_actual_krw, billed_actual_krw, status, started_at, terminal_at
    )
    SELECT p_request_id, 'preflight_provider_run',
           pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/preflight/v1:' || run.operation_key, 'UTF8'), 'sha256'), 'hex'),
           CASE run.operation_key WHEN 'target-profile-fallback' THEN 1 ELSE 2 END, 'target_profile', 1, NULL,
           pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/preflight/v1:' || run.operation_key, 'UTF8'), 'sha256'), 'hex'),
           0, run.actual_usage_usd, public.analysis_revenue_cost_ceil_krw(run.actual_usage_usd),
           run.actual_usage_usd, 0, public.analysis_revenue_cost_ceil_krw(run.actual_usage_usd), 0,
           'settled', run.terminalized_at, run.terminalized_at
    FROM public.analysis_preflight_provider_runs AS run
    WHERE run.preflight_id = v_preflight.id
      AND run.operation_key IN ('target-profile-fallback', 'target-profile-fresh-admission:g1')
    ON CONFLICT (request_id, owner_kind, owner_key_hash, attempt) DO NOTHING;
    SELECT COALESCE(pg_catalog.sum(economic_actual_krw), 0)::INTEGER INTO v_imported_economic
    FROM public.analysis_revenue_cost_operations
    WHERE request_id = p_request_id AND owner_kind = 'preflight_provider_run';
    UPDATE public.analysis_revenue_run_ledgers
    SET economic_actual_krw = v_imported_economic,
        actual_cost_krw = v_imported_economic,
        billed_actual_krw = 0
    WHERE request_id = p_request_id;
    RETURN jsonb_build_object('disposition', 'begun', 'requestId', p_request_id);
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
    IF p_request_id IS NULL OR p_owner_kind NOT IN ('preflight_provider_run','provider_run','ai_attempt')
       OR p_owner_key_hash !~ '^[a-f0-9]{64}$' OR p_attempt NOT BETWEEN 1 AND 4
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
    IF (p_operation_kind = 'stage_one_routing' AND p_attempt <> 1)
       OR (p_operation_kind = 'stage_one_routing_retry' AND p_attempt <> 2)
       OR (p_operation_kind NOT IN ('stage_one_routing','stage_one_routing_retry') AND p_attempt NOT BETWEEN 1 AND 4)
       OR (p_owner_kind = 'preflight_provider_run' AND p_operation_kind <> 'target_profile') THEN
       RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_limit := CASE p_operation_kind WHEN 'target_profile' THEN 2 WHEN 'relationship_followers' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'relationship_following' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'stage_one_routing' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'stage_one_routing_retry' THEN CASE WHEN v_ledger.plan_id='basic' THEN 400 ELSE 800 END WHEN 'detail_profile' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END WHEN 'detail_media' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END WHEN 'detail_interaction' THEN CASE WHEN v_ledger.plan_id='basic' THEN 100 ELSE 200 END ELSE CASE WHEN v_ledger.plan_id='basic' THEN 20 ELSE 40 END END;
    IF p_operation_kind IN ('detail_profile','detail_media','detail_interaction','resolver') THEN
      IF p_selected_manifest_scope_hash IS NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE'; END IF;
      SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
          'revenue-cost/selected-scope/v1:' || manifest.request_id::TEXT || ':' || manifest.relationship_checkpoint_id || ':' || manifest.policy_version || ':' || manifest.canonical_input_hmac || ':' ||
          COALESCE((SELECT pg_catalog.string_agg(candidate.candidate_key || ':' || candidate.ordinal::TEXT, ',' ORDER BY candidate.ordinal)
                    FROM public.analysis_v2_gender_routing_candidates AS candidate
                    WHERE candidate.request_id = manifest.request_id
                      AND candidate.relationship_checkpoint_id = manifest.relationship_checkpoint_id
                      AND candidate.policy_version = manifest.policy_version
                      AND candidate.selected), ''), 'UTF8'), 'sha256'), 'hex')
      INTO v_scope
      FROM public.analysis_v2_gender_routing_manifests AS manifest
      WHERE manifest.request_id = p_request_id
        AND manifest.status = 'complete'
        AND manifest.plan_id = v_ledger.plan_id
        AND manifest.selected_count = (SELECT pg_catalog.count(*) FROM public.analysis_v2_gender_routing_candidates AS candidate
                                       WHERE candidate.request_id = manifest.request_id
                                         AND candidate.relationship_checkpoint_id = manifest.relationship_checkpoint_id
                                         AND candidate.policy_version = manifest.policy_version
                                         AND candidate.selected);
      IF v_scope IS NULL OR v_scope IS DISTINCT FROM p_selected_manifest_scope_hash
         OR (v_ledger.selected_manifest_scope_hash IS NOT NULL AND v_ledger.selected_manifest_scope_hash IS DISTINCT FROM v_scope) THEN
         RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE';
      END IF;
      UPDATE public.analysis_revenue_run_ledgers SET selected_manifest_scope_hash=v_scope WHERE request_id=p_request_id;
    ELSIF p_selected_manifest_scope_hash IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_SCOPE'; END IF;
    SELECT COALESCE(sum(units),0)::INTEGER INTO v_used FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND operation_kind=p_operation_kind AND status IN ('reserved','started','settled','ambiguous');
    v_krw := public.analysis_revenue_cost_ceil_krw(p_estimated_economic_usd);
    IF v_used + p_units > v_limit THEN
      INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,source_operation_key_hash,source_attempt,estimated_economic_usd,reserved_krw,status,denial_reason,terminal_at) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_owner_key_hash,p_attempt,p_estimated_economic_usd,v_krw,'denied','unit_cap',clock_timestamp()) RETURNING * INTO v_existing;
      UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_denied' WHERE request_id=p_request_id;
      RETURN jsonb_build_object('disposition','denied','operationId',v_existing.id,'reason','unit_cap');
    END IF;
    v_reserved := v_ledger.economic_actual_krw + v_ledger.reserved_cost_krw;
    IF v_reserved + v_krw > v_ledger.cost_cap_krw THEN
      INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,source_operation_key_hash,source_attempt,estimated_economic_usd,reserved_krw,status,denial_reason,terminal_at) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_owner_key_hash,p_attempt,p_estimated_economic_usd,v_krw,'denied','hard_cap',clock_timestamp()) RETURNING * INTO v_existing;
      UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_denied' WHERE request_id=p_request_id;
      RETURN jsonb_build_object('disposition','denied','operationId',v_existing.id,'reason','hard_cap');
    END IF;
    INSERT INTO public.analysis_revenue_cost_operations(request_id,owner_kind,owner_key_hash,attempt,operation_kind,units,selected_manifest_scope_hash,source_operation_key_hash,source_attempt,estimated_economic_usd,reserved_krw) VALUES(p_request_id,p_owner_kind,p_owner_key_hash,p_attempt,p_operation_kind,p_units,p_selected_manifest_scope_hash,p_owner_key_hash,p_attempt,p_estimated_economic_usd,v_krw) RETURNING * INTO v_existing;
    UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw+v_krw WHERE request_id=p_request_id;
    RETURN jsonb_build_object('disposition','accepted','operationId',v_existing.id);
END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_cost_operation_started_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; v_ledger public.analysis_revenue_run_ledgers%ROWTYPE;
BEGIN
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
 IF NOT FOUND OR v_ledger.status <> 'running' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND OR v_row.status IN ('denied','released','ambiguous') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='settled' THEN RETURN jsonb_build_object('disposition','settled','operationId',v_row.id); END IF;
 IF v_row.status='reserved' THEN UPDATE public.analysis_revenue_cost_operations SET status='started',started_at=pg_catalog.clock_timestamp() WHERE id=v_row.id; END IF;
 RETURN jsonb_build_object('disposition','started','operationId',v_row.id);
END; $$;

CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT,p_economic_actual_usd NUMERIC,p_billed_actual_usd NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_economic INTEGER; v_billed INTEGER; BEGIN
 IF p_economic_actual_usd IS NULL OR p_billed_actual_usd IS NULL OR p_economic_actual_usd NOT BETWEEN 0 AND 100000 OR p_billed_actual_usd NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_INVALID'; END IF;
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE; SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND OR v_row.status NOT IN ('started','settled') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='settled' THEN IF v_row.economic_actual_usd IS DISTINCT FROM p_economic_actual_usd OR v_row.billed_actual_usd IS DISTINCT FROM p_billed_actual_usd THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_DRIFT'; END IF; RETURN jsonb_build_object('disposition','settled','operationId',v_row.id); END IF;
 v_economic:=public.analysis_revenue_cost_ceil_krw(p_economic_actual_usd); v_billed:=public.analysis_revenue_cost_ceil_krw(p_billed_actual_usd);
 UPDATE public.analysis_revenue_cost_operations SET status='settled',economic_actual_usd=p_economic_actual_usd,billed_actual_usd=p_billed_actual_usd,economic_actual_krw=v_economic,billed_actual_krw=v_billed,terminal_at=clock_timestamp() WHERE id=v_row.id;
 UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_row.reserved_krw,economic_actual_krw=economic_actual_krw+v_economic,billed_actual_krw=billed_actual_krw+v_billed,actual_cost_krw=economic_actual_krw+v_economic,status=CASE WHEN v_economic>v_row.reserved_krw OR economic_actual_krw+v_economic>cost_cap_krw THEN 'manual_review' ELSE status END,manual_review_reason=CASE WHEN v_economic>v_row.reserved_krw OR economic_actual_krw+v_economic>cost_cap_krw THEN 'cost_overrun' ELSE manual_review_reason END WHERE request_id=p_request_id;
 RETURN jsonb_build_object('disposition','settled','operationId',v_row.id); END; $$;

CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v1(p_request_id UUID,p_owner_kind TEXT,p_owner_key_hash TEXT,p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ DECLARE v_row public.analysis_revenue_cost_operations%ROWTYPE; v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; BEGIN
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 SELECT * INTO v_row FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind=p_owner_kind AND owner_key_hash=p_owner_key_hash AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 IF v_row.status='reserved' THEN UPDATE public.analysis_revenue_cost_operations SET status='released',terminal_at=clock_timestamp() WHERE id=v_row.id; UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=reserved_cost_krw-v_row.reserved_krw WHERE request_id=p_request_id; RETURN jsonb_build_object('disposition','released','operationId',v_row.id); END IF;
 IF v_row.status='started' THEN UPDATE public.analysis_revenue_cost_operations SET status='ambiguous',terminal_at=clock_timestamp() WHERE id=v_row.id; UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='ambiguous_external_call' WHERE request_id=p_request_id; RETURN jsonb_build_object('disposition','ambiguous','operationId',v_row.id); END IF;
 RETURN jsonb_build_object('disposition',CASE WHEN v_row.status='ambiguous' THEN 'ambiguous' WHEN v_row.status='settled' THEN 'settled' WHEN v_row.status='denied' THEN 'denied' ELSE 'released' END,'operationId',v_row.id); END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_manual_review_v1(p_request_id UUID,p_reason_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN
 IF p_reason_code NOT IN ('routing_failure','ambiguous_external_call','cost_overrun') THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_MANUAL_REVIEW_INVALID'; END IF;
 UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason=p_reason_code WHERE request_id=p_request_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE'; END IF;
 RETURN jsonb_build_object('disposition','manual_review'); END; $$;

CREATE OR REPLACE FUNCTION public.read_analysis_revenue_cost_reconciliation_v1(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
 v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_job public.analysis_pipeline_jobs%ROWTYPE;
 v_coverage BOOLEAN; v_disposition TEXT; v_reason TEXT := 'ready'; v_request_status TEXT;
BEGIN
 IF p_request_id IS NULL OR p_job_key IS DISTINCT FROM 'coordinator:finalize' OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
 END IF;
 -- finalizer job is locked before its parent ledger; children are only read after parent.
 SELECT * INTO v_job FROM public.analysis_pipeline_jobs WHERE request_id=p_request_id AND job_key=p_job_key FOR UPDATE;
 SELECT status INTO v_request_status FROM public.analysis_requests WHERE id=p_request_id FOR UPDATE;
 SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id=p_request_id FOR UPDATE;
 IF v_job.request_id IS NULL OR v_job.status IS DISTINCT FROM 'processing' OR v_job.lease_token IS DISTINCT FROM p_claim_token
    OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.clock_timestamp()
    OR v_job.input_hash IS DISTINCT FROM p_job_input_hash OR v_request_status IS DISTINCT FROM 'processing'
    OR v_ledger.request_id IS NULL OR v_ledger.status IS DISTINCT FROM 'running' THEN
   RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_FENCE';
 END IF;
 v_coverage := v_ledger.public_mutual_count IS NOT NULL AND v_ledger.screened_count IS NOT NULL
   AND v_ledger.not_screened_count IS NOT NULL AND v_ledger.unknown_burden_count IS NOT NULL
   AND v_ledger.screened_count+v_ledger.not_screened_count=v_ledger.public_mutual_count
   AND v_ledger.unknown_burden_count<=v_ledger.screened_count
   AND (v_ledger.public_mutual_count=0 OR v_ledger.screened_count>0)
   AND v_ledger.unknown_burden_count*10<=v_ledger.screened_count*3;
 IF NOT EXISTS (SELECT 1 FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind='preflight_provider_run' AND operation_kind='target_profile' AND status='settled')
    OR (SELECT pg_catalog.count(*) FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND owner_kind='preflight_provider_run') <> 2 THEN v_reason := 'missing_fresh_import';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_revenue_cost_operations WHERE request_id=p_request_id AND status IN ('reserved','started','ambiguous','denied')) THEN v_reason := 'nonterminal_or_ambiguous';
 ELSIF NOT v_coverage THEN v_reason := 'coverage_gate_absent';
 ELSIF v_ledger.reserved_cost_krw <> 0 THEN v_reason := 'costs_incomplete';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_pipeline_jobs AS dep WHERE dep.request_id=p_request_id AND dep.job_key = ANY(v_job.required_job_keys) AND dep.status <> 'completed') THEN v_reason := 'dependencies_incomplete';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_v2_provider_runs AS source WHERE source.request_id=p_request_id AND (source.status NOT IN ('succeeded','failed','aborted','timed_out') OR source.actual_usage_usd IS NULL OR source.usage_reconciled_at IS NULL)) THEN v_reason := 'provider_source_active';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_v2_ai_attempts AS source WHERE source.request_id=p_request_id AND (source.status IN ('reserved','ambiguous') OR source.usage_metadata_status IS DISTINCT FROM 'complete' OR source.usage_complete IS DISTINCT FROM TRUE OR source.estimated_cost_usd IS NULL OR source.terminalized_at IS NULL)) THEN v_reason := 'ai_source_active';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_v2_provider_runs AS source WHERE source.request_id=p_request_id AND source.max_charge_usd > 0 AND 1 <> (SELECT pg_catalog.count(*) FROM public.analysis_revenue_cost_operations AS child WHERE child.request_id=p_request_id AND child.owner_kind='provider_run' AND child.owner_key_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/provider-run/v1:' || source.job_key || ':' || source.operation_key, 'UTF8'), 'sha256'), 'hex'))) THEN v_reason := 'provider_source_unmatched';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_v2_ai_attempts AS source WHERE source.request_id=p_request_id AND source.estimated_cost_usd > 0 AND 1 <> (SELECT pg_catalog.count(*) FROM public.analysis_revenue_cost_operations AS child WHERE child.request_id=p_request_id AND child.owner_kind='ai_attempt' AND child.owner_key_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/ai-attempt/v1:' || source.job_key || ':' || source.operation_key || ':' || source.attempt::TEXT, 'UTF8'), 'sha256'), 'hex') AND child.attempt=source.attempt)) THEN v_reason := 'ai_source_unmatched';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_revenue_cost_operations AS child WHERE child.request_id=p_request_id AND child.owner_kind='provider_run' AND 1 <> (SELECT pg_catalog.count(*) FROM public.analysis_v2_provider_runs AS source WHERE source.request_id=p_request_id AND child.owner_key_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/provider-run/v1:' || source.job_key || ':' || source.operation_key, 'UTF8'), 'sha256'), 'hex'))) THEN v_reason := 'provider_source_unmatched';
 ELSIF EXISTS (SELECT 1 FROM public.analysis_revenue_cost_operations AS child WHERE child.request_id=p_request_id AND child.owner_kind='ai_attempt' AND 1 <> (SELECT pg_catalog.count(*) FROM public.analysis_v2_ai_attempts AS source WHERE source.request_id=p_request_id AND child.owner_key_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/ai-attempt/v1:' || source.job_key || ':' || source.operation_key || ':' || source.attempt::TEXT, 'UTF8'), 'sha256'), 'hex') AND child.attempt=source.attempt)) THEN v_reason := 'ai_source_unmatched';
 END IF;
 v_disposition := CASE WHEN v_ledger.economic_actual_krw>v_ledger.cost_cap_krw THEN 'hard_cap_exceeded' WHEN v_ledger.economic_actual_krw>v_ledger.margin_target_krw THEN 'negative_margin_pilot' ELSE 'within_margin_target' END;
 RETURN pg_catalog.jsonb_build_object('finalizable',v_reason='ready','reason',v_reason,'economicDisposition',v_disposition,'economicActualKrw',v_ledger.economic_actual_krw,'billedActualKrw',v_ledger.billed_actual_krw);
END; $$;

REVOKE ALL ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID,TEXT,UUID,TEXT) TO service_role;
