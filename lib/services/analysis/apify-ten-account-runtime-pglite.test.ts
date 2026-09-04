import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260904120000_expand_apify_free_pool_to_nine.sql',
);
const migration = readFileSync(migrationPath, 'utf8');
const slots = [
    'primary', 'tertiary', 'quaternary', 'quinary', 'senary',
    'septenary', 'octonary', 'nonary', 'tenth',
] as const;
const allSlots = ['primary', 'secondary', ...slots.slice(1)] as const;
const observedAt = new Date(Date.now() - 1_000).toISOString();
const freePreflightId = '123e4567-e89b-42d3-a456-426614174000';
const freeClaimToken = '223e4567-e89b-42d3-a456-426614174000';
const freeInputHash = 'a'.repeat(64);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.users(id UUID PRIMARY KEY);
CREATE TABLE public.analysis_preflights(
 id UUID PRIMARY KEY, user_id UUID, status TEXT, access_mode TEXT,
 analysis_entry_channel TEXT, dispatch_state TEXT, dispatch_generation INTEGER,
 dispatch_token UUID, dispatch_reserved_at TIMESTAMPTZ, dispatched_at TIMESTAMPTZ,
 consumed_request_id UUID, expires_at TIMESTAMPTZ, blocked_at TIMESTAMPTZ,
 beta_entry_provenance TEXT, beta_prepare_generation INTEGER, beta_prepare_token UUID,
 beta_prepare_state TEXT, beta_prepare_lease_token UUID, beta_prepare_lease_expires_at TIMESTAMPTZ,
 beta_prepare_dispatch_state TEXT, beta_prepare_retry_exhausted_at TIMESTAMPTZ,
 beta_prepare_completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_requests(
 id UUID PRIMARY KEY, user_id UUID, preflight_id UUID, pipeline_version TEXT,
 plan_access_mode_snapshot TEXT, test_entitlement_jti_hash TEXT,
 selected_plan_id_snapshot TEXT, status TEXT, background_processing BOOLEAN,
 analysis_entry_channel TEXT, target_instagram_id TEXT, completed_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_pipeline_jobs(
 request_id UUID, job_key TEXT, status TEXT, dispatch_state TEXT,
 dispatch_generation INTEGER, dispatch_reservation_token UUID,
 dispatch_reserved_at TIMESTAMPTZ, dispatched_at TIMESTAMPTZ,
 dispatch_task_name TEXT, delivered_at TIMESTAMPTZ, first_started_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_preflight_provider_runs(
 preflight_id UUID NOT NULL, operation_key TEXT NOT NULL,
 input_hash TEXT NOT NULL, logical_provider TEXT NOT NULL DEFAULT 'apify',
 actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
 credential_slot TEXT NOT NULL, max_charge_usd NUMERIC NOT NULL,
 status TEXT NOT NULL DEFAULT 'starting', run_id TEXT,
 actual_usage_usd NUMERIC, reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 run_started_at TIMESTAMPTZ, terminalized_at TIMESTAMPTZ,
 usage_reconciled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (preflight_id, operation_key)
);
CREATE TABLE public.analysis_v2_provider_runs(request_id UUID);
CREATE TABLE public.analysis_provider_admission_budgets(
 budget_key TEXT PRIMARY KEY, workload_role TEXT, logical_provider TEXT,
 credential_slot TEXT, max_active INTEGER, rate_limit_per_minute INTEGER,
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 window_count INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.analysis_provider_admission_budgets(
 budget_key, workload_role, logical_provider, credential_slot,
 max_active, rate_limit_per_minute, window_count
) VALUES
 ('preflight:apify:global', 'preflight', 'apify', NULL, 32, 120, 9),
 ('preflight:apify:primary', 'preflight', 'apify', 'primary', 16, 60, 7),
 ('preflight:apify:quinary', 'preflight', 'apify', 'quinary', 16, 60, 5),
 ('preflight:apify:senary', 'preflight', 'apify', 'senary', 16, 60, 3),
 ('paid:apify:global', 'paid', 'apify', NULL, 8, 30, 4),
 ('paid:apify:primary', 'paid', 'apify', 'primary', 8, 30, 2),
 ('paid:apify:secondary', 'paid', 'apify', 'secondary', 8, 30, 1);
CREATE TABLE public.analysis_beta_runtime_gate(singleton BOOLEAN, enabled BOOLEAN);
CREATE TABLE public.analysis_beta_access_grants(
 user_id UUID, enabled BOOLEAN, expires_at TIMESTAMPTZ,
 audit_reference_hash TEXT, granted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
CREATE FUNCTION public.analysis_beta_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path=''
AS $$ SELECT COALESCE(p_slot IN ('primary','secondary','tertiary','quaternary','quinary','senary'), FALSE) $$;
CREATE FUNCTION public.analysis_beta_valid_operation_slot_map(p_map JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path=''
AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_beta_valid_operation_budget_map(p_map JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path=''
AS $$ SELECT TRUE $$;
CREATE TABLE public.analysis_apify_credit_snapshots(
 credential_slot VARCHAR(16) PRIMARY KEY,
 monthly_limit_usd NUMERIC, monthly_usage_usd NUMERIC,
 billing_cycle_start_at TIMESTAMPTZ, billing_cycle_end_at TIMESTAMPTZ,
 observed_at TIMESTAMPTZ, health_state VARCHAR(16) NOT NULL DEFAULT 'unhealthy',
 refreshed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.analysis_apify_credit_snapshots(credential_slot, health_state)
VALUES
    ('primary', 'unhealthy'),
    ('tertiary', 'unhealthy'),
    ('quaternary', 'unhealthy'),
    ('quinary', 'unhealthy'),
    ('senary', 'unhealthy'),
    ('septenary', 'unhealthy');
CREATE TABLE public.analysis_beta_pool_allocations(
 id UUID PRIMARY KEY, preflight_id UUID, request_id UUID, user_id UUID,
 lifecycle_state TEXT, selected_plan_id TEXT, policy_version TEXT,
 operation_slot_map JSONB, operation_budget_map JSONB, expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, activated_at TIMESTAMPTZ,
 settled_at TIMESTAMPTZ, settlement_reason TEXT
);
CREATE TABLE public.analysis_beta_pool_reservations(
 allocation_id UUID, operation_family TEXT, credential_slot TEXT,
 reserved_usd NUMERIC, lifecycle_state TEXT, created_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ, actual_usd NUMERIC DEFAULT 0, released_usd NUMERIC DEFAULT 0,
 reconciliation_watermark TIMESTAMPTZ, settled_at TIMESTAMPTZ, settlement_reason TEXT
);
CREATE TABLE public.analysis_beta_pool_local_debits(
 debit_identity UUID, credential_slot TEXT, actual_usd NUMERIC,
 reconciliation_watermark TIMESTAMPTZ
);
CREATE TABLE public.analysis_beta_pool_reservation_archive(
 allocation_id UUID, operation_family TEXT, credential_slot TEXT,
 reserved_usd NUMERIC, actual_usd NUMERIC, released_usd NUMERIC,
 reconciliation_watermark TIMESTAMPTZ, archive_state TEXT, unabsorbed_debit_usd NUMERIC
);
CREATE FUNCTION public.analysis_beta_pool_allocation_json(p public.analysis_beta_pool_allocations)
RETURNS JSONB LANGUAGE sql STABLE SET search_path=''
AS $$ SELECT jsonb_build_object('allocationId',p.id) $$;
CREATE FUNCTION public.analysis_beta_pool_effective_local_debit_usd(p_slot TEXT,p_observed TIMESTAMPTZ)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path=''
AS $$ SELECT 0::NUMERIC $$;

CREATE FUNCTION public.test_reserve_analysis_preflight_provider_run(
 p_preflight_id UUID, p_claim_token UUID, p_input_hash TEXT,
 p_credential_slot TEXT, p_max_charge_usd NUMERIC, p_operation_key TEXT
)
RETURNS JSONB LANGUAGE plpgsql SET search_path=''
AS $$
DECLARE
 v_existing public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
 SELECT provider_run.* INTO v_existing
 FROM public.analysis_preflight_provider_runs AS provider_run
 WHERE provider_run.preflight_id = p_preflight_id
   AND provider_run.operation_key = p_operation_key
 FOR UPDATE;
 IF FOUND THEN
  RETURN jsonb_build_object(
   'created', FALSE,
   'run', jsonb_build_object(
    'preflightId', v_existing.preflight_id,
    'operationKey', v_existing.operation_key,
    'inputHash', v_existing.input_hash,
    'logicalProvider', v_existing.logical_provider,
    'actorId', v_existing.actor_id,
    'credentialSlot', v_existing.credential_slot,
    'maxChargeUsd', v_existing.max_charge_usd,
    'status', v_existing.status,
    'runId', v_existing.run_id,
    'actualUsageUsd', v_existing.actual_usage_usd,
    'reservedAt', v_existing.reserved_at,
    'runStartedAt', v_existing.run_started_at,
    'terminalizedAt', v_existing.terminalized_at,
    'usageReconciledAt', v_existing.usage_reconciled_at
   )
  );
 END IF;
 INSERT INTO public.analysis_preflight_provider_runs(
  preflight_id, operation_key, input_hash, credential_slot, max_charge_usd
 ) VALUES (
  p_preflight_id, p_operation_key, p_input_hash, p_credential_slot, p_max_charge_usd
 ) RETURNING * INTO v_existing;
 RETURN jsonb_build_object(
  'created', TRUE,
  'run', jsonb_build_object(
   'preflightId', v_existing.preflight_id,
   'operationKey', v_existing.operation_key,
   'inputHash', v_existing.input_hash,
   'logicalProvider', v_existing.logical_provider,
   'actorId', v_existing.actor_id,
   'credentialSlot', v_existing.credential_slot,
   'maxChargeUsd', v_existing.max_charge_usd,
   'status', v_existing.status,
   'runId', v_existing.run_id,
   'actualUsageUsd', v_existing.actual_usage_usd,
   'reservedAt', v_existing.reserved_at,
   'runStartedAt', v_existing.run_started_at,
   'terminalizedAt', v_existing.terminalized_at,
   'usageReconciledAt', v_existing.usage_reconciled_at
  )
 );
END;
$$;

CREATE FUNCTION public.reserve_analysis_preflight_provider_run(
 p_preflight_id UUID, p_claim_token UUID, p_input_hash TEXT,
 p_credential_slot TEXT, p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE sql SET search_path=''
AS $$
 SELECT public.test_reserve_analysis_preflight_provider_run(
  p_preflight_id, p_claim_token, p_input_hash, p_credential_slot,
  p_max_charge_usd, 'target-profile-fallback'
 )
$$;

CREATE FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
 p_preflight_id UUID, p_admission_generation INTEGER, p_claim_token UUID,
 p_input_hash TEXT, p_credential_slot TEXT, p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE sql SET search_path=''
AS $$
 SELECT public.test_reserve_analysis_preflight_provider_run(
  p_preflight_id, p_claim_token, p_input_hash, p_credential_slot,
  p_max_charge_usd, 'target-profile-fresh-admission:g' || p_admission_generation::TEXT
 )
$$;
`;

let db: PGlite;
let migrationInitialRows: Array<{ credential_slot: string; valid: boolean }> = [];
let admissionBudgetRows: Array<{
    budget_key: string;
    workload_role: string;
    logical_provider: string;
    credential_slot: string | null;
    max_active: number;
    rate_limit_per_minute: number;
    window_count: number;
}> = [];
let paidAdmissionBudgetRows: Array<{
    budget_key: string;
    workload_role: string;
    logical_provider: string;
    credential_slot: string | null;
    max_active: number;
    rate_limit_per_minute: number;
    window_count: number;
}> = [];

function snapshotRows() {
    return slots.map(credentialSlot => ({
        credentialSlot,
        monthlyLimitUsd: 10,
        monthlyUsageUsd: 1,
        billingCycleStartAt: '2026-09-01T00:00:00.000Z',
        billingCycleEndAt: '2026-10-01T00:00:00.000Z',
        observedAt,
        healthState: 'healthy',
    }));
}

beforeAll(async () => {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(bootstrap);
    await db.exec(migration);
    const seeded = await db.query<{ credential_slot: string; valid: boolean }>(
        `SELECT credential_slot,
                public.analysis_beta_valid_apify_credential_slot(credential_slot) AS valid
         FROM public.analysis_apify_credit_snapshots ORDER BY credential_slot`,
    );
    migrationInitialRows = seeded.rows;
    const budgets = await db.query<typeof admissionBudgetRows[number]>(
        `SELECT budget_key, workload_role, logical_provider, credential_slot,
                max_active, rate_limit_per_minute, window_count
         FROM public.analysis_provider_admission_budgets
         WHERE workload_role = 'preflight' AND logical_provider = 'apify'
         ORDER BY budget_key`,
    );
    admissionBudgetRows = budgets.rows;
    const paidBudgets = await db.query<typeof paidAdmissionBudgetRows[number]>(
        `SELECT budget_key, workload_role, logical_provider, credential_slot,
                max_active, rate_limit_per_minute, window_count
         FROM public.analysis_provider_admission_budgets
         WHERE workload_role = 'paid' AND logical_provider = 'apify'
           AND budget_key IN (
               'paid:apify:octonary', 'paid:apify:nonary',
               'paid:apify:octonary:relationship',
               'paid:apify:nonary:relationship'
           )
         ORDER BY budget_key`,
    );
    paidAdmissionBudgetRows = paidBudgets.rows;
});

beforeEach(async () => {
    await db.exec('DELETE FROM public.analysis_apify_credit_snapshots;');
    await db.query(
        `INSERT INTO public.analysis_apify_credit_snapshots(credential_slot, health_state)
         SELECT slot, 'unhealthy' FROM unnest($1::TEXT[]) AS slot`,
        [allSlots],
    );
    await db.exec('DELETE FROM public.analysis_preflight_provider_runs;');
    await db.exec('DELETE FROM public.analysis_preflights;');
});

afterAll(async () => {
    await db.close();
});

describe('Apify ten-account runtime PGlite migration', () => {
    it('seeds global plus exact-nine preflight budgets and preserves existing counters', () => {
        expect(admissionBudgetRows.map(row => row.budget_key).sort()).toEqual([
            'preflight:apify:global',
            'preflight:apify:primary',
            'preflight:apify:quaternary',
            'preflight:apify:quinary',
            'preflight:apify:senary',
            'preflight:apify:septenary',
            'preflight:apify:tertiary',
            'preflight:apify:tenth',
            'preflight:apify:nonary',
            'preflight:apify:octonary',
        ].sort());
        expect(admissionBudgetRows).toHaveLength(10);
        expect(admissionBudgetRows.some(row => row.credential_slot === 'secondary')).toBe(false);
        expect(admissionBudgetRows.find(row => row.budget_key === 'preflight:apify:global'))
            .toMatchObject({ max_active: 32, rate_limit_per_minute: 120, window_count: 9 });
        expect(admissionBudgetRows.find(row => row.budget_key === 'preflight:apify:primary'))
            .toMatchObject({ max_active: 16, rate_limit_per_minute: 60, window_count: 7 });
        expect(admissionBudgetRows.find(row => row.budget_key === 'preflight:apify:quinary'))
            .toMatchObject({ max_active: 16, rate_limit_per_minute: 60, window_count: 5 });
        for (const slot of slots) {
            expect(admissionBudgetRows.find(row => row.credential_slot === slot))
                .toMatchObject({ max_active: 16, rate_limit_per_minute: 60 });
        }
    });

    it('seeds missing paid slot and relationship budgets without resetting existing paid counters', async () => {
        expect(paidAdmissionBudgetRows).toHaveLength(4);
        expect(paidAdmissionBudgetRows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                budget_key: 'paid:apify:octonary',
                workload_role: 'paid',
                logical_provider: 'apify',
                credential_slot: 'octonary',
                max_active: 8,
                rate_limit_per_minute: 480,
            }),
            expect.objectContaining({
                budget_key: 'paid:apify:nonary',
                workload_role: 'paid',
                logical_provider: 'apify',
                credential_slot: 'nonary',
                max_active: 8,
                rate_limit_per_minute: 480,
            }),
            expect.objectContaining({
                budget_key: 'paid:apify:octonary:relationship',
                workload_role: 'paid',
                logical_provider: 'apify',
                credential_slot: 'octonary',
                max_active: 4,
                rate_limit_per_minute: 240,
            }),
            expect.objectContaining({
                budget_key: 'paid:apify:nonary:relationship',
                workload_role: 'paid',
                logical_provider: 'apify',
                credential_slot: 'nonary',
                max_active: 4,
                rate_limit_per_minute: 240,
            }),
        ]));
        const preserved = await db.query<{ window_count: number }>(
            `SELECT window_count
             FROM public.analysis_provider_admission_budgets
             WHERE budget_key = 'paid:apify:secondary'`,
        );
        expect(preserved.rows).toEqual([{ window_count: 1 }]);
    });

    it('seeds all ten aliases while exposing exactly nine beta/free aliases', async () => {
        expect(migrationInitialRows).toHaveLength(10);
        expect(migrationInitialRows.map(row => row.credential_slot).sort()).toEqual([...allSlots].sort());
        expect(migrationInitialRows.filter(row => row.valid).map(row => row.credential_slot).sort()).toEqual([...slots].sort());
        expect(migrationInitialRows.find(row => row.credential_slot === 'secondary')?.valid).toBe(false);
        const allValid = await db.query<{ valid: boolean }>(
            `SELECT bool_and(public.analysis_v2_valid_apify_credential_slot(credential_slot)) AS valid
             FROM public.analysis_apify_credit_snapshots`,
        );
        expect(allValid.rows[0]?.valid).toBe(true);
    });

    it('stores manual exclusion on the existing snapshot ledger under the pool lock', async () => {
        await db.query(
            `SELECT public.set_analysis_apify_account_exclusion('octonary', TRUE)`,
        );
        const projected = await db.query<{ state: unknown }>(
            'SELECT public.load_analysis_apify_account_control_state() AS state',
        );
        const state = projected.rows[0]?.state as Array<{ credentialSlot: string; excluded: boolean }>;
        expect(state).toHaveLength(9);
        expect(state.find(row => row.credentialSlot === 'octonary')?.excluded).toBe(true);
        expect(JSON.stringify(projected.rows)).not.toMatch(/token|provider|operator/i);
        await db.query(
            `SELECT public.set_analysis_apify_account_exclusion('octonary', FALSE)`,
        );
        const restored = await db.query<{ excluded: boolean }>(
            `SELECT manually_excluded AS excluded
             FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'octonary'`,
        );
        expect(restored.rows[0]?.excluded).toBe(false);
    });

    it('refreshes the exact nine catalog while preserving an individually unhealthy slot', async () => {
        const payload = snapshotRows();
        const result = await db.query<{ pool: unknown }>(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB) AS pool',
            [JSON.stringify(payload)],
        );
        const pool = result.rows[0]?.pool as Array<{ credentialSlot: string }>;
        expect(pool.map(row => row.credentialSlot)).toEqual([...slots]);

        const partialPayload = payload.map(row => row.credentialSlot === 'quinary'
            ? {
                credentialSlot: row.credentialSlot,
                monthlyLimitUsd: null,
                monthlyUsageUsd: null,
                billingCycleStartAt: null,
                billingCycleEndAt: null,
                observedAt: null,
                healthState: 'unhealthy',
            }
            : row);
        const partial = await db.query<{ pool: unknown }>(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB) AS pool',
            [JSON.stringify(partialPayload)],
        );
        expect((partial.rows[0]?.pool as Array<Record<string, unknown>>)
            .find(row => row.credentialSlot === 'quinary'))
            .toMatchObject({ healthState: 'unhealthy', effectiveHeadroomUsd: null });
        const secondaryPayload = payload.map((row, index) => (
            index === 0 ? { ...row, credentialSlot: 'secondary' } : row
        ));
        await expect(db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(secondaryPayload)],
        )).rejects.toThrow('ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE');
    });

    it('returns an exact ten-row sanitized inventory and keeps missing secondary explicit', async () => {
        const initial = await db.query<{ inventory: unknown }>(
            'SELECT public.load_analysis_apify_account_credit_inventory(300) AS inventory',
        );
        const missing = initial.rows[0]?.inventory as Array<Record<string, unknown>>;
        expect(missing).toHaveLength(10);
        expect(missing.map(row => row.credentialSlot)).toEqual([...allSlots]);
        expect(missing[1]).toMatchObject({
            credentialSlot: 'secondary',
            workloadRole: 'paid',
            healthState: 'unhealthy',
            freshnessState: 'missing',
            effectiveRemainingUsd: null,
        });
        expect(JSON.stringify(missing)).not.toMatch(/token|account|userId|provider/i);

        await db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshotRows())],
        );
        const paidPayload = {
            credentialSlot: 'secondary',
            monthlyLimitUsd: 20,
            monthlyUsageUsd: 3,
            billingCycleStartAt: '2026-09-01T00:00:00.000Z',
            billingCycleEndAt: '2026-10-01T00:00:00.000Z',
            observedAt,
            healthState: 'healthy',
        };
        const refreshed = await db.query<{ inventory: unknown }>(
            'SELECT public.upsert_analysis_apify_paid_credit_snapshot($1::JSONB) AS inventory',
            [JSON.stringify(paidPayload)],
        );
        const inventory = refreshed.rows[0]?.inventory as Array<Record<string, unknown>>;
        expect(inventory).toHaveLength(10);
        expect(inventory[1]).toMatchObject({
            credentialSlot: 'secondary',
            workloadRole: 'paid',
            healthState: 'healthy',
            freshnessState: 'fresh',
            monthlyLimitUsd: 20,
            monthlyUsageUsd: 3,
            effectiveRemainingUsd: 17,
        });
        expect(Date.parse(String(inventory[1]?.billingCycleEndAt)))
            .toBe(Date.parse('2026-10-01T00:00:00Z'));
        expect(Date.parse(String(inventory[1]?.cycleResetAt)))
            .toBe(Date.parse('2026-10-01T00:00:00Z'));
    });

    it('allows secondary staleness without blocking the independent nine-row free refresh', async () => {
        await db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshotRows())],
        );
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd = 20, monthly_usage_usd = 3,
                 billing_cycle_start_at = '2026-09-01T00:00:00Z',
                 billing_cycle_end_at = '2026-10-01T00:00:00Z',
                 observed_at = clock_timestamp() - interval '1 day',
                 health_state = 'healthy'
             WHERE credential_slot = 'secondary'`,
        );
        await expect(db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshotRows())],
        )).resolves.toBeDefined();
        const inventory = await db.query<{ inventory: unknown }>(
            'SELECT public.load_analysis_apify_account_credit_inventory(300) AS inventory',
        );
        const rows = inventory.rows[0]?.inventory as Array<Record<string, unknown>>;
        expect(rows[1]).toMatchObject({
            credentialSlot: 'secondary',
            freshnessState: 'stale',
            effectiveRemainingUsd: null,
        });
    });

    it('requires all exact-nine free snapshots before allocating a slot', async () => {
        await db.query(
            `DELETE FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'tenth'`,
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, expires_at, beta_entry_provenance, analysis_entry_channel
            ) VALUES ($1, clock_timestamp() + interval '30 minutes', NULL, 'standard')`,
            [freePreflightId],
        );
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd = 0.0026, monthly_usage_usd = 0,
                 billing_cycle_start_at = clock_timestamp() - interval '1 day',
                 billing_cycle_end_at = clock_timestamp() + interval '1 day',
                 observed_at = clock_timestamp() - interval '1 second',
                 health_state = 'healthy'`,
        );

        await expect(db.query(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026)`,
            [freePreflightId],
        )).rejects.toThrow('ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE');
    });

    it('debits a reconciled terminal run while its snapshot is older than reconciliation', async () => {
        await seedFreeAllocatorFixture({
            snapshotObservedSql: "clock_timestamp() - interval '1 minute'",
            snapshotLimit: 0.0026,
            onlySlot: 'primary',
        });
        await insertProviderRun({
            status: 'succeeded',
            actualUsageUsd: 0.0026,
            usageReconciledSql: 'clock_timestamp()',
        });

        await expect(db.query(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026)`,
            [freePreflightId],
        )).rejects.toThrow('ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE');
    });

    it('absorbs a reconciled terminal usage into a new snapshot exactly once', async () => {
        await seedFreeAllocatorFixture({
            snapshotLimit: 0.0052,
            snapshotUsage: 0.0026,
            snapshotObservedSql: 'clock_timestamp()',
            onlySlot: 'primary',
        });
        await insertProviderRun({
            status: 'succeeded',
            actualUsageUsd: 0.0026,
            usageReconciledSql: "clock_timestamp() - interval '1 minute'",
        });

        const first = await db.query<{ slot: string }>(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026) AS slot`,
            [freePreflightId],
        );
        const second = await db.query<{ slot: string }>(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026) AS slot`,
            [freePreflightId],
        );
        expect(first.rows[0]?.slot).toBe(second.rows[0]?.slot);
        expect(slots).toContain(first.rows[0]?.slot as typeof slots[number]);
    });

    it('uses the maximum charge for an unreconciled terminal run', async () => {
        await seedFreeAllocatorFixture({ snapshotLimit: 0.0026, onlySlot: 'primary' });
        await insertProviderRun({
            status: 'failed',
            actualUsageUsd: null,
            usageReconciledSql: 'NULL',
        });

        await expect(db.query(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026)`,
            [freePreflightId],
        )).rejects.toThrow('ANALYSIS_APIFY_FREE_POOL_CAPACITY_UNAVAILABLE');
    });

    it('does not debit an empty pool or a zero-usage terminal run', async () => {
        await seedFreeAllocatorFixture({ snapshotLimit: 0.0026, onlySlot: 'primary' });
        await expect(db.query(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026)`,
            [freePreflightId],
        )).resolves.toBeDefined();

        await insertProviderRun({
            status: 'timed_out',
            actualUsageUsd: 0,
            usageReconciledSql: 'clock_timestamp()',
        });
        await expect(db.query(
            `SELECT public.reserve_analysis_apify_free_provider_slot($1, 0.0026)`,
            [freePreflightId],
        )).resolves.toBeDefined();
    });

    it.each([
        'reserve_analysis_preflight_provider_run',
        'reserve_analysis_v2_fresh_admission_provider_run',
    ])('rejects an explicit secondary slot in %s before predecessor delegation', async functionName => {
        await seedFreeAllocatorFixture();
        await expect(db.query(
            functionName === 'reserve_analysis_preflight_provider_run'
                ? `SELECT public.reserve_analysis_preflight_provider_run(
                    $1, $2, $3, 'secondary', 0.0026
                )`
                : `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
                    $1, 1, $2, $3, 'secondary', 0.0026
                )`,
            functionName === 'reserve_analysis_preflight_provider_run'
                ? [freePreflightId, freeClaimToken, freeInputHash]
                : [freePreflightId, freeClaimToken, freeInputHash],
        )).rejects.toThrow('ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH');
    });

    it.each([
        'reserve_analysis_preflight_provider_run',
        'reserve_analysis_v2_fresh_admission_provider_run',
    ])('rejects a replayed secondary slot in %s before predecessor delegation', async functionName => {
        await seedFreeAllocatorFixture();
        await insertProviderRun({
            credentialSlot: 'secondary',
            operationKey: functionName === 'reserve_analysis_preflight_provider_run'
                ? 'target-profile-fallback'
                : 'target-profile-fresh-admission:g1',
            status: 'starting',
            actualUsageUsd: null,
            usageReconciledSql: 'NULL',
        });
        await expect(db.query(
            functionName === 'reserve_analysis_preflight_provider_run'
                ? `SELECT public.reserve_analysis_preflight_provider_run(
                    $1, $2, $3, NULL, 0.0026
                )`
                : `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
                    $1, 1, $2, $3, NULL, 0.0026
                )`,
            [freePreflightId, freeClaimToken, freeInputHash],
        )).rejects.toThrow('ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH');
    });

    it.each([
        'reserve_analysis_preflight_provider_run',
        'reserve_analysis_v2_fresh_admission_provider_run',
    ])('selects and replays one exact-nine free slot in %s', async functionName => {
        await seedFreeAllocatorFixture();
        const sql = functionName === 'reserve_analysis_preflight_provider_run'
            ? `SELECT public.reserve_analysis_preflight_provider_run(
                $1, $2, $3, NULL, 0.0026
            ) AS result`
            : `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
                $1, 1, $2, $3, NULL, 0.0026
            ) AS result`;
        const first = await db.query<{ result: { created: boolean; run: { credentialSlot: string } } }>(
            sql,
            [freePreflightId, freeClaimToken, freeInputHash],
        );
        const second = await db.query<{ result: { created: boolean; run: { credentialSlot: string } } }>(
            sql,
            [freePreflightId, freeClaimToken, freeInputHash],
        );
        expect(first.rows[0]?.result).toMatchObject({
            created: true,
            run: { credentialSlot: expect.not.stringMatching(/^secondary$/) },
        });
        expect(second.rows[0]?.result).toMatchObject({
            created: false,
            run: { credentialSlot: first.rows[0]?.result.run.credentialSlot },
        });
    });
});

async function seedFreeAllocatorFixture(input: {
    snapshotLimit?: number;
    snapshotUsage?: number;
    snapshotObservedSql?: string;
    onlySlot?: string;
} = {}): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, expires_at, beta_entry_provenance, analysis_entry_channel
        ) VALUES ($1, clock_timestamp() + interval '30 minutes', NULL, 'standard')`,
        [freePreflightId],
    );
    await db.query(
        `UPDATE public.analysis_apify_credit_snapshots
         SET monthly_limit_usd = $1, monthly_usage_usd = $2,
             billing_cycle_start_at = clock_timestamp() - interval '1 day',
             billing_cycle_end_at = clock_timestamp() + interval '1 day',
             observed_at = ${input.snapshotObservedSql ?? "clock_timestamp() - interval '1 second'"},
             health_state = 'healthy'`,
        [input.snapshotLimit ?? 0.0052, input.snapshotUsage ?? 0],
    );
    if (input.onlySlot) {
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET health_state = 'unhealthy', monthly_limit_usd = NULL,
                 monthly_usage_usd = NULL, billing_cycle_start_at = NULL,
                 billing_cycle_end_at = NULL, observed_at = NULL
             WHERE credential_slot <> $1`,
            [input.onlySlot],
        );
    }
}

async function insertProviderRun(input: {
    credentialSlot?: string;
    operationKey?: string;
    status: string;
    actualUsageUsd: number | null;
    usageReconciledSql: string;
}): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflight_provider_runs (
            preflight_id, operation_key, input_hash, logical_provider, actor_id,
            credential_slot, max_charge_usd, status, run_id, actual_usage_usd,
            reserved_at, run_started_at, terminalized_at, usage_reconciled_at
        ) VALUES (
            $1, $2, $3, 'apify', 'apify/instagram-profile-scraper', $4, 0.0026,
            $5, $6, $7, clock_timestamp() - interval '10 minutes',
            clock_timestamp() - interval '9 minutes', clock_timestamp() - interval '8 minutes',
            ${input.usageReconciledSql}
        )`,
        [
            freePreflightId,
            input.operationKey ?? 'target-profile-fallback',
            freeInputHash,
            input.credentialSlot ?? 'primary',
            input.status,
            `${input.status.slice(0, 1).toUpperCase()}run12345678`,
            input.actualUsageUsd,
        ],
    );
}
