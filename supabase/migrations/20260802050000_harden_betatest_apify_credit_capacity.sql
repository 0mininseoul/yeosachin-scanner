-- Task 2B3 forward correction.  Capacity is always evaluated from one MVCC
-- statement: an archive transaction moves a debit live -> archive atomically,
-- so this aggregate observes either representation and never a gap.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The original generic arithmetic check accidentally made the deliberately
-- conservative ambiguous_held archive shape impossible (it requires zero
-- released debit, whereas a deterministic settlement releases the remainder).
-- Keep the two archive shapes explicit and mutually exclusive.
ALTER TABLE public.analysis_beta_pool_reservation_archive
    DROP CONSTRAINT analysis_beta_pool_reservation_archive_check,
    ADD CONSTRAINT analysis_beta_pool_reservation_archive_check CHECK (
        (archive_state = 'settled'
            AND actual_usd BETWEEN 0 AND reserved_usd
            AND released_usd = reserved_usd - actual_usd)
        OR (archive_state = 'ambiguous_held'
            AND actual_usd = 0 AND released_usd = 0)
    );

CREATE OR REPLACE FUNCTION public.analysis_beta_pool_effective_capacity_snapshot()
RETURNS TABLE (
    credential_slot TEXT,
    observed_at TIMESTAMP WITH TIME ZONE,
    effective_capacity_usd NUMERIC
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT snapshot.credential_slot,
           snapshot.observed_at,
           snapshot.monthly_limit_usd - snapshot.monthly_usage_usd
             - COALESCE(held.usd, 0::NUMERIC)
             - COALESCE(debit.usd, 0::NUMERIC) AS effective_capacity_usd
    FROM public.analysis_apify_credit_snapshots AS snapshot
    LEFT JOIN LATERAL (
        SELECT COALESCE(pg_catalog.sum(reservation.reserved_usd), 0::NUMERIC) AS usd
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.credential_slot = snapshot.credential_slot
          AND reservation.lifecycle_state IN ('preflight_held', 'active')
    ) AS held ON TRUE
    LEFT JOIN LATERAL (
        SELECT COALESCE(pg_catalog.sum(item.usd), 0::NUMERIC) AS usd
        FROM (
            SELECT reservation.actual_usd AS usd
            FROM public.analysis_beta_pool_reservations AS reservation
            WHERE reservation.credential_slot = snapshot.credential_slot
              AND reservation.lifecycle_state = 'settled'
              AND reservation.actual_usd > 0
              AND reservation.reconciliation_watermark >= snapshot.observed_at
            UNION ALL
            SELECT local_debit.actual_usd
            FROM public.analysis_beta_pool_local_debits AS local_debit
            WHERE local_debit.credential_slot = snapshot.credential_slot
              AND local_debit.reconciliation_watermark >= snapshot.observed_at
            UNION ALL
            SELECT archive.unabsorbed_debit_usd
            FROM public.analysis_beta_pool_reservation_archive AS archive
            WHERE archive.credential_slot = snapshot.credential_slot
              AND (archive.archive_state = 'ambiguous_held'
                   OR archive.reconciliation_watermark >= snapshot.observed_at)
        ) AS item
    ) AS debit ON TRUE;
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_pool_effective_capacity_snapshot()
    FROM PUBLIC, anon, authenticated, service_role;

-- Keep the legacy definitions private.  The public wrappers below retain all
-- existing validation/replay behaviour, add an authoritative debit-aware
-- precheck, and rely on the shared final trigger fence for concurrent writes.
ALTER FUNCTION public.hold_analysis_beta_apify_preflight_credit(UUID, UUID, TEXT, NUMERIC, INTEGER)
    RENAME TO hold_analysis_beta_apify_preflight_credit_pre_capacity_hardening;
ALTER FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER)
    RENAME TO activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening;

CREATE OR REPLACE FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    p_preflight_id UUID, p_user_id UUID, p_credential_slot TEXT,
    p_target_profile_budget_usd NUMERIC, p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
DECLARE v_capacity NUMERIC; DECLARE v_existing UUID;
BEGIN
    -- Preserve the predecessor's idempotency branch before a capacity refresh.
    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    SELECT preflight.id INTO v_existing FROM public.analysis_preflights AS preflight
      WHERE preflight.id = p_preflight_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.analysis_beta_pool_allocations AS allocation
       WHERE allocation.preflight_id = p_preflight_id) THEN
      RETURN public.hold_analysis_beta_apify_preflight_credit_pre_capacity_hardening(
        p_preflight_id,p_user_id,p_credential_slot,p_target_profile_budget_usd,p_max_snapshot_age_seconds);
    END IF;
    -- Canonical snapshot lock and fresh effective formula.  Invalid inputs and
    -- lifecycle predicates are still authoritatively validated by the exact
    -- predecessor implementation immediately below.
    FOR v_snapshot IN SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
      ORDER BY CASE snapshot.credential_slot WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
        WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4 WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6 END
      FOR UPDATE LOOP END LOOP;
    SELECT capacity.effective_capacity_usd INTO v_capacity
      FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
      WHERE capacity.credential_slot = p_credential_slot;
    IF v_capacity IS NOT NULL AND p_target_profile_budget_usd IS NOT NULL
       AND v_capacity < p_target_profile_budget_usd THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    RETURN public.hold_analysis_beta_apify_preflight_credit_pre_capacity_hardening(
      p_preflight_id,p_user_id,p_credential_slot,p_target_profile_budget_usd,p_max_snapshot_age_seconds);
END; $$;
REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(UUID, UUID, TEXT, NUMERIC, INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(UUID, UUID, TEXT, NUMERIC, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit_pre_capacity_hardening(UUID, UUID, TEXT, NUMERIC, INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(
    p_preflight_id UUID, p_request_id UUID, p_user_id UUID, p_selected_plan_id TEXT,
    p_operation_slot_map JSONB, p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
DECLARE v_proposed RECORD; DECLARE v_capacity NUMERIC; DECLARE v_state TEXT;
BEGIN
    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    PERFORM preflight.id FROM public.analysis_preflights AS preflight WHERE preflight.id = p_preflight_id FOR UPDATE;
    SELECT allocation.lifecycle_state INTO v_state FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.preflight_id = p_preflight_id FOR UPDATE;
    IF v_state = 'active' THEN
      RETURN public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(
       p_preflight_id,p_request_id,p_user_id,p_selected_plan_id,p_operation_slot_map,p_operation_budget_map,p_max_snapshot_age_seconds);
    END IF;
    FOR v_snapshot IN SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
      ORDER BY CASE snapshot.credential_slot WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
        WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4 WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6 END
      FOR UPDATE LOOP END LOOP;
    IF p_operation_slot_map IS NOT NULL AND p_operation_budget_map IS NOT NULL THEN
      FOR v_proposed IN SELECT slot_entry.slot_value AS credential_slot,
          pg_catalog.sum((p_operation_budget_map->>slot_entry.operation_family)::NUMERIC) AS proposed_usd
        FROM pg_catalog.jsonb_each_text(p_operation_slot_map) AS slot_entry(operation_family,slot_value)
        WHERE slot_entry.operation_family <> 'target-profile'
        GROUP BY slot_entry.slot_value
      LOOP
        SELECT capacity.effective_capacity_usd INTO v_capacity
          FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
          WHERE capacity.credential_slot = v_proposed.credential_slot;
        IF v_capacity IS NOT NULL AND v_capacity < v_proposed.proposed_usd THEN
          RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
    RETURN public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(
      p_preflight_id,p_request_id,p_user_id,p_selected_plan_id,p_operation_slot_map,p_operation_budget_map,p_max_snapshot_age_seconds);
END; $$;
REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;

-- Recreate the latest 2B2 policy-binding entry point as well.  Its complete
-- predecessor checks remain unchanged; its unbound allocation stage above is
-- now the debit-aware, snapshot-consistent implementation.
CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit(
    p_preflight_id UUID, p_request_id UUID, p_user_id UUID, p_selected_plan_id TEXT,
    p_operation_slot_map JSONB, p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_before public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_active public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_request public.analysis_requests%ROWTYPE;
DECLARE v_existing public.analysis_v2_provider_execution_policies%ROWTYPE;
DECLARE v_policy_hash TEXT; DECLARE v_result JSONB;
BEGIN
    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
      WHERE preflight.id = p_preflight_id FOR UPDATE;
    SELECT allocation.* INTO v_before FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.preflight_id = p_preflight_id FOR UPDATE;
    v_result := public.activate_analysis_beta_apify_request_credit_unbound(
      p_preflight_id,p_request_id,p_user_id,p_selected_plan_id,p_operation_slot_map,p_operation_budget_map,p_max_snapshot_age_seconds);
    SELECT allocation.* INTO v_active FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.preflight_id = p_preflight_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request FROM public.analysis_requests AS analysis_request
      WHERE analysis_request.id = p_request_id FOR UPDATE;
    v_policy_hash := public.analysis_beta_provider_policy_hash(pg_catalog.lower(v_request.target_instagram_id),p_operation_slot_map);
    SELECT policy.* INTO v_existing FROM public.analysis_v2_provider_execution_policies AS policy
      WHERE policy.request_id = p_request_id FOR UPDATE;
    IF v_before.lifecycle_state = 'active' THEN
      IF NOT FOUND OR v_existing.mode IS DISTINCT FROM 'betatest_free_pool'
        OR v_existing.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
        OR v_existing.entitlement_jti_hash IS NOT NULL
        OR v_existing.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
        OR v_existing.operation_slot_map IS DISTINCT FROM p_operation_slot_map
        OR v_existing.policy_hash IS DISTINCT FROM v_policy_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001';
      END IF;
      RETURN v_result;
    END IF;
    IF FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001'; END IF;
    IF v_active.lifecycle_state IS DISTINCT FROM 'active' OR v_active.request_id IS DISTINCT FROM p_request_id
      OR v_active.operation_slot_map IS DISTINCT FROM p_operation_slot_map
      OR v_request.analysis_entry_channel IS DISTINCT FROM 'betatest' THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.analysis_v2_provider_execution_policies(
      request_id,mode,policy_version,entitlement_jti_hash,target_instagram_id,operation_slot_map,policy_hash
    ) VALUES (p_request_id,'betatest_free_pool','betatest-free-pool-v1',NULL,
      pg_catalog.lower(v_request.target_instagram_id),p_operation_slot_map,v_policy_hash);
    RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit(UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_analysis_beta_apify_request_credit(UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_analysis_beta_pool_reservation_headroom()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
DECLARE v_capacity NUMERIC; DECLARE v_locked INTEGER := 0;
BEGIN
    FOR v_snapshot IN SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
      ORDER BY CASE snapshot.credential_slot WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
        WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4 WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6 END
      FOR UPDATE LOOP v_locked := v_locked + 1; END LOOP;
    IF v_locked <> 6 THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001'; END IF;
    SELECT snapshot.* INTO v_snapshot FROM public.analysis_apify_credit_snapshots AS snapshot WHERE snapshot.credential_slot = NEW.credential_slot;
    SELECT capacity.effective_capacity_usd INTO v_capacity FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
      WHERE capacity.credential_slot = NEW.credential_slot;
    -- This is a BEFORE INSERT trigger, so the effective snapshot contains
    -- existing state only.  Charge NEW exactly once at this final concurrent
    -- fence instead of merely rejecting already-negative capacity.
    IF v_snapshot.health_state <> 'healthy' OR v_snapshot.observed_at IS NULL
       OR v_capacity < NEW.reserved_usd THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_analysis_beta_pool_reservation_headroom() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(
 p_limit INTEGER DEFAULT 100
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id UUID; DECLARE v_count INTEGER := 0; DECLARE v_state TEXT;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001'; END IF;
 FOR v_id IN SELECT allocation.id FROM public.analysis_beta_pool_allocations AS allocation
   JOIN public.users AS users ON users.id = allocation.user_id
   LEFT JOIN public.analysis_requests AS request ON request.id = allocation.request_id
   LEFT JOIN public.analysis_preflights AS preflight ON preflight.id = allocation.preflight_id
   WHERE allocation.lifecycle_state = 'settled'
      OR (allocation.lifecycle_state = 'active' AND request.status IN ('completed','failed'))
      OR (allocation.lifecycle_state = 'preflight_held' AND (preflight.expires_at <= pg_catalog.clock_timestamp() OR preflight.status IN ('blocked','expired')))
   ORDER BY allocation.updated_at, allocation.id LIMIT p_limit FOR UPDATE OF users SKIP LOCKED
 LOOP
   PERFORM public.settle_analysis_beta_apify_credit_allocation(v_id, 'recovery');
   SELECT lifecycle_state INTO v_state FROM public.analysis_beta_pool_allocations WHERE id = v_id FOR UPDATE;
   IF EXISTS (
     SELECT 1 FROM public.analysis_beta_pool_reservations AS reservation
     JOIN public.analysis_beta_pool_reservation_archive AS archive
       ON archive.allocation_id = reservation.allocation_id AND archive.operation_family = reservation.operation_family
     WHERE reservation.allocation_id = v_id AND (
       archive.credential_slot IS DISTINCT FROM reservation.credential_slot OR
       archive.reserved_usd IS DISTINCT FROM reservation.reserved_usd OR
       archive.actual_usd IS DISTINCT FROM reservation.actual_usd OR
       archive.released_usd IS DISTINCT FROM reservation.released_usd OR
       archive.reconciliation_watermark IS DISTINCT FROM reservation.reconciliation_watermark OR
       archive.settled_at IS DISTINCT FROM COALESCE(reservation.settled_at,reservation.updated_at) OR
       archive.settlement_reason IS DISTINCT FROM COALESCE(reservation.settlement_reason,'retention_ambiguous') OR
       archive.archive_state IS DISTINCT FROM CASE WHEN reservation.lifecycle_state = 'settled' THEN 'settled' ELSE 'ambiguous_held' END OR
       archive.unabsorbed_debit_usd IS DISTINCT FROM CASE WHEN reservation.lifecycle_state = 'settled' THEN reservation.actual_usd ELSE reservation.reserved_usd END
     )
   ) THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_ARCHIVE_CONFLICT', ERRCODE = 'P0001'; END IF;
   INSERT INTO public.analysis_beta_pool_reservation_archive(
     allocation_id,operation_family,credential_slot,reserved_usd,actual_usd,released_usd,reconciliation_watermark,settled_at,settlement_reason,archive_state,unabsorbed_debit_usd
   ) SELECT reservation.allocation_id,reservation.operation_family,reservation.credential_slot,reservation.reserved_usd,reservation.actual_usd,reservation.released_usd,reservation.reconciliation_watermark,COALESCE(reservation.settled_at,reservation.updated_at),COALESCE(reservation.settlement_reason,'retention_ambiguous'),CASE WHEN reservation.lifecycle_state = 'settled' THEN 'settled' ELSE 'ambiguous_held' END,CASE WHEN reservation.lifecycle_state = 'settled' THEN reservation.actual_usd ELSE reservation.reserved_usd END
     FROM public.analysis_beta_pool_reservations AS reservation
     WHERE reservation.allocation_id = v_id AND NOT EXISTS (
       SELECT 1 FROM public.analysis_beta_pool_reservation_archive AS archive
       WHERE archive.allocation_id = reservation.allocation_id AND archive.operation_family = reservation.operation_family
     );
   DELETE FROM public.analysis_beta_pool_allocations WHERE id = v_id;
   v_count := v_count + 1;
 END LOOP;
 RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;
COMMIT;
