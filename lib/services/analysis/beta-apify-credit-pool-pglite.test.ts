import { existsSync, readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl)
    ? readFileSync(migrationUrl, 'utf8')
    : '';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const REQUEST_ID = '30000000-0000-4000-8000-000000000001';
const AUDIT_HASH = 'a'.repeat(64);
const BETA_SLOTS = [
    'primary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
] as const;
const OPERATIONS = [
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'profile-repair',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT NULLIF(
        pg_catalog.current_setting('request.jwt.claim.sub', TRUE),
        ''
    )::UUID;
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

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
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
        ),
        FALSE
    );
$$;

CREATE TABLE public.users (
    id UUID PRIMARY KEY
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('production', 'test_entitlement'))
);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    pipeline_version TEXT,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash TEXT
);
`;

interface JsonRow<T> {
    result: T;
}

interface SnapshotReading {
    credentialSlot: string;
    monthlyLimitUsd: number;
    monthlyUsageUsd: number;
    billingCycleStartAt: string;
    billingCycleEndAt: string;
    observedAt: string;
    healthState: string;
    effectiveHeadroomUsd: number;
}

type SnapshotInput = Omit<SnapshotReading, 'effectiveHeadroomUsd'>;

let db: PGlite;

async function serviceQuery<T>(
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function authenticatedQuery<T>(
    userId: string | null,
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.query(
        `SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, FALSE)`,
        [userId ?? '']
    );
    await db.exec('SET ROLE authenticated');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

function snapshotBatch(
    change?: (entry: SnapshotInput, index: number) => SnapshotInput
): SnapshotInput[] {
    const now = Date.now();
    const cycleStart = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const cycleEnd = new Date(now + 29 * 24 * 60 * 60 * 1000).toISOString();
    const observedAt = new Date(now - 2_000).toISOString();
    return BETA_SLOTS.map((credentialSlot, index) => {
        const entry: SnapshotInput = {
            credentialSlot,
            monthlyLimitUsd: 10 + index,
            monthlyUsageUsd: 2 + index,
            billingCycleStartAt: cycleStart,
            billingCycleEndAt: cycleEnd,
            observedAt,
            healthState: 'healthy',
        };
        return change ? change(entry, index) : entry;
    });
}

function slotMap(
    changed?: Partial<Record<(typeof OPERATIONS)[number], string>>
): Record<string, string> {
    return Object.fromEntries(OPERATIONS.map((operation, index) => [
        operation,
        changed?.[operation] ?? BETA_SLOTS[index % BETA_SLOTS.length],
    ]));
}

function budgetMap(
    changed?: Partial<Record<(typeof OPERATIONS)[number], unknown>>
): Record<string, unknown> {
    return Object.fromEntries(OPERATIONS.map((operation, index) => [
        operation,
        changed?.[operation] ?? (index + 1) / 100,
    ]));
}

async function upsertSnapshots(
    snapshots: unknown = snapshotBatch()
): Promise<SnapshotReading[]> {
    const result = await serviceQuery<JsonRow<SnapshotReading[]>>(
        `SELECT public.upsert_analysis_beta_apify_credit_snapshots(
            $1::JSONB
        ) AS result`,
        [JSON.stringify(snapshots)]
    );
    return result.rows[0].result;
}

async function loadSnapshots(maxAgeSeconds = 300): Promise<SnapshotReading[]> {
    const result = await serviceQuery<JsonRow<SnapshotReading[]>>(
        `SELECT public.load_analysis_beta_apify_credit_pool($1) AS result`,
        [maxAgeSeconds]
    );
    return result.rows[0].result;
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(bootstrap);
    if (migration !== '') {
        await db.exec(migration);
    }
});

beforeEach(async () => {
    if (migration === '') return;
    await db.exec(`
        DELETE FROM public.analysis_beta_access_grants;
        DELETE FROM public.analysis_preflights;
        DELETE FROM public.analysis_requests;
        DELETE FROM public.users;
        UPDATE public.analysis_apify_credit_snapshots
        SET monthly_limit_usd = NULL,
            monthly_usage_usd = NULL,
            billing_cycle_start_at = NULL,
            billing_cycle_end_at = NULL,
            observed_at = NULL,
            health_state = 'unhealthy',
            refreshed_at = pg_catalog.clock_timestamp();
    `);
});

afterAll(async () => {
    await db?.close();
});

describe('beta Apify credit pool foundation migration PGlite', () => {
    it('applies the forward migration to the current six-slot foundation', () => {
        expect(migration).not.toBe('');
    });

    it('accepts exactly seven general slots and the separate six beta slots', async () => {
        for (const slot of ['primary', 'secondary', ...BETA_SLOTS.slice(1)]) {
            const result = await db.query<{ valid: boolean }>(
                'SELECT public.analysis_v2_valid_apify_credential_slot($1) AS valid',
                [slot]
            );
            expect(result.rows[0].valid, slot).toBe(true);
        }
        for (const slot of BETA_SLOTS) {
            const result = await db.query<{ valid: boolean }>(
                'SELECT public.analysis_beta_valid_apify_credential_slot($1) AS valid',
                [slot]
            );
            expect(result.rows[0].valid, slot).toBe(true);
        }
        for (const rejected of ['secondary', 'unknown', '', null]) {
            const result = await db.query<{ valid: boolean }>(
                'SELECT public.analysis_beta_valid_apify_credential_slot($1) AS valid',
                [rejected]
            );
            expect(result.rows[0].valid, String(rejected)).toBe(false);
        }
    });

    it('accepts only complete exact beta slot and positive bounded budget maps', async () => {
        const valid = await db.query<{ slots: boolean; budgets: boolean }>(
            `SELECT
                public.analysis_beta_valid_operation_slot_map($1::JSONB) AS slots,
                public.analysis_beta_valid_operation_budget_map($2::JSONB) AS budgets`,
            [JSON.stringify(slotMap()), JSON.stringify(budgetMap())]
        );
        expect(valid.rows).toEqual([{ slots: true, budgets: true }]);

        const invalidInputs = [
            [slotMap({ 'target-profile': 'secondary' }), budgetMap()],
            [{ ...slotMap(), unknown: 'primary' }, budgetMap()],
            [Object.fromEntries(Object.entries(slotMap()).slice(1)), budgetMap()],
            [slotMap(), budgetMap({ 'profile-repair': 0 })],
            [slotMap(), budgetMap({ 'target-likers': -0.01 })],
            [slotMap(), budgetMap({ 'target-comments': 1000.000000000001 })],
            [slotMap(), budgetMap({ 'candidate-likers': '0.1' })],
            [slotMap(), { ...budgetMap(), unknown: 0.1 }],
        ];
        for (const [slots, budgets] of invalidInputs) {
            const result = await db.query<{ slots: boolean; budgets: boolean }>(
                `SELECT
                    public.analysis_beta_valid_operation_slot_map($1::JSONB) AS slots,
                    public.analysis_beta_valid_operation_budget_map($2::JSONB) AS budgets`,
                [JSON.stringify(slots), JSON.stringify(budgets)]
            );
            expect(result.rows[0].slots && result.rows[0].budgets).toBe(false);
        }
    });

    it('defaults existing entry paths to standard and fences betatest to production access', async () => {
        await db.query(
            'INSERT INTO public.users (id) VALUES ($1), ($2)',
            [USER_ID, OTHER_USER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (id, user_id, access_mode)
             VALUES ($1, $2, 'test_entitlement')`,
            [PREFLIGHT_ID, USER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, pipeline_version, plan_access_mode_snapshot,
                test_entitlement_jti_hash
             ) VALUES ($1, $2, 'v2', 'test_entitlement', $3)`,
            [REQUEST_ID, USER_ID, AUDIT_HASH]
        );

        const stored = await db.query<{
            preflight_channel: string;
            request_channel: string;
        }>(
            `SELECT
                preflight.analysis_entry_channel AS preflight_channel,
                request.analysis_entry_channel AS request_channel
             FROM public.analysis_preflights AS preflight
             CROSS JOIN public.analysis_requests AS request`
        );
        expect(stored.rows).toEqual([{
            preflight_channel: 'standard',
            request_channel: 'standard',
        }]);

        await expect(db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, access_mode, analysis_entry_channel
             ) VALUES ('20000000-0000-4000-8000-000000000002', $1,
                'test_entitlement', 'betatest')`,
            [USER_ID]
        )).rejects.toThrow(/analysis_preflights_entry_channel_access_check/);
        await expect(db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, pipeline_version, plan_access_mode_snapshot,
                test_entitlement_jti_hash, analysis_entry_channel
             ) VALUES ('30000000-0000-4000-8000-000000000002', $1,
                'v2', 'test_entitlement', $2, 'betatest')`,
            [USER_ID, AUDIT_HASH]
        )).rejects.toThrow(/analysis_requests_entry_channel_access_check/);
        await expect(db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, pipeline_version, plan_access_mode_snapshot,
                test_entitlement_jti_hash, analysis_entry_channel
             ) VALUES ('30000000-0000-4000-8000-000000000004', $1,
                NULL, NULL, NULL, 'betatest')`,
            [USER_ID]
        )).rejects.toThrow(/analysis_requests_entry_channel_access_check/);

        await expect(db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, access_mode, analysis_entry_channel
             ) VALUES ('20000000-0000-4000-8000-000000000003', $1,
                'production', 'betatest')`,
            [USER_ID]
        )).resolves.toBeDefined();
        await expect(db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, pipeline_version, plan_access_mode_snapshot,
                test_entitlement_jti_hash, analysis_entry_channel
             ) VALUES ('30000000-0000-4000-8000-000000000003', $1,
                'v2', 'production', NULL, 'betatest')`,
            [USER_ID]
        )).resolves.toBeDefined();
    });

    it('forces RLS and denies every direct client/service table privilege', async () => {
        const security = await db.query<{
            relname: string;
            rls: boolean;
            force_rls: boolean;
        }>(
            `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force_rls
             FROM pg_catalog.pg_class
             WHERE relname IN (
                'analysis_beta_access_grants',
                'analysis_apify_credit_snapshots'
             )
             ORDER BY relname`
        );
        expect(security.rows).toEqual([
            {
                relname: 'analysis_apify_credit_snapshots',
                rls: true,
                force_rls: true,
            },
            {
                relname: 'analysis_beta_access_grants',
                rls: true,
                force_rls: true,
            },
        ]);

        for (const role of ['anon', 'authenticated', 'service_role']) {
            for (const table of [
                'analysis_beta_access_grants',
                'analysis_apify_credit_snapshots',
            ]) {
                const privileges = await db.query<{ allowed: boolean }>(
                    `SELECT pg_catalog.has_table_privilege(
                        $1, $2, 'SELECT,INSERT,UPDATE,DELETE'
                    ) AS allowed`,
                    [role, `public.${table}`]
                );
                expect(privileges.rows[0].allowed, `${role}:${table}`).toBe(false);
            }
        }

        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query(
                'SELECT * FROM public.analysis_apify_credit_snapshots'
            )).rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('answers only the authenticated caller self-check without grant enumeration', async () => {
        await db.query(
            'INSERT INTO public.users (id) VALUES ($1), ($2)',
            [USER_ID, OTHER_USER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_beta_access_grants (
                user_id, enabled, expires_at, audit_reference_hash
             ) VALUES (
                $1, TRUE, pg_catalog.clock_timestamp() + INTERVAL '1 hour', $2
             )`,
            [USER_ID, AUDIT_HASH]
        );

        const active = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        const other = await authenticatedQuery<{ allowed: boolean }>(
            OTHER_USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        const missingIdentity = await authenticatedQuery<{ allowed: boolean }>(
            null,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(active.rows).toEqual([{ allowed: true }]);
        expect(other.rows).toEqual([{ allowed: false }]);
        expect(missingIdentity.rows).toEqual([{ allowed: false }]);

        const signature = await db.query<{ pronargs: number }>(
            `SELECT pronargs
             FROM pg_catalog.pg_proc
             WHERE oid = 'public.analysis_beta_has_access()'::REGPROCEDURE`
        );
        expect(signature.rows).toEqual([{ pronargs: 0 }]);

        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                'SELECT user_id FROM public.analysis_beta_access_grants'
            )).rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('fails the self-check closed for disabled and expired grants', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_beta_access_grants (
                user_id, enabled, expires_at, audit_reference_hash
             ) VALUES ($1, FALSE, NULL, $2)`,
            [USER_ID, AUDIT_HASH]
        );
        let result = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(result.rows).toEqual([{ allowed: false }]);

        await db.query(
            `UPDATE public.analysis_beta_access_grants
             SET enabled = TRUE,
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'`
        );
        result = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(result.rows).toEqual([{ allowed: false }]);
    });

    it('starts with exactly six unhealthy sanitized slot sentinels', async () => {
        const rows = await db.query<{
            credential_slot: string;
            health_state: string;
            amounts_absent: boolean;
        }>(
            `SELECT credential_slot, health_state,
                    monthly_limit_usd IS NULL
                    AND monthly_usage_usd IS NULL
                    AND billing_cycle_start_at IS NULL
                    AND billing_cycle_end_at IS NULL
                    AND observed_at IS NULL AS amounts_absent
             FROM public.analysis_apify_credit_snapshots
             ORDER BY CASE credential_slot
                WHEN 'primary' THEN 1
                WHEN 'tertiary' THEN 2
                WHEN 'quaternary' THEN 3
                WHEN 'quinary' THEN 4
                WHEN 'senary' THEN 5
                WHEN 'septenary' THEN 6
             END`
        );
        expect(rows.rows).toEqual(BETA_SLOTS.map(credentialSlot => ({
            credential_slot: credentialSlot,
            health_state: 'unhealthy',
            amounts_absent: true,
        })));

        const columns = await db.query<{ column_name: string }>(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'analysis_apify_credit_snapshots'
             ORDER BY ordinal_position`
        );
        expect(columns.rows.map(row => row.column_name)).toEqual([
            'credential_slot',
            'monthly_limit_usd',
            'monthly_usage_usd',
            'billing_cycle_start_at',
            'billing_cycle_end_at',
            'observed_at',
            'health_state',
            'refreshed_at',
        ]);

        await expect(db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET health_state = 'healthy'
             WHERE credential_slot = 'primary'`
        )).rejects.toThrow(/analysis_apify_credit_snapshots_state_check/);
    });

    it('atomically refreshes all six slots and reads foundation-only headroom', async () => {
        const stored = await upsertSnapshots();
        expect(stored.map(row => row.credentialSlot)).toEqual(BETA_SLOTS);
        for (const [index, row] of stored.entries()) {
            expect(row).toMatchObject({
                credentialSlot: BETA_SLOTS[index],
                monthlyLimitUsd: 10 + index,
                monthlyUsageUsd: 2 + index,
                healthState: 'healthy',
                effectiveHeadroomUsd: 8,
            });
        }

        const loaded = await loadSnapshots();
        expect(loaded).toEqual(stored);
        expect(JSON.stringify(loaded)).not.toMatch(
            /token|accountId|userId|email|cookie|payload|raw/i
        );
    });

    it('accepts distinct valid billing cycles for the six independent accounts', async () => {
        const observedAt = new Date(Date.now() - 2_000).toISOString();
        const independentCycles = snapshotBatch((entry, index) => ({
            ...entry,
            billingCycleStartAt: new Date(
                Date.now() - (index + 1) * 24 * 60 * 60 * 1000
            ).toISOString(),
            billingCycleEndAt: new Date(
                Date.now() + (index + 2) * 24 * 60 * 60 * 1000
            ).toISOString(),
            observedAt,
        }));

        const stored = await upsertSnapshots(independentCycles);
        expect(stored.map(row => row.billingCycleStartAt)).toHaveLength(6);
        expect(new Set(stored.map(row => row.billingCycleStartAt)).size).toBe(6);
        expect(await loadSnapshots()).toEqual(stored);
    });

    it.each([
        ['five slots', () => snapshotBatch().slice(0, 5)],
        ['duplicate slot', () => snapshotBatch((entry, index) => (
            index === 5 ? { ...entry, credentialSlot: 'primary' } : entry
        ))],
        ['secondary slot', () => snapshotBatch((entry, index) => (
            index === 1 ? { ...entry, credentialSlot: 'secondary' } : entry
        ))],
        ['negative amount', () => snapshotBatch((entry, index) => (
            index === 2 ? { ...entry, monthlyUsageUsd: -0.01 } : entry
        ))],
        ['overbound amount', () => snapshotBatch((entry, index) => (
            index === 3 ? { ...entry, monthlyLimitUsd: 100000.00000000001 } : entry
        ))],
        ['string amount', () => snapshotBatch((entry, index) => (
            index === 4
                ? { ...entry, monthlyLimitUsd: '10' as unknown as number }
                : entry
        ))],
        ['unhealthy state', () => snapshotBatch((entry, index) => (
            index === 0 ? { ...entry, healthState: 'unhealthy' } : entry
        ))],
        ['extra raw field', () => snapshotBatch((entry, index) => (
            index === 0
                ? { ...entry, rawPayload: 'forbidden' } as unknown as SnapshotInput
                : entry
        ))],
        ['stale observation', () => snapshotBatch(entry => ({
            ...entry,
            observedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        }))],
        ['future observation', () => snapshotBatch(entry => ({
            ...entry,
            observedAt: new Date(Date.now() + 61 * 1000).toISOString(),
        }))],
    ])('rejects an invalid exact-six refresh for %s without partial writes', async (
        _name,
        invalidBatch
    ) => {
        const before = await upsertSnapshots();
        await expect(upsertSnapshots(invalidBatch())).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_(INVALID|INCOMPLETE|STALE)/
        );
        expect(await loadSnapshots()).toEqual(before);
    });

    it('rejects same-observation mutation and older snapshot regression', async () => {
        const initial = snapshotBatch();
        const stored = await upsertSnapshots(initial);

        const changedSameObservation = initial.map((entry, index) => (
            index === 0 ? { ...entry, monthlyUsageUsd: entry.monthlyUsageUsd + 1 } : entry
        ));
        await expect(upsertSnapshots(changedSameObservation)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT/
        );

        const older = initial.map(entry => ({
            ...entry,
            observedAt: new Date(Date.parse(entry.observedAt) - 1_000).toISOString(),
        }));
        await expect(upsertSnapshots(older)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT/
        );
        expect(await loadSnapshots()).toEqual(stored);
    });

    it('fails closed when snapshots are unhealthy, stale, or the age bound is invalid', async () => {
        await expect(loadSnapshots()).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY/
        );
        await upsertSnapshots();
        await db.exec(`
            UPDATE public.analysis_apify_credit_snapshots
            SET observed_at = pg_catalog.clock_timestamp() - INTERVAL '6 minutes'
        `);
        await expect(loadSnapshots(300)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_STALE/
        );
        await expect(loadSnapshots(0)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_INVALID/
        );
        await expect(loadSnapshots(901)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_INVALID/
        );
    });

    it('fails closed if the exact-six batch observation timestamp is split', async () => {
        await upsertSnapshots();
        await db.exec(`
            UPDATE public.analysis_apify_credit_snapshots
            SET observed_at = observed_at + INTERVAL '1 second'
            WHERE credential_slot = 'septenary'
        `);

        await expect(loadSnapshots()).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE/
        );
    });

    it('grants only the narrow authenticated and service-role RPC surfaces', async () => {
        const checks = await db.query<{
            self_authenticated: boolean;
            self_anon: boolean;
            upsert_service: boolean;
            upsert_authenticated: boolean;
            load_service: boolean;
            load_authenticated: boolean;
        }>(`
            SELECT
                pg_catalog.has_function_privilege(
                    'authenticated', 'public.analysis_beta_has_access()', 'EXECUTE'
                ) AS self_authenticated,
                pg_catalog.has_function_privilege(
                    'anon', 'public.analysis_beta_has_access()', 'EXECUTE'
                ) AS self_anon,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.upsert_analysis_beta_apify_credit_snapshots(jsonb)',
                    'EXECUTE'
                ) AS upsert_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.upsert_analysis_beta_apify_credit_snapshots(jsonb)',
                    'EXECUTE'
                ) AS upsert_authenticated,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.load_analysis_beta_apify_credit_pool(integer)',
                    'EXECUTE'
                ) AS load_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.load_analysis_beta_apify_credit_pool(integer)',
                    'EXECUTE'
                ) AS load_authenticated
        `);
        expect(checks.rows).toEqual([{
            self_authenticated: true,
            self_anon: false,
            upsert_service: true,
            upsert_authenticated: false,
            load_service: true,
            load_authenticated: false,
        }]);
    });
});
