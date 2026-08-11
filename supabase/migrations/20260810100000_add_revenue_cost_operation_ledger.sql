-- Revenue cost-operation foundation.  This migration deliberately imports only
-- the two authoritative preflight provider rows; live source operations arrive
-- in later migrations.

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

-- Existing observability rows predate cost authority.  Keep this sequence
-- plan-aware so the Basic/Standard immutable pricing constraint remains valid.
ALTER TABLE public.analysis_revenue_run_ledgers ADD COLUMN margin_target_krw INTEGER;
UPDATE public.analysis_revenue_run_ledgers
SET margin_target_krw = CASE plan_id WHEN 'basic' THEN 904 WHEN 'standard' THEN 1817 END
WHERE margin_target_krw IS NULL;
ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_margin_target_check CHECK (margin_target_krw IN (904, 1817)) NOT VALID;
ALTER TABLE public.analysis_revenue_run_ledgers VALIDATE CONSTRAINT analysis_revenue_run_ledgers_margin_target_check;
ALTER TABLE public.analysis_revenue_run_ledgers ALTER COLUMN margin_target_krw SET NOT NULL;

UPDATE public.analysis_revenue_run_ledgers SET actual_cost_krw = 0 WHERE actual_cost_krw IS NULL;
ALTER TABLE public.analysis_revenue_run_ledgers ALTER COLUMN actual_cost_krw SET DEFAULT 0;
ALTER TABLE public.analysis_revenue_run_ledgers ALTER COLUMN actual_cost_krw SET NOT NULL;
ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_actual_cost_nonnegative_check CHECK (actual_cost_krw >= 0);
ALTER TABLE public.analysis_revenue_run_ledgers
    ADD CONSTRAINT analysis_revenue_run_ledgers_plan_pricing_check CHECK (
        (plan_id = 'basic' AND cost_cap_krw = 1808 AND margin_target_krw = 904)
        OR (plan_id = 'standard' AND cost_cap_krw = 3634 AND margin_target_krw = 1817)
    );
ALTER TABLE public.analysis_revenue_run_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_run_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_run_ledgers TO service_role;

CREATE TABLE public.analysis_revenue_cost_operations (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('preflight_provider_run', 'provider_run', 'ai_attempt')),
    owner_key_hash TEXT NOT NULL CHECK (owner_key_hash ~ '^[a-f0-9]{64}$'),
    attempt SMALLINT NOT NULL CHECK (attempt BETWEEN 1 AND 4),
    operation_kind TEXT NOT NULL CHECK (operation_kind IN (
        'target_profile', 'relationship_followers', 'relationship_following',
        'stage_one_routing', 'stage_one_routing_retry', 'detail_profile',
        'detail_media', 'detail_interaction', 'resolver'
    )),
    units INTEGER NOT NULL CHECK (units > 0),
    selected_manifest_scope_hash TEXT CHECK (selected_manifest_scope_hash ~ '^[a-f0-9]{64}$'),
    source_job_key TEXT NOT NULL CHECK (
        source_job_key = 'preflight'
        OR source_job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
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
    -- A terminal source can prove that the runtime skipped its mandatory local
    -- start transition.  Keep that fact on the child: the parent has room for
    -- only one review reason and may temporarily need to represent another
    -- child's unresolved ambiguity instead.
    lifecycle_anomaly TEXT CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_value_check CHECK (lifecycle_anomaly IN ('skipped_start')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    started_at TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ,
    CONSTRAINT analysis_revenue_cost_operations_source_mapping_check CHECK (
        (owner_kind = 'preflight_provider_run' AND source_job_key = 'preflight' AND source_attempt = 0 AND operation_kind = 'target_profile')
        OR (owner_kind = 'provider_run' AND source_job_key <> 'preflight' AND source_attempt = 0)
        OR (owner_kind = 'ai_attempt' AND source_job_key <> 'preflight' AND source_attempt = attempt)
    ),
    CONSTRAINT analysis_revenue_cost_operations_lifecycle_check CHECK (
        (status = 'reserved' AND started_at IS NULL AND terminal_at IS NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL AND economic_actual_krw IS NULL AND billed_actual_krw IS NULL)
        OR (status = 'started' AND started_at IS NOT NULL AND terminal_at IS NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL AND economic_actual_krw IS NULL AND billed_actual_krw IS NULL)
        OR (status = 'settled' AND started_at IS NOT NULL AND terminal_at IS NOT NULL AND terminal_at >= started_at AND economic_actual_usd IS NOT NULL AND billed_actual_usd IS NOT NULL AND economic_actual_krw IS NOT NULL AND billed_actual_krw IS NOT NULL)
        OR (status = 'released' AND started_at IS NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL AND economic_actual_krw IS NULL AND billed_actual_krw IS NULL)
        OR (status = 'ambiguous' AND started_at IS NOT NULL AND terminal_at IS NOT NULL AND terminal_at >= started_at AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL AND economic_actual_krw IS NULL AND billed_actual_krw IS NULL)
        OR (status = 'denied' AND started_at IS NULL AND terminal_at IS NOT NULL AND economic_actual_usd IS NULL AND billed_actual_usd IS NULL AND economic_actual_krw IS NULL AND billed_actual_krw IS NULL)
    ),
    CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_check CHECK (
        lifecycle_anomaly IS NULL
        OR (lifecycle_anomaly = 'skipped_start' AND owner_kind = 'provider_run' AND source_job_key <> 'preflight' AND source_attempt = 0 AND attempt = 1
            AND status = 'settled' AND denial_reason IS NULL)
    ),
    UNIQUE (request_id, owner_kind, owner_key_hash, attempt),
    UNIQUE (request_id, owner_kind, source_job_key, source_operation_key_hash, source_attempt)
);
CREATE INDEX analysis_revenue_cost_operations_request_status_idx ON public.analysis_revenue_cost_operations(request_id, status, created_at);
CREATE INDEX analysis_revenue_cost_operations_source_lookup_idx ON public.analysis_revenue_cost_operations(request_id, owner_kind, source_job_key, source_operation_key_hash, source_attempt);
CREATE INDEX analysis_revenue_cost_operations_operation_status_idx ON public.analysis_revenue_cost_operations(request_id, operation_kind, status);
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
    v_fallback public.analysis_preflight_provider_runs%ROWTYPE;
    v_fresh public.analysis_preflight_provider_runs%ROWTYPE;
    v_existing public.analysis_revenue_run_ledgers%ROWTYPE;
    v_child public.analysis_revenue_cost_operations%ROWTYPE;
    v_runner_plan TEXT; v_target_hash TEXT; v_count INTEGER; v_total INTEGER;
    v_fallback_hash TEXT; v_fresh_hash TEXT; v_fallback_owner TEXT; v_fresh_owner TEXT;
BEGIN
    IF p_request_id IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_INVALID'; END IF;
    -- Canonical begin order: consumed preflight -> request -> entitlement ->
    -- policy -> exact preflight source rows -> parent -> child.
    SELECT * INTO v_preflight FROM public.analysis_preflights WHERE consumed_request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_request FROM public.analysis_requests WHERE id = p_request_id FOR UPDATE;
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_request.preflight_id IS DISTINCT FROM v_preflight.id THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE';
    END IF;
    SELECT * INTO v_entitlement FROM public.analysis_v2_test_entitlement_consumptions WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_policy FROM public.analysis_v2_provider_execution_policies WHERE request_id = p_request_id FOR UPDATE;
    SELECT runner_plan INTO v_runner_plan FROM public.load_e2e_test_runner_v1(v_request.user_id);
    IF v_entitlement.request_id IS NULL OR v_policy.request_id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR v_preflight.status IS DISTINCT FROM 'consumed' OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation IS DISTINCT FROM 1 OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.admission_entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_preflight.admission_refreshed_at IS NULL OR v_preflight.admission_target_followers_count IS NULL OR v_preflight.admission_target_following_count IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_request.user_id
       OR pg_catalog.lower(v_preflight.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_entitlement.user_id IS DISTINCT FROM v_request.user_id OR v_entitlement.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_entitlement.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_entitlement.entitlement_jti_hash IS DISTINCT FROM v_request.test_entitlement_jti_hash
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split' OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_policy.entitlement_jti_hash IS DISTINCT FROM v_entitlement.entitlement_jti_hash
       OR pg_catalog.lower(v_policy.target_instagram_id) IS DISTINCT FROM pg_catalog.lower(v_preflight.target_instagram_id)
       OR v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_FENCE';
    END IF;
    SELECT * INTO v_fallback FROM public.analysis_preflight_provider_runs
      WHERE preflight_id = v_preflight.id AND operation_key = 'target-profile-fallback' FOR UPDATE;
    SELECT * INTO v_fresh FROM public.analysis_preflight_provider_runs
      WHERE preflight_id = v_preflight.id AND operation_key = 'target-profile-fresh-admission:g1' FOR UPDATE;
    SELECT pg_catalog.count(*)::INTEGER INTO v_count FROM public.analysis_preflight_provider_runs WHERE preflight_id = v_preflight.id;
    IF v_count <> 2 OR v_fallback.preflight_id IS NULL OR v_fresh.preflight_id IS NULL
       OR v_fallback.status IS DISTINCT FROM 'succeeded' OR v_fresh.status IS DISTINCT FROM 'succeeded'
       OR v_fallback.actual_usage_usd IS NULL OR v_fresh.actual_usage_usd IS NULL
       OR v_fallback.terminalized_at IS NULL OR v_fresh.terminalized_at IS NULL
       OR v_fallback.usage_reconciled_at IS NULL OR v_fresh.usage_reconciled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_TARGET_LINEAGE';
    END IF;
    v_target_hash := v_preflight.target_input_hash;
    IF v_target_hash IS NULL OR v_target_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_TARGET_LINEAGE'; END IF;
    v_fallback_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_fallback.operation_key, 'UTF8'), 'sha256'), 'hex');
    v_fresh_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_fresh.operation_key, 'UTF8'), 'sha256'), 'hex');
    v_fallback_owner := pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/preflight-owner/v1:' || p_request_id::TEXT || ':' || v_fallback.operation_key, 'UTF8'), 'sha256'), 'hex');
    v_fresh_owner := pg_catalog.encode(extensions.digest(pg_catalog.convert_to('revenue-cost/preflight-owner/v1:' || p_request_id::TEXT || ':' || v_fresh.operation_key, 'UTF8'), 'sha256'), 'hex');
    v_total := public.analysis_revenue_cost_ceil_krw(v_fallback.actual_usage_usd) + public.analysis_revenue_cost_ceil_krw(v_fresh.actual_usage_usd);
    SELECT * INTO v_existing FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.preflight_id IS DISTINCT FROM v_preflight.id OR v_existing.user_id IS DISTINCT FROM v_request.user_id
           OR v_existing.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_existing.access_mode IS DISTINCT FROM 'test_entitlement'
           OR v_existing.target_username_hmac IS DISTINCT FROM v_target_hash
           OR v_existing.pricing_snapshot_version IS DISTINCT FROM 'revenue-e2e-cost-2026-08-10-v1'
           OR v_existing.buffered_fx_krw_per_usd IS DISTINCT FROM 1450
           OR v_existing.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
           OR v_existing.request_started_at IS DISTINCT FROM v_request.created_at
           OR v_existing.cost_cap_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 1808 ELSE 3634 END)
           OR v_existing.margin_target_krw IS DISTINCT FROM (CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 904 ELSE 1817 END)
           OR v_existing.economic_actual_krw IS DISTINCT FROM v_total OR v_existing.actual_cost_krw IS DISTINCT FROM v_total
           OR v_existing.billed_actual_krw IS DISTINCT FROM 0
           OR v_existing.reserved_cost_krw IS DISTINCT FROM 0 OR v_existing.status IS DISTINCT FROM 'running'
           OR v_existing.selected_manifest_scope_hash IS NOT NULL OR v_existing.manual_review_reason IS NOT NULL
           OR (SELECT pg_catalog.count(*) FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id) <> 2 THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_DRIFT';
        END IF;
        FOR v_child IN SELECT * FROM public.analysis_revenue_cost_operations WHERE request_id = p_request_id ORDER BY attempt FOR UPDATE LOOP
            IF NOT (
                v_child.owner_kind = 'preflight_provider_run' AND v_child.operation_kind = 'target_profile'
                AND v_child.source_job_key = 'preflight' AND v_child.source_attempt = 0 AND v_child.units = 1
                AND v_child.selected_manifest_scope_hash IS NULL AND v_child.denial_reason IS NULL AND v_child.lifecycle_anomaly IS NULL
                AND v_child.billed_actual_usd = 0 AND v_child.billed_actual_krw = 0 AND v_child.reserved_krw = 0 AND v_child.status = 'settled'
                AND ((v_child.attempt = 1 AND v_child.owner_key_hash = v_fallback_owner AND v_child.source_operation_key_hash = v_fallback_hash
                     AND v_child.estimated_economic_usd = v_fallback.actual_usage_usd AND v_child.economic_actual_usd = v_fallback.actual_usage_usd
                     AND v_child.economic_actual_krw = public.analysis_revenue_cost_ceil_krw(v_fallback.actual_usage_usd)
                     AND v_child.started_at = v_fallback.terminalized_at AND v_child.terminal_at = v_fallback.usage_reconciled_at)
                 OR (v_child.attempt = 2 AND v_child.owner_key_hash = v_fresh_owner AND v_child.source_operation_key_hash = v_fresh_hash
                     AND v_child.estimated_economic_usd = v_fresh.actual_usage_usd AND v_child.economic_actual_usd = v_fresh.actual_usage_usd
                     AND v_child.economic_actual_krw = public.analysis_revenue_cost_ceil_krw(v_fresh.actual_usage_usd)
                     AND v_child.started_at = v_fresh.terminalized_at AND v_child.terminal_at = v_fresh.usage_reconciled_at)
                )
            ) THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_DRIFT';
            END IF;
        END LOOP;
        RETURN pg_catalog.jsonb_build_object('disposition', 'begun', 'created', FALSE, 'replayed', TRUE, 'requestId', p_request_id);
    END IF;
    INSERT INTO public.analysis_revenue_run_ledgers (
        request_id, preflight_id, user_id, plan_id, access_mode, target_username_hmac, preflight_refreshed_at, request_started_at,
        cost_cap_krw, margin_target_krw, economic_actual_krw, actual_cost_krw, billed_actual_krw
    ) VALUES (p_request_id, v_preflight.id, v_request.user_id, v_request.selected_plan_id_snapshot, 'test_entitlement', v_target_hash,
        v_preflight.admission_refreshed_at, v_request.created_at,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 1808 ELSE 3634 END,
        CASE WHEN v_request.selected_plan_id_snapshot = 'basic' THEN 904 ELSE 1817 END, v_total, v_total, 0);
    INSERT INTO public.analysis_revenue_cost_operations (
        request_id, owner_kind, owner_key_hash, attempt, operation_kind, units, source_job_key, source_operation_key_hash, source_attempt,
        estimated_economic_usd, economic_actual_usd, billed_actual_usd, reserved_krw, economic_actual_krw, billed_actual_krw, status, started_at, terminal_at
    ) VALUES
      (p_request_id, 'preflight_provider_run', v_fallback_owner, 1, 'target_profile', 1, 'preflight', v_fallback_hash, 0,
       v_fallback.actual_usage_usd, v_fallback.actual_usage_usd, 0, 0, public.analysis_revenue_cost_ceil_krw(v_fallback.actual_usage_usd), 0, 'settled', v_fallback.terminalized_at, v_fallback.usage_reconciled_at),
      (p_request_id, 'preflight_provider_run', v_fresh_owner, 2, 'target_profile', 1, 'preflight', v_fresh_hash, 0,
       v_fresh.actual_usage_usd, v_fresh.actual_usage_usd, 0, 0, public.analysis_revenue_cost_ceil_krw(v_fresh.actual_usage_usd), 0, 'settled', v_fresh.terminalized_at, v_fresh.usage_reconciled_at);
    RETURN pg_catalog.jsonb_build_object('disposition', 'begun', 'created', TRUE, 'replayed', FALSE, 'requestId', p_request_id);
END; $$;

CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_cost_operation_v1(p_request_id UUID, p_owner_kind TEXT, p_owner_key_hash TEXT, p_attempt SMALLINT, p_operation_kind TEXT, p_units INTEGER, p_estimated_economic_usd NUMERIC, p_selected_manifest_scope_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_NOT_READY'; END; $$;
CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_cost_operation_started_v1(p_request_id UUID, p_owner_kind TEXT, p_owner_key_hash TEXT, p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_NOT_READY'; END; $$;
CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v1(p_request_id UUID, p_owner_kind TEXT, p_owner_key_hash TEXT, p_attempt SMALLINT, p_economic_actual_usd NUMERIC, p_billed_actual_usd NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_NOT_READY'; END; $$;
CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v1(p_request_id UUID, p_owner_kind TEXT, p_owner_key_hash TEXT, p_attempt SMALLINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_NOT_READY'; END; $$;

CREATE OR REPLACE FUNCTION public.mark_analysis_revenue_manual_review_v1(p_request_id UUID, p_reason_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_reason_code IS NULL OR p_reason_code NOT IN ('routing_failure', 'ambiguous_external_call', 'cost_overrun') THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_MANUAL_REVIEW_INVALID'; END IF;
    -- Review causes are monotonic: cost_overrun > cost_denied >
    -- ambiguous_external_call > routing_failure.  This RPC can introduce the
    -- three non-denial reasons but must never erase stronger cost evidence.
    UPDATE public.analysis_revenue_run_ledgers
       SET status = 'manual_review', manual_review_reason = CASE
           WHEN manual_review_reason = 'cost_overrun' THEN 'cost_overrun'
           WHEN p_reason_code = 'cost_overrun' THEN 'cost_overrun'
           WHEN manual_review_reason = 'cost_denied' THEN 'cost_denied'
           WHEN manual_review_reason = 'ambiguous_external_call' THEN 'ambiguous_external_call'
           ELSE p_reason_code
       END
     WHERE request_id = p_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    RETURN pg_catalog.jsonb_build_object('disposition', 'manual_review', 'created', FALSE, 'replayed', FALSE);
END; $$;

DROP FUNCTION IF EXISTS public.read_analysis_revenue_cost_reconciliation_v1(UUID);
CREATE OR REPLACE FUNCTION public.read_analysis_revenue_cost_reconciliation_v1(p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ledger public.analysis_revenue_run_ledgers%ROWTYPE; v_disposition TEXT;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS DISTINCT FROM 'coordinator:finalize' OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE'; END IF;
    v_disposition := CASE WHEN v_ledger.economic_actual_krw > v_ledger.cost_cap_krw THEN 'hard_cap_exceeded' WHEN v_ledger.economic_actual_krw > v_ledger.margin_target_krw THEN 'negative_margin_pilot' ELSE 'within_margin_target' END;
    RETURN pg_catalog.jsonb_build_object('finalizable', FALSE, 'reason', 'not_ready', 'economicDisposition', v_disposition, 'economicActualKrw', v_ledger.economic_actual_krw, 'billedActualKrw', v_ledger.billed_actual_krw);
END; $$;

REVOKE ALL ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_revenue_cost_ledger_v1(UUID), public.reserve_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT), public.mark_analysis_revenue_cost_operation_started_v1(UUID,TEXT,TEXT,SMALLINT), public.settle_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC), public.release_analysis_revenue_cost_operation_v1(UUID,TEXT,TEXT,SMALLINT), public.mark_analysis_revenue_manual_review_v1(UUID,TEXT), public.read_analysis_revenue_cost_reconciliation_v1(UUID,TEXT,UUID,TEXT) TO service_role;

-- Live operations derive their identity solely from the already-reserved source
-- ledger.  The caller supplies a live job claim and PII-free source locator, never
-- either child hash.  Unsupported source prefixes/stages stay fenced until a
-- dedicated authoritative mapping is added.
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
    -- AI cost authority is intentionally absent: no source/parent/child lock or
    -- mutation is allowed until a separate pre-call maximum-charge schema lands.
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_AI_NOT_READY'; END IF;

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
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_AI_NOT_READY'; END IF;
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
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_AI_NOT_READY'; END IF;

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
    IF p_source_kind = 'ai_attempt' THEN RAISE EXCEPTION USING MESSAGE='REVENUE_COST_OPERATION_AI_NOT_READY'; END IF;
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
