-- Terminal beta-credit settlement is deliberately a post-commit worker action.
-- Do not call it from request/preflight terminal triggers: admission and terminal
-- transactions have different ownership and combining them would invert locks.
DO $migration_transaction_fence$
BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM pg_catalog.set_config('statement_timeout', '2min', true);
END;
$migration_transaction_fence$;

CREATE OR REPLACE FUNCTION public.settle_analysis_beta_apify_credit_allocation(
    p_allocation_id UUID, p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
-- A caller-side abort also bounds the already-started top-level statement.
SET statement_timeout = '5s'
AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_request public.analysis_requests%ROWTYPE;
DECLARE v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_actual NUMERIC; DECLARE v_watermark TIMESTAMP WITH TIME ZONE;
DECLARE v_safe BOOLEAN; DECLARE v_settled_count INTEGER := 0;
DECLARE v_held_count INTEGER := 0; DECLARE v_actual_total NUMERIC := 0;
DECLARE v_released_total NUMERIC := 0;
BEGIN
 IF p_allocation_id IS NULL OR p_reason NOT IN ('request_terminal','preflight_expired','recovery') THEN
  RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001'; END IF;
 -- Canonical order is user -> preflight -> request -> allocation -> family.
 SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations allocation WHERE allocation.id = p_allocation_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_NOT_FOUND', ERRCODE = 'P0001'; END IF;
 PERFORM users.id FROM public.users users WHERE users.id = v_allocation.user_id FOR KEY SHARE;
 SELECT preflight.* INTO v_preflight FROM public.analysis_preflights preflight WHERE preflight.id = v_allocation.preflight_id FOR UPDATE;
 IF v_allocation.request_id IS NOT NULL THEN SELECT request.* INTO v_request FROM public.analysis_requests request WHERE request.id = v_allocation.request_id FOR UPDATE; END IF;
 SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations allocation WHERE allocation.id = p_allocation_id FOR UPDATE;
 IF v_allocation.lifecycle_state = 'settled' THEN RETURN pg_catalog.jsonb_build_object('allocationId',v_allocation.id,'lifecycleState','settled','settledFamilies',0,'heldFamilies',0,'actualUsd',0,'releasedUsd',0); END IF;
 IF (v_allocation.lifecycle_state = 'active' AND (v_request.id IS NULL OR v_request.status NOT IN ('completed','failed')))
    OR (v_allocation.lifecycle_state = 'preflight_held' AND (v_preflight.id IS NULL OR (v_preflight.expires_at > v_now AND v_preflight.status NOT IN ('blocked','expired')))) THEN
   RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_NOT_TERMINAL', ERRCODE = 'P0001'; END IF;
 FOR v_reservation IN SELECT reservation.* FROM public.analysis_beta_pool_reservations reservation WHERE reservation.allocation_id = v_allocation.id ORDER BY reservation.operation_family FOR UPDATE LOOP
  IF v_reservation.lifecycle_state = 'settled' THEN CONTINUE; END IF;
  v_actual := 0; v_watermark := NULL; v_safe := TRUE;
  IF v_reservation.operation_family = 'target-profile' THEN
   SELECT COALESCE(pg_catalog.bool_and(provider_run.status = 'rejected' OR (provider_run.status IN ('succeeded','failed','aborted','timed_out','resolved_no_run') AND provider_run.actual_usage_usd IS NOT NULL AND provider_run.usage_reconciled_at IS NOT NULL)), TRUE),
          COALESCE(pg_catalog.sum(CASE WHEN provider_run.status = 'rejected' THEN 0::NUMERIC ELSE provider_run.actual_usage_usd END),0::NUMERIC),
          pg_catalog.max(CASE WHEN provider_run.status = 'rejected' THEN NULL ELSE provider_run.usage_reconciled_at END)
     INTO v_safe,v_actual,v_watermark FROM public.analysis_preflight_provider_runs provider_run
    WHERE provider_run.preflight_id = v_allocation.preflight_id AND (provider_run.operation_key = 'target-profile-fallback' OR provider_run.operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$');
  ELSE
   SELECT COALESCE(pg_catalog.bool_and(provider_run.status = 'rejected' OR (provider_run.status IN ('succeeded','failed','aborted','timed_out') AND provider_run.actual_usage_usd IS NOT NULL AND provider_run.usage_reconciled_at IS NOT NULL)), TRUE),
          COALESCE(pg_catalog.sum(CASE WHEN provider_run.status = 'rejected' THEN 0::NUMERIC ELSE provider_run.actual_usage_usd END),0::NUMERIC),
          pg_catalog.max(CASE WHEN provider_run.status = 'rejected' THEN NULL ELSE provider_run.usage_reconciled_at END)
     INTO v_safe,v_actual,v_watermark FROM public.analysis_v2_provider_runs provider_run
    WHERE provider_run.request_id = v_allocation.request_id AND pg_catalog.split_part(provider_run.operation_key,':',1) = v_reservation.operation_family;
  END IF;
  IF NOT v_safe THEN v_held_count := v_held_count + 1; CONTINUE; END IF;
  IF v_actual > v_reservation.reserved_usd THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_ACTUAL_EXCEEDS_RESERVATION', ERRCODE = 'P0001'; END IF;
  UPDATE public.analysis_beta_pool_reservations reservation SET lifecycle_state='settled',actual_usd=v_actual,released_usd=reservation.reserved_usd-v_actual,reconciliation_watermark=v_watermark,settled_at=v_now,settlement_reason=p_reason,updated_at=v_now WHERE reservation.allocation_id=v_allocation.id AND reservation.operation_family=v_reservation.operation_family;
  v_settled_count:=v_settled_count+1; v_actual_total:=v_actual_total+v_actual; v_released_total:=v_released_total+(v_reservation.reserved_usd-v_actual);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM public.analysis_beta_pool_reservations reservation WHERE reservation.allocation_id=v_allocation.id AND reservation.lifecycle_state <> 'settled') THEN
  UPDATE public.analysis_beta_pool_allocations allocation SET lifecycle_state='settled',settled_at=v_now,settlement_reason=p_reason,updated_at=v_now WHERE allocation.id=v_allocation.id; v_allocation.lifecycle_state:='settled'; END IF;
 RETURN pg_catalog.jsonb_build_object('allocationId',v_allocation.id,'lifecycleState',v_allocation.lifecycle_state,'settledFamilies',v_settled_count,'heldFamilies',v_held_count,'actualUsd',v_actual_total,'releasedUsd',v_released_total);
END; $$;
REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_credit_allocation(UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_beta_apify_credit_allocation(UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.settle_analysis_beta_apify_request_credit(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '1s' SET statement_timeout = '5s' AS $$
DECLARE v_id UUID; BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE='P0001'; END IF;
 -- Plain identity read; canonical primitive owns all lifecycle locks.
 SELECT allocation.id INTO v_id FROM public.analysis_beta_pool_allocations allocation JOIN public.analysis_requests request ON request.id=allocation.request_id
  WHERE allocation.request_id=p_request_id AND allocation.lifecycle_state='active' AND request.status IN ('completed','failed') LIMIT 1;
 IF v_id IS NULL THEN RETURN NULL; END IF;
 RETURN public.settle_analysis_beta_apify_credit_allocation(v_id,'request_terminal');
END; $$;
CREATE OR REPLACE FUNCTION public.settle_analysis_beta_apify_preflight_credit(p_preflight_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '1s' SET statement_timeout = '5s' AS $$
DECLARE v_id UUID; BEGIN
 IF p_preflight_id IS NULL THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE='P0001'; END IF;
 -- Ready/consumed and soft admission blocks do not meet this terminal predicate.
 SELECT allocation.id INTO v_id FROM public.analysis_beta_pool_allocations allocation JOIN public.analysis_preflights preflight ON preflight.id=allocation.preflight_id
  WHERE allocation.preflight_id=p_preflight_id AND allocation.lifecycle_state='preflight_held'
   AND (preflight.status IN ('blocked','expired') OR preflight.expires_at <= pg_catalog.clock_timestamp()) LIMIT 1;
 IF v_id IS NULL THEN RETURN NULL; END IF;
 RETURN public.settle_analysis_beta_apify_credit_allocation(v_id,'preflight_expired');
END; $$;
REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_request_credit(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_preflight_credit(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_beta_apify_request_credit(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_beta_apify_preflight_credit(UUID) TO service_role;

-- Automatic retention only archives fully-settled allocations.  Ambiguous starts
-- remain recoverable holds until provider reconciliation can prove their charge.
CREATE OR REPLACE FUNCTION public.archive_fully_settled_analysis_beta_apify_credit_allocations(p_limit INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '1s' SET statement_timeout = '5s' AS $$
DECLARE v_id UUID; DECLARE v_count INTEGER:=0; BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE='P0001'; END IF;
 FOR v_id IN SELECT allocation.id FROM public.analysis_beta_pool_allocations allocation JOIN public.users users ON users.id=allocation.user_id
  -- Preserve the short idempotent terminal replay window. Capacity was already
  -- released by settlement; archival itself is deliberately not urgent.
  WHERE allocation.lifecycle_state='settled' AND allocation.settled_at <= pg_catalog.clock_timestamp() - INTERVAL '1 hour' ORDER BY allocation.updated_at,allocation.id LIMIT p_limit FOR UPDATE OF users SKIP LOCKED LOOP
  BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.analysis_beta_pool_reservations reservation WHERE reservation.allocation_id=v_id) <> 8
     OR EXISTS (SELECT 1 FROM public.analysis_beta_pool_reservations reservation WHERE reservation.allocation_id=v_id AND reservation.lifecycle_state <> 'settled') THEN
    RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_POOL_ARCHIVE_CONFLICT', ERRCODE='P0001';
  END IF;
  INSERT INTO public.analysis_beta_pool_reservation_archive(allocation_id,operation_family,credential_slot,reserved_usd,actual_usd,released_usd,reconciliation_watermark,settled_at,settlement_reason,archive_state,unabsorbed_debit_usd)
   SELECT reservation.allocation_id,reservation.operation_family,reservation.credential_slot,reservation.reserved_usd,reservation.actual_usd,reservation.released_usd,reservation.reconciliation_watermark,reservation.settled_at,reservation.settlement_reason,'settled',reservation.actual_usd FROM public.analysis_beta_pool_reservations reservation WHERE reservation.allocation_id=v_id
   ON CONFLICT (allocation_id,operation_family) DO NOTHING;
  IF (SELECT pg_catalog.count(*) FROM public.analysis_beta_pool_reservation_archive archive WHERE archive.allocation_id=v_id) <> 8
     OR EXISTS (SELECT 1 FROM public.analysis_beta_pool_reservations reservation LEFT JOIN public.analysis_beta_pool_reservation_archive archive ON archive.allocation_id=reservation.allocation_id AND archive.operation_family=reservation.operation_family WHERE reservation.allocation_id=v_id AND (archive.operation_family IS NULL OR archive.credential_slot IS DISTINCT FROM reservation.credential_slot OR archive.reserved_usd IS DISTINCT FROM reservation.reserved_usd OR archive.actual_usd IS DISTINCT FROM reservation.actual_usd OR archive.released_usd IS DISTINCT FROM reservation.released_usd OR archive.reconciliation_watermark IS DISTINCT FROM reservation.reconciliation_watermark OR archive.settled_at IS DISTINCT FROM reservation.settled_at OR archive.settlement_reason IS DISTINCT FROM reservation.settlement_reason OR archive.archive_state <> 'settled' OR archive.unabsorbed_debit_usd IS DISTINCT FROM reservation.actual_usd)) THEN
    RAISE EXCEPTION USING MESSAGE='ANALYSIS_BETA_POOL_ARCHIVE_CONFLICT', ERRCODE='P0001';
  END IF;
  DELETE FROM public.analysis_beta_pool_allocations allocation WHERE allocation.id=v_id; v_count:=v_count+1;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    -- Corrupt/partial immutable history stays live for explicit operator repair;
    -- the exception subtransaction rolls back any attempted archive inserts.
    NULL;
  END;
 END LOOP; RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.archive_fully_settled_analysis_beta_apify_credit_allocations(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_fully_settled_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;
CREATE OR REPLACE FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(p_limit INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE sql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '1s' SET statement_timeout = '5s'
AS $$ SELECT public.archive_fully_settled_analysis_beta_apify_credit_allocations(p_limit) $$;
REVOKE ALL ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;

-- Keep normal expired retention moving when a beta allocation still owns the row.
CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
SET statement_timeout = '5s'
AS $$
DECLARE
    v_scrubbed_count INTEGER;
    v_deleted_count INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;
    WITH expired AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status <> 'consumed'
          AND preflight.expires_at <= pg_catalog.clock_timestamp()
          AND preflight.pii_scrubbed_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
                AND earlybird_order.status IN (
                    'payment_pending', 'cancelled', 'paid',
                    'analysis_in_progress', 'completed'
                )
          )
        ORDER BY preflight.expires_at, preflight.id
        LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
        ),
        target_full_name = NULL, target_bio = NULL,
        target_profile_image_url = NULL, target_followers_count = NULL,
        target_following_count = NULL, target_is_private = NULL,
        capacity_required_plan_id = NULL, required_plan_id = NULL,
        plan_cards_snapshot = NULL, error_code = NULL, blocked_at = NULL,
        ready_at = NULL, exclusion_decision = 'skip',
        excluded_instagram_id = NULL, lease_token = NULL,
        lease_expires_at = NULL, pii_scrubbed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    FROM expired WHERE preflight.id = expired.id;
    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

    WITH deletable AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status = 'expired'
          AND preflight.created_at <= pg_catalog.clock_timestamp() - INTERVAL '1 hour'
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_preflight_provider_runs AS provider_run
              WHERE provider_run.preflight_id = preflight.id
                AND provider_run.status <> 'rejected'
                AND (
                    provider_run.status NOT IN (
                        'succeeded', 'failed', 'aborted', 'timed_out',
                        'resolved_no_run'
                    )
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_waitlist AS waitlist_entry
              WHERE waitlist_entry.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_schema_failure_recoveries AS recovery
              WHERE recovery.recovery_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_replay_capture_authorizations
                  AS capture_authorization
              WHERE capture_authorization.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_adoption_policy_failure_rearms
                  AS adoption_rearm
              WHERE adoption_rearm.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_terminal_unavailable_exhaustion_rearms
                  AS exhaustion_rearm
              WHERE exhaustion_rearm.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_beta_pool_allocations AS allocation
              WHERE allocation.preflight_id = preflight.id
          )
        ORDER BY preflight.created_at, preflight.id
        LIMIT p_limit FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_preflights AS preflight
    USING deletable WHERE preflight.id = deletable.id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_scrubbed_count + v_deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER) TO service_role;

-- Recovery is defined by Task 2B3 and remains the live implementation. Attach
-- invocation-time bounds here as part of the terminal handoff correction.
ALTER FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER)
    SET lock_timeout TO '1s';
ALTER FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER)
    SET statement_timeout TO '5s';
