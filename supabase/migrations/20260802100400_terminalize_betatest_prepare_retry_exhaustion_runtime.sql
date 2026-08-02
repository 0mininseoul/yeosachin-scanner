-- Convert beta prepare delivery exhaustion from a pending tombstone into a
-- public terminal result after the short schema-only constraint swap commits.
-- This phase takes row-level locks only; validation remains separate.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.mark_analysis_beta_preflight_prepare_retry_exhausted(
    p_preflight_id UUID,p_user_id UUID,p_prepare_generation INTEGER,
    p_prepare_token UUID
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ;
DECLARE v_gate_enabled BOOLEAN; v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_has_allocation BOOLEAN := FALSE;
BEGIN
    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id=p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id
    FOR UPDATE;
    IF v_preflight.id IS NULL
       OR v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.status='expired'
       OR v_preflight.beta_prepare_state='expired' THEN
        RETURN FALSE;
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET status='expired', updated_at=v_now,
            error_code=NULL, blocked_at=NULL
        WHERE preflight.id=v_preflight.id;
        RETURN TRUE;
    END IF;
    IF v_preflight.beta_prepare_state IN (
        'prepared','capacity_blocked','retry_exhausted','expired'
    ) OR v_preflight.beta_prepare_retry_exhausted_at IS NOT NULL THEN
        RETURN FALSE;
    END IF;
    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id
    FOR UPDATE;
    v_has_allocation := FOUND;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET status='expired', updated_at=v_now,
            error_code=NULL, blocked_at=NULL
        WHERE preflight.id=v_preflight.id;
        RETURN TRUE;
    END IF;
    -- A historical split hold is recovered by the claim RPC. It must never be
    -- replaced with a queue failure after provider credit was held.
    IF v_has_allocation THEN RETURN FALSE; END IF;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET status='expired', updated_at=v_now,
            error_code=NULL, blocked_at=NULL
        WHERE preflight.id=v_preflight.id;
        RETURN TRUE;
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'pending'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR v_preflight.dispatch_state IS DISTINCT FROM 'unreserved'
       OR v_preflight.dispatch_generation IS DISTINCT FROM 0
       OR v_preflight.beta_prepare_state NOT IN ('reserved','preparing')
       OR (
            v_preflight.beta_prepare_state='preparing'
            AND v_preflight.beta_prepare_lease_expires_at>v_now
       ) THEN
        RETURN FALSE;
    END IF;
    UPDATE public.analysis_preflights AS preflight
    SET analysis_entry_channel='betatest',
        status='blocked',
        error_code='QUEUE_UNAVAILABLE',
        blocked_at=v_now,
        beta_prepare_state='retry_exhausted',
        beta_prepare_dispatch_state='completed',
        beta_prepare_lease_token=NULL,
        beta_prepare_lease_expires_at=NULL,
        beta_prepare_retry_exhausted_at=v_now,
        beta_prepare_completed_at=v_now,
        updated_at=v_now
    WHERE preflight.id=v_preflight.id;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_analysis_beta_preflight_prepare_retry_exhausted(
    UUID,UUID,INTEGER,UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_beta_preflight_prepare_retry_exhausted(
    UUID,UUID,INTEGER,UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_analysis_beta_preflight_prepare(
    p_preflight_id UUID, p_user_id UUID, p_prepare_generation INTEGER,
    p_prepare_token UUID, p_claim_token UUID, p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN, prepare_state TEXT, claim_disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_gate_enabled BOOLEAN;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
BEGIN
    IF p_claim_token IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_INVALID', ERRCODE='P0001';
    END IF;
    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id=p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'missing'::TEXT, 'missing'::TEXT; RETURN;
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.status='pending'
       AND v_preflight.beta_prepare_state IN ('reserved','preparing')
       AND v_preflight.expires_at <= v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET status='expired', updated_at=v_now
        WHERE preflight.id=v_preflight.id;
        RETURN QUERY SELECT FALSE, 'expired'::TEXT, 'terminal'::TEXT;
        RETURN;
    END IF;
    IF v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'stale'::TEXT; RETURN;
    END IF;
    IF v_preflight.beta_prepare_state IN (
        'prepared','capacity_blocked','retry_exhausted','expired'
    ) THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'terminal'::TEXT; RETURN;
    END IF;
    -- Recover the only historical split-commit shape before evaluating the
    -- current gate. New workers perform hold+promotion atomically.
    IF v_preflight.beta_prepare_state = 'preparing'
       AND v_preflight.analysis_entry_channel = 'betatest' THEN
        SELECT allocation.* INTO v_allocation
        FROM public.analysis_beta_pool_allocations AS allocation
        WHERE allocation.preflight_id = p_preflight_id
        FOR UPDATE;
        SELECT reservation.* INTO v_reservation
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_allocation.id
          AND reservation.operation_family = 'target-profile'
        FOR UPDATE;
        IF NOT FOUND
           OR v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
           OR v_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held' THEN
            RAISE EXCEPTION USING
                MESSAGE='ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE='P0001';
        END IF;
        UPDATE public.analysis_preflights AS preflight
        SET beta_prepare_state='prepared',
            beta_prepare_dispatch_state='completed',
            beta_prepare_lease_token=NULL,
            beta_prepare_lease_expires_at=NULL,
            beta_prepare_retry_exhausted_at=NULL,
            beta_prepare_completed_at=v_now,
            updated_at=v_now
        WHERE preflight.id=v_preflight.id;
        RETURN QUERY SELECT FALSE, 'prepared'::TEXT, 'terminal'::TEXT;
        RETURN;
    END IF;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at <= v_now
       )) THEN
        UPDATE public.analysis_preflights AS preflight
        SET analysis_entry_channel='betatest', status='blocked',
            error_code='BETA_CAPACITY_UNAVAILABLE', blocked_at=v_now,
            beta_prepare_state='capacity_blocked',
            beta_prepare_dispatch_state='completed',
            beta_prepare_lease_token=NULL,
            beta_prepare_lease_expires_at=NULL,
            beta_prepare_retry_exhausted_at=NULL,
            beta_prepare_completed_at=v_now,
            updated_at=v_now
        WHERE preflight.id=v_preflight.id;
        RETURN QUERY SELECT FALSE, 'capacity_blocked'::TEXT, 'terminal'::TEXT;
        RETURN;
    END IF;
    IF v_preflight.beta_prepare_state='preparing'
       AND v_preflight.beta_prepare_lease_expires_at > v_now THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'busy'::TEXT;
        RETURN;
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'pending'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR v_preflight.dispatch_state IS DISTINCT FROM 'unreserved'
       OR v_preflight.beta_prepare_state NOT IN ('reserved','preparing') THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'terminal'::TEXT;
        RETURN;
    END IF;
    UPDATE public.analysis_preflights AS preflight
    SET beta_prepare_state='preparing', beta_prepare_lease_token=p_claim_token,
        beta_prepare_lease_expires_at=v_now+pg_catalog.make_interval(secs=>p_lease_seconds),
        updated_at=v_now WHERE preflight.id=v_preflight.id;
    RETURN QUERY SELECT TRUE, 'preparing'::TEXT, 'claimed'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_analysis_beta_preflight_prepare(
    UUID,UUID,INTEGER,UUID,UUID,INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_beta_preflight_prepare(
    UUID,UUID,INTEGER,UUID,UUID,INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.block_analysis_beta_preflight_capacity(
    p_preflight_id UUID,p_user_id UUID,p_prepare_generation INTEGER,
    p_prepare_token UUID,p_claim_token UUID
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_gate_enabled BOOLEAN; v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_has_allocation BOOLEAN := FALSE;
BEGIN
    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id=p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    IF v_preflight.beta_prepare_state='capacity_blocked' THEN RETURN 'blocked'; END IF;
    IF v_preflight.beta_prepare_state='prepared' THEN RETURN 'prepared'; END IF;
    IF v_preflight.beta_prepare_state='retry_exhausted' THEN RETURN 'retry_exhausted'; END IF;
    IF v_preflight.beta_prepare_state='expired' THEN RETURN 'expired'; END IF;
    IF NOT (
        (
            v_preflight.beta_prepare_state='reserved'
            AND p_claim_token IS NULL
            AND v_preflight.analysis_entry_channel='standard'
        ) OR (
            v_preflight.beta_prepare_state='preparing'
            AND p_claim_token IS NOT NULL
            AND v_preflight.beta_prepare_lease_token IS NOT DISTINCT FROM p_claim_token
        )
    ) THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id FOR UPDATE;
    v_has_allocation := FOUND;
    IF v_has_allocation THEN
        SELECT reservation.* INTO v_reservation FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id=v_allocation.id AND reservation.operation_family='target-profile' FOR UPDATE;
        IF NOT FOUND OR v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
           OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
           OR v_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held' THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE='P0001';
        END IF;
    END IF;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    IF v_has_allocation THEN
        UPDATE public.analysis_preflights SET beta_prepare_state='prepared',
            beta_prepare_dispatch_state='completed',beta_prepare_lease_token=NULL,
            beta_prepare_lease_expires_at=NULL,beta_prepare_retry_exhausted_at=NULL,
            beta_prepare_completed_at=pg_catalog.clock_timestamp(),
            updated_at=pg_catalog.clock_timestamp() WHERE id=p_preflight_id;
        RETURN 'prepared';
    END IF;
    UPDATE public.analysis_preflights SET analysis_entry_channel='betatest',
        status='blocked',error_code='BETA_CAPACITY_UNAVAILABLE',
        blocked_at=pg_catalog.clock_timestamp(),beta_prepare_state='capacity_blocked',
        beta_prepare_dispatch_state='completed',beta_prepare_lease_token=NULL,
        beta_prepare_lease_expires_at=NULL,beta_prepare_retry_exhausted_at=NULL,
        beta_prepare_completed_at=pg_catalog.clock_timestamp(),
        updated_at=pg_catalog.clock_timestamp() WHERE id=p_preflight_id;
    RETURN 'blocked';
END;
$$;
REVOKE ALL ON FUNCTION public.block_analysis_beta_preflight_capacity(
    UUID,UUID,INTEGER,UUID,UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.block_analysis_beta_preflight_capacity(
    UUID,UUID,INTEGER,UUID,UUID
) TO service_role;

-- 20260802100100 could persist only this exact pending tombstone. Convert it
-- before the following migration validates the replacement constraint.
UPDATE public.analysis_preflights AS preflight
SET status = 'expired',
    error_code = NULL,
    blocked_at = NULL,
    updated_at = pg_catalog.clock_timestamp()
WHERE preflight.beta_entry_provenance IS NOT NULL
  AND preflight.beta_prepare_state = 'reserved'
  AND preflight.beta_prepare_dispatch_state = 'completed'
  AND preflight.beta_prepare_retry_exhausted_at IS NOT NULL
  AND preflight.expires_at <= pg_catalog.clock_timestamp();

UPDATE public.analysis_preflights AS preflight
SET analysis_entry_channel = 'betatest',
    status = 'blocked',
    error_code = 'QUEUE_UNAVAILABLE',
    blocked_at = COALESCE(
        preflight.blocked_at,
        preflight.beta_prepare_retry_exhausted_at,
        pg_catalog.clock_timestamp()
    ),
    beta_prepare_state = 'retry_exhausted',
    beta_prepare_dispatch_state = 'completed',
    beta_prepare_lease_token = NULL,
    beta_prepare_lease_expires_at = NULL,
    beta_prepare_completed_at = COALESCE(
        preflight.beta_prepare_completed_at,
        preflight.beta_prepare_retry_exhausted_at,
        pg_catalog.clock_timestamp()
    ),
    updated_at = pg_catalog.clock_timestamp()
WHERE preflight.beta_entry_provenance IS NOT NULL
  AND preflight.beta_prepare_state = 'reserved'
  AND preflight.beta_prepare_dispatch_state = 'completed'
  AND preflight.beta_prepare_retry_exhausted_at IS NOT NULL;
COMMIT;
