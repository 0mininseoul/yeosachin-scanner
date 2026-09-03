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
const operatorId = '11111111-1111-4111-8111-111111111111';
const observedAt = new Date(Date.now() - 1_000).toISOString();

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
CREATE TABLE public.analysis_preflight_provider_runs(preflight_id UUID);
CREATE TABLE public.analysis_v2_provider_runs(request_id UUID);
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
`;

let db: PGlite;

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
});

beforeEach(async () => {
    // Snapshot rows are replaceable runtime state; control events are
    // deliberately never deleted, even by a test reset.
    await db.exec('DELETE FROM public.analysis_apify_credit_snapshots;');
    await db.query(
        `INSERT INTO public.analysis_apify_credit_snapshots(credential_slot, health_state)
         SELECT slot, 'unhealthy' FROM unnest($1::TEXT[]) AS slot`,
        [slots],
    );
});

afterAll(async () => {
    await db.close();
});

describe('Apify ten-account runtime PGlite migration', () => {
    it('seeds and accepts exactly nine free aliases while rejecting secondary', async () => {
        const result = await db.query<{ credential_slot: string; valid: boolean }>(
            `SELECT credential_slot, public.analysis_beta_valid_apify_credential_slot(credential_slot) AS valid
             FROM public.analysis_apify_credit_snapshots ORDER BY credential_slot`,
        );
        expect(result.rows).toHaveLength(9);
        expect(result.rows.every(row => row.valid)).toBe(true);
        const secondary = await db.query<{ valid: boolean }>(
            `SELECT public.analysis_beta_valid_apify_credential_slot('secondary') AS valid`,
        );
        expect(secondary.rows[0]?.valid).toBe(false);
    });

    it('keeps exclusion history append-only and projects restore state by latest event', async () => {
        await db.query(
            `SELECT public.append_analysis_apify_account_control_event($1::UUID, 'octonary', 'exclude', 'maintenance', $2::TIMESTAMPTZ)`,
            [operatorId, observedAt],
        );
        await db.query(
            `SELECT public.append_analysis_apify_account_control_event($1::UUID, 'octonary', 'restore', 'restored', $2::TIMESTAMPTZ)`,
            [operatorId, new Date(Date.parse(observedAt) + 1_000).toISOString()],
        );
        const projected = await db.query<{ state: unknown }>(
            'SELECT public.load_analysis_apify_account_control_state() AS state',
        );
        const state = projected.rows[0]?.state as Array<{ credentialSlot: string; excluded: boolean }>;
        expect(state).toHaveLength(9);
        expect(state.find(row => row.credentialSlot === 'octonary')?.excluded).toBe(false);
        expect(JSON.stringify(projected.rows)).not.toContain(operatorId);

        await expect(db.query(
            `UPDATE public.analysis_apify_account_control_events SET reason = 'mutated'`,
        )).rejects.toThrow('ANALYSIS_APIFY_ACCOUNT_CONTROL_APPEND_ONLY');
        await expect(db.query(
            `DELETE FROM public.analysis_apify_account_control_events`,
        )).rejects.toThrow('ANALYSIS_APIFY_ACCOUNT_CONTROL_APPEND_ONLY');
    });

    it('atomically refreshes all nine snapshots and rejects a secondary or partial batch', async () => {
        const payload = snapshotRows();
        const result = await db.query<{ pool: unknown }>(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB) AS pool',
            [JSON.stringify(payload)],
        );
        const pool = result.rows[0]?.pool as Array<{ credentialSlot: string }>;
        expect(pool.map(row => row.credentialSlot)).toEqual([...slots]);

        await expect(db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(payload.slice(0, 8))],
        )).rejects.toThrow('ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE');
        const secondaryPayload = payload.map((row, index) => (
            index === 0 ? { ...row, credentialSlot: 'secondary' } : row
        ));
        await expect(db.query(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(secondaryPayload)],
        )).rejects.toThrow('ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE');
    });
});
