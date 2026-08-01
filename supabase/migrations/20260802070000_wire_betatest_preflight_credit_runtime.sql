-- Worker-facing beta admission contract.  This is deliberately service-role
-- only: it exposes neither an owner id nor any upstream account metadata.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    DROP CONSTRAINT IF EXISTS analysis_preflights_error_code_check;
ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_error_code_check CHECK (
        error_code IS NULL OR error_code IN (
            'TARGET_NOT_FOUND', 'TARGET_PRIVATE', 'TARGET_UNSUPPORTED',
            'OVER_PLUS_CAPACITY', 'EXCLUSION_REQUIRED', 'INVALID_EXCLUSION',
            'PLAN_UPGRADE_REQUIRED', 'RELATIONSHIP_INCOMPLETE',
            'PROFILE_EVIDENCE_INCOMPLETE', 'QUEUE_UNAVAILABLE',
            'AI_RATE_LIMITED', 'AI_AMBIGUOUS_RESULT',
            'BETA_CAPACITY_UNAVAILABLE', 'ANALYSIS_FAILED'
        )
    );

CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_preflight_hold(
    p_preflight_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR KEY SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT reservation.* INTO v_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_allocation.id
      AND reservation.operation_family = 'target-profile'
    FOR KEY SHARE;
    IF NOT FOUND
       OR v_allocation.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
       OR v_allocation.lifecycle_state NOT IN ('preflight_held', 'active')
       OR NOT public.analysis_beta_valid_apify_credential_slot(v_reservation.credential_slot)
       OR v_reservation.reserved_usd IS DISTINCT FROM 0.005200000000
       OR v_reservation.lifecycle_state IS DISTINCT FROM v_allocation.lifecycle_state THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'allocationId', v_allocation.id,
        'preflightId', v_allocation.preflight_id,
        'credentialSlot', v_reservation.credential_slot,
        'targetProfileBudgetUsd', v_reservation.reserved_usd
    );
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_preflight_hold(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_preflight_hold(UUID) TO service_role;

-- Full latest claim implementation, with one append-only output field. The
-- function body intentionally preserves all prior lease/status transitions.
DROP FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER);
CREATE FUNCTION public.claim_analysis_v2_preflight(
    p_preflight_id UUID, p_claim_token UUID, p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE(
    preflight_id UUID, user_id UUID, claimed BOOLEAN, target_instagram_id TEXT,
    access_mode TEXT, analysis_entry_channel TEXT, plan_catalog_snapshot JSONB,
    pricing_version TEXT, pricing_snapshot JSONB, worker_attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE, preflight_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_lease_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL OR p_lease_seconds IS NULL
       OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001'; END IF;
    IF v_preflight.expires_at <= v_now THEN
        IF v_preflight.status IN ('pending','processing','ready') THEN
            UPDATE public.analysis_preflights SET status='expired', lease_token=NULL,
                lease_expires_at=NULL, updated_at=v_now WHERE id=v_preflight.id;
        END IF;
        RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,FALSE,NULL::TEXT,
            v_preflight.access_mode::TEXT,v_preflight.analysis_entry_channel::TEXT,
            v_preflight.plan_catalog_snapshot,v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,v_preflight.worker_attempt_count,NULL::TIMESTAMPTZ,'expired'::TEXT; RETURN;
    END IF;
    IF v_preflight.status='processing' AND v_preflight.lease_token=p_claim_token
       AND v_preflight.lease_expires_at > v_now THEN
        v_lease_expires_at:=LEAST(v_preflight.expires_at,v_now+pg_catalog.make_interval(secs=>p_lease_seconds));
        UPDATE public.analysis_preflights SET lease_expires_at=v_lease_expires_at,updated_at=v_now WHERE id=v_preflight.id;
        RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,TRUE,v_preflight.target_instagram_id::TEXT,
            v_preflight.access_mode::TEXT,v_preflight.analysis_entry_channel::TEXT,v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT,v_preflight.pricing_snapshot,v_preflight.worker_attempt_count,v_lease_expires_at,'processing'::TEXT; RETURN;
    END IF;
    IF v_preflight.status='processing' AND v_preflight.lease_expires_at > v_now THEN
        RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,FALSE,NULL::TEXT,v_preflight.access_mode::TEXT,
            v_preflight.analysis_entry_channel::TEXT,v_preflight.plan_catalog_snapshot,v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,v_preflight.worker_attempt_count,v_preflight.lease_expires_at,'processing'::TEXT; RETURN;
    END IF;
    IF v_preflight.status NOT IN ('pending','processing') THEN
        RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,FALSE,NULL::TEXT,v_preflight.access_mode::TEXT,
            v_preflight.analysis_entry_channel::TEXT,v_preflight.plan_catalog_snapshot,v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,v_preflight.worker_attempt_count,NULL::TIMESTAMPTZ,v_preflight.status::TEXT; RETURN;
    END IF;
    IF v_preflight.worker_attempt_count >= 7 THEN
        UPDATE public.analysis_preflights SET status='blocked',error_code='ANALYSIS_FAILED',blocked_at=v_now,
            lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_preflight.id;
        RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,FALSE,NULL::TEXT,v_preflight.access_mode::TEXT,
            v_preflight.analysis_entry_channel::TEXT,v_preflight.plan_catalog_snapshot,v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,v_preflight.worker_attempt_count,NULL::TIMESTAMPTZ,'blocked'::TEXT; RETURN;
    END IF;
    v_lease_expires_at:=LEAST(v_preflight.expires_at,v_now+pg_catalog.make_interval(secs=>p_lease_seconds));
    UPDATE public.analysis_preflights AS preflight SET status='processing',worker_attempt_count=preflight.worker_attempt_count+1,
        lease_token=p_claim_token,lease_expires_at=v_lease_expires_at,claimed_at=v_now,updated_at=v_now WHERE preflight.id=v_preflight.id;
    RETURN QUERY SELECT v_preflight.id,v_preflight.user_id,TRUE,v_preflight.target_instagram_id::TEXT,
        v_preflight.access_mode::TEXT,v_preflight.analysis_entry_channel::TEXT,v_preflight.plan_catalog_snapshot,
        v_preflight.pricing_version::TEXT,v_preflight.pricing_snapshot,v_preflight.worker_attempt_count+1,v_lease_expires_at,'processing'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER) TO service_role;

-- Latest fresh-admission claim state machine with the same immutable channel
-- propagated to the worker. No admission state transition is changed.
DROP FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER);
CREATE FUNCTION public.claim_analysis_v2_preflight_admission(
    p_preflight_id UUID, p_admission_generation INTEGER, p_dispatch_generation INTEGER,
    p_dispatch_token UUID, p_claim_token UUID, p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp(); v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_admission_generation IS NULL OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_generation IS NULL OR p_dispatch_generation NOT BETWEEN 1 AND 100 OR p_dispatch_token IS NULL
       OR p_claim_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE='P0001';
    END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id FOR UPDATE;
    IF NOT FOUND OR v_preflight.status <> 'ready' OR v_preflight.consumed_request_id IS NOT NULL OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation <> p_admission_generation
       OR v_preflight.admission_dispatch_generation <> p_dispatch_generation
       OR v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token
       OR v_preflight.admission_dispatch_state NOT IN ('reserved','enqueued') THEN
        RETURN QUERY SELECT FALSE,'blocked'::TEXT,NULL::TEXT,COALESCE(v_preflight.analysis_entry_channel::TEXT,'standard'::TEXT); RETURN;
    END IF;
    IF v_preflight.admission_status IN ('idle','ready','blocked') THEN
        RETURN QUERY SELECT FALSE,CASE WHEN v_preflight.admission_status='idle' THEN 'blocked' ELSE v_preflight.admission_status END,
            NULL::TEXT,v_preflight.analysis_entry_channel::TEXT; RETURN;
    END IF;
    IF v_preflight.admission_status='processing' AND v_preflight.admission_lease_expires_at > v_now THEN
        RETURN QUERY SELECT FALSE,'processing'::TEXT,NULL::TEXT,v_preflight.analysis_entry_channel::TEXT; RETURN;
    END IF;
    UPDATE public.analysis_preflights AS preflight SET admission_status='processing',admission_claim_token=p_claim_token,
        admission_lease_expires_at=v_now+pg_catalog.make_interval(secs=>p_lease_seconds),admission_dispatch_state='enqueued',
        admission_dispatched_at=COALESCE(preflight.admission_dispatched_at,v_now),updated_at=v_now WHERE preflight.id=v_preflight.id;
    RETURN QUERY SELECT TRUE,'processing'::TEXT,v_preflight.target_instagram_id::TEXT,v_preflight.analysis_entry_channel::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER) TO service_role;
