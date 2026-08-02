-- Runtime/backfill phase for the betatest entry lifecycle. The short schema
-- migration has already committed its table locks; validation follows in a
-- separate migration after these normalizers and fenced functions exist.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.set_analysis_beta_runtime_gate(
    p_enabled BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_generation BIGINT;
BEGIN
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_GATE_INVALID', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_beta_runtime_gate AS gate_row
    SET enabled = p_enabled,
        generation = gate_row.generation + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE gate_row.singleton = TRUE
      AND gate_row.enabled IS DISTINCT FROM p_enabled
    RETURNING gate_row.generation INTO v_generation;
    IF v_generation IS NULL THEN
        SELECT gate_row.generation INTO v_generation
        FROM public.analysis_beta_runtime_gate AS gate_row
        WHERE gate_row.singleton = TRUE
        FOR UPDATE;
    END IF;
    RETURN v_generation;
END;
$$;
REVOKE ALL ON FUNCTION public.set_analysis_beta_runtime_gate(BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_beta_runtime_gate(BOOLEAN)
    TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_beta_has_access()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF v_user_id IS NULL THEN RETURN FALSE; END IF;
    RETURN EXISTS (
        SELECT 1
        FROM public.analysis_beta_runtime_gate AS gate_row
        JOIN public.analysis_beta_access_grants AS grant_row
          ON grant_row.user_id = v_user_id
        WHERE gate_row.singleton = TRUE
          AND gate_row.enabled = TRUE
          AND grant_row.enabled = TRUE
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at > v_now)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_has_access()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_beta_has_access()
    TO authenticated;

-- Preserve already-held/active beta rows while making every new entry use the
-- stronger service provenance and prepare protocol.
UPDATE public.analysis_preflights AS preflight
SET beta_entry_provenance = 'legacy_betatest_v1',
    beta_prepare_generation = 1,
    beta_prepare_token = extensions.gen_random_uuid(),
    beta_prepare_state = CASE
        WHEN preflight.status = 'expired' THEN 'expired'
        ELSE 'prepared'
    END,
    beta_prepare_dispatch_state = 'completed',
    beta_prepare_completed_at = COALESCE(preflight.ready_at, preflight.updated_at)
WHERE preflight.analysis_entry_channel = 'betatest';

-- Every historical expiry writer (ordinary create replay, claim, and purge)
-- updates status through this table. Normalize beta provenance into one clean
-- terminal shape before the NOT VALID check is evaluated for that write.
CREATE OR REPLACE FUNCTION public.normalize_analysis_beta_prepare_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status='expired'
       AND NEW.beta_entry_provenance IS NOT NULL THEN
        NEW.analysis_entry_channel:='betatest';
        NEW.beta_prepare_state:='expired';
        NEW.beta_prepare_dispatch_state:='completed';
        NEW.beta_prepare_lease_token:=NULL;
        NEW.beta_prepare_lease_expires_at:=NULL;
        NEW.beta_prepare_retry_exhausted_at:=NULL;
        NEW.beta_prepare_completed_at:=COALESCE(
            NEW.beta_prepare_completed_at,
            pg_catalog.clock_timestamp()
        );
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.normalize_analysis_beta_prepare_expiry()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER normalize_analysis_beta_prepare_expiry
BEFORE UPDATE OF status ON public.analysis_preflights
FOR EACH ROW
WHEN (NEW.status='expired' AND NEW.beta_entry_provenance IS NOT NULL)
EXECUTE FUNCTION public.normalize_analysis_beta_prepare_expiry();

-- Keep the latest ordinary implementation private, then put a provenance
-- guard in front of its original signature.
ALTER FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) RENAME TO analysis_v2_create_or_replay_preflight_unfenced_20260802;
REVOKE ALL ON FUNCTION public.analysis_v2_create_or_replay_preflight_unfenced_20260802(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_or_replay_analysis_v2_preflight(
    p_user_id UUID, p_email TEXT, p_auth_provider TEXT,
    p_target_instagram_id TEXT, p_idempotency_key TEXT, p_access_mode TEXT,
    p_launch_status_snapshot JSONB, p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT, p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB
)
RETURNS TABLE(preflight_id UUID, created BOOLEAN, preflight_status TEXT,
    expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_existing public.analysis_preflights%ROWTYPE;
BEGIN
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id = p_user_id FOR UPDATE;
    SELECT preflight.* INTO v_existing
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND AND v_existing.beta_entry_provenance IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT *
    FROM public.analysis_v2_create_or_replay_preflight_unfenced_20260802(
        p_user_id,p_email,p_auth_provider,p_target_instagram_id,p_idempotency_key,
        p_access_mode,p_launch_status_snapshot,p_plan_catalog_snapshot,
        p_pricing_version,p_pricing_snapshot,p_policy_versions_snapshot
    );
END;
$$;
REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_or_replay_analysis_v2_betatest_preflight(
    p_user_id UUID, p_email TEXT, p_auth_provider TEXT,
    p_target_instagram_id TEXT, p_idempotency_key TEXT,
    p_launch_status_snapshot JSONB, p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT, p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB, p_beta_prepare_token UUID
)
RETURNS TABLE(preflight_id UUID, created BOOLEAN, preflight_status TEXT,
    expires_at TIMESTAMP WITH TIME ZONE, prepare_generation INTEGER,
    prepare_token UUID, should_enqueue BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_gate_enabled BOOLEAN;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_created RECORD;
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_beta_prepare_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREPARE_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton = TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    -- Existing rows are locked before the grant. For a new key, the stronger
    -- users FOR UPDATE lock is the same-user insertion serializer.
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.idempotency_key = p_idempotency_key
    FOR UPDATE;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE OR NOT FOUND
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at <= v_now
       )) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_created
    FROM public.analysis_v2_create_or_replay_preflight_unfenced_20260802(
        p_user_id,p_email,p_auth_provider,p_target_instagram_id,p_idempotency_key,
        'production',p_launch_status_snapshot,p_plan_catalog_snapshot,
        p_pricing_version,p_pricing_snapshot,p_policy_versions_snapshot
    );
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_created.preflight_id FOR UPDATE;
    -- The private predecessor may wait on its rate-limit/advisory serializer.
    -- Re-sample current access before attaching or rearming beta provenance;
    -- a rejection rolls back any newly inserted ordinary row as well.
    v_now:=pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE
       OR v_grant.user_id IS NULL
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE='P0001';
    END IF;
    IF v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       AND v_preflight.beta_entry_provenance IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_created.created THEN
        UPDATE public.analysis_preflights AS preflight
        SET beta_entry_provenance = 'betatest_service_v1',
            beta_prepare_generation = 1,
            beta_prepare_token = p_beta_prepare_token,
            beta_prepare_state = 'reserved',
            beta_prepare_dispatch_state = 'reserved',
            updated_at = v_now
        WHERE preflight.id = v_preflight.id
        RETURNING preflight.* INTO v_preflight;
    ELSIF v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
    ELSIF v_preflight.status = 'pending'
       AND v_preflight.analysis_entry_channel = 'standard'
       AND (
            v_preflight.beta_prepare_retry_exhausted_at IS NOT NULL
            OR (
                v_preflight.beta_prepare_state = 'preparing'
                AND v_preflight.beta_prepare_lease_expires_at <= v_now
            )
       ) THEN
        IF v_preflight.beta_prepare_generation >= 100 THEN
            RAISE EXCEPTION USING
                MESSAGE='ANALYSIS_BETA_PREPARE_EXHAUSTED', ERRCODE='P0001';
        END IF;
        UPDATE public.analysis_preflights AS preflight
        SET beta_prepare_generation=preflight.beta_prepare_generation + 1,
            beta_prepare_token=p_beta_prepare_token,
            beta_prepare_state='reserved',
            beta_prepare_dispatch_state='reserved',
            beta_prepare_dispatched_at=NULL,
            beta_prepare_lease_token=NULL,
            beta_prepare_lease_expires_at=NULL,
            beta_prepare_retry_exhausted_at=NULL,
            updated_at=v_now
        WHERE preflight.id=v_preflight.id
        RETURNING preflight.* INTO v_preflight;
    END IF;
    RETURN QUERY SELECT v_preflight.id, v_created.created,
        v_preflight.status, v_preflight.expires_at,
        v_preflight.beta_prepare_generation, v_preflight.beta_prepare_token,
        (v_preflight.status = 'pending'
            AND v_preflight.beta_prepare_state IN ('reserved','preparing'));
END;
$$;
REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_betatest_preflight(
    UUID,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,JSONB,JSONB,UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_betatest_preflight(
    UUID,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,JSONB,JSONB,UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_beta_preflight_prepare_dispatched(
    p_preflight_id UUID, p_user_id UUID, p_prepare_generation INTEGER,
    p_prepare_token UUID
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ;
DECLARE v_gate_enabled BOOLEAN; v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id=p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id FOR UPDATE;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.id IS NULL
       OR v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    IF v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       )) THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE='P0001';
    END IF;
    IF v_preflight.beta_prepare_dispatch_state IN ('enqueued','completed') THEN RETURN FALSE; END IF;
    IF v_preflight.beta_prepare_dispatch_state IS DISTINCT FROM 'reserved' THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    UPDATE public.analysis_preflights SET beta_prepare_dispatch_state='enqueued',
        beta_prepare_dispatched_at=v_now,
        updated_at=v_now WHERE id=p_preflight_id;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_analysis_beta_preflight_prepare_dispatched(UUID,UUID,INTEGER,UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_beta_preflight_prepare_dispatched(UUID,UUID,INTEGER,UUID)
    TO service_role;

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
    IF v_preflight.beta_prepare_state IN ('prepared','capacity_blocked','expired')
       OR v_preflight.beta_prepare_retry_exhausted_at IS NOT NULL THEN
        RETURN FALSE;
    END IF;
    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE='P0001';
    END IF;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    v_now := pg_catalog.clock_timestamp();
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
    SET beta_prepare_state='reserved',
        beta_prepare_dispatch_state='completed',
        beta_prepare_lease_token=NULL,
        beta_prepare_lease_expires_at=NULL,
        beta_prepare_retry_exhausted_at=v_now,
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
    IF v_preflight.beta_prepare_state IN ('prepared','capacity_blocked','expired') THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'terminal'::TEXT; RETURN;
    END IF;
    IF v_preflight.beta_prepare_retry_exhausted_at IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, v_preflight.beta_prepare_state, 'exhausted'::TEXT; RETURN;
    END IF;
    -- Recover the only historical split-commit shape before evaluating the
    -- current gate. New workers perform hold+promotion atomically below.
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
REVOKE ALL ON FUNCTION public.claim_analysis_beta_preflight_prepare(UUID,UUID,INTEGER,UUID,UUID,INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_beta_preflight_prepare(UUID,UUID,INTEGER,UUID,UUID,INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.release_analysis_beta_preflight_prepare_claim(
    p_preflight_id UUID,p_user_id UUID,p_prepare_generation INTEGER,
    p_prepare_token UUID,p_claim_token UUID
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_gate_enabled BOOLEAN; v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
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
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    IF v_preflight.id IS NULL
       OR v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token
       OR v_preflight.beta_prepare_state IS DISTINCT FROM 'preparing'
       OR v_preflight.beta_prepare_lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard' THEN
        RETURN FALSE;
    END IF;
    UPDATE public.analysis_preflights AS preflight
    SET beta_prepare_state='reserved',
        beta_prepare_lease_token=NULL,
        beta_prepare_lease_expires_at=NULL,
        updated_at=pg_catalog.clock_timestamp()
    WHERE preflight.id=v_preflight.id;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.release_analysis_beta_preflight_prepare_claim(
    UUID,UUID,INTEGER,UUID,UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_beta_preflight_prepare_claim(
    UUID,UUID,INTEGER,UUID,UUID
) TO service_role;

-- Gate and claim state are held while the historical exact-six hold primitive
-- performs its own user/preflight/snapshot locks.
ALTER FUNCTION public.hold_analysis_beta_apify_preflight_credit(UUID,UUID,TEXT,NUMERIC,INTEGER)
    RENAME TO hold_analysis_beta_apify_preflight_credit_unfenced_20260802;
REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit_unfenced_20260802(UUID,UUID,TEXT,NUMERIC,INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    p_preflight_id UUID,p_user_id UUID,p_credential_slot TEXT,
    p_target_profile_budget_usd NUMERIC,p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
BEGIN
    -- The historical signature cannot carry the persisted generation/token
    -- and claim token. Keep it present for schema compatibility, but make it
    -- unusable after the fenced lifecycle is installed.
    RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_REQUIRED', ERRCODE='P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(UUID,UUID,TEXT,NUMERIC,INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prepare_analysis_beta_apify_preflight_credit(
    p_preflight_id UUID,p_user_id UUID,p_prepare_generation INTEGER,
    p_prepare_token UUID,p_claim_token UUID,p_credential_slot TEXT,
    p_target_profile_budget_usd NUMERIC,p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ;
DECLARE v_gate_enabled BOOLEAN; v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_result JSONB;
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
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token
       OR v_preflight.beta_prepare_state IS DISTINCT FROM 'preparing'
       OR v_preflight.beta_prepare_lease_token IS DISTINCT FROM p_claim_token THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    -- The predecessor takes this allocation lock before upgrading the grant.
    -- Prove the atomic path has no historical split hold, then take the final
    -- grant strength up front so the nested predecessor never upgrades.
    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_PREPARE_HOLD_CONFLICT', ERRCODE='P0001';
    END IF;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE
       OR v_grant.user_id IS NULL OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       ))
       OR v_preflight.beta_prepare_lease_expires_at<=v_now THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;

    -- The internal exact-six hold and lifecycle promotion are one database
    -- transaction. There is no committed hold-before-complete crash window.
    v_result := public.hold_analysis_beta_apify_preflight_credit_unfenced_20260802(
        p_preflight_id,p_user_id,p_credential_slot,p_target_profile_budget_usd,
        p_max_snapshot_age_seconds);
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id FOR UPDATE;
    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id FOR UPDATE;
    SELECT reservation.* INTO v_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id=v_allocation.id
      AND reservation.operation_family='target-profile'
    FOR UPDATE;
    -- Snapshot locking inside the hold may have crossed the claim/grant expiry
    -- boundary. Re-sample database time and repeat every time-sensitive fence;
    -- raising here rolls the nested hold back with this transaction.
    v_now:=pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       ))
       OR v_preflight.beta_entry_provenance IS DISTINCT FROM 'betatest_service_v1'
       OR v_preflight.beta_prepare_generation IS DISTINCT FROM p_prepare_generation
       OR v_preflight.beta_prepare_token IS DISTINCT FROM p_prepare_token
       OR v_preflight.beta_prepare_state IS DISTINCT FROM 'preparing'
       OR v_preflight.beta_prepare_lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.beta_prepare_lease_expires_at<=v_now THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_PREPARE_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    IF NOT FOUND
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held' THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_PREPARE_HOLD_MISSING', ERRCODE='P0001';
    END IF;
    UPDATE public.analysis_preflights AS preflight
    SET beta_prepare_state='prepared',
        beta_prepare_dispatch_state='completed',
        beta_prepare_lease_token=NULL,
        beta_prepare_lease_expires_at=NULL,
        beta_prepare_retry_exhausted_at=NULL,
        beta_prepare_completed_at=v_now,
        updated_at=v_now
    WHERE preflight.id=p_preflight_id;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_analysis_beta_apify_preflight_credit(
    UUID,UUID,INTEGER,UUID,UUID,TEXT,NUMERIC,INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_analysis_beta_apify_preflight_credit(
    UUID,UUID,INTEGER,UUID,UUID,TEXT,NUMERIC,INTEGER
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
REVOKE ALL ON FUNCTION public.block_analysis_beta_preflight_capacity(UUID,UUID,INTEGER,UUID,UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.block_analysis_beta_preflight_capacity(UUID,UUID,INTEGER,UUID,UUID)
    TO service_role;

ALTER FUNCTION public.reserve_analysis_v2_preflight_dispatch(UUID,UUID,UUID)
    RENAME TO reserve_analysis_v2_preflight_dispatch_unfenced_20260802;
REVOKE ALL ON FUNCTION public.reserve_analysis_v2_preflight_dispatch_unfenced_20260802(UUID,UUID,UUID)
    FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_preflight_dispatch(
    p_preflight_id UUID,p_user_id UUID,p_dispatch_token UUID
)
RETURNS TABLE(should_enqueue BOOLEAN,dispatch_generation INTEGER,
    reservation_token UUID,preflight_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id FOR UPDATE;
    IF FOUND AND v_preflight.status='pending'
       AND v_preflight.beta_entry_provenance IS NOT NULL
       AND v_preflight.beta_prepare_state IS DISTINCT FROM 'prepared' THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREPARE_REQUIRED', ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT * FROM public.reserve_analysis_v2_preflight_dispatch_unfenced_20260802(
        p_preflight_id,p_user_id,p_dispatch_token);
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_v2_preflight_dispatch(UUID,UUID,UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_preflight_dispatch(UUID,UUID,UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.set_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,p_user_id UUID,p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ; v_gate_enabled BOOLEAN;
DECLARE v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE; v_excluded_instagram_id TEXT;
BEGIN
    IF p_preflight_id IS NULL OR p_user_id IS NULL OR p_decision NOT IN ('exclude','skip') THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE='P0001';
    END IF;
    IF p_decision='exclude' THEN
        v_excluded_instagram_id:=pg_catalog.lower(pg_catalog.btrim(p_excluded_instagram_id));
        IF v_excluded_instagram_id IS NULL OR v_excluded_instagram_id!~'^[a-z0-9._]{1,30}$' THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE='P0001';
        END IF;
    ELSIF p_excluded_instagram_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE='P0001';
    END IF;
    SELECT gate_row.enabled INTO v_gate_enabled FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user WHERE owner_user.id=p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE='P0001'; END IF;
    SELECT grant_row.* INTO v_grant FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR SHARE;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.beta_entry_provenance IS NOT NULL AND (
        v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
        OR v_grant.enabled IS DISTINCT FROM TRUE
        OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
        ))
    ) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE='P0001'; END IF;
    IF v_preflight.exclusion_decision=p_decision
       AND v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id THEN RETURN FALSE; END IF;
    IF v_preflight.exclusion_decision<>'pending' THEN RAISE EXCEPTION USING MESSAGE='PREFLIGHT_IMMUTABLE', ERRCODE='P0001'; END IF;
    IF v_preflight.expires_at<=v_now OR v_preflight.status='expired' THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE='P0001'; END IF;
    IF v_preflight.status='consumed' THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_PREFLIGHT_CONSUMED', ERRCODE='P0001'; END IF;
    IF v_preflight.status NOT IN ('pending','processing','ready') THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE='P0001'; END IF;
    IF p_decision='exclude' AND v_excluded_instagram_id=v_preflight.target_instagram_id THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE='P0001'; END IF;
    UPDATE public.analysis_preflights SET exclusion_decision=p_decision,
        excluded_instagram_id=v_excluded_instagram_id,exclusion_decided_at=v_now,
        updated_at=v_now WHERE id=v_preflight.id AND exclusion_decision='pending';
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='PREFLIGHT_IMMUTABLE', ERRCODE='P0001'; END IF;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID,UUID,TEXT,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID,UUID,TEXT,TEXT)
    TO service_role;

-- Provider-run overrides are deliberately limited to pre-request beta spend.
-- Existing matching authorizations replay before gate/grant enforcement.
CREATE OR REPLACE FUNCTION public.reserve_analysis_preflight_provider_run(
    p_preflight_id UUID,p_claim_token UUID,p_input_hash TEXT,
    p_credential_slot TEXT,p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ; v_user_hint UUID; v_gate_enabled BOOLEAN;
DECLARE v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_existing public.analysis_preflight_provider_runs%ROWTYPE; v_spent NUMERIC;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL OR p_input_hash!~'^[0-9a-f]{64}$'
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE='P0001'; END IF;
    SELECT preflight.user_id INTO v_user_hint FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id;
    SELECT gate_row.enabled INTO v_gate_enabled FROM public.analysis_beta_runtime_gate AS gate_row WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user WHERE owner_user.id=v_user_hint FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE='P0001'; END IF;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now OR NOT ((v_preflight.status='processing' AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token AND v_preflight.lease_expires_at>v_now) OR (v_preflight.status='ready' AND v_preflight.consumed_request_id IS NULL AND v_preflight.admission_status='processing' AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token AND v_preflight.admission_lease_expires_at>v_now)) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001'; END IF;
    IF v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest' THEN
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.preflight_id=p_preflight_id AND allocation.lifecycle_state='preflight_held' FOR UPDATE;
        SELECT reservation.* INTO v_target_reservation FROM public.analysis_beta_pool_reservations AS reservation WHERE reservation.allocation_id=v_allocation.id AND reservation.operation_family='target-profile' FOR UPDATE;
        IF NOT FOUND OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot) OR v_target_reservation.credential_slot IS DISTINCT FROM p_credential_slot THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE='P0001'; END IF;
    ELSIF NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE='P0001'; END IF;
    SELECT provider_run.* INTO v_existing FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id AND provider_run.operation_key='target-profile-fallback' FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now OR NOT (
        (v_preflight.status='processing'
            AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
            AND v_preflight.lease_expires_at>v_now)
        OR (v_preflight.status='ready'
            AND v_preflight.consumed_request_id IS NULL
            AND v_preflight.admission_status='processing'
            AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
            AND v_preflight.admission_lease_expires_at>v_now)
    ) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001'; END IF;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash OR v_existing.logical_provider IS DISTINCT FROM 'apify' OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper' OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE='P0001'; END IF;
        RETURN pg_catalog.jsonb_build_object('created',FALSE,'run',public.analysis_preflight_provider_run_json(v_existing));
    END IF;
    IF v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest' THEN
        SELECT grant_row.* INTO v_grant FROM public.analysis_beta_access_grants AS grant_row WHERE grant_row.user_id=v_user_hint FOR SHARE;
        v_now:=pg_catalog.clock_timestamp();
        IF v_preflight.expires_at<=v_now
           OR NOT ((v_preflight.status='processing'
                AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.lease_expires_at>v_now)
             OR (v_preflight.status='ready'
                AND v_preflight.consumed_request_id IS NULL
                AND v_preflight.admission_status='processing'
                AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.admission_lease_expires_at>v_now)) THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001';
        END IF;
        IF v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
           OR v_grant.enabled IS DISTINCT FROM TRUE
           OR (v_grant.expires_at IS NOT NULL AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at<=v_now
           )) THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_RUNTIME_DISABLED', ERRCODE='P0001';
        END IF;
        PERFORM 1 FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id FOR UPDATE;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd),0::NUMERIC) INTO v_spent FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id AND provider_run.operation_key IS DISTINCT FROM 'target-profile-fallback';
        IF v_spent+p_max_charge_usd>v_target_reservation.reserved_usd THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE='P0001'; END IF;
    END IF;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.expires_at<=v_now OR NOT (
        (v_preflight.status='processing'
            AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
            AND v_preflight.lease_expires_at>v_now)
        OR (v_preflight.status='ready'
            AND v_preflight.consumed_request_id IS NULL
            AND v_preflight.admission_status='processing'
            AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
            AND v_preflight.admission_lease_expires_at>v_now)
    ) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001'; END IF;
    IF (v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest')
       AND (v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
            OR v_grant.enabled IS DISTINCT FROM TRUE
            OR (v_grant.expires_at IS NOT NULL AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at<=v_now
            ))) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_RUNTIME_DISABLED', ERRCODE='P0001'; END IF;
    INSERT INTO public.analysis_preflight_provider_runs(preflight_id,input_hash,credential_slot,max_charge_usd) VALUES(p_preflight_id,p_input_hash,p_credential_slot,p_max_charge_usd) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object('created',TRUE,'run',public.analysis_preflight_provider_run_json(v_existing));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_preflight_provider_run(UUID,UUID,TEXT,TEXT,NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_preflight_provider_run(UUID,UUID,TEXT,TEXT,NUMERIC)
    TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    p_preflight_id UUID,p_admission_generation INTEGER,p_claim_token UUID,
    p_input_hash TEXT,p_credential_slot TEXT,p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min' AS $$
DECLARE v_now TIMESTAMPTZ; v_operation_key TEXT; v_user_hint UUID; v_gate_enabled BOOLEAN;
DECLARE v_grant public.analysis_beta_access_grants%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_existing public.analysis_preflight_provider_runs%ROWTYPE; v_spent NUMERIC;
BEGIN
    IF p_preflight_id IS NULL OR p_admission_generation NOT BETWEEN 1 AND 100 OR p_claim_token IS NULL OR p_input_hash!~'^[0-9a-f]{64}$' OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE='P0001'; END IF;
    v_operation_key:='target-profile-fresh-admission:g'||p_admission_generation::TEXT;
    SELECT preflight.user_id INTO v_user_hint FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id;
    SELECT gate_row.enabled INTO v_gate_enabled FROM public.analysis_beta_runtime_gate AS gate_row WHERE gate_row.singleton=TRUE FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user WHERE owner_user.id=v_user_hint FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE='P0001'; END IF;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.status IS DISTINCT FROM 'ready' OR v_preflight.consumed_request_id IS NOT NULL OR v_preflight.expires_at<=v_now OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation OR v_preflight.admission_status IS DISTINCT FROM 'processing' OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token OR v_preflight.admission_lease_expires_at IS NULL OR v_preflight.admission_lease_expires_at<=v_now THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001'; END IF;
    IF v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest' THEN
        IF p_admission_generation>1 THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_GENERATION_INVALID', ERRCODE='P0001'; END IF;
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.preflight_id=p_preflight_id AND allocation.lifecycle_state='preflight_held' FOR UPDATE;
        SELECT reservation.* INTO v_target_reservation FROM public.analysis_beta_pool_reservations AS reservation WHERE reservation.allocation_id=v_allocation.id AND reservation.operation_family='target-profile' FOR UPDATE;
        IF NOT FOUND OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot) OR v_target_reservation.credential_slot IS DISTINCT FROM p_credential_slot THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE='P0001'; END IF;
    ELSIF NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE='P0001'; END IF;
    PERFORM public.adopt_legacy_fresh_admission_provider_run(p_preflight_id,v_operation_key,v_preflight.admission_requested_at);
    SELECT provider_run.* INTO v_existing FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id AND provider_run.operation_key=v_operation_key FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at<=v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at<=v_now THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash OR v_existing.logical_provider IS DISTINCT FROM 'apify' OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper' OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE='P0001'; END IF;
        RETURN pg_catalog.jsonb_build_object('created',FALSE,'run',public.analysis_preflight_provider_run_json(v_existing));
    END IF;
    IF v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest' THEN
        SELECT grant_row.* INTO v_grant FROM public.analysis_beta_access_grants AS grant_row WHERE grant_row.user_id=v_user_hint FOR SHARE;
        v_now:=pg_catalog.clock_timestamp();
        IF v_preflight.expires_at<=v_now
           OR v_preflight.admission_lease_expires_at IS NULL
           OR v_preflight.admission_lease_expires_at<=v_now THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001';
        END IF;
        IF v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
           OR v_grant.enabled IS DISTINCT FROM TRUE
           OR (v_grant.expires_at IS NOT NULL AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at<=v_now
           )) THEN
            RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_RUNTIME_DISABLED', ERRCODE='P0001';
        END IF;
        PERFORM 1 FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id FOR UPDATE;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd),0::NUMERIC) INTO v_spent FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id=p_preflight_id AND provider_run.operation_key IS DISTINCT FROM v_operation_key;
        IF v_spent+p_max_charge_usd>v_target_reservation.reserved_usd THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE='P0001'; END IF;
    END IF;
    v_now:=pg_catalog.clock_timestamp();
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at<=v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at<=v_now THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE='P0001';
    END IF;
    IF (v_preflight.beta_entry_provenance IS NOT NULL OR v_preflight.analysis_entry_channel='betatest')
       AND (v_gate_enabled IS DISTINCT FROM TRUE OR v_grant.user_id IS NULL
            OR v_grant.enabled IS DISTINCT FROM TRUE
            OR (v_grant.expires_at IS NOT NULL AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at<=v_now
            ))) THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_RUNTIME_DISABLED', ERRCODE='P0001'; END IF;
    INSERT INTO public.analysis_preflight_provider_runs(preflight_id,operation_key,input_hash,credential_slot,max_charge_usd) VALUES(p_preflight_id,v_operation_key,p_input_hash,p_credential_slot,p_max_charge_usd) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object('created',TRUE,'run',public.analysis_preflight_provider_run_json(v_existing));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(UUID,INTEGER,UUID,TEXT,TEXT,NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(UUID,INTEGER,UUID,TEXT,TEXT,NUMERIC)
    TO service_role;

-- Lost-response recovery must precede every mutable fresh-admission boundary.
-- This wrapper reads only an unlocked identity hint. The existing internal
-- validator then acquires the canonical user -> preflight -> allocation ->
-- request/job/policy locks and rechecks the complete immutable bind.
CREATE OR REPLACE FUNCTION public.load_analysis_v2_betatest_consumed_replay(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_replay JSONB;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    -- Deliberately unlocked. Locking this row here would invert the canonical
    -- replay validator's user -> preflight order.
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id;

    IF NOT FOUND
       OR v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.beta_entry_provenance IS NULL
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest' THEN
        RETURN NULL;
    END IF;

    IF v_preflight.status IS DISTINCT FROM 'consumed' THEN
        IF v_preflight.consumed_request_id IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN NULL;
    END IF;

    IF v_preflight.admission_selected_plan_id
            IS DISTINCT FROM p_selected_plan_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.consumed_request_id IS NULL
       OR v_preflight.admission_token IS NULL
       OR v_preflight.admission_generation IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_replay := public.analysis_v2_betatest_plan_replay_internal(
        p_preflight_id,
        p_user_id,
        v_preflight.admission_token,
        v_preflight.admission_generation,
        p_selected_plan_id
    );
    IF v_replay IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN v_replay;
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_v2_betatest_consumed_replay(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_betatest_consumed_replay(
    UUID, UUID, TEXT
) TO service_role;
COMMENT ON FUNCTION public.load_analysis_v2_betatest_consumed_replay(
    UUID, UUID, TEXT
) IS 'Returns only a fully integrity-validated consumed beta request/job/allocation identity for idempotent redispatch.';

-- Preserve the reviewed admission body privately. The public boundary adds a
-- database-atomic operational gate and durable entry/prepare fence around only
-- the fresh preflight-held transition. Consumed active/settled identities keep
-- their existing integrity-validated replay continuity without current access.
ALTER FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) RENAME TO analysis_v2_admit_betatest_plan_ungated_20260802;
REVOKE ALL ON FUNCTION public.analysis_v2_admit_betatest_plan_ungated_20260802(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admit_analysis_v2_betatest_plan(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_token UUID,
    p_admission_generation INTEGER,
    p_selected_plan_id TEXT,
    p_operation_slot_map JSONB,
    p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_status_hint TEXT;
    v_consumed_request_hint UUID;
    v_gate_enabled BOOLEAN;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
    v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_replay JSONB;
    v_result JSONB;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_token IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_max_snapshot_age_seconds IS NULL
       OR p_max_snapshot_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE='P0001';
    END IF;

    -- Unlocked routing hint only. A consumed candidate is fully revalidated by
    -- the canonical user -> preflight -> allocation -> request/job/policy
    -- replay validator; a fresh candidate takes the gate before any row lock.
    SELECT preflight.status, preflight.consumed_request_id
    INTO v_status_hint, v_consumed_request_hint
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id AND preflight.user_id=p_user_id;
    IF FOUND AND (
        v_status_hint='consumed' OR v_consumed_request_hint IS NOT NULL
    ) THEN
        v_replay:=public.analysis_v2_betatest_plan_replay_internal(
            p_preflight_id,p_user_id,p_admission_token,
            p_admission_generation,p_selected_plan_id
        );
        IF v_replay IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE='ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE='P0001';
        END IF;
        RETURN v_replay;
    END IF;

    SELECT gate_row.enabled INTO v_gate_enabled
    FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE
    FOR SHARE;
    PERFORM 1 FROM public.users AS owner_user
    WHERE owner_user.id=p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE='P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id
    FOR UPDATE;
    IF v_preflight.id IS NULL OR v_preflight.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE='P0001';
    END IF;

    -- A competing winner may have committed while the unlocked hint was
    -- stale. Re-enter immutable replay without applying current access.
    IF v_preflight.status='consumed'
       OR v_preflight.consumed_request_id IS NOT NULL THEN
        v_replay:=public.analysis_v2_betatest_plan_replay_internal(
            p_preflight_id,p_user_id,p_admission_token,
            p_admission_generation,p_selected_plan_id
        );
        IF v_replay IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE='ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE='P0001';
        END IF;
        RETURN v_replay;
    END IF;

    SELECT allocation.* INTO v_allocation
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id=p_preflight_id
    FOR UPDATE;
    SELECT reservation.* INTO v_target_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id=v_allocation.id
      AND reservation.operation_family='target-profile'
    FOR UPDATE;
    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id
    FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();

    IF v_gate_enabled IS DISTINCT FROM TRUE
       OR v_grant.user_id IS NULL
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE='P0001';
    END IF;
    IF v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.beta_entry_provenance IS NULL
       OR v_preflight.beta_entry_provenance NOT IN (
            'betatest_service_v1','legacy_betatest_v1'
       )
       OR v_preflight.beta_prepare_generation NOT BETWEEN 1 AND 100
       OR v_preflight.beta_prepare_token IS NULL
       OR v_preflight.beta_prepare_state IS DISTINCT FROM 'prepared'
       OR v_preflight.beta_prepare_dispatch_state IS DISTINCT FROM 'completed'
       OR v_preflight.beta_prepare_completed_at IS NULL
       OR v_allocation.id IS NULL
       OR v_allocation.user_id IS DISTINCT FROM p_user_id
       OR v_allocation.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_allocation.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
       OR v_target_reservation.allocation_id IS NULL
       OR v_target_reservation.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_target_reservation.credential_slot IS DISTINCT FROM
            p_operation_slot_map->>'target-profile' THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE='P0001';
    END IF;

    v_result:=public.analysis_v2_admit_betatest_plan_ungated_20260802(
        p_preflight_id,p_user_id,p_admission_token,p_admission_generation,
        p_selected_plan_id,p_operation_slot_map,p_operation_budget_map,
        p_max_snapshot_age_seconds
    );
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id
    FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();
    IF v_gate_enabled IS DISTINCT FROM TRUE
       OR v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at)
            OR v_grant.expires_at<=v_now
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE='P0001';
    END IF;
    IF v_result IS NULL
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.consumed_request_id IS NULL
       OR v_preflight.expires_at<=v_now
       OR v_preflight.admission_token IS DISTINCT FROM p_admission_token
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at<v_now-INTERVAL '2 minutes'
       OR v_preflight.admission_refreshed_at>v_now+INTERVAL '30 seconds'
       OR v_preflight.beta_entry_provenance IS NULL
       OR v_preflight.beta_prepare_state IS DISTINCT FROM 'prepared' THEN
        RAISE EXCEPTION USING
            MESSAGE='ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE='P0001';
    END IF;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) TO service_role;
COMMENT ON FUNCTION public.admit_analysis_v2_betatest_plan(
    UUID, UUID, UUID, INTEGER, TEXT, JSONB, JSONB, INTEGER
) IS 'Atomically gates and consumes one prepared beta preflight while preserving integrity-validated consumed replay.';
COMMIT;
