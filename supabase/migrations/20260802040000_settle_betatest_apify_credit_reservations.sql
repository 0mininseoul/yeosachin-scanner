-- Betatest free-credit terminal settlement and bounded recovery (Task 2B3).
--
-- A settled family releases its unused reservation immediately.  Its actual
-- spend remains a local debit until a provider observation is *strictly*
-- newer than the ledger reconciliation watermark.  Equality is deliberately
-- not enough: an observation at the same time may have been read before the
-- provider incorporated the charge.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_beta_pool_allocations
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_allocations_lifecycle_check,
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_allocations_state_check,
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_allocations_preflight_id_fkey,
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_allocations_request_id_fkey,
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_allocations_user_id_fkey;

ALTER TABLE public.analysis_beta_pool_allocations
    ALTER COLUMN preflight_id DROP NOT NULL,
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN settled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN settlement_reason TEXT,
    ADD CONSTRAINT analysis_beta_pool_allocations_preflight_id_fkey
        FOREIGN KEY (preflight_id) REFERENCES public.analysis_preflights(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT analysis_beta_pool_allocations_request_id_fkey
        FOREIGN KEY (request_id) REFERENCES public.analysis_requests(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT analysis_beta_pool_allocations_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT analysis_beta_pool_allocations_lifecycle_check CHECK (
        lifecycle_state IN ('preflight_held', 'active', 'settled')
    ),
    ADD CONSTRAINT analysis_beta_pool_allocations_state_check CHECK (
        (lifecycle_state = 'preflight_held'
            AND preflight_id IS NOT NULL AND user_id IS NOT NULL
            AND request_id IS NULL AND selected_plan_id IS NULL
            AND operation_slot_map IS NULL AND operation_budget_map IS NULL
            AND activated_at IS NULL)
        OR
        (lifecycle_state = 'active'
            AND preflight_id IS NOT NULL AND request_id IS NOT NULL
            AND user_id IS NOT NULL AND selected_plan_id IN ('basic', 'standard', 'plus')
            AND public.analysis_beta_valid_operation_slot_map(operation_slot_map)
            AND public.analysis_beta_valid_operation_budget_map(operation_budget_map)
            AND activated_at IS NOT NULL)
        OR (lifecycle_state = 'settled'
            AND settled_at IS NOT NULL
            AND settlement_reason IN ('request_terminal', 'preflight_expired', 'recovery'))
    );

ALTER TABLE public.analysis_beta_pool_reservations
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_reservations_allocation_id_lifecycle_state_fkey,
    -- PostgreSQL truncates the historic unnamed composite FK at NAMEDATALEN.
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_reservatio_allocation_id_lifecycle_stat_fkey,
    DROP CONSTRAINT IF EXISTS analysis_beta_pool_reservations_lifecycle_check,
    ADD COLUMN actual_usd NUMERIC(18, 12) NOT NULL DEFAULT 0,
    ADD COLUMN released_usd NUMERIC(18, 12) NOT NULL DEFAULT 0,
    ADD COLUMN reconciliation_watermark TIMESTAMP WITH TIME ZONE,
    ADD COLUMN settled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN settlement_reason TEXT,
    ADD CONSTRAINT analysis_beta_pool_reservations_allocation_id_fkey
        FOREIGN KEY (allocation_id) REFERENCES public.analysis_beta_pool_allocations(id)
        ON DELETE CASCADE,
    ADD CONSTRAINT analysis_beta_pool_reservations_lifecycle_check CHECK (
        lifecycle_state IN ('preflight_held', 'active', 'settled')
    ),
    ADD CONSTRAINT analysis_beta_pool_reservations_settlement_check CHECK (
        (lifecycle_state IN ('preflight_held', 'active')
            AND actual_usd = 0 AND released_usd = 0
            AND reconciliation_watermark IS NULL AND settled_at IS NULL
            AND settlement_reason IS NULL)
        OR
        (lifecycle_state = 'settled'
            AND actual_usd BETWEEN 0 AND reserved_usd
            AND released_usd = reserved_usd - actual_usd
            AND settled_at IS NOT NULL
            AND settlement_reason IN ('request_terminal', 'preflight_expired', 'recovery')
            AND (actual_usd = 0 OR reconciliation_watermark IS NOT NULL))
    );

CREATE INDEX idx_analysis_beta_pool_reservations_settlement
    ON public.analysis_beta_pool_reservations(
        credential_slot, lifecycle_state, reconciliation_watermark
    );

CREATE TABLE public.analysis_beta_pool_local_debits (
    debit_identity UUID PRIMARY KEY,
    credential_slot TEXT NOT NULL CHECK (
        public.analysis_beta_valid_apify_credential_slot(credential_slot)
    ),
    actual_usd NUMERIC(18, 12) NOT NULL CHECK (
        actual_usd > 0 AND actual_usd <= 1000
        AND actual_usd = pg_catalog.round(actual_usd, 12)
    ),
    reconciliation_watermark TIMESTAMP WITH TIME ZONE NOT NULL,
    archived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.analysis_beta_pool_local_debits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_pool_local_debits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_pool_local_debits
    FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.analysis_beta_pool_local_debits IS
    'PII-free archived settled debit. Deleted only after a strictly newer provider observation.';

CREATE OR REPLACE FUNCTION public.retire_analysis_beta_pool_local_debits_after_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- An equal timestamp is intentionally retained: the observation can be
    -- concurrent with the provider-side reconciliation rather than after it.
    DELETE FROM public.analysis_beta_pool_local_debits AS debit
    WHERE debit.credential_slot = NEW.credential_slot
      AND NEW.observed_at > debit.reconciliation_watermark;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.retire_analysis_beta_pool_local_debits_after_snapshot()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER retire_analysis_beta_pool_local_debits_after_snapshot
AFTER UPDATE OF observed_at ON public.analysis_apify_credit_snapshots
FOR EACH ROW EXECUTE FUNCTION public.retire_analysis_beta_pool_local_debits_after_snapshot();

CREATE OR REPLACE FUNCTION public.analysis_beta_pool_effective_local_debit_usd(
    p_credential_slot TEXT,
    p_observed_at TIMESTAMP WITH TIME ZONE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT COALESCE(pg_catalog.sum(debit.actual_usd), 0::NUMERIC)
    FROM (
        SELECT reservation.credential_slot, reservation.actual_usd,
               reservation.reconciliation_watermark
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.lifecycle_state = 'settled'
          AND reservation.actual_usd > 0
        UNION ALL
        SELECT archived.credential_slot, archived.actual_usd,
               archived.reconciliation_watermark
        FROM public.analysis_beta_pool_local_debits AS archived
    ) AS debit
    WHERE debit.credential_slot = p_credential_slot
      -- Strictly newer snapshot is the only safe retirement condition.
      AND debit.reconciliation_watermark >= p_observed_at;
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_pool_effective_local_debit_usd(TEXT, TIMESTAMP WITH TIME ZONE)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_credit_pool(
    p_max_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_result JSONB;
BEGIN
    IF p_max_age_seconds IS NULL OR p_max_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF (SELECT pg_catalog.count(*) FROM public.analysis_apify_credit_snapshots) <> 6
       OR (SELECT pg_catalog.count(DISTINCT observed_at) FROM public.analysis_apify_credit_snapshots) <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE health_state <> 'healthy' OR monthly_limit_usd IS NULL OR monthly_usage_usd IS NULL
           OR billing_cycle_start_at IS NULL OR billing_cycle_end_at IS NULL OR observed_at IS NULL) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE observed_at < v_now - pg_catalog.make_interval(secs => p_max_age_seconds)
           OR observed_at > v_now + INTERVAL '1 minute'
           OR billing_cycle_start_at > v_now OR billing_cycle_end_at <= v_now) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'credentialSlot', snapshot.credential_slot,
        'monthlyLimitUsd', snapshot.monthly_limit_usd,
        'monthlyUsageUsd', snapshot.monthly_usage_usd,
        'billingCycleStartAt', snapshot.billing_cycle_start_at,
        'billingCycleEndAt', snapshot.billing_cycle_end_at,
        'observedAt', snapshot.observed_at,
        'healthState', snapshot.health_state,
        'effectiveHeadroomUsd', GREATEST(
            snapshot.monthly_limit_usd - snapshot.monthly_usage_usd
            - COALESCE(held.reserved_usd, 0::NUMERIC)
            - public.analysis_beta_pool_effective_local_debit_usd(snapshot.credential_slot, snapshot.observed_at),
            0::NUMERIC)
    ) ORDER BY CASE snapshot.credential_slot WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
        WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4 WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6 END)
    INTO v_result
    FROM public.analysis_apify_credit_snapshots AS snapshot
    LEFT JOIN (
        SELECT reservation.credential_slot, pg_catalog.sum(reservation.reserved_usd) AS reserved_usd
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.lifecycle_state IN ('preflight_held', 'active')
          AND reservation.lifecycle_state <> 'settled'
        GROUP BY reservation.credential_slot
    ) AS held ON held.credential_slot = snapshot.credential_slot;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_analysis_beta_pool_reservation_headroom()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
DECLARE v_locked INTEGER := 0;
DECLARE v_held NUMERIC;
BEGIN
    -- This is the final admission fence. Existing hold/activation functions
    -- already lock these exact rows; repeat canonical locking keeps future
    -- callers safe without relying on application-level ordering.
    FOR v_snapshot IN SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
      ORDER BY CASE snapshot.credential_slot WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
          WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4 WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6 END
      FOR UPDATE LOOP v_locked := v_locked + 1; END LOOP;
    IF v_locked <> 6 THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001'; END IF;
    SELECT snapshot.* INTO v_snapshot FROM public.analysis_apify_credit_snapshots AS snapshot
      WHERE snapshot.credential_slot = NEW.credential_slot;
    SELECT COALESCE(pg_catalog.sum(reservation.reserved_usd), 0::NUMERIC) INTO v_held
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.credential_slot = NEW.credential_slot
      AND reservation.lifecycle_state IN ('preflight_held', 'active');
    IF v_snapshot.health_state <> 'healthy' OR v_snapshot.observed_at IS NULL
       OR v_snapshot.monthly_limit_usd - v_snapshot.monthly_usage_usd - v_held
          - public.analysis_beta_pool_effective_local_debit_usd(NEW.credential_slot, v_snapshot.observed_at)
          < NEW.reserved_usd THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_analysis_beta_pool_reservation_headroom()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_analysis_beta_pool_reservation_headroom
BEFORE INSERT ON public.analysis_beta_pool_reservations
FOR EACH ROW EXECUTE FUNCTION public.guard_analysis_beta_pool_reservation_headroom();

CREATE OR REPLACE FUNCTION public.settle_analysis_beta_apify_credit_allocation(
    p_allocation_id UUID, p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_request public.analysis_requests%ROWTYPE;
DECLARE v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_actual NUMERIC;
DECLARE v_watermark TIMESTAMP WITH TIME ZONE;
DECLARE v_safe BOOLEAN;
DECLARE v_settled_count INTEGER := 0;
DECLARE v_held_count INTEGER := 0;
DECLARE v_actual_total NUMERIC := 0;
DECLARE v_released_total NUMERIC := 0;
BEGIN
    IF p_allocation_id IS NULL OR p_reason NOT IN ('request_terminal', 'preflight_expired', 'recovery') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001';
    END IF;
    -- Canonical lifecycle lock order: user, preflight, request, allocation,
    -- then family rows ordered by their primary key.
    SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.id = p_allocation_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_NOT_FOUND', ERRCODE = 'P0001'; END IF;
    IF v_allocation.user_id IS NOT NULL THEN
      PERFORM users.id FROM public.users AS users WHERE users.id = v_allocation.user_id FOR KEY SHARE;
    END IF;
    IF v_allocation.preflight_id IS NOT NULL THEN
      SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
        WHERE preflight.id = v_allocation.preflight_id FOR UPDATE;
    END IF;
    IF v_allocation.request_id IS NOT NULL THEN
      SELECT request.* INTO v_request FROM public.analysis_requests AS request
        WHERE request.id = v_allocation.request_id FOR UPDATE;
    END IF;
    SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.id = p_allocation_id FOR UPDATE;
    IF v_allocation.lifecycle_state = 'settled' THEN
      RETURN pg_catalog.jsonb_build_object('allocationId', v_allocation.id, 'lifecycleState', 'settled',
        'settledFamilies', 0, 'heldFamilies', 0, 'actualUsd', 0, 'releasedUsd', 0);
    END IF;
    IF (v_allocation.lifecycle_state = 'active' AND (v_request.id IS NULL OR v_request.status NOT IN ('completed', 'failed')))
       OR (v_allocation.lifecycle_state = 'preflight_held' AND (
          v_preflight.id IS NULL OR (v_preflight.expires_at > v_now AND v_preflight.status NOT IN ('blocked', 'expired'))
       )) THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_NOT_TERMINAL', ERRCODE = 'P0001';
    END IF;
    FOR v_reservation IN SELECT reservation.* FROM public.analysis_beta_pool_reservations AS reservation
      WHERE reservation.allocation_id = v_allocation.id ORDER BY reservation.operation_family FOR UPDATE LOOP
      IF v_reservation.lifecycle_state = 'settled' THEN CONTINUE; END IF;
      v_actual := 0; v_watermark := NULL; v_safe := TRUE;
      IF v_reservation.operation_family = 'target-profile' THEN
        SELECT COALESCE(pg_catalog.bool_and(
                 provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out', 'resolved_no_run')
                 AND provider_run.actual_usage_usd IS NOT NULL
                 AND provider_run.usage_reconciled_at IS NOT NULL), TRUE),
               COALESCE(pg_catalog.sum(provider_run.actual_usage_usd), 0::NUMERIC),
               pg_catalog.max(provider_run.usage_reconciled_at)
        INTO v_safe, v_actual, v_watermark
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = v_allocation.preflight_id
          AND (provider_run.operation_key = 'target-profile-fallback'
               OR provider_run.operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$');
      ELSE
        SELECT COALESCE(pg_catalog.bool_and(
                 provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                 AND provider_run.actual_usage_usd IS NOT NULL
                 AND provider_run.usage_reconciled_at IS NOT NULL), TRUE),
               COALESCE(pg_catalog.sum(provider_run.actual_usage_usd), 0::NUMERIC),
               pg_catalog.max(provider_run.usage_reconciled_at)
        INTO v_safe, v_actual, v_watermark
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = v_allocation.request_id
          AND pg_catalog.split_part(provider_run.operation_key, ':', 1) = v_reservation.operation_family;
      END IF;
      IF NOT v_safe THEN v_held_count := v_held_count + 1; CONTINUE; END IF;
      IF v_actual > v_reservation.reserved_usd THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_ACTUAL_EXCEEDS_RESERVATION', ERRCODE = 'P0001';
      END IF;
      UPDATE public.analysis_beta_pool_reservations AS reservation
      SET lifecycle_state = 'settled', actual_usd = v_actual,
          released_usd = reservation.reserved_usd - v_actual,
          reconciliation_watermark = v_watermark, settled_at = v_now,
          settlement_reason = p_reason, updated_at = v_now
      WHERE reservation.allocation_id = v_allocation.id
        AND reservation.operation_family = v_reservation.operation_family;
      v_settled_count := v_settled_count + 1;
      v_actual_total := v_actual_total + v_actual;
      v_released_total := v_released_total + (v_reservation.reserved_usd - v_actual);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.analysis_beta_pool_reservations AS reservation
      WHERE reservation.allocation_id = v_allocation.id AND reservation.lifecycle_state <> 'settled') THEN
      UPDATE public.analysis_beta_pool_allocations AS allocation
      SET lifecycle_state = 'settled', settled_at = v_now,
          settlement_reason = p_reason, updated_at = v_now
      WHERE allocation.id = v_allocation.id;
      v_allocation.lifecycle_state := 'settled';
    END IF;
    RETURN pg_catalog.jsonb_build_object('allocationId', v_allocation.id,
      'lifecycleState', v_allocation.lifecycle_state, 'settledFamilies', v_settled_count,
      'heldFamilies', v_held_count, 'actualUsd', v_actual_total, 'releasedUsd', v_released_total);
END;
$$;
REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_credit_allocation(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_beta_apify_credit_allocation(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.recover_analysis_beta_apify_credit_allocations(
    p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_candidate UUID;
DECLARE v_result JSONB := '[]'::JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001';
    END IF;
    FOR v_candidate IN SELECT allocation.id FROM public.analysis_beta_pool_allocations AS allocation
      LEFT JOIN public.analysis_requests AS request ON request.id = allocation.request_id
      LEFT JOIN public.analysis_preflights AS preflight ON preflight.id = allocation.preflight_id
      WHERE (allocation.lifecycle_state = 'active' AND request.status IN ('completed', 'failed'))
         OR (allocation.lifecycle_state = 'preflight_held' AND (preflight.expires_at <= v_now OR preflight.status IN ('blocked', 'expired')))
      ORDER BY allocation.created_at, allocation.id LIMIT p_limit FOR UPDATE OF allocation SKIP LOCKED LOOP
      v_result := v_result || public.settle_analysis_beta_apify_credit_allocation(v_candidate, 'recovery');
    END LOOP;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_allocation UUID;
DECLARE v_count INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001';
    END IF;
    FOR v_allocation IN SELECT allocation.id FROM public.analysis_beta_pool_allocations AS allocation
      WHERE allocation.lifecycle_state = 'settled' ORDER BY allocation.updated_at, allocation.id
      LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
      INSERT INTO public.analysis_beta_pool_local_debits(
        debit_identity, credential_slot, actual_usd, reconciliation_watermark
      ) SELECT extensions.gen_random_uuid(), reservation.credential_slot, reservation.actual_usd,
          reservation.reconciliation_watermark
        FROM public.analysis_beta_pool_reservations AS reservation
        JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = reservation.credential_slot
        WHERE reservation.allocation_id = v_allocation AND reservation.actual_usd > 0
          AND reservation.reconciliation_watermark >= snapshot.observed_at;
      DELETE FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.id = v_allocation;
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;

COMMENT ON FUNCTION public.settle_analysis_beta_apify_credit_allocation(UUID, TEXT) IS
    'Service-only idempotent settlement. Ambiguous starts/running/unreconciled ledger rows retain their complete reservation.';
COMMENT ON FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER) IS
    'Bounded service-only terminal/expiry sweep using database time and SKIP LOCKED.';

-- Correction within this unapplied forward migration: parent deletion must not
-- silently detach live work.  Retention archives deterministic family history
-- first, then deletes the allocation; active/nonterminal rows keep RESTRICT
-- protection.  The temporary SET NULL declarations above are therefore never
-- externally observable and are replaced before this migration commits.
ALTER TABLE public.analysis_beta_pool_allocations
    DROP CONSTRAINT analysis_beta_pool_allocations_preflight_id_fkey,
    DROP CONSTRAINT analysis_beta_pool_allocations_request_id_fkey,
    DROP CONSTRAINT analysis_beta_pool_allocations_user_id_fkey,
    ALTER COLUMN preflight_id SET NOT NULL,
    ALTER COLUMN user_id SET NOT NULL,
    ADD CONSTRAINT analysis_beta_pool_allocations_preflight_id_fkey
        FOREIGN KEY (preflight_id) REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    ADD CONSTRAINT analysis_beta_pool_allocations_request_id_fkey
        FOREIGN KEY (request_id) REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    ADD CONSTRAINT analysis_beta_pool_allocations_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE TABLE public.analysis_beta_pool_reservation_archive (
    allocation_id UUID NOT NULL,
    operation_family TEXT NOT NULL,
    credential_slot TEXT NOT NULL CHECK (public.analysis_beta_valid_apify_credential_slot(credential_slot)),
    reserved_usd NUMERIC(18, 12) NOT NULL,
    actual_usd NUMERIC(18, 12) NOT NULL,
    released_usd NUMERIC(18, 12) NOT NULL,
    reconciliation_watermark TIMESTAMP WITH TIME ZONE,
    settled_at TIMESTAMP WITH TIME ZONE,
    settlement_reason TEXT NOT NULL,
    archive_state TEXT NOT NULL CHECK (archive_state IN ('settled', 'ambiguous_held')),
    unabsorbed_debit_usd NUMERIC(18, 12) NOT NULL,
    archived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (allocation_id, operation_family),
    CHECK (reserved_usd > 0 AND actual_usd BETWEEN 0 AND reserved_usd
       AND released_usd = reserved_usd - actual_usd),
    CHECK ((archive_state = 'settled' AND unabsorbed_debit_usd = actual_usd
            AND (actual_usd = 0 OR reconciliation_watermark IS NOT NULL))
        OR (archive_state = 'ambiguous_held' AND unabsorbed_debit_usd = reserved_usd
            AND actual_usd = 0 AND released_usd = 0 AND reconciliation_watermark IS NULL))
);
ALTER TABLE public.analysis_beta_pool_reservation_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_pool_reservation_archive FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_pool_reservation_archive FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.analysis_beta_pool_reservation_archive IS
    'Immutable PII-free deterministic allocation/family settlement history and local debit ledger. ambiguous_held is intentionally never snapshot-retired: after source-ledger retention it remains a full conservative debit until a separately reviewed, evidence-backed service remediation exists.';

CREATE OR REPLACE FUNCTION public.analysis_beta_pool_effective_local_debit_usd(
    p_credential_slot TEXT, p_observed_at TIMESTAMP WITH TIME ZONE
) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT COALESCE(pg_catalog.sum(debit.usd), 0::NUMERIC)
    FROM (
      SELECT reservation.credential_slot, reservation.actual_usd AS usd,
             reservation.reconciliation_watermark, 'settled'::TEXT AS state
      FROM public.analysis_beta_pool_reservations AS reservation
      WHERE reservation.lifecycle_state = 'settled' AND reservation.actual_usd > 0
      UNION ALL
      SELECT archive.credential_slot, archive.unabsorbed_debit_usd,
             archive.reconciliation_watermark, archive.archive_state
      FROM public.analysis_beta_pool_reservation_archive AS archive
    ) AS debit
    WHERE debit.credential_slot = p_credential_slot
      -- There is deliberately no synthetic post-retention watermark for an
      -- ambiguous start. A provider snapshot, even a much newer one, cannot
      -- prove the unknown charge was included, so only settled debit has the
      -- strict-newer retirement path.
      AND (debit.state = 'ambiguous_held'
        OR debit.reconciliation_watermark >= p_observed_at);
$$;
REVOKE ALL ON FUNCTION public.analysis_beta_pool_effective_local_debit_usd(TEXT, TIMESTAMP WITH TIME ZONE)
    FROM PUBLIC, anon, authenticated, service_role;

-- The recovery candidate takes the same *first* lifecycle lock as admission
-- (user) and never holds allocation before user/preflight/request.
CREATE OR REPLACE FUNCTION public.recover_analysis_beta_apify_credit_allocations(
    p_limit INTEGER DEFAULT 100
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_candidate UUID; DECLARE v_result JSONB := '[]'::JSONB;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
   RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001'; END IF;
 FOR v_candidate IN
   SELECT allocation.id FROM public.analysis_beta_pool_allocations AS allocation
   JOIN public.users AS users ON users.id = allocation.user_id
   LEFT JOIN public.analysis_requests AS request ON request.id = allocation.request_id
   LEFT JOIN public.analysis_preflights AS preflight ON preflight.id = allocation.preflight_id
   WHERE (allocation.lifecycle_state = 'active' AND request.status IN ('completed', 'failed'))
      OR (allocation.lifecycle_state = 'preflight_held' AND (preflight.expires_at <= v_now OR preflight.status IN ('blocked','expired')))
   ORDER BY allocation.created_at, allocation.id LIMIT p_limit
   FOR UPDATE OF users SKIP LOCKED
 LOOP v_result := v_result || public.settle_analysis_beta_apify_credit_allocation(v_candidate, 'recovery'); END LOOP;
 RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(
    p_limit INTEGER DEFAULT 100
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id UUID; DECLARE v_count INTEGER := 0; DECLARE v_state TEXT;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_SETTLEMENT_INVALID', ERRCODE = 'P0001'; END IF;
 -- User-first locking mirrors every mutator. Terminal ambiguous state is
 -- archived as a full held debit, not guessed as a no-run.
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
   INSERT INTO public.analysis_beta_pool_reservation_archive(
     allocation_id,operation_family,credential_slot,reserved_usd,actual_usd,released_usd,
     reconciliation_watermark,settled_at,settlement_reason,archive_state,unabsorbed_debit_usd
   ) SELECT reservation.allocation_id,reservation.operation_family,reservation.credential_slot,
       reservation.reserved_usd,reservation.actual_usd,reservation.released_usd,
       reservation.reconciliation_watermark,COALESCE(reservation.settled_at, pg_catalog.clock_timestamp()),
       COALESCE(reservation.settlement_reason,'retention_ambiguous'),
       CASE WHEN reservation.lifecycle_state = 'settled' THEN 'settled' ELSE 'ambiguous_held' END,
       CASE WHEN reservation.lifecycle_state = 'settled' THEN reservation.actual_usd ELSE reservation.reserved_usd END
     FROM public.analysis_beta_pool_reservations AS reservation WHERE reservation.allocation_id = v_id
   ON CONFLICT (allocation_id,operation_family) DO UPDATE SET
      credential_slot = EXCLUDED.credential_slot, reserved_usd = EXCLUDED.reserved_usd,
      actual_usd = EXCLUDED.actual_usd, released_usd = EXCLUDED.released_usd,
      reconciliation_watermark = EXCLUDED.reconciliation_watermark, settled_at = EXCLUDED.settled_at,
      settlement_reason = EXCLUDED.settlement_reason, archive_state = EXCLUDED.archive_state,
      unabsorbed_debit_usd = EXCLUDED.unabsorbed_debit_usd;
   DELETE FROM public.analysis_beta_pool_allocations WHERE id = v_id;
   v_count := v_count + 1;
 END LOOP;
 RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_settled_analysis_beta_apify_credit_allocations(INTEGER) TO service_role;
