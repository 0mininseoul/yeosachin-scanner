import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260802100600_add_betatest_pool_observability.sql',
    import.meta.url,
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.analysis_apify_credit_snapshots (
    credential_slot TEXT PRIMARY KEY,
    monthly_limit_usd NUMERIC,
    monthly_usage_usd NUMERIC,
    billing_cycle_start_at TIMESTAMPTZ,
    billing_cycle_end_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ,
    health_state TEXT NOT NULL
);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY, status TEXT NOT NULL, completed_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY, status TEXT NOT NULL, blocked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.analysis_beta_pool_allocations (
    id UUID PRIMARY KEY, request_id UUID, preflight_id UUID,
    lifecycle_state TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.analysis_beta_pool_reservations (
    allocation_id UUID NOT NULL, credential_slot TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL, reserved_usd NUMERIC NOT NULL
);
CREATE TABLE public.analysis_beta_runtime_gate (
    singleton BOOLEAN PRIMARY KEY, enabled BOOLEAN NOT NULL
);
INSERT INTO public.analysis_beta_runtime_gate VALUES (TRUE, FALSE);
CREATE OR REPLACE FUNCTION public.analysis_beta_pool_effective_capacity_snapshot()
RETURNS TABLE (credential_slot TEXT, observed_at TIMESTAMPTZ, effective_capacity_usd NUMERIC)
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT snapshot.credential_slot, snapshot.observed_at,
           snapshot.monthly_limit_usd - snapshot.monthly_usage_usd
             - COALESCE(pg_catalog.sum(reservation.reserved_usd) FILTER (
                 WHERE reservation.lifecycle_state IN ('preflight_held','active')
               ), 0::NUMERIC)
    FROM public.analysis_apify_credit_snapshots AS snapshot
    LEFT JOIN public.analysis_beta_pool_reservations AS reservation
      ON reservation.credential_slot = snapshot.credential_slot
    GROUP BY snapshot.credential_slot, snapshot.observed_at,
             snapshot.monthly_limit_usd, snapshot.monthly_usage_usd;
$$;
REVOKE ALL ON TABLE public.analysis_apify_credit_snapshots,
    public.analysis_requests, public.analysis_preflights,
    public.analysis_beta_pool_allocations,
    public.analysis_beta_pool_reservations,
    public.analysis_beta_runtime_gate
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_beta_pool_effective_capacity_snapshot()
FROM PUBLIC, anon, authenticated, service_role;
`;

let db: PGlite;

async function servicePool() {
    await db.exec('SET ROLE service_role');
    try {
        const result = await db.query<{ result: Record<string, unknown> }>(
            'SELECT public.load_analysis_beta_apify_pool_observability(300) AS result'
        );
        return result.rows[0]?.result;
    } finally {
        await db.exec('RESET ROLE');
    }
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(bootstrap);
    await db.exec(migration);
    await db.exec(`
        INSERT INTO public.analysis_apify_credit_snapshots
        SELECT slot, 10, 2,
               pg_catalog.clock_timestamp() - INTERVAL '1 day',
               pg_catalog.clock_timestamp() + INTERVAL '29 days',
               CASE WHEN slot='septenary'
                    THEN pg_catalog.clock_timestamp() - INTERVAL '10 minutes'
                    ELSE pg_catalog.clock_timestamp() - INTERVAL '1 minute' END,
               'healthy'
        FROM unnest(ARRAY[
            'primary','tertiary','quaternary','quinary','senary','septenary'
        ]) AS slot;
        INSERT INTO public.analysis_requests VALUES
            ('10000000-0000-4000-8000-000000000001','completed',
             pg_catalog.clock_timestamp() - INTERVAL '2 minutes');
        INSERT INTO public.analysis_preflights VALUES
            ('20000000-0000-4000-8000-000000000001','consumed',NULL,
             pg_catalog.clock_timestamp()+INTERVAL '1 hour',pg_catalog.clock_timestamp()),
            ('20000000-0000-4000-8000-000000000002','ready',NULL,
             pg_catalog.clock_timestamp()+INTERVAL '1 hour',pg_catalog.clock_timestamp());
        INSERT INTO public.analysis_beta_pool_allocations VALUES
            ('30000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001',
             '20000000-0000-4000-8000-000000000001','active',pg_catalog.clock_timestamp()),
            ('30000000-0000-4000-8000-000000000002',NULL,
             '20000000-0000-4000-8000-000000000002','preflight_held',pg_catalog.clock_timestamp());
        INSERT INTO public.analysis_beta_pool_reservations VALUES
            ('30000000-0000-4000-8000-000000000001','primary','active',1),
            ('30000000-0000-4000-8000-000000000001','tertiary','active',9);
    `);
});

afterAll(async () => { await db?.close(); });

describe('betatest pool observability PGlite', () => {
    it('returns debit-aware aggregate health without row identities', async () => {
        const result = await servicePool();
        expect(result).toMatchObject({
            schemaVersion: 1,
            runtimeEnabled: false,
            totalEffectiveHeadroomUsd: 39,
            staleSnapshotCount: 1,
            activeAllocationCount: 2,
            overcommittedSlotCount: 1,
        });
        expect(Number(result?.settlementLagMs)).toBeGreaterThanOrEqual(119_000);
        expect(JSON.stringify(result)).not.toMatch(
            /10000000|20000000|30000000|credentialSlot|secondary|userId|requestId|preflightId/
        );
    });

    it('allows only service_role execution and validates the age bound', async () => {
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`SET ROLE ${role}`);
            await expect(db.query(
                'SELECT public.load_analysis_beta_apify_pool_observability(300)'
            )).rejects.toThrow();
            await db.exec('RESET ROLE');
        }
        const acl = await db.query<{ role_name: string; allowed: boolean }>(`
            SELECT role_name,
              pg_catalog.has_function_privilege(
                role_name,
                'public.load_analysis_beta_apify_pool_observability(integer)',
                'EXECUTE'
              ) AS allowed
            FROM unnest(ARRAY['anon','authenticated','service_role']) AS role_name
            ORDER BY role_name
        `);
        expect(acl.rows).toEqual([
            { role_name: 'anon', allowed: false },
            { role_name: 'authenticated', allowed: false },
            { role_name: 'service_role', allowed: true },
        ]);
        await db.exec('SET ROLE service_role');
        await expect(db.query(
            'SELECT public.load_analysis_beta_apify_pool_observability(0)'
        )).rejects.toThrow('ANALYSIS_BETA_POOL_OBSERVABILITY_INVALID');
        await db.exec('RESET ROLE');
    });
});
