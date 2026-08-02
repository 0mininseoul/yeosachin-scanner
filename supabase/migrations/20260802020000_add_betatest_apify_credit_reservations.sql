-- Durable betatest free-credit reservations and atomic admission foundation
-- (Task 2B1). Provider-run enforcement and terminal settlement deliberately
-- remain in the following migration slice.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.analysis_beta_pool_allocations (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    request_id UUID UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,
    lifecycle_state TEXT NOT NULL DEFAULT 'preflight_held',
    selected_plan_id TEXT,
    policy_version TEXT NOT NULL DEFAULT 'betatest-free-pool-v1',
    operation_slot_map JSONB,
    operation_budget_map JSONB,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    activated_at TIMESTAMP WITH TIME ZONE,
    UNIQUE (id, lifecycle_state),
    CONSTRAINT analysis_beta_pool_allocations_lifecycle_check CHECK (
        lifecycle_state IN ('preflight_held', 'active')
    ),
    CONSTRAINT analysis_beta_pool_allocations_policy_check CHECK (
        policy_version = 'betatest-free-pool-v1'
    ),
    CONSTRAINT analysis_beta_pool_allocations_state_check CHECK (
        (
            lifecycle_state = 'preflight_held'
            AND request_id IS NULL
            AND selected_plan_id IS NULL
            AND operation_slot_map IS NULL
            AND operation_budget_map IS NULL
            AND activated_at IS NULL
        )
        OR (
            lifecycle_state = 'active'
            AND request_id IS NOT NULL
            AND selected_plan_id IN ('basic', 'standard', 'plus')
            AND operation_slot_map IS NOT NULL
            AND public.analysis_beta_valid_operation_slot_map(
                operation_slot_map
            )
            AND operation_budget_map IS NOT NULL
            AND public.analysis_beta_valid_operation_budget_map(
                operation_budget_map
            )
            AND activated_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_beta_pool_allocations_time_check CHECK (
        pg_catalog.isfinite(expires_at)
        AND expires_at > created_at
        AND updated_at >= created_at
        AND (activated_at IS NULL OR activated_at >= created_at)
        AND (activated_at IS NULL OR updated_at >= activated_at)
    )
);

CREATE TABLE public.analysis_beta_pool_reservations (
    allocation_id UUID NOT NULL,
    operation_family TEXT NOT NULL,
    credential_slot TEXT NOT NULL
        CHECK (
            public.analysis_beta_valid_apify_credential_slot(
                credential_slot
            )
        ),
    reserved_usd NUMERIC(18, 12) NOT NULL,
    lifecycle_state TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (allocation_id, operation_family),
    FOREIGN KEY (allocation_id, lifecycle_state)
        REFERENCES public.analysis_beta_pool_allocations(id, lifecycle_state)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT analysis_beta_pool_reservations_operation_check CHECK (
        operation_family IN (
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers'
        )
    ),
    CONSTRAINT analysis_beta_pool_reservations_amount_check CHECK (
        reserved_usd BETWEEN 0.000000000001 AND 1000
        AND reserved_usd = pg_catalog.round(reserved_usd, 12)
    ),
    CONSTRAINT analysis_beta_pool_reservations_lifecycle_check CHECK (
        lifecycle_state IN ('preflight_held', 'active')
    ),
    CONSTRAINT analysis_beta_pool_reservations_time_check CHECK (
        updated_at >= created_at
    )
);

CREATE INDEX idx_analysis_beta_pool_reservations_headroom
    ON public.analysis_beta_pool_reservations(
        credential_slot,
        lifecycle_state,
        allocation_id,
        operation_family
    );
CREATE INDEX idx_analysis_beta_pool_allocations_request_lifecycle
    ON public.analysis_beta_pool_allocations(
        request_id,
        lifecycle_state,
        expires_at
    );

ALTER TABLE public.analysis_beta_pool_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_pool_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_pool_allocations
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_beta_pool_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_pool_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_pool_reservations
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_beta_pool_allocations IS
    'Service-owned durable betatest credit allocations, keyed idempotently by preflight and optionally bound to one request.';
COMMENT ON TABLE public.analysis_beta_pool_reservations IS
    'One exact operation-family credit reservation per allocation; later migrations own provider enforcement and settlement.';
COMMENT ON COLUMN public.analysis_beta_pool_allocations.operation_slot_map IS
    'Exact immutable eight-operation beta-free slot map, populated only at request activation.';
COMMENT ON COLUMN public.analysis_beta_pool_allocations.operation_budget_map IS
    'Exact immutable eight-operation conservative USD budget map, populated only at request activation.';

CREATE OR REPLACE FUNCTION public.analysis_beta_pool_allocation_json(
    p_allocation public.analysis_beta_pool_allocations
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'allocationId', p_allocation.id,
        'preflightId', p_allocation.preflight_id,
        'requestId', p_allocation.request_id,
        'lifecycleState', p_allocation.lifecycle_state,
        'policyVersion', p_allocation.policy_version,
        'selectedPlanId', p_allocation.selected_plan_id,
        'operationSlotMap', p_allocation.operation_slot_map,
        'operationBudgetMap', p_allocation.operation_budget_map,
        'expiresAt', p_allocation.expires_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_pool_allocation_json(
    public.analysis_beta_pool_allocations
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.upsert_analysis_beta_access_grant(
    p_user_id UUID,
    p_enabled BOOLEAN,
    p_expires_at TIMESTAMP WITH TIME ZONE,
    p_audit_reference_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_existing_grant public.analysis_beta_access_grants%ROWTYPE;
BEGIN
    IF p_user_id IS NULL
       OR p_enabled IS NULL
       OR p_audit_reference_hash IS NULL
       OR p_audit_reference_hash !~ '^[a-f0-9]{64}$'
       OR (
            p_expires_at IS NOT NULL
            AND NOT pg_catalog.isfinite(p_expires_at)
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Serialize both the existing-row and first-insert cases without taking a
    -- conflicting lock on users. Hold/activation later acquire the grant row
    -- before their user foreign-key checks, so a user-row UPDATE lock here
    -- would introduce a grant -> user / user -> grant deadlock cycle.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'analysis-beta-grant:' || pg_catalog.lower(p_user_id::TEXT),
            0
        )
    );

    PERFORM users.id
    FROM public.users AS users
    WHERE users.id = p_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT existing_grant.*
    INTO v_existing_grant
    FROM public.analysis_beta_access_grants AS existing_grant
    WHERE existing_grant.user_id = p_user_id
    FOR UPDATE;

    -- Any advisory/user/grant lock wait happened before this clock read. An
    -- expiry that elapsed while waiting can therefore never be enabled.
    v_now := pg_catalog.clock_timestamp();
    IF p_enabled = TRUE
       AND p_expires_at IS NOT NULL
       AND p_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_beta_access_grants (
        user_id,
        enabled,
        expires_at,
        audit_reference_hash,
        granted_at,
        updated_at
    ) VALUES (
        p_user_id,
        p_enabled,
        p_expires_at,
        p_audit_reference_hash,
        v_now,
        v_now
    )
    ON CONFLICT (user_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        expires_at = EXCLUDED.expires_at,
        audit_reference_hash = EXCLUDED.audit_reference_hash,
        updated_at = v_now;

    RETURN p_enabled;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_analysis_beta_access_grant(
    UUID, BOOLEAN, TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_beta_access_grant(
    UUID, BOOLEAN, TIMESTAMP WITH TIME ZONE, TEXT
) TO service_role;

COMMENT ON FUNCTION public.upsert_analysis_beta_access_grant(
    UUID, BOOLEAN, TIMESTAMP WITH TIME ZONE, TEXT
) IS
    'Service-only audited beta grant upsert/disable. Returns only the stored enabled state.';

-- Task 2B1 headroom is provider limit less observed usage and every durable
-- held/active reservation. Post-snapshot debit is added only with settlement.
CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_credit_pool(
    p_max_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_result JSONB;
BEGIN
    IF p_max_age_seconds IS NULL
       OR NOT (p_max_age_seconds BETWEEN 1 AND 900) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF (
        SELECT pg_catalog.count(*)
        FROM public.analysis_apify_credit_snapshots AS snapshot
    ) <> 6
       OR (
            SELECT pg_catalog.count(DISTINCT snapshot.credential_slot)
            FROM public.analysis_apify_credit_snapshots AS snapshot
       ) <> 6 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.health_state <> 'healthy'
           OR snapshot.monthly_limit_usd IS NULL
           OR snapshot.monthly_usage_usd IS NULL
           OR snapshot.billing_cycle_start_at IS NULL
           OR snapshot.billing_cycle_end_at IS NULL
           OR snapshot.observed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
            ERRCODE = 'P0001';
    END IF;

    IF (
        SELECT pg_catalog.count(DISTINCT snapshot.observed_at)
        FROM public.analysis_apify_credit_snapshots AS snapshot
    ) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.observed_at < v_now - pg_catalog.make_interval(
                secs => p_max_age_seconds
              )
           OR snapshot.observed_at > v_now + INTERVAL '1 minute'
           OR snapshot.billing_cycle_start_at > v_now
           OR snapshot.billing_cycle_end_at <= v_now
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'credentialSlot', snapshot.credential_slot,
            'monthlyLimitUsd', snapshot.monthly_limit_usd,
            'monthlyUsageUsd', snapshot.monthly_usage_usd,
            'billingCycleStartAt', snapshot.billing_cycle_start_at,
            'billingCycleEndAt', snapshot.billing_cycle_end_at,
            'observedAt', snapshot.observed_at,
            'healthState', snapshot.health_state,
            'effectiveHeadroomUsd', GREATEST(
                snapshot.monthly_limit_usd
                    - snapshot.monthly_usage_usd
                    - COALESCE(reserved.reserved_usd, 0::NUMERIC),
                0::NUMERIC
            )
        )
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1
            WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3
            WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5
            WHEN 'septenary' THEN 6
        END
    )
    INTO v_result
    FROM public.analysis_apify_credit_snapshots AS snapshot
    LEFT JOIN (
        SELECT reservation.credential_slot,
               pg_catalog.sum(reservation.reserved_usd) AS reserved_usd
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.lifecycle_state IN ('preflight_held', 'active')
        GROUP BY reservation.credential_slot
    ) AS reserved
      ON reserved.credential_slot = snapshot.credential_slot;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER) IS
    'Service-only sanitized exact-six pool read with held/active reservation-aware headroom; settlement debit is deferred.';

CREATE OR REPLACE FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    p_preflight_id UUID,
    p_user_id UUID,
    p_credential_slot TEXT,
    p_target_profile_budget_usd NUMERIC,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.analysis_beta_pool_allocations%ROWTYPE;
    v_created public.analysis_beta_pool_allocations%ROWTYPE;
    v_existing_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_locked_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
    v_selected_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
    v_common_observed_at TIMESTAMP WITH TIME ZONE;
    v_lock_count INTEGER := 0;
    v_snapshot_unhealthy BOOLEAN := FALSE;
    v_snapshot_stale BOOLEAN := FALSE;
    v_snapshot_split BOOLEAN := FALSE;
    v_reserved_usd NUMERIC := 0;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_credential_slot IS NULL
       OR NOT public.analysis_beta_valid_apify_credential_slot(
            p_credential_slot
       )
       OR p_target_profile_budget_usd IS NULL
       OR p_target_profile_budget_usd NOT BETWEEN 0.000000000001 AND 1000
       OR p_target_profile_budget_usd
            <> pg_catalog.round(p_target_profile_budget_usd, 12)
       OR p_max_snapshot_age_seconds IS NULL
       OR NOT (p_max_snapshot_age_seconds BETWEEN 1 AND 900) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Match the repository-wide user -> preflight lock order. The eventual
    -- allocation insert needs this same KEY SHARE lock for its user FK; taking
    -- it first avoids a cycle with concurrent user deletion and its cascades.
    PERFORM users.id
    FROM public.users AS users
    WHERE users.id = p_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT allocation.*
    INTO v_existing
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF FOUND THEN
        SELECT reservation.*
        INTO v_existing_reservation
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_existing.id
          AND reservation.operation_family = 'target-profile'
        FOR UPDATE;

        IF NOT FOUND
           OR v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.policy_version
                IS DISTINCT FROM 'betatest-free-pool-v1'
           OR v_existing_reservation.credential_slot
                IS DISTINCT FROM p_credential_slot
           OR v_existing_reservation.reserved_usd
                IS DISTINCT FROM p_target_profile_budget_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        RETURN public.analysis_beta_pool_allocation_json(v_existing);
    END IF;

    IF p_target_profile_budget_usd IS DISTINCT FROM 0.005200000000
       OR v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.status IS DISTINCT FROM 'pending'
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR v_preflight.dispatch_state IS DISTINCT FROM 'unreserved'
       OR v_preflight.dispatch_generation <> 0
       OR v_preflight.dispatch_token IS NOT NULL
       OR v_preflight.dispatch_reserved_at IS NOT NULL
       OR v_preflight.dispatched_at IS NOT NULL
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflight_provider_runs AS provider_run
            WHERE provider_run.preflight_id = p_preflight_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.*
    INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_locked_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1
            WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3
            WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5
            WHEN 'septenary' THEN 6
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
        IF v_locked_snapshot.credential_slot = p_credential_slot THEN
            v_selected_snapshot := v_locked_snapshot;
        END IF;
        IF v_locked_snapshot.health_state <> 'healthy'
           OR v_locked_snapshot.monthly_limit_usd IS NULL
           OR v_locked_snapshot.monthly_usage_usd IS NULL
           OR v_locked_snapshot.billing_cycle_start_at IS NULL
           OR v_locked_snapshot.billing_cycle_end_at IS NULL
           OR v_locked_snapshot.observed_at IS NULL THEN
            v_snapshot_unhealthy := TRUE;
        ELSE
            IF v_common_observed_at IS NULL THEN
                v_common_observed_at := v_locked_snapshot.observed_at;
            ELSIF v_locked_snapshot.observed_at
                    IS DISTINCT FROM v_common_observed_at THEN
                v_snapshot_split := TRUE;
            END IF;
        END IF;
    END LOOP;

    -- Refresh database time only after the current grant and all six snapshot
    -- rows are locked. Recheck every time-sensitive predicate on those locked
    -- values so lock waits cannot turn an expired state into an admission.
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_grant.enabled IS DISTINCT FROM TRUE
       OR (
            v_grant.expires_at IS NOT NULL
            AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at <= v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_locked_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1
            WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3
            WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5
            WHEN 'septenary' THEN 6
        END
    LOOP
        IF v_locked_snapshot.observed_at < v_now
                - pg_catalog.make_interval(
                    secs => p_max_snapshot_age_seconds
                )
           OR v_locked_snapshot.observed_at > v_now + INTERVAL '1 minute'
           OR v_locked_snapshot.billing_cycle_start_at > v_now
           OR v_locked_snapshot.billing_cycle_end_at <= v_now THEN
            v_snapshot_stale := TRUE;
        END IF;
    END LOOP;

    IF v_lock_count <> 6 OR v_snapshot_split THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;
    IF v_snapshot_unhealthy THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
            ERRCODE = 'P0001';
    END IF;
    IF v_snapshot_stale THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
            ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.sum(reservation.reserved_usd), 0::NUMERIC)
    INTO v_reserved_usd
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.credential_slot = p_credential_slot
      AND reservation.lifecycle_state IN ('preflight_held', 'active');

    IF v_selected_snapshot.monthly_limit_usd
            - v_selected_snapshot.monthly_usage_usd
            - v_reserved_usd
            < p_target_profile_budget_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET analysis_entry_channel = 'betatest'
    WHERE preflight.id = p_preflight_id;

    INSERT INTO public.analysis_beta_pool_allocations (
        preflight_id,
        user_id,
        lifecycle_state,
        policy_version,
        expires_at,
        created_at,
        updated_at
    ) VALUES (
        p_preflight_id,
        p_user_id,
        'preflight_held',
        'betatest-free-pool-v1',
        v_preflight.expires_at,
        v_now,
        v_now
    )
    RETURNING * INTO v_created;

    INSERT INTO public.analysis_beta_pool_reservations (
        allocation_id,
        operation_family,
        credential_slot,
        reserved_usd,
        lifecycle_state,
        created_at,
        updated_at
    ) VALUES (
        v_created.id,
        'target-profile',
        p_credential_slot,
        p_target_profile_budget_usd,
        'preflight_held',
        v_now,
        v_now
    );

    RETURN public.analysis_beta_pool_allocation_json(v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    UUID, UUID, TEXT, NUMERIC, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    UUID, UUID, TEXT, NUMERIC, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.hold_analysis_beta_apify_preflight_credit(
    UUID, UUID, TEXT, NUMERIC, INTEGER
) IS
    'Atomically holds the reviewed full pre-request target-profile budget on one caller-proposed beta-free slot before preflight dispatch.';

CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit(
    p_preflight_id UUID,
    p_request_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_operation_slot_map JSONB,
    p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.analysis_beta_pool_allocations%ROWTYPE;
    v_active public.analysis_beta_pool_allocations%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
    v_locked_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_proposed RECORD;
    v_common_observed_at TIMESTAMP WITH TIME ZONE;
    v_lock_count INTEGER := 0;
    v_job_count INTEGER := 0;
    v_snapshot_unhealthy BOOLEAN := FALSE;
    v_snapshot_stale BOOLEAN := FALSE;
    v_snapshot_split BOOLEAN := FALSE;
    v_job_ineligible BOOLEAN := FALSE;
    v_reserved_usd NUMERIC;
    v_monthly_limit_usd NUMERIC;
    v_monthly_usage_usd NUMERIC;
BEGIN
    IF p_preflight_id IS NULL
       OR p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_operation_slot_map IS NULL
       OR NOT public.analysis_beta_valid_operation_slot_map(
            p_operation_slot_map
       )
       OR p_operation_budget_map IS NULL
       OR NOT public.analysis_beta_valid_operation_budget_map(
            p_operation_budget_map
       )
       OR p_max_snapshot_age_seconds IS NULL
       OR NOT (p_max_snapshot_age_seconds BETWEEN 1 AND 900) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Keep user lifecycle operations and every beta admission on the same
    -- user -> preflight order. The allocation FK later reuses this lock.
    PERFORM users.id
    FROM public.users AS users
    WHERE users.id = p_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT allocation.*
    INTO v_existing
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    IF v_existing.lifecycle_state = 'active' THEN
        IF v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.request_id IS DISTINCT FROM p_request_id
           OR v_existing.selected_plan_id IS DISTINCT FROM p_selected_plan_id
           OR v_existing.operation_slot_map
                IS DISTINCT FROM p_operation_slot_map
           OR v_existing.operation_budget_map
                IS DISTINCT FROM p_operation_budget_map THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_beta_pool_allocation_json(v_existing);
    END IF;

    SELECT reservation.*
    INTO v_target_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_existing.id
      AND reservation.operation_family = 'target-profile'
    FOR UPDATE;
    IF NOT FOUND
       OR v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_existing.policy_version
            IS DISTINCT FROM 'betatest-free-pool-v1'
       OR v_target_reservation.credential_slot
            IS DISTINCT FROM p_operation_slot_map->>'target-profile'
       OR v_target_reservation.reserved_usd IS DISTINCT FROM
            (p_operation_budget_map->>'target-profile')::NUMERIC THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_existing.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.*
    INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.user_id IS DISTINCT FROM p_user_id
       OR v_request.preflight_id IS DISTINCT FROM p_preflight_id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'production'
       OR v_request.test_entitlement_jti_hash IS NOT NULL
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_selected_plan_id
       OR v_request.status IS DISTINCT FROM 'pending'
       OR v_request.background_processing IS DISTINCT FROM FALSE
       OR v_request.analysis_entry_channel IS DISTINCT FROM 'standard' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_job IN
        SELECT job.*
        FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_request_id
        ORDER BY job.job_key
        FOR UPDATE
    LOOP
        v_job_count := v_job_count + 1;
        IF v_job.status IS DISTINCT FROM 'pending'
           OR v_job.dispatch_state IS DISTINCT FROM 'pending'
           OR v_job.dispatch_generation <> 0
           OR v_job.dispatch_reservation_token IS NOT NULL
           OR v_job.dispatch_reserved_at IS NOT NULL
           OR v_job.dispatched_at IS NOT NULL
           OR v_job.dispatch_task_name IS NOT NULL
           OR v_job.delivered_at IS NOT NULL
           OR v_job.first_started_at IS NOT NULL THEN
            v_job_ineligible := TRUE;
        END IF;
    END LOOP;

    IF v_job_count = 0
       OR v_job_ineligible
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = p_request_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_locked_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1
            WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3
            WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5
            WHEN 'septenary' THEN 6
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
        IF v_locked_snapshot.health_state <> 'healthy'
           OR v_locked_snapshot.monthly_limit_usd IS NULL
           OR v_locked_snapshot.monthly_usage_usd IS NULL
           OR v_locked_snapshot.billing_cycle_start_at IS NULL
           OR v_locked_snapshot.billing_cycle_end_at IS NULL
           OR v_locked_snapshot.observed_at IS NULL THEN
            v_snapshot_unhealthy := TRUE;
        ELSE
            IF v_common_observed_at IS NULL THEN
                v_common_observed_at := v_locked_snapshot.observed_at;
            ELSIF v_locked_snapshot.observed_at
                    IS DISTINCT FROM v_common_observed_at THEN
                v_snapshot_split := TRUE;
            END IF;
        END IF;
    END LOOP;

    -- All mutable admission fences are now locked. Refresh the database clock
    -- and make the authoritative expiry/freshness decision using that time.
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at <= v_now
       OR v_existing.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_grant.enabled IS DISTINCT FROM TRUE
       OR (
            v_grant.expires_at IS NOT NULL
            AND (
                NOT pg_catalog.isfinite(v_grant.expires_at)
                OR v_grant.expires_at <= v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_locked_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1
            WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3
            WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5
            WHEN 'septenary' THEN 6
        END
    LOOP
        IF v_locked_snapshot.observed_at < v_now
                - pg_catalog.make_interval(
                    secs => p_max_snapshot_age_seconds
                )
           OR v_locked_snapshot.observed_at > v_now + INTERVAL '1 minute'
           OR v_locked_snapshot.billing_cycle_start_at > v_now
           OR v_locked_snapshot.billing_cycle_end_at <= v_now THEN
            v_snapshot_stale := TRUE;
        END IF;
    END LOOP;

    IF v_lock_count <> 6 OR v_snapshot_split THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;
    IF v_snapshot_unhealthy THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
            ERRCODE = 'P0001';
    END IF;
    IF v_snapshot_stale THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_proposed IN
        SELECT slot_entry.slot_value AS credential_slot,
               pg_catalog.sum(
                    (p_operation_budget_map->>slot_entry.operation_family)
                        ::NUMERIC
               ) AS proposed_usd
        FROM pg_catalog.jsonb_each_text(p_operation_slot_map)
            AS slot_entry(operation_family, slot_value)
        WHERE slot_entry.operation_family <> 'target-profile'
        GROUP BY slot_entry.slot_value
        ORDER BY slot_entry.slot_value
    LOOP
        SELECT snapshot.monthly_limit_usd,
               snapshot.monthly_usage_usd
        INTO v_monthly_limit_usd, v_monthly_usage_usd
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.credential_slot = v_proposed.credential_slot;

        SELECT COALESCE(
                   pg_catalog.sum(reservation.reserved_usd),
                   0::NUMERIC
               )
        INTO v_reserved_usd
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.credential_slot = v_proposed.credential_slot
          AND reservation.lifecycle_state IN ('preflight_held', 'active');

        IF v_monthly_limit_usd
                - v_monthly_usage_usd
                - v_reserved_usd
                < v_proposed.proposed_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
                ERRCODE = 'P0001';
        END IF;
    END LOOP;

    INSERT INTO public.analysis_beta_pool_reservations (
        allocation_id,
        operation_family,
        credential_slot,
        reserved_usd,
        lifecycle_state,
        created_at,
        updated_at
    )
    SELECT v_existing.id,
           slot_entry.operation_family,
           slot_entry.slot_value,
           (p_operation_budget_map->>slot_entry.operation_family)::NUMERIC,
           'preflight_held',
           v_now,
           v_now
    FROM pg_catalog.jsonb_each_text(p_operation_slot_map)
        AS slot_entry(operation_family, slot_value)
    WHERE slot_entry.operation_family <> 'target-profile'
    ORDER BY slot_entry.operation_family;

    UPDATE public.analysis_beta_pool_allocations AS allocation
    SET request_id = p_request_id,
        lifecycle_state = 'active',
        selected_plan_id = p_selected_plan_id,
        operation_slot_map = p_operation_slot_map,
        operation_budget_map = p_operation_budget_map,
        expires_at = v_now + INTERVAL '24 hours',
        updated_at = v_now,
        activated_at = v_now
    WHERE allocation.id = v_existing.id
    RETURNING * INTO v_active;

    UPDATE public.analysis_requests AS analysis_request
    SET analysis_entry_channel = 'betatest'
    WHERE analysis_request.id = p_request_id;

    RETURN public.analysis_beta_pool_allocation_json(v_active);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) IS
    'Atomically rechecks incremental seven-operation headroom and freezes one exact eight-operation beta policy before request dispatch.';
COMMIT;
