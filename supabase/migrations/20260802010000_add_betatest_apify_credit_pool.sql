-- Betatest free-credit pool foundation (Task 2A).
--
-- This forward-only slice establishes exact credential/operation vocabularies,
-- a server-owned entry channel, non-enumerable beta access grants, and atomic
-- sanitized provider-credit snapshots. Allocation, reservation, provider-run
-- policy, and settlement state are intentionally introduced by their own later
-- Task 2B migration so this foundation keeps a bounded lock transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- The general Analysis V2 vocabulary remains a distinct superset of the beta
-- pool. Replacing the immutable helper widens every existing helper-backed
-- constraint without editing any historical migration.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(
    p_slot TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary',
            'senary', 'septenary'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The authorized-free-e2e-v1 policy is a historical six-slot contract. Pin
-- its accepted slot vocabulary so widening the general V2 helper cannot
-- silently make septenary valid for already-deployed policy constraints.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_test_operation_slot_map(
    p_map JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_map) = 'object'
        AND p_map ?& ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'target-likers',
            'target-comments',
            'candidate-likers'
        ]
        AND p_map - ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'target-likers',
            'target-comments',
            'candidate-likers'
        ] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(p_map)
                AS entry(operation_kind, slot_value)
            WHERE pg_catalog.jsonb_typeof(entry.slot_value) <> 'string'
               OR entry.slot_value #>> '{}' NOT IN (
                    'primary', 'secondary', 'tertiary',
                    'quaternary', 'quinary', 'senary'
               )
        )
        AND p_map->>'target-profile' = p_map->>'profile-fallback'
        AND p_map->>'relationship-followers' <> p_map->>'relationship-following'
        AND p_map->>'target-likers' <> p_map->>'candidate-likers',
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_test_operation_slot_map(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- Beta-free credentials are an independent immutable subset. In particular,
-- secondary cannot become eligible through a general-V2 vocabulary change.
CREATE OR REPLACE FUNCTION public.analysis_beta_valid_apify_credential_slot(
    p_slot TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'tertiary', 'quaternary', 'quinary', 'senary',
            'septenary'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_beta_valid_operation_slot_map(
    p_map JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_map) = 'object'
        AND p_map ?& ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers'
        ]
        AND p_map - ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers'
        ] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(p_map)
                AS entry(operation_key, slot_value)
            WHERE pg_catalog.jsonb_typeof(entry.slot_value) <> 'string'
               OR NOT public.analysis_beta_valid_apify_credential_slot(
                    entry.slot_value #>> '{}'
               )
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_valid_operation_slot_map(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_beta_valid_operation_budget_map(
    p_map JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    entry RECORD;
    v_budget NUMERIC;
BEGIN
    IF pg_catalog.jsonb_typeof(p_map) IS DISTINCT FROM 'object'
       OR NOT p_map ?& ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers'
       ]
       OR p_map - ARRAY[
            'target-profile',
            'relationship-followers',
            'relationship-following',
            'profile-fallback',
            'profile-repair',
            'target-likers',
            'target-comments',
            'candidate-likers'
       ] <> '{}'::JSONB THEN
        RETURN FALSE;
    END IF;

    FOR entry IN
        SELECT operation_key, budget_value
        FROM pg_catalog.jsonb_each(p_map)
            AS budget_entry(operation_key, budget_value)
    LOOP
        IF pg_catalog.jsonb_typeof(entry.budget_value) <> 'number' THEN
            RETURN FALSE;
        END IF;
        BEGIN
            v_budget := (entry.budget_value #>> '{}')::NUMERIC;
        EXCEPTION
            WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                RETURN FALSE;
        END;
        IF v_budget NOT BETWEEN 0.000000000001 AND 1000
           OR v_budget <> pg_catalog.round(v_budget, 12) THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_valid_operation_budget_map(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- No grant is seeded. Operators will add grants through a later service-owned
-- mutation boundary, with only a non-reversible audit reference in this table.
CREATE TABLE public.analysis_beta_access_grants (
    user_id UUID PRIMARY KEY
        REFERENCES public.users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMP WITH TIME ZONE,
    audit_reference_hash VARCHAR(64) NOT NULL,
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_beta_access_grants_audit_hash_check CHECK (
        audit_reference_hash ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_beta_access_grants_timestamp_check CHECK (
        updated_at >= granted_at
    )
);

ALTER TABLE public.analysis_beta_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_access_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_access_grants
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_beta_access_grants IS
    'Non-enumerable service-owned betatest allowlist. The only client surface is a boolean self-check.';
COMMENT ON COLUMN public.analysis_beta_access_grants.audit_reference_hash IS
    'SHA-256 audit reference supplied out of band; no email or operator payload is stored.';

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
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.analysis_beta_access_grants AS grant_row
        WHERE grant_row.user_id = v_user_id
          AND grant_row.enabled = TRUE
          AND (
                grant_row.expires_at IS NULL
                OR grant_row.expires_at > v_now
          )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_has_access()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_beta_has_access()
    TO authenticated;

COMMENT ON FUNCTION public.analysis_beta_has_access() IS
    'Returns only whether auth.uid() has a current beta grant; accepts no target identity and cannot enumerate grants.';

-- Six unhealthy sentinels make the exact account set durable and provide rows
-- that every refresh/allocation transaction can lock in one canonical order.
-- Healthy rows contain only slot aliases and sanitized aggregate USD/cycle
-- observations; tokens, provider identities, and raw responses have no column.
CREATE TABLE public.analysis_apify_credit_snapshots (
    credential_slot VARCHAR(16) PRIMARY KEY
        CHECK (public.analysis_beta_valid_apify_credential_slot(credential_slot)),
    monthly_limit_usd NUMERIC(18, 12),
    monthly_usage_usd NUMERIC(18, 12),
    billing_cycle_start_at TIMESTAMP WITH TIME ZONE,
    billing_cycle_end_at TIMESTAMP WITH TIME ZONE,
    observed_at TIMESTAMP WITH TIME ZONE,
    health_state VARCHAR(16) NOT NULL DEFAULT 'unhealthy'
        CHECK (health_state IN ('healthy', 'unhealthy')),
    refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_apify_credit_snapshots_state_check CHECK (
        (
            health_state = 'unhealthy'
            AND monthly_limit_usd IS NULL
            AND monthly_usage_usd IS NULL
            AND billing_cycle_start_at IS NULL
            AND billing_cycle_end_at IS NULL
            AND observed_at IS NULL
        )
        OR (
            health_state = 'healthy'
            AND monthly_limit_usd IS NOT NULL
            AND monthly_usage_usd IS NOT NULL
            AND billing_cycle_start_at IS NOT NULL
            AND billing_cycle_end_at IS NOT NULL
            AND observed_at IS NOT NULL
            AND pg_catalog.isfinite(billing_cycle_start_at)
            AND pg_catalog.isfinite(billing_cycle_end_at)
            AND pg_catalog.isfinite(observed_at)
            AND monthly_limit_usd BETWEEN 0 AND 100000
            AND monthly_usage_usd BETWEEN 0 AND 100000
            AND monthly_limit_usd = pg_catalog.round(monthly_limit_usd, 12)
            AND monthly_usage_usd = pg_catalog.round(monthly_usage_usd, 12)
            AND billing_cycle_start_at <= observed_at
            AND observed_at < billing_cycle_end_at
        )
    )
);

ALTER TABLE public.analysis_apify_credit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_apify_credit_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_apify_credit_snapshots
    FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.analysis_apify_credit_snapshots
    (credential_slot, health_state)
VALUES
    ('primary', 'unhealthy'),
    ('tertiary', 'unhealthy'),
    ('quaternary', 'unhealthy'),
    ('quinary', 'unhealthy'),
    ('senary', 'unhealthy'),
    ('septenary', 'unhealthy');

COMMENT ON TABLE public.analysis_apify_credit_snapshots IS
    'Exact six-slot sanitized Apify limit/usage snapshots. Task 2A unhealthy sentinels fail closed until one atomic refresh succeeds.';

-- Foundation-only headroom is limit minus conservative observed usage. Task
-- 2B extends this correctness boundary with held reservations and reconciled
-- post-snapshot debit before any admission path is enabled.
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
                snapshot.monthly_limit_usd - snapshot.monthly_usage_usd,
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
    FROM public.analysis_apify_credit_snapshots AS snapshot;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER) IS
    'Service-only sanitized exact-six snapshot read; Task 2A foundation-only headroom excludes reservation/debit state until Task 2B.';

CREATE OR REPLACE FUNCTION public.upsert_analysis_beta_apify_credit_snapshots(
    p_snapshots JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_entry JSONB;
    v_slot TEXT;
    v_monthly_limit_usd NUMERIC;
    v_monthly_usage_usd NUMERIC;
    v_cycle_start_at TIMESTAMP WITH TIME ZONE;
    v_cycle_end_at TIMESTAMP WITH TIME ZONE;
    v_observed_at TIMESTAMP WITH TIME ZONE;
    v_common_observed_at TIMESTAMP WITH TIME ZONE;
    v_entry_count INTEGER;
    v_distinct_slot_count INTEGER;
    v_lock_count INTEGER := 0;
    v_locked_slot TEXT;
    v_existing public.analysis_apify_credit_snapshots%ROWTYPE;
BEGIN
    IF pg_catalog.jsonb_typeof(p_snapshots) <> 'array'
       OR pg_catalog.jsonb_array_length(p_snapshots) <> 6 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*),
           COUNT(DISTINCT snapshot_entry->>'credentialSlot')
    INTO v_entry_count, v_distinct_slot_count
    FROM pg_catalog.jsonb_array_elements(p_snapshots) AS snapshot_entry;

    IF v_entry_count <> 6
       OR v_distinct_slot_count <> 6
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_snapshots) AS snapshot_entry
            WHERE NOT public.analysis_beta_valid_apify_credential_slot(
                snapshot_entry->>'credentialSlot'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_entry IN
        SELECT snapshot_entry
        FROM pg_catalog.jsonb_array_elements(p_snapshots) AS snapshot_entry
    LOOP
        IF pg_catalog.jsonb_typeof(v_entry) <> 'object'
           OR NOT v_entry ?& ARRAY[
                'credentialSlot',
                'monthlyLimitUsd',
                'monthlyUsageUsd',
                'billingCycleStartAt',
                'billingCycleEndAt',
                'observedAt',
                'healthState'
           ]
           OR v_entry - ARRAY[
                'credentialSlot',
                'monthlyLimitUsd',
                'monthlyUsageUsd',
                'billingCycleStartAt',
                'billingCycleEndAt',
                'observedAt',
                'healthState'
           ] <> '{}'::JSONB
           OR (v_entry->>'healthState') IS DISTINCT FROM 'healthy'
           OR pg_catalog.jsonb_typeof(v_entry->'monthlyLimitUsd') <> 'number'
           OR pg_catalog.jsonb_typeof(v_entry->'monthlyUsageUsd') <> 'number'
           OR pg_catalog.jsonb_typeof(v_entry->'billingCycleStartAt') <> 'string'
           OR pg_catalog.jsonb_typeof(v_entry->'billingCycleEndAt') <> 'string'
           OR pg_catalog.jsonb_typeof(v_entry->'observedAt') <> 'string' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
                ERRCODE = 'P0001';
        END IF;

        BEGIN
            v_slot := v_entry->>'credentialSlot';
            v_monthly_limit_usd := (v_entry->>'monthlyLimitUsd')::NUMERIC;
            v_monthly_usage_usd := (v_entry->>'monthlyUsageUsd')::NUMERIC;
            v_cycle_start_at := (v_entry->>'billingCycleStartAt')
                ::TIMESTAMP WITH TIME ZONE;
            v_cycle_end_at := (v_entry->>'billingCycleEndAt')
                ::TIMESTAMP WITH TIME ZONE;
            v_observed_at := (v_entry->>'observedAt')
                ::TIMESTAMP WITH TIME ZONE;
        EXCEPTION
            WHEN invalid_text_representation
                OR numeric_value_out_of_range
                OR invalid_datetime_format
                OR datetime_field_overflow THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
                    ERRCODE = 'P0001';
        END;

        IF NOT public.analysis_beta_valid_apify_credential_slot(v_slot)
           OR v_monthly_limit_usd NOT BETWEEN 0 AND 100000
           OR v_monthly_usage_usd NOT BETWEEN 0 AND 100000
           OR v_monthly_limit_usd <> pg_catalog.round(v_monthly_limit_usd, 12)
           OR v_monthly_usage_usd <> pg_catalog.round(v_monthly_usage_usd, 12)
           OR NOT pg_catalog.isfinite(v_cycle_start_at)
           OR NOT pg_catalog.isfinite(v_cycle_end_at)
           OR NOT pg_catalog.isfinite(v_observed_at)
           OR NOT (
                v_cycle_start_at <= v_observed_at
                AND v_observed_at < v_cycle_end_at
           )
           OR v_cycle_start_at > v_now
           OR v_cycle_end_at <= v_now THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
                ERRCODE = 'P0001';
        END IF;

        IF v_observed_at < v_now - INTERVAL '5 minutes'
           OR v_observed_at > v_now + INTERVAL '1 minute' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
                ERRCODE = 'P0001';
        END IF;

        IF v_common_observed_at IS NULL THEN
            v_common_observed_at := v_observed_at;
        ELSIF v_observed_at IS DISTINCT FROM v_common_observed_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
                ERRCODE = 'P0001';
        END IF;
    END LOOP;

    -- All writers take the same six durable rows in this exact order. The
    -- loop (rather than an aggregate) guarantees PostgreSQL actually locks
    -- every row before any freshness/headroom state is changed.
    FOR v_locked_slot IN
        SELECT snapshot.credential_slot
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
    END LOOP;

    IF v_lock_count <> 6 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    FOR v_entry IN
        SELECT snapshot_entry
        FROM pg_catalog.jsonb_array_elements(p_snapshots) AS snapshot_entry
    LOOP
        v_slot := v_entry->>'credentialSlot';
        v_monthly_limit_usd := (v_entry->>'monthlyLimitUsd')::NUMERIC;
        v_monthly_usage_usd := (v_entry->>'monthlyUsageUsd')::NUMERIC;
        v_cycle_start_at := (v_entry->>'billingCycleStartAt')
            ::TIMESTAMP WITH TIME ZONE;
        v_cycle_end_at := (v_entry->>'billingCycleEndAt')
            ::TIMESTAMP WITH TIME ZONE;
        v_observed_at := (v_entry->>'observedAt')
            ::TIMESTAMP WITH TIME ZONE;

        SELECT snapshot.*
        INTO v_existing
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.credential_slot = v_slot;

        IF v_existing.health_state = 'healthy'
           AND (
                v_existing.observed_at > v_observed_at
                OR (
                    v_existing.observed_at = v_observed_at
                    AND (
                        v_existing.monthly_limit_usd
                            IS DISTINCT FROM v_monthly_limit_usd
                        OR v_existing.monthly_usage_usd
                            IS DISTINCT FROM v_monthly_usage_usd
                        OR v_existing.billing_cycle_start_at
                            IS DISTINCT FROM v_cycle_start_at
                        OR v_existing.billing_cycle_end_at
                            IS DISTINCT FROM v_cycle_end_at
                    )
                )
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_apify_credit_snapshots AS snapshot
        SET monthly_limit_usd = v_monthly_limit_usd,
            monthly_usage_usd = v_monthly_usage_usd,
            billing_cycle_start_at = v_cycle_start_at,
            billing_cycle_end_at = v_cycle_end_at,
            observed_at = v_observed_at,
            health_state = 'healthy',
            refreshed_at = v_now
        WHERE snapshot.credential_slot = v_slot;
    END LOOP;

    RETURN public.load_analysis_beta_apify_credit_pool(300);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_analysis_beta_apify_credit_snapshots(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_beta_apify_credit_snapshots(JSONB)
    TO service_role;

COMMENT ON FUNCTION public.upsert_analysis_beta_apify_credit_snapshots(JSONB) IS
    'Atomically validates and replaces the exact six sanitized healthy snapshots under canonical row locks; partial refresh is impossible.';

-- Entry channel is server-persisted metadata, not a PlanAccessMode. Existing
-- rows and every existing insert path remain standard through the defaults.
-- A beta path must retain production access snapshots and may not manufacture
-- a signed test-entitlement identity. Keep this as the final executable block
-- so its ACCESS EXCLUSIVE locks are held for the shortest part of this
-- migration; 20260802010100 validates existing rows in a new transaction.
ALTER TABLE public.analysis_preflights
    ADD COLUMN analysis_entry_channel TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE public.analysis_requests
    ADD COLUMN analysis_entry_channel TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_entry_channel_check CHECK (
        analysis_entry_channel IN ('standard', 'betatest')
    ) NOT VALID,
    ADD CONSTRAINT analysis_preflights_entry_channel_access_check CHECK (
        analysis_entry_channel <> 'betatest'
        OR access_mode = 'production'
    ) NOT VALID;

ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_entry_channel_check CHECK (
        analysis_entry_channel IN ('standard', 'betatest')
    ) NOT VALID,
    ADD CONSTRAINT analysis_requests_entry_channel_access_check CHECK (
        analysis_entry_channel <> 'betatest'
        OR (
            pipeline_version IS NOT DISTINCT FROM 'v2'
            AND plan_access_mode_snapshot IS NOT DISTINCT FROM 'production'
            AND test_entitlement_jti_hash IS NULL
        )
    ) NOT VALID;

COMMENT ON COLUMN public.analysis_preflights.analysis_entry_channel IS
    'Server-persisted entry channel; betatest is authority only when paired with a current service-owned access grant.';
COMMENT ON COLUMN public.analysis_requests.analysis_entry_channel IS
    'Immutable-at-admission entry channel snapshot; it does not widen the production/test_entitlement access-mode domain.';
