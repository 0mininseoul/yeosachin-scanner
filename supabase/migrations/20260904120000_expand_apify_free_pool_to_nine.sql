-- Apify ten-account runtime expansion (forward-only).
--
-- secondary is the paid full-analysis account.  The other nine aliases are
-- the beta/free pool.  This migration widens the current runtime fences and
-- adds balance-aware account controls; historical receipts and policy
-- snapshots keep any historical rows and are completed with unhealthy
-- sentinels for each newly configured alias below.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
            'senary', 'septenary', 'octonary', 'nonary', 'tenth'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    TO anon, authenticated;

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
            'septenary', 'octonary', 'nonary', 'tenth'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The admission catalog predates the nine-account free pool and initially
-- contains only the three canary slot budgets. Keep the global budget and all
-- existing counters untouched, then add the missing free and paid slot budgets
-- required by fresh/test-entitlement and frozen relationship paths.
-- There is intentionally no preflight secondary budget: secondary remains the
-- paid full-analysis account even though it is present in the operator ledger.
INSERT INTO public.analysis_provider_admission_budgets (
    budget_key, workload_role, logical_provider, credential_slot,
    max_active, rate_limit_per_minute
) VALUES
    ('preflight:apify:global', 'preflight', 'apify', NULL, 32, 120),
    ('preflight:apify:primary', 'preflight', 'apify', 'primary', 16, 60),
    ('preflight:apify:tertiary', 'preflight', 'apify', 'tertiary', 16, 60),
    ('preflight:apify:quaternary', 'preflight', 'apify', 'quaternary', 16, 60),
    ('preflight:apify:quinary', 'preflight', 'apify', 'quinary', 16, 60),
    ('preflight:apify:senary', 'preflight', 'apify', 'senary', 16, 60),
    ('preflight:apify:septenary', 'preflight', 'apify', 'septenary', 16, 60),
    ('preflight:apify:octonary', 'preflight', 'apify', 'octonary', 16, 60),
    ('preflight:apify:nonary', 'preflight', 'apify', 'nonary', 16, 60),
    ('preflight:apify:tenth', 'preflight', 'apify', 'tenth', 16, 60),
    ('paid:apify:octonary', 'paid', 'apify', 'octonary', 8, 480),
    ('paid:apify:nonary', 'paid', 'apify', 'nonary', 8, 480),
    ('paid:apify:octonary:relationship', 'paid', 'apify', 'octonary', 4, 240),
    ('paid:apify:nonary:relationship', 'paid', 'apify', 'nonary', 4, 240)
ON CONFLICT (budget_key) DO NOTHING;

-- Existing budget rows are durable admission policy, not migration scratch
-- data. Validate only immutable policy fields; window counters and timestamps
-- are deliberately left untouched so a replay cannot reset live admission.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('preflight:apify:global', 'preflight', 'apify', NULL, 32, 120),
                ('preflight:apify:primary', 'preflight', 'apify', 'primary', 16, 60),
                ('preflight:apify:tertiary', 'preflight', 'apify', 'tertiary', 16, 60),
                ('preflight:apify:quaternary', 'preflight', 'apify', 'quaternary', 16, 60),
                ('preflight:apify:quinary', 'preflight', 'apify', 'quinary', 16, 60),
                ('preflight:apify:senary', 'preflight', 'apify', 'senary', 16, 60),
                ('preflight:apify:septenary', 'preflight', 'apify', 'septenary', 16, 60),
                ('preflight:apify:octonary', 'preflight', 'apify', 'octonary', 16, 60),
                ('preflight:apify:nonary', 'preflight', 'apify', 'nonary', 16, 60),
                ('preflight:apify:tenth', 'preflight', 'apify', 'tenth', 16, 60)
        ) AS expected(budget_key, workload_role, logical_provider, credential_slot,
                      max_active, rate_limit_per_minute)
        LEFT JOIN public.analysis_provider_admission_budgets AS actual
            ON actual.budget_key = expected.budget_key
        WHERE actual.budget_key IS NULL
           OR actual.workload_role IS DISTINCT FROM expected.workload_role
           OR actual.logical_provider IS DISTINCT FROM expected.logical_provider
           OR actual.credential_slot IS DISTINCT FROM expected.credential_slot
           OR actual.max_active IS DISTINCT FROM expected.max_active
           OR actual.rate_limit_per_minute IS DISTINCT FROM expected.rate_limit_per_minute
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_provider_admission_budgets AS actual
        WHERE actual.workload_role = 'preflight'
          AND actual.logical_provider = 'apify'
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  VALUES
                      ('preflight:apify:global'),
                      ('preflight:apify:primary'),
                      ('preflight:apify:tertiary'),
                      ('preflight:apify:quaternary'),
                      ('preflight:apify:quinary'),
                      ('preflight:apify:senary'),
                      ('preflight:apify:septenary'),
                      ('preflight:apify:octonary'),
                      ('preflight:apify:nonary'),
                      ('preflight:apify:tenth')
              ) AS expected(budget_key)
              WHERE expected.budget_key = actual.budget_key
          )
    ) OR EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('paid:apify:octonary', 'paid', 'apify', 'octonary', 8, 480),
                ('paid:apify:nonary', 'paid', 'apify', 'nonary', 8, 480),
                ('paid:apify:octonary:relationship', 'paid', 'apify', 'octonary', 4, 240),
                ('paid:apify:nonary:relationship', 'paid', 'apify', 'nonary', 4, 240)
        ) AS expected(budget_key, workload_role, logical_provider, credential_slot,
                      max_active, rate_limit_per_minute)
        LEFT JOIN public.analysis_provider_admission_budgets AS actual
            ON actual.budget_key = expected.budget_key
        WHERE actual.budget_key IS NULL
           OR actual.workload_role IS DISTINCT FROM expected.workload_role
           OR actual.logical_provider IS DISTINCT FROM expected.logical_provider
           OR actual.credential_slot IS DISTINCT FROM expected.credential_slot
           OR actual.max_active IS DISTINCT FROM expected.max_active
           OR actual.rate_limit_per_minute IS DISTINCT FROM expected.rate_limit_per_minute
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_BUDGET_DRIFT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

-- The predecessor admission RPC protected preflight with its original
-- three-canary allow-list.  Keep that function's reviewed claim, lease, and
-- budget fencing intact while widening only the credential boundary to the
-- exact nine free aliases introduced above.  Use pg_get_functiondef so this
-- forward migration updates already-migrated installations without copying
-- the large predecessor body into a second source of truth.
DO $$
DECLARE
    v_definition TEXT;
    v_old_guard TEXT :=
        'p_credential_slot NOT IN (''primary'', ''quinary'', ''senary'')';
    v_new_guard TEXT :=
        'p_credential_slot NOT IN (''primary'', ''tertiary'', ''quaternary'', ''quinary'', ''senary'', ''septenary'', ''octonary'', ''nonary'', ''tenth'')';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(function_row.oid)
    INTO v_definition
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
        'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'
    );
    IF v_definition IS NOT NULL
       AND pg_catalog.strpos(v_definition, v_old_guard) > 0 THEN
        EXECUTE pg_catalog.replace(v_definition, v_old_guard, v_new_guard);
    END IF;
END;
$$;

-- The historical snapshot table was intentionally beta-only.  Keep one
-- sanitized row for every configured account so operator/paid monitoring can
-- observe secondary and the newly configured free slots without making
-- secondary a beta allocation candidate.  The predecessor seeds the first
-- six free aliases; these four idempotent inserts complete the exact ten-row
-- inventory on an already-migrated installation.
ALTER TABLE public.analysis_apify_credit_snapshots
    DROP CONSTRAINT IF EXISTS analysis_apify_credit_snapshots_credential_slot_check;
ALTER TABLE public.analysis_apify_credit_snapshots
    ADD CONSTRAINT analysis_apify_credit_snapshots_credential_slot_check
    CHECK (public.analysis_v2_valid_apify_credential_slot(credential_slot));

INSERT INTO public.analysis_apify_credit_snapshots (credential_slot, health_state)
VALUES
    ('secondary', 'unhealthy'),
    ('octonary', 'unhealthy'),
    ('nonary', 'unhealthy'),
    ('tenth', 'unhealthy')
ON CONFLICT (credential_slot) DO NOTHING;

COMMENT ON TABLE public.analysis_apify_credit_snapshots IS
    'Exact ten-slot sanitized Apify balance/cycle snapshots; secondary is paid-only and starts as an explicit unhealthy sentinel until independently refreshed. Manual free-slot controls are a mutable flag on this existing snapshot ledger.';

-- Reuse the existing sanitized snapshot ledger for operator controls. This
-- avoids a second account-control table and keeps allocation and control
-- updates inside the same row/advisory lock protocol.
ALTER TABLE public.analysis_apify_credit_snapshots
    ADD COLUMN IF NOT EXISTS manually_excluded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.analysis_apify_account_is_excluded(
    p_credential_slot TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE((
        SELECT snapshot.manually_excluded
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.credential_slot = p_credential_slot
    ), FALSE);
$$;

REVOKE ALL ON FUNCTION public.analysis_apify_account_is_excluded(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_apify_account_control_state()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH free_slots(credential_slot) AS (
        VALUES ('primary'::TEXT), ('tertiary'::TEXT),
               ('quaternary'::TEXT), ('quinary'::TEXT),
               ('senary'::TEXT), ('septenary'::TEXT),
               ('octonary'::TEXT), ('nonary'::TEXT), ('tenth'::TEXT)
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'credentialSlot', free_slots.credential_slot,
            'excluded', COALESCE(snapshot.manually_excluded, FALSE),
            'updatedAt', snapshot.refreshed_at
        )
        ORDER BY CASE free_slots.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
    ), '[]'::JSONB)
    FROM free_slots
    LEFT JOIN public.analysis_apify_credit_snapshots AS snapshot
      ON snapshot.credential_slot = free_slots.credential_slot;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_apify_account_control_state()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_apify_account_control_state()
    TO service_role;

CREATE OR REPLACE FUNCTION public.set_analysis_apify_account_exclusion(
    p_credential_slot TEXT,
    p_excluded BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot)
       OR p_excluded IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_CONTROL_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-apify-free-pool', 0)
    );

    UPDATE public.analysis_apify_credit_snapshots AS snapshot
    SET manually_excluded = p_excluded,
        refreshed_at = v_now
    WHERE snapshot.credential_slot = p_credential_slot;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_CONTROL_INVALID',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'credentialSlot', p_credential_slot,
        'excluded', p_excluded,
        'updatedAt', v_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_analysis_apify_account_exclusion(
    TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_apify_account_exclusion(
    TEXT, BOOLEAN
) TO service_role;

-- Every runtime writer takes this same advisory lock before locking the nine
-- snapshots in canonical order.  It serializes account-control races without
-- exposing account or provider identities to callers.
CREATE OR REPLACE FUNCTION public.analysis_beta_pool_lock()
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-apify-free-pool', 0)
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_pool_lock()
    FROM PUBLIC, anon, authenticated, service_role;

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
    v_entry_count INTEGER;
    v_distinct_slot_count INTEGER;
    v_lock_count INTEGER := 0;
    v_locked_slot TEXT;
    v_existing public.analysis_apify_credit_snapshots%ROWTYPE;
BEGIN
    IF pg_catalog.jsonb_typeof(p_snapshots) <> 'array'
       OR pg_catalog.jsonb_array_length(p_snapshots) <> 9 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT entry->>'credentialSlot')
    INTO v_entry_count, v_distinct_slot_count
    FROM pg_catalog.jsonb_array_elements(p_snapshots) AS entry;
    IF v_entry_count <> 9
       OR v_distinct_slot_count <> 9
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_snapshots) AS entry
            WHERE NOT public.analysis_beta_valid_apify_credential_slot(entry->>'credentialSlot')
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    FOR v_entry IN SELECT entry FROM pg_catalog.jsonb_array_elements(p_snapshots) AS entry LOOP
        IF pg_catalog.jsonb_typeof(v_entry) <> 'object'
           OR NOT v_entry ?& ARRAY[
                'credentialSlot', 'monthlyLimitUsd', 'monthlyUsageUsd',
                'billingCycleStartAt', 'billingCycleEndAt', 'observedAt', 'healthState'
           ]
           OR v_entry - ARRAY[
                'credentialSlot', 'monthlyLimitUsd', 'monthlyUsageUsd',
                'billingCycleStartAt', 'billingCycleEndAt', 'observedAt', 'healthState'
           ] <> '{}'::JSONB
           OR v_entry->>'healthState' NOT IN ('healthy', 'unhealthy') THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
        END IF;

        v_slot := v_entry->>'credentialSlot';
        IF NOT public.analysis_beta_valid_apify_credential_slot(v_slot) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
        END IF;
        IF v_entry->>'healthState' = 'unhealthy' THEN
            IF v_entry->>'monthlyLimitUsd' IS NOT NULL
               OR v_entry->>'monthlyUsageUsd' IS NOT NULL
               OR v_entry->>'billingCycleStartAt' IS NOT NULL
               OR v_entry->>'billingCycleEndAt' IS NOT NULL
               OR v_entry->>'observedAt' IS NOT NULL THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
            END IF;
        ELSE
            IF pg_catalog.jsonb_typeof(v_entry->'monthlyLimitUsd') <> 'number'
               OR pg_catalog.jsonb_typeof(v_entry->'monthlyUsageUsd') <> 'number'
               OR pg_catalog.jsonb_typeof(v_entry->'billingCycleStartAt') <> 'string'
               OR pg_catalog.jsonb_typeof(v_entry->'billingCycleEndAt') <> 'string'
               OR pg_catalog.jsonb_typeof(v_entry->'observedAt') <> 'string' THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
            END IF;
            BEGIN
                v_monthly_limit_usd := (v_entry->>'monthlyLimitUsd')::NUMERIC;
                v_monthly_usage_usd := (v_entry->>'monthlyUsageUsd')::NUMERIC;
                v_cycle_start_at := (v_entry->>'billingCycleStartAt')::TIMESTAMP WITH TIME ZONE;
                v_cycle_end_at := (v_entry->>'billingCycleEndAt')::TIMESTAMP WITH TIME ZONE;
                v_observed_at := (v_entry->>'observedAt')::TIMESTAMP WITH TIME ZONE;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
                OR invalid_datetime_format OR datetime_field_overflow THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
            END;
            IF v_monthly_limit_usd NOT BETWEEN 0 AND 100000
               OR v_monthly_usage_usd NOT BETWEEN 0 AND 100000
               OR v_monthly_limit_usd <> pg_catalog.round(v_monthly_limit_usd, 12)
               OR v_monthly_usage_usd <> pg_catalog.round(v_monthly_usage_usd, 12)
               OR NOT pg_catalog.isfinite(v_cycle_start_at)
               OR NOT pg_catalog.isfinite(v_cycle_end_at)
               OR NOT pg_catalog.isfinite(v_observed_at)
               OR v_cycle_start_at > v_observed_at
               OR v_observed_at >= v_cycle_end_at
               OR v_cycle_start_at > v_now
               OR v_cycle_end_at <= v_now THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
            END IF;
            IF v_observed_at < v_now - INTERVAL '5 minutes'
               OR v_observed_at > v_now + INTERVAL '1 minute' THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE', ERRCODE = 'P0001';
            END IF;
        END IF;
    END LOOP;

    PERFORM public.analysis_beta_pool_lock();
    FOR v_locked_slot IN
        SELECT snapshot.credential_slot
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
    END LOOP;
    IF v_lock_count <> 9 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    FOR v_entry IN SELECT entry FROM pg_catalog.jsonb_array_elements(p_snapshots) AS entry LOOP
        v_slot := v_entry->>'credentialSlot';
        IF v_entry->>'healthState' = 'healthy' THEN
            v_monthly_limit_usd := (v_entry->>'monthlyLimitUsd')::NUMERIC;
            v_monthly_usage_usd := (v_entry->>'monthlyUsageUsd')::NUMERIC;
            v_cycle_start_at := (v_entry->>'billingCycleStartAt')::TIMESTAMP WITH TIME ZONE;
            v_cycle_end_at := (v_entry->>'billingCycleEndAt')::TIMESTAMP WITH TIME ZONE;
            v_observed_at := (v_entry->>'observedAt')::TIMESTAMP WITH TIME ZONE;
        ELSE
            v_monthly_limit_usd := NULL;
            v_monthly_usage_usd := NULL;
            v_cycle_start_at := NULL;
            v_cycle_end_at := NULL;
            v_observed_at := NULL;
        END IF;
        SELECT snapshot.* INTO v_existing
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE snapshot.credential_slot = v_slot;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
        END IF;
        IF v_entry->>'healthState' = 'healthy'
           AND v_existing.health_state = 'healthy'
           AND (v_existing.observed_at > v_observed_at OR (
                v_existing.observed_at = v_observed_at
                AND (v_existing.monthly_limit_usd IS DISTINCT FROM v_monthly_limit_usd
                  OR v_existing.monthly_usage_usd IS DISTINCT FROM v_monthly_usage_usd
                  OR v_existing.billing_cycle_start_at IS DISTINCT FROM v_cycle_start_at
                  OR v_existing.billing_cycle_end_at IS DISTINCT FROM v_cycle_end_at))) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_apify_credit_snapshots AS snapshot
        SET monthly_limit_usd = v_monthly_limit_usd,
            monthly_usage_usd = v_monthly_usage_usd,
            billing_cycle_start_at = v_cycle_start_at,
            billing_cycle_end_at = v_cycle_end_at,
            observed_at = v_observed_at,
            health_state = (v_entry->>'healthState'),
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
    SELECT snapshot.credential_slot, snapshot.observed_at,
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
    ) AS debit ON TRUE
    WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot);
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_pool_effective_capacity_snapshot()
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
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_result JSONB;
BEGIN
    IF p_max_age_seconds IS NULL OR p_max_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID', ERRCODE = 'P0001';
    END IF;
    WITH required_slots(credential_slot, slot_order) AS (
        VALUES ('primary'::TEXT, 1), ('tertiary'::TEXT, 2),
               ('quaternary'::TEXT, 3), ('quinary'::TEXT, 4),
               ('senary'::TEXT, 5), ('septenary'::TEXT, 6),
               ('octonary'::TEXT, 7), ('nonary'::TEXT, 8),
               ('tenth'::TEXT, 9)
    ), held AS (
        SELECT reservation.credential_slot,
               pg_catalog.sum(reservation.reserved_usd) AS reserved_usd
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.lifecycle_state IN ('preflight_held', 'active')
        GROUP BY reservation.credential_slot
    ), decorated AS (
        SELECT required_slots.credential_slot,
               required_slots.slot_order,
               snapshot.monthly_limit_usd,
               snapshot.monthly_usage_usd,
               snapshot.billing_cycle_start_at,
               snapshot.billing_cycle_end_at,
               snapshot.observed_at,
               COALESCE(snapshot.health_state, 'unhealthy') AS health_state,
               COALESCE(snapshot.manually_excluded, FALSE) AS manually_excluded,
               CASE
                   WHEN snapshot.credential_slot IS NULL
                     OR snapshot.health_state IS DISTINCT FROM 'healthy'
                     OR snapshot.monthly_limit_usd IS NULL
                     OR snapshot.monthly_usage_usd IS NULL
                     OR snapshot.billing_cycle_start_at IS NULL
                     OR snapshot.billing_cycle_end_at IS NULL
                     OR snapshot.observed_at IS NULL
                     THEN 'missing'
                   WHEN snapshot.observed_at < v_now - pg_catalog.make_interval(secs => p_max_age_seconds)
                     OR snapshot.observed_at > v_now + INTERVAL '1 minute'
                     OR snapshot.billing_cycle_start_at > v_now
                     OR snapshot.billing_cycle_end_at <= v_now
                     THEN 'stale'
                   ELSE 'fresh'
               END AS freshness_state,
               held.reserved_usd
        FROM required_slots
        LEFT JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = required_slots.credential_slot
        LEFT JOIN held ON held.credential_slot = required_slots.credential_slot
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'credentialSlot', decorated.credential_slot,
        'monthlyLimitUsd', decorated.monthly_limit_usd,
        'monthlyUsageUsd', decorated.monthly_usage_usd,
        'billingCycleStartAt', decorated.billing_cycle_start_at,
        'billingCycleEndAt', decorated.billing_cycle_end_at,
        'observedAt', decorated.observed_at,
        'healthState', decorated.health_state,
        'freshnessState', decorated.freshness_state,
        'manuallyExcluded', decorated.manually_excluded,
        'effectiveHeadroomUsd', CASE
            WHEN decorated.freshness_state <> 'fresh' THEN NULL
            ELSE GREATEST(
                decorated.monthly_limit_usd - decorated.monthly_usage_usd
                - COALESCE(decorated.reserved_usd, 0::NUMERIC)
                - public.analysis_beta_pool_effective_local_debit_usd(
                    decorated.credential_slot, decorated.observed_at
                ), 0::NUMERIC)
        END
    ) ORDER BY decorated.slot_order)
    INTO v_result
    FROM decorated;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_credit_pool(INTEGER)
    TO service_role;

-- One service-only read model covers operator/paid monitoring for all ten
-- accounts. It reuses the beta snapshot rows but keeps secondary outside all
-- free-pool capacity functions. A missing/unhealthy/stale row never becomes a
-- numeric zero, so operators can distinguish unavailable data from no credit.
CREATE OR REPLACE FUNCTION public.load_analysis_apify_account_credit_inventory(
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
    IF p_max_age_seconds IS NULL OR p_max_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_INVENTORY_INVALID', ERRCODE = 'P0001';
    END IF;

    WITH required_slots(credential_slot, workload_role, slot_order) AS (
        VALUES
            ('primary'::TEXT, 'free'::TEXT, 1),
            ('secondary'::TEXT, 'paid'::TEXT, 2),
            ('tertiary'::TEXT, 'free'::TEXT, 3),
            ('quaternary'::TEXT, 'free'::TEXT, 4),
            ('quinary'::TEXT, 'free'::TEXT, 5),
            ('senary'::TEXT, 'free'::TEXT, 6),
            ('septenary'::TEXT, 'free'::TEXT, 7),
            ('octonary'::TEXT, 'free'::TEXT, 8),
            ('nonary'::TEXT, 'free'::TEXT, 9),
            ('tenth'::TEXT, 'free'::TEXT, 10)
    ), latest_exclusion AS (
        SELECT snapshot.credential_slot,
               snapshot.manually_excluded AS excluded
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
    ), capacity AS (
        SELECT effective.credential_slot, effective.effective_capacity_usd
        FROM public.analysis_beta_pool_effective_capacity_snapshot() AS effective
    ), inventory AS (
        SELECT required_slots.credential_slot,
               required_slots.workload_role,
               required_slots.slot_order,
               snapshot.health_state,
               snapshot.monthly_limit_usd,
               snapshot.monthly_usage_usd,
               snapshot.billing_cycle_start_at,
               snapshot.billing_cycle_end_at,
               snapshot.observed_at,
               snapshot.refreshed_at,
               capacity.effective_capacity_usd,
               COALESCE(latest_exclusion.excluded, FALSE) AS manually_excluded,
               CASE
                   WHEN snapshot.credential_slot IS NULL
                     OR snapshot.health_state IS DISTINCT FROM 'healthy'
                     OR snapshot.monthly_limit_usd IS NULL
                     OR snapshot.monthly_usage_usd IS NULL
                     OR snapshot.billing_cycle_start_at IS NULL
                     OR snapshot.billing_cycle_end_at IS NULL
                     OR snapshot.observed_at IS NULL
                     THEN 'missing'
                   WHEN snapshot.observed_at < v_now - pg_catalog.make_interval(secs => p_max_age_seconds)
                     OR snapshot.observed_at > v_now + INTERVAL '1 minute'
                     OR snapshot.billing_cycle_start_at > v_now
                     OR snapshot.billing_cycle_end_at <= v_now
                     THEN 'stale'
                   ELSE 'fresh'
               END AS freshness_state
        FROM required_slots
        LEFT JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = required_slots.credential_slot
        LEFT JOIN capacity
          ON capacity.credential_slot = required_slots.credential_slot
        LEFT JOIN latest_exclusion
          ON latest_exclusion.credential_slot = required_slots.credential_slot
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'credentialSlot', inventory.credential_slot,
        'workloadRole', inventory.workload_role,
        'healthState', COALESCE(inventory.health_state, 'missing'),
        'freshnessState', inventory.freshness_state,
        'monthlyLimitUsd', inventory.monthly_limit_usd,
        'monthlyUsageUsd', inventory.monthly_usage_usd,
        'effectiveRemainingUsd', CASE
            WHEN inventory.freshness_state <> 'fresh' THEN NULL
            WHEN inventory.workload_role = 'free' THEN inventory.effective_capacity_usd
            ELSE GREATEST(
                inventory.monthly_limit_usd - inventory.monthly_usage_usd,
                0::NUMERIC
            )
        END,
        'billingCycleStartAt', inventory.billing_cycle_start_at,
        'billingCycleEndAt', inventory.billing_cycle_end_at,
        'cycleResetAt', inventory.billing_cycle_end_at,
        'observedAt', inventory.observed_at,
        'refreshedAt', inventory.refreshed_at,
        'manuallyExcluded', CASE
            WHEN inventory.workload_role = 'free' THEN inventory.manually_excluded
            ELSE FALSE
        END
    ) ORDER BY inventory.slot_order)
    INTO v_result
    FROM inventory;

    RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_apify_account_credit_inventory(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_apify_account_credit_inventory(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_apify_account_credit_inventory(INTEGER) IS
    'Service-only sanitized exact-ten Apify balance/cycle inventory; missing or stale values remain explicit and secondary is paid-only.';

-- Paid/operator refresh is deliberately one-row and secondary-only. Free
-- preflight refresh remains an independent exact-nine atomic operation and
-- never requires this account or its secret.
CREATE OR REPLACE FUNCTION public.upsert_analysis_apify_paid_credit_snapshot(
    p_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_slot TEXT;
    v_monthly_limit_usd NUMERIC;
    v_monthly_usage_usd NUMERIC;
    v_cycle_start_at TIMESTAMP WITH TIME ZONE;
    v_cycle_end_at TIMESTAMP WITH TIME ZONE;
    v_observed_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR NOT p_snapshot ?& ARRAY[
            'credentialSlot', 'monthlyLimitUsd', 'monthlyUsageUsd',
            'billingCycleStartAt', 'billingCycleEndAt', 'observedAt', 'healthState'
       ]
       OR p_snapshot - ARRAY[
            'credentialSlot', 'monthlyLimitUsd', 'monthlyUsageUsd',
            'billingCycleStartAt', 'billingCycleEndAt', 'observedAt', 'healthState'
       ] <> '{}'::JSONB
       OR p_snapshot->>'credentialSlot' IS DISTINCT FROM 'secondary'
       OR p_snapshot->>'healthState' IS DISTINCT FROM 'healthy'
       OR pg_catalog.jsonb_typeof(p_snapshot->'monthlyLimitUsd') <> 'number'
       OR pg_catalog.jsonb_typeof(p_snapshot->'monthlyUsageUsd') <> 'number'
       OR pg_catalog.jsonb_typeof(p_snapshot->'billingCycleStartAt') <> 'string'
       OR pg_catalog.jsonb_typeof(p_snapshot->'billingCycleEndAt') <> 'string'
       OR pg_catalog.jsonb_typeof(p_snapshot->'observedAt') <> 'string' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_INVENTORY_INVALID', ERRCODE = 'P0001';
    END IF;

    BEGIN
        v_slot := p_snapshot->>'credentialSlot';
        v_monthly_limit_usd := (p_snapshot->>'monthlyLimitUsd')::NUMERIC;
        v_monthly_usage_usd := (p_snapshot->>'monthlyUsageUsd')::NUMERIC;
        v_cycle_start_at := (p_snapshot->>'billingCycleStartAt')::TIMESTAMP WITH TIME ZONE;
        v_cycle_end_at := (p_snapshot->>'billingCycleEndAt')::TIMESTAMP WITH TIME ZONE;
        v_observed_at := (p_snapshot->>'observedAt')::TIMESTAMP WITH TIME ZONE;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
        OR invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_INVENTORY_INVALID', ERRCODE = 'P0001';
    END;

    IF v_slot IS DISTINCT FROM 'secondary'
       OR v_monthly_limit_usd NOT BETWEEN 0 AND 100000
       OR v_monthly_usage_usd NOT BETWEEN 0 AND 100000
       OR v_monthly_limit_usd <> pg_catalog.round(v_monthly_limit_usd, 12)
       OR v_monthly_usage_usd <> pg_catalog.round(v_monthly_usage_usd, 12)
       OR NOT pg_catalog.isfinite(v_cycle_start_at)
       OR NOT pg_catalog.isfinite(v_cycle_end_at)
       OR NOT pg_catalog.isfinite(v_observed_at)
       OR v_cycle_start_at > v_observed_at
       OR v_observed_at >= v_cycle_end_at
       OR v_cycle_start_at > v_now
       OR v_cycle_end_at <= v_now
       OR v_observed_at < v_now - INTERVAL '5 minutes'
       OR v_observed_at > v_now + INTERVAL '1 minute' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_INVENTORY_INVALID', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_apify_credit_snapshots AS snapshot
    SET monthly_limit_usd = v_monthly_limit_usd,
        monthly_usage_usd = v_monthly_usage_usd,
        billing_cycle_start_at = v_cycle_start_at,
        billing_cycle_end_at = v_cycle_end_at,
        observed_at = v_observed_at,
        health_state = 'healthy',
        refreshed_at = v_now
    WHERE snapshot.credential_slot = 'secondary';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_APIFY_ACCOUNT_INVENTORY_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    RETURN public.load_analysis_apify_account_credit_inventory(300);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_analysis_apify_paid_credit_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_apify_paid_credit_snapshot(JSONB)
    TO service_role;

COMMENT ON FUNCTION public.upsert_analysis_apify_paid_credit_snapshot(JSONB) IS
    'Service-only secondary paid/operator snapshot refresh; accepts sanitized aggregate balance/cycle fields only.';

-- This is the implementation called by the fenced prepare RPC.  Keep the
-- historical public signature unavailable; only the generation/claim-bound
-- prepare function may reach this primitive.
CREATE OR REPLACE FUNCTION public.hold_analysis_beta_apify_preflight_credit_unfenced_20260802(
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
    v_lock_count INTEGER := 0;
    v_selected_slot TEXT;
    v_capacity NUMERIC;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR (p_credential_slot IS NOT NULL
           AND NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot))
       OR p_target_profile_budget_usd IS NULL
       OR p_target_profile_budget_usd NOT BETWEEN 0.000000000001 AND 1000
       OR p_target_profile_budget_usd <> pg_catalog.round(p_target_profile_budget_usd, 12)
       OR p_max_snapshot_age_seconds IS NULL
       OR p_max_snapshot_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT allocation.* INTO v_existing
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF FOUND THEN
        SELECT reservation.* INTO v_existing_reservation
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_existing.id
          AND reservation.operation_family = 'target-profile'
        FOR UPDATE;
        IF NOT FOUND
           OR v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
           OR (p_credential_slot IS NOT NULL
               AND v_existing_reservation.credential_slot IS DISTINCT FROM p_credential_slot)
           OR v_existing_reservation.reserved_usd IS DISTINCT FROM p_target_profile_budget_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
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
            SELECT 1 FROM public.analysis_preflight_provider_runs AS provider_run
            WHERE provider_run.preflight_id = p_preflight_id
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    PERFORM public.analysis_beta_pool_lock();
    FOR v_locked_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
    END LOOP;

    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;
    IF v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at) OR v_grant.expires_at <= v_now
       )) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    IF v_lock_count <> 9 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    SELECT capacity.credential_slot, capacity.effective_capacity_usd
    INTO v_selected_slot, v_capacity
    FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
    JOIN public.analysis_apify_credit_snapshots AS snapshot
      ON snapshot.credential_slot = capacity.credential_slot
    WHERE snapshot.health_state = 'healthy'
      AND snapshot.monthly_limit_usd IS NOT NULL
      AND snapshot.monthly_usage_usd IS NOT NULL
      AND snapshot.observed_at IS NOT NULL
      AND snapshot.billing_cycle_start_at <= v_now
      AND snapshot.billing_cycle_end_at > v_now
      AND snapshot.observed_at >= v_now - pg_catalog.make_interval(secs => p_max_snapshot_age_seconds)
      AND snapshot.observed_at <= v_now + INTERVAL '1 minute'
      AND snapshot.manually_excluded IS NOT TRUE
      AND capacity.effective_capacity_usd >= p_target_profile_budget_usd
      AND (p_credential_slot IS NULL OR capacity.credential_slot = p_credential_slot)
    ORDER BY capacity.effective_capacity_usd - p_target_profile_budget_usd,
        CASE capacity.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
    LIMIT 1;
    IF v_selected_slot IS NULL OR v_capacity < p_target_profile_budget_usd THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET analysis_entry_channel = 'betatest'
    WHERE preflight.id = p_preflight_id;
    INSERT INTO public.analysis_beta_pool_allocations(
        preflight_id, user_id, lifecycle_state, policy_version,
        expires_at, created_at, updated_at
    ) VALUES (
        p_preflight_id, p_user_id, 'preflight_held', 'betatest-free-pool-v1',
        v_preflight.expires_at, v_now, v_now
    ) RETURNING * INTO v_created;
    INSERT INTO public.analysis_beta_pool_reservations(
        allocation_id, operation_family, credential_slot, reserved_usd,
        lifecycle_state, created_at, updated_at
    ) VALUES (
        v_created.id, 'target-profile', v_selected_slot,
        p_target_profile_budget_usd, 'preflight_held', v_now, v_now
    );
    RETURN public.analysis_beta_pool_allocation_json(v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.hold_analysis_beta_apify_preflight_credit_unfenced_20260802(
    UUID, UUID, TEXT, NUMERIC, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

-- Replace the six-row predecessor behind the policy-binding wrapper.  All
-- identity, lifecycle, job, and frozen-map checks remain explicit here so the
-- widened pool cannot turn a malformed replay into a new allocation.
CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(
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
    v_lock_count INTEGER := 0;
    v_job_count INTEGER := 0;
    v_job_ineligible BOOLEAN := FALSE;
    v_capacity NUMERIC;
BEGIN
    IF p_preflight_id IS NULL
       OR p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_operation_slot_map IS NULL
       OR NOT public.analysis_beta_valid_operation_slot_map(p_operation_slot_map)
       OR p_operation_budget_map IS NULL
       OR NOT public.analysis_beta_valid_operation_budget_map(p_operation_budget_map)
       OR p_max_snapshot_age_seconds IS NULL
       OR p_max_snapshot_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;
    SELECT allocation.* INTO v_existing
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    IF v_existing.lifecycle_state = 'active' THEN
        IF v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.request_id IS DISTINCT FROM p_request_id
           OR v_existing.selected_plan_id IS DISTINCT FROM p_selected_plan_id
           OR v_existing.operation_slot_map IS DISTINCT FROM p_operation_slot_map
           OR v_existing.operation_budget_map IS DISTINCT FROM p_operation_budget_map THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_beta_pool_allocation_json(v_existing);
    END IF;

    SELECT reservation.* INTO v_target_reservation
    FROM public.analysis_beta_pool_reservations AS reservation
    WHERE reservation.allocation_id = v_existing.id
      AND reservation.operation_family = 'target-profile'
    FOR UPDATE;
    IF NOT FOUND
       OR v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.lifecycle_state IS DISTINCT FROM 'preflight_held'
       OR v_existing.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
       OR v_target_reservation.credential_slot IS DISTINCT FROM p_operation_slot_map->>'target-profile'
       OR v_target_reservation.reserved_usd IS DISTINCT FROM (p_operation_budget_map->>'target-profile')::NUMERIC THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.user_id IS DISTINCT FROM p_user_id
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_existing.expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    SELECT grant_row.* INTO v_grant
    FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
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
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    FOR v_job IN
        SELECT job.* FROM public.analysis_pipeline_jobs AS job
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
    IF v_job_count = 0 OR v_job_ineligible
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = p_request_id
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;

    PERFORM public.analysis_beta_pool_lock();
    FOR v_locked_snapshot IN
        SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
    END LOOP;

    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at <= v_now OR v_existing.expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE', ERRCODE = 'P0001';
    END IF;
    IF v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND (
            NOT pg_catalog.isfinite(v_grant.expires_at) OR v_grant.expires_at <= v_now
       )) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    IF v_lock_count <> 9 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;

    -- The target reservation is immutable, but its account must still be
    -- healthy and within the current snapshot fence at activation time.
    SELECT capacity.effective_capacity_usd INTO v_capacity
    FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
    JOIN public.analysis_apify_credit_snapshots AS snapshot
      ON snapshot.credential_slot = capacity.credential_slot
    WHERE capacity.credential_slot = v_target_reservation.credential_slot
      AND snapshot.health_state = 'healthy'
      AND snapshot.monthly_limit_usd IS NOT NULL
      AND snapshot.monthly_usage_usd IS NOT NULL
      AND snapshot.observed_at IS NOT NULL
      AND snapshot.billing_cycle_start_at <= v_now
      AND snapshot.billing_cycle_end_at > v_now
      AND snapshot.observed_at >= v_now - pg_catalog.make_interval(secs => p_max_snapshot_age_seconds)
      AND snapshot.observed_at <= v_now + INTERVAL '1 minute'
      AND snapshot.manually_excluded IS NOT TRUE
      AND capacity.effective_capacity_usd >= v_target_reservation.reserved_usd;
    IF v_capacity IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    FOR v_proposed IN
        SELECT slot_entry.slot_value AS credential_slot,
               pg_catalog.sum((p_operation_budget_map->>slot_entry.operation_family)::NUMERIC) AS proposed_usd
        FROM pg_catalog.jsonb_each_text(p_operation_slot_map) AS slot_entry(operation_family, slot_value)
        WHERE slot_entry.operation_family <> 'target-profile'
        GROUP BY slot_entry.slot_value
        ORDER BY slot_entry.slot_value
    LOOP
        SELECT capacity.effective_capacity_usd INTO v_capacity
        FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
        JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = capacity.credential_slot
        WHERE capacity.credential_slot = v_proposed.credential_slot
          AND snapshot.health_state = 'healthy'
          AND snapshot.monthly_limit_usd IS NOT NULL
          AND snapshot.monthly_usage_usd IS NOT NULL
          AND snapshot.observed_at IS NOT NULL
          AND snapshot.billing_cycle_start_at <= v_now
          AND snapshot.billing_cycle_end_at > v_now
          AND snapshot.observed_at >= v_now - pg_catalog.make_interval(secs => p_max_snapshot_age_seconds)
          AND snapshot.observed_at <= v_now + INTERVAL '1 minute'
          AND snapshot.manually_excluded IS NOT TRUE;
        IF v_capacity IS NULL OR v_capacity < v_proposed.proposed_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    INSERT INTO public.analysis_beta_pool_reservations(
        allocation_id, operation_family, credential_slot, reserved_usd,
        lifecycle_state, created_at, updated_at
    )
    SELECT v_existing.id, slot_entry.operation_family, slot_entry.slot_value,
           (p_operation_budget_map->>slot_entry.operation_family)::NUMERIC,
           'preflight_held', v_now, v_now
    FROM pg_catalog.jsonb_each_text(p_operation_slot_map) AS slot_entry(operation_family, slot_value)
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

REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

-- The public unbound wrapper is deliberately narrow; policy binding remains in
-- the historical activate_analysis_beta_apify_request_credit wrapper.
CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(
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
BEGIN
    -- The delegated implementation locks all exact nine snapshots under the
    -- shared analysis-apify-free-pool advisory lock before validating capacity.
    RETURN public.activate_analysis_beta_apify_request_credit_unbound_pre_capacity_hardening(
        p_preflight_id, p_request_id, p_user_id, p_selected_plan_id,
        p_operation_slot_map, p_operation_budget_map, p_max_snapshot_age_seconds
    );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_analysis_beta_pool_reservation_headroom()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
    v_capacity NUMERIC;
    v_locked INTEGER := 0;
BEGIN
    PERFORM public.analysis_beta_pool_lock();
    FOR v_snapshot IN
        SELECT snapshot.* FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
        FOR UPDATE
    LOOP
        v_locked := v_locked + 1;
    END LOOP;
    IF v_locked <> 9 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE', ERRCODE = 'P0001';
    END IF;
    SELECT snapshot.* INTO v_snapshot
    FROM public.analysis_apify_credit_snapshots AS snapshot
    WHERE snapshot.credential_slot = NEW.credential_slot;
    SELECT capacity.effective_capacity_usd INTO v_capacity
    FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
    WHERE capacity.credential_slot = NEW.credential_slot;
    IF NOT FOUND
       OR v_snapshot.health_state IS DISTINCT FROM 'healthy'
       OR v_snapshot.observed_at IS NULL
       OR public.analysis_apify_account_is_excluded(NEW.credential_slot)
       OR v_capacity IS NULL
       OR v_capacity < NEW.reserved_usd THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_analysis_beta_pool_reservation_headroom()
    FROM PUBLIC, anon, authenticated, service_role;

-- New ordinary/B-lite/fresh-free reservations use the existing provider-run
-- ledger as their durable slot record. A NULL slot means "best fit" and is
-- resolved while the nine snapshot rows and all existing provider reservations
-- are fenced under one transaction lock. No account token or provider payload
-- is copied into this allocator.
CREATE OR REPLACE FUNCTION public.reserve_analysis_apify_free_provider_slot(
    p_preflight_id UUID,
    p_max_charge_usd NUMERIC
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_snapshot public.analysis_apify_credit_snapshots%ROWTYPE;
    v_slot TEXT;
    v_capacity NUMERIC;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lock_count INTEGER := 0;
BEGIN
    IF p_preflight_id IS NULL
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.beta_entry_provenance IS NOT NULL
       OR v_preflight.analysis_entry_channel = 'betatest' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    PERFORM public.analysis_beta_pool_lock();
    FOR v_snapshot IN
        SELECT snapshot.*
        FROM public.analysis_apify_credit_snapshots AS snapshot
        WHERE public.analysis_beta_valid_apify_credential_slot(snapshot.credential_slot)
        ORDER BY CASE snapshot.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
        FOR UPDATE
    LOOP
        v_lock_count := v_lock_count + 1;
    END LOOP;

    SELECT candidate.credential_slot, candidate.effective_capacity_usd
    INTO v_slot, v_capacity
    FROM (
        SELECT capacity.credential_slot,
               capacity.effective_capacity_usd
                 - COALESCE(provider_reservation.reserved_usd, 0::NUMERIC)
                   AS effective_capacity_usd,
               snapshot.observed_at
        FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
        JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = capacity.credential_slot
        LEFT JOIN LATERAL (
            SELECT pg_catalog.sum(CASE
                WHEN provider_run.status IN ('starting', 'running')
                    THEN provider_run.max_charge_usd
                WHEN provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                     AND (
                         provider_run.usage_reconciled_at IS NULL
                         OR snapshot.observed_at < provider_run.usage_reconciled_at
                     )
                    THEN COALESCE(provider_run.actual_usage_usd, provider_run.max_charge_usd)
                ELSE 0::NUMERIC
            END) AS reserved_usd
            FROM public.analysis_preflight_provider_runs AS provider_run
            JOIN public.analysis_preflights AS owner_preflight
              ON owner_preflight.id = provider_run.preflight_id
            WHERE provider_run.credential_slot = capacity.credential_slot
              AND owner_preflight.beta_entry_provenance IS NULL
              AND owner_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'
        ) AS provider_reservation ON TRUE
        WHERE snapshot.health_state = 'healthy'
          AND snapshot.monthly_limit_usd IS NOT NULL
          AND snapshot.monthly_usage_usd IS NOT NULL
          AND snapshot.billing_cycle_start_at IS NOT NULL
          AND snapshot.billing_cycle_end_at IS NOT NULL
          AND snapshot.observed_at IS NOT NULL
          AND snapshot.billing_cycle_start_at <= v_now
          AND snapshot.billing_cycle_end_at > v_now
          AND snapshot.observed_at >= v_now - INTERVAL '5 minutes'
          AND snapshot.observed_at <= v_now + INTERVAL '1 minute'
          AND snapshot.manually_excluded IS NOT TRUE
          AND capacity.effective_capacity_usd
                - COALESCE(provider_reservation.reserved_usd, 0::NUMERIC)
                >= p_max_charge_usd
    ) AS candidate
    ORDER BY candidate.effective_capacity_usd - p_max_charge_usd,
        CASE candidate.credential_slot
            WHEN 'primary' THEN 1 WHEN 'tertiary' THEN 2
            WHEN 'quaternary' THEN 3 WHEN 'quinary' THEN 4
            WHEN 'senary' THEN 5 WHEN 'septenary' THEN 6
            WHEN 'octonary' THEN 7 WHEN 'nonary' THEN 8 WHEN 'tenth' THEN 9
        END
    LIMIT 1;

    IF v_lock_count <> 9 OR v_slot IS NULL OR v_capacity < p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    RETURN v_slot;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_apify_free_provider_slot(UUID, NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;

-- Keep the reviewed beta/paid validator body intact and add only a nullable
-- slot wrapper. Existing persisted rows are read first so a replay always
-- delegates using its recorded slot instead of remapping it.
DO $$
BEGIN
    IF pg_catalog.to_regprocedure(
        'public.reserve_analysis_preflight_provider_run(uuid,uuid,text,text,numeric)'
    ) IS NOT NULL THEN
        ALTER FUNCTION public.reserve_analysis_preflight_provider_run(
            UUID, UUID, TEXT, TEXT, NUMERIC
        ) RENAME TO reserve_analysis_preflight_provider_run_fixed_20260904;
        REVOKE ALL ON FUNCTION public.reserve_analysis_preflight_provider_run_fixed_20260904(
            UUID, UUID, TEXT, TEXT, NUMERIC
        ) FROM PUBLIC, anon, authenticated, service_role;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_analysis_preflight_provider_run(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_slot TEXT := p_credential_slot;
    v_existing public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_credential_slot IS NULL THEN
        -- Serialize the read-before-select with the allocator. Without this
        -- preflight lock, two NULL-slot callers could both observe no row,
        -- then the second would conflict against the first chosen slot.
        PERFORM 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = p_preflight_id
        FOR UPDATE;
        SELECT provider_run.* INTO v_existing
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = p_preflight_id
          AND provider_run.operation_key = 'target-profile-fallback'
        FOR UPDATE;
        IF FOUND THEN
            v_slot := v_existing.credential_slot;
        ELSE
            v_slot := public.reserve_analysis_apify_free_provider_slot(
                p_preflight_id, p_max_charge_usd
            );
        END IF;
    END IF;
    IF v_slot IS NULL
       OR NOT public.analysis_beta_valid_apify_credential_slot(v_slot) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001';
    END IF;
    RETURN public.reserve_analysis_preflight_provider_run_fixed_20260904(
        p_preflight_id, p_claim_token, p_input_hash, v_slot, p_max_charge_usd
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_preflight_provider_run(
    UUID, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_preflight_provider_run(
    UUID, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

DO $$
BEGIN
    IF pg_catalog.to_regprocedure(
        'public.reserve_analysis_v2_fresh_admission_provider_run(uuid,integer,uuid,text,text,numeric)'
    ) IS NOT NULL THEN
        ALTER FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
            UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
        ) RENAME TO reserve_analysis_v2_fresh_admission_provider_run_fixed_20260904;
        REVOKE ALL ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run_fixed_20260904(
            UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
        ) FROM PUBLIC, anon, authenticated, service_role;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_slot TEXT := p_credential_slot;
    v_operation_key TEXT := 'target-profile-fresh-admission:g'
        || p_admission_generation::TEXT;
    v_existing public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_credential_slot IS NULL THEN
        -- See the initial preflight wrapper: serialize the row lookup with
        -- the free-pool allocator so a concurrent retry reuses its slot.
        PERFORM 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = p_preflight_id
        FOR UPDATE;
        SELECT provider_run.* INTO v_existing
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = p_preflight_id
          AND provider_run.operation_key = v_operation_key
        FOR UPDATE;
        IF FOUND THEN
            v_slot := v_existing.credential_slot;
        ELSE
            v_slot := public.reserve_analysis_apify_free_provider_slot(
                p_preflight_id, p_max_charge_usd
            );
        END IF;
    END IF;
    IF v_slot IS NULL
       OR NOT public.analysis_beta_valid_apify_credential_slot(v_slot) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001';
    END IF;
    RETURN public.reserve_analysis_v2_fresh_admission_provider_run_fixed_20260904(
        p_preflight_id, p_admission_generation, p_claim_token,
        p_input_hash, v_slot, p_max_charge_usd
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_pool_observability(
    p_max_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '5s'
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_result JSONB;
BEGIN
    IF p_max_age_seconds IS NULL OR p_max_age_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POOL_OBSERVABILITY_INVALID', ERRCODE = 'P0001';
    END IF;
    WITH required_slots(credential_slot) AS (
        VALUES ('primary'::TEXT), ('tertiary'::TEXT), ('quaternary'::TEXT),
               ('quinary'::TEXT), ('senary'::TEXT), ('septenary'::TEXT),
               ('octonary'::TEXT), ('nonary'::TEXT), ('tenth'::TEXT)
    ), capacity AS (
        SELECT effective.credential_slot, effective.effective_capacity_usd
        FROM public.analysis_beta_pool_effective_capacity_snapshot() AS effective
    ), snapshot_health AS (
        SELECT pg_catalog.count(*) FILTER (
            WHERE snapshot.credential_slot IS NULL
               OR snapshot.health_state IS DISTINCT FROM 'healthy'
               OR snapshot.monthly_limit_usd IS NULL
               OR snapshot.monthly_usage_usd IS NULL
               OR snapshot.observed_at IS NULL
               OR snapshot.billing_cycle_start_at IS NULL
               OR snapshot.billing_cycle_end_at IS NULL
               OR snapshot.observed_at < v_now - pg_catalog.make_interval(secs => p_max_age_seconds)
               OR snapshot.observed_at > v_now + INTERVAL '1 minute'
               OR snapshot.billing_cycle_start_at > v_now
               OR snapshot.billing_cycle_end_at <= v_now
        )::INTEGER AS stale_snapshot_count
        FROM required_slots
        LEFT JOIN public.analysis_apify_credit_snapshots AS snapshot
          ON snapshot.credential_slot = required_slots.credential_slot
    ), capacity_health AS (
        SELECT COALESCE(pg_catalog.sum(GREATEST(COALESCE(capacity.effective_capacity_usd, 0), 0)), 0::NUMERIC)
                   AS total_effective_headroom_usd,
               pg_catalog.count(*) FILTER (WHERE capacity.effective_capacity_usd < 0)::INTEGER
                   AS overcommitted_slot_count
        FROM required_slots
        LEFT JOIN capacity ON capacity.credential_slot = required_slots.credential_slot
    ), allocation_health AS (
        SELECT pg_catalog.count(*) FILTER (
            WHERE allocation.lifecycle_state IN ('preflight_held', 'active')
        )::INTEGER AS active_allocation_count
        FROM public.analysis_beta_pool_allocations AS allocation
    ), terminal_unsettled AS (
        SELECT COALESCE(request.completed_at, allocation.updated_at) AS terminal_at
        FROM public.analysis_beta_pool_allocations AS allocation
        JOIN public.analysis_requests AS request ON request.id = allocation.request_id
        WHERE allocation.lifecycle_state = 'active' AND request.status IN ('completed', 'failed')
        UNION ALL
        SELECT COALESCE(preflight.blocked_at,
                        CASE WHEN preflight.expires_at <= v_now THEN preflight.expires_at END,
                        preflight.updated_at, allocation.updated_at) AS terminal_at
        FROM public.analysis_beta_pool_allocations AS allocation
        JOIN public.analysis_preflights AS preflight ON preflight.id = allocation.preflight_id
        WHERE allocation.lifecycle_state = 'preflight_held'
          AND (preflight.status IN ('blocked', 'expired') OR preflight.expires_at <= v_now)
    ), settlement_health AS (
        SELECT COALESCE(pg_catalog.floor(LEAST(GREATEST(
            EXTRACT(EPOCH FROM (v_now - pg_catalog.min(terminal_at))) * 1000, 0
        ), 31536000000)), 0)::BIGINT AS settlement_lag_ms
        FROM terminal_unsettled
    )
    SELECT pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'observedAt', v_now,
        'runtimeEnabled', COALESCE((
            SELECT gate_row.enabled FROM public.analysis_beta_runtime_gate AS gate_row
            WHERE gate_row.singleton = TRUE
        ), FALSE),
        'totalEffectiveHeadroomUsd', capacity_health.total_effective_headroom_usd,
        'staleSnapshotCount', snapshot_health.stale_snapshot_count,
        'activeAllocationCount', allocation_health.active_allocation_count,
        'settlementLagMs', settlement_health.settlement_lag_ms,
        'overcommittedSlotCount', capacity_health.overcommitted_slot_count
    ) INTO v_result
    FROM snapshot_health CROSS JOIN capacity_health
    CROSS JOIN allocation_health CROSS JOIN settlement_health;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_pool_observability(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_pool_observability(INTEGER)
    TO service_role;

COMMIT;
