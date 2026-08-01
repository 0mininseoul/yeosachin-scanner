import { existsSync, readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationUrls = [
    new URL(
        '../../../supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802010100_validate_betatest_entry_channel_constraints.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802020000_add_betatest_apify_credit_reservations.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802070000_wire_betatest_preflight_credit_runtime.sql',
        import.meta.url
    ),
];
const migrations = migrationUrls.map(migrationUrl => (
    existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : ''
));
const reservationMigration = migrations[2];

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000002';
const REQUEST_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_REQUEST_ID = '30000000-0000-4000-8000-000000000002';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN_B = '40000000-0000-4000-8000-000000000002';
const DISPATCH_TOKEN = '50000000-0000-4000-8000-000000000001';
const AUDIT_HASH = 'a'.repeat(64);
const TARGET_PROFILE_BUDGET_USD = 0.0052;
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
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$ SELECT pg_catalog.gen_random_uuid() $$;

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

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    background_processing BOOLEAN NOT NULL DEFAULT FALSE,
    pipeline_version TEXT,
    preflight_id UUID,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash TEXT,
    selected_plan_id_snapshot TEXT
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    error_code TEXT,
    access_mode TEXT NOT NULL CHECK (
        access_mode IN ('production', 'test_entitlement')
    ),
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
    dispatch_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    consumed_request_id UUID,
    target_instagram_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    worker_attempt_count INTEGER NOT NULL DEFAULT 0,
    plan_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    pricing_version TEXT NOT NULL DEFAULT 'test',
    pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    admission_status TEXT NOT NULL DEFAULT 'pending',
    admission_generation INTEGER NOT NULL DEFAULT 1,
    admission_dispatch_generation INTEGER NOT NULL DEFAULT 1,
    admission_dispatch_token UUID,
    admission_dispatch_state TEXT NOT NULL DEFAULT 'reserved',
    admission_dispatched_at TIMESTAMPTZ,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dispatch_state TEXT NOT NULL DEFAULT 'pending',
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    dispatch_task_name TEXT,
    delivered_at TIMESTAMP WITH TIME ZONE,
    first_started_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id)
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    PRIMARY KEY (request_id, job_key, operation_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

-- Faithful predecessor signatures are required because 070000 replaces them.
CREATE FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER DEFAULT 300)
RETURNS TABLE(preflight_id UUID, user_id UUID, claimed BOOLEAN, target_instagram_id TEXT,
    access_mode TEXT, plan_catalog_snapshot JSONB, pricing_version TEXT, pricing_snapshot JSONB,
    worker_attempt_count INTEGER, lease_expires_at TIMESTAMPTZ, preflight_status TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::UUID,NULL::UUID,FALSE,NULL::TEXT,NULL::TEXT,NULL::JSONB,NULL::TEXT,NULL::JSONB,NULL::INTEGER,NULL::TIMESTAMPTZ,NULL::TEXT $$;
CREATE FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT FALSE,NULL::TEXT,NULL::TEXT $$;
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

interface AllocationResult {
    allocationId: string;
    preflightId: string;
    requestId: string | null;
    lifecycleState: 'preflight_held' | 'active';
    policyVersion: 'betatest-free-pool-v1';
    selectedPlanId: 'basic' | 'standard' | 'plus' | null;
    operationSlotMap: Record<string, string> | null;
    operationBudgetMap: Record<string, number> | null;
    expiresAt: string;
}

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
            monthlyLimitUsd: Number((0.1 + index / 100).toFixed(2)),
            monthlyUsageUsd: 0.01,
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
    changed?: Partial<Record<(typeof OPERATIONS)[number], number>>
): Record<string, number> {
    return Object.fromEntries(OPERATIONS.map((operation, index) => [
        operation,
        changed?.[operation]
            ?? (operation === 'target-profile'
                ? TARGET_PROFILE_BUDGET_USD
                : (index + 1) / 1000),
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

async function loadPool(maxAgeSeconds = 300): Promise<SnapshotReading[]> {
    const result = await serviceQuery<JsonRow<SnapshotReading[]>>(
        `SELECT public.load_analysis_beta_apify_credit_pool($1) AS result`,
        [maxAgeSeconds]
    );
    return result.rows[0].result;
}

async function upsertGrant(
    userId = USER_ID,
    enabled = true,
    expiresAt: string | null = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    auditHash = AUDIT_HASH
): Promise<boolean> {
    const result = await serviceQuery<JsonRow<boolean>>(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1::UUID, $2::BOOLEAN, $3::TIMESTAMPTZ, $4::TEXT
        ) AS result`,
        [userId, enabled, expiresAt, auditHash]
    );
    return result.rows[0].result;
}

async function holdCredit(
    preflightId = PREFLIGHT_ID,
    userId = USER_ID,
    credentialSlot: string = 'primary',
    budgetUsd = TARGET_PROFILE_BUDGET_USD,
    maxAgeSeconds = 300
): Promise<AllocationResult> {
    const result = await serviceQuery<JsonRow<AllocationResult>>(
        `SELECT public.hold_analysis_beta_apify_preflight_credit(
            $1::UUID, $2::UUID, $3::TEXT, $4::NUMERIC, $5::INTEGER
        ) AS result`,
        [preflightId, userId, credentialSlot, budgetUsd, maxAgeSeconds]
    );
    return result.rows[0].result;
}

async function activateCredit(
    preflightId = PREFLIGHT_ID,
    requestId = REQUEST_ID,
    userId = USER_ID,
    selectedPlanId = 'standard',
    operationSlotMap: Record<string, string> = slotMap(),
    operationBudgetMap: Record<string, number> = budgetMap(),
    maxAgeSeconds = 300
): Promise<AllocationResult> {
    const result = await serviceQuery<JsonRow<AllocationResult>>(
        `SELECT public.activate_analysis_beta_apify_request_credit(
            $1::UUID, $2::UUID, $3::UUID, $4::TEXT,
            $5::JSONB, $6::JSONB, $7::INTEGER
        ) AS result`,
        [
            preflightId,
            requestId,
            userId,
            selectedPlanId,
            JSON.stringify(operationSlotMap),
            JSON.stringify(operationBudgetMap),
            maxAgeSeconds,
        ]
    );
    return result.rows[0].result;
}

async function seedEligiblePreflight(
    preflightId = PREFLIGHT_ID,
    userId = USER_ID
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, status, access_mode, expires_at
         ) VALUES (
            $1, $2, 'pending', 'production',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
         )`,
        [preflightId, userId]
    );
}

async function seedPendingRequest(
    requestId = REQUEST_ID,
    preflightId = PREFLIGHT_ID,
    userId = USER_ID,
    selectedPlanId = 'standard'
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, status, pipeline_version, preflight_id,
            plan_access_mode_snapshot, test_entitlement_jti_hash,
            selected_plan_id_snapshot
         ) VALUES ($1, $2, 'pending', 'v2', $3, 'production', NULL, $4)`,
        [requestId, userId, preflightId, selectedPlanId]
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'consumed', consumed_request_id = $2
         WHERE id = $1`,
        [preflightId, requestId]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, dispatch_state
         ) VALUES ($1, 'coordinator:bootstrap', 'pending', 'pending')`,
        [requestId]
    );
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(bootstrap);
    for (const migration of migrations) {
        if (migration !== '') await db.exec(migration);
    }
});

beforeEach(async () => {
    if (reservationMigration !== '') {
        await db.exec(`
            DELETE FROM public.analysis_beta_pool_reservations;
            DELETE FROM public.analysis_beta_pool_allocations;
        `);
    }
    await db.exec(`
        DELETE FROM public.analysis_v2_provider_runs;
        DELETE FROM public.analysis_pipeline_jobs;
        DELETE FROM public.analysis_preflight_provider_runs;
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

describe('beta Apify credit reservation migration PGlite', () => {
    it('applies the reservation migration after both Task 2A transactions', () => {
        expect(migrations.every(migration => migration !== '')).toBe(true);
        expect(migrationUrls.map(url => url.pathname.split('/').at(-1))).toEqual([
            '20260802010000_add_betatest_apify_credit_pool.sql',
            '20260802010100_validate_betatest_entry_channel_constraints.sql',
            '20260802020000_add_betatest_apify_credit_reservations.sql',
            '20260802070000_wire_betatest_preflight_credit_runtime.sql',
        ]);
    });

    it('loads a held target identity with no owner or provider fields and replays it exactly', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit(PREFLIGHT_ID, USER_ID, 'septenary');

        const loaded = await serviceQuery<JsonRow<Record<string, unknown> | null>>(
            'SELECT public.load_analysis_beta_apify_preflight_hold($1::UUID) AS result',
            [PREFLIGHT_ID]
        );
        expect(loaded.rows[0].result).toEqual({
            allocationId: expect.any(String),
            preflightId: PREFLIGHT_ID,
            credentialSlot: 'septenary',
            targetProfileBudgetUsd: 0.0052,
        });
        expect(Object.keys(loaded.rows[0].result ?? {}).sort()).toEqual([
            'allocationId', 'credentialSlot', 'preflightId', 'targetProfileBudgetUsd',
        ]);
    });

    it('claims the beta channel and keeps the fresh-admission dispatch fence', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_instagram_id = 'target.user', status = 'pending',
                 analysis_entry_channel = 'betatest', admission_status = 'pending',
                 admission_dispatch_token = $2, admission_dispatch_state = 'reserved'
             WHERE id = $1`,
            [PREFLIGHT_ID, DISPATCH_TOKEN]
        );
        const claimed = await serviceQuery<{
            analysis_entry_channel: string; claimed: boolean; preflight_status: string;
        }>(
            'SELECT * FROM public.claim_analysis_v2_preflight($1, $2, 60)',
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        expect(claimed.rows[0]).toMatchObject({
            analysis_entry_channel: 'betatest', claimed: true, preflight_status: 'processing',
        });
        await db.query(
            `UPDATE public.analysis_preflights SET status='ready', lease_token=NULL,
                lease_expires_at=NULL WHERE id=$1`, [PREFLIGHT_ID]
        );
        const fresh = await serviceQuery<{
            claimed: boolean; admission_status: string; target_instagram_id: string;
            analysis_entry_channel: string;
        }>(
            'SELECT * FROM public.claim_analysis_v2_preflight_admission($1, 1, 1, $2, $3, 60)',
            [PREFLIGHT_ID, DISPATCH_TOKEN, CLAIM_TOKEN_B]
        );
        expect(fresh.rows[0]).toEqual({
            claimed: true, admission_status: 'processing', target_instagram_id: 'target.user',
            analysis_entry_channel: 'betatest',
        });
    });

    it('forces RLS, exposes no forbidden columns, and denies direct DML', async () => {
        const security = await db.query<{
            relname: string;
            rls: boolean;
            force_rls: boolean;
        }>(
            `SELECT relname, relrowsecurity AS rls,
                    relforcerowsecurity AS force_rls
             FROM pg_catalog.pg_class
             WHERE relname IN (
                'analysis_beta_pool_allocations',
                'analysis_beta_pool_reservations'
             )
             ORDER BY relname`
        );
        expect(security.rows).toEqual([
            {
                relname: 'analysis_beta_pool_allocations',
                rls: true,
                force_rls: true,
            },
            {
                relname: 'analysis_beta_pool_reservations',
                rls: true,
                force_rls: true,
            },
        ]);

        const columns = await db.query<{ column_name: string }>(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN (
                    'analysis_beta_pool_allocations',
                    'analysis_beta_pool_reservations'
               )
             ORDER BY table_name, ordinal_position`
        );
        expect(columns.rows.map(row => row.column_name).join(' ')).not.toMatch(
            /token|provider_account|account_identifier|raw_payload|email|cookie/i
        );

        for (const role of ['anon', 'authenticated', 'service_role']) {
            for (const table of [
                'analysis_beta_pool_allocations',
                'analysis_beta_pool_reservations',
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
    });

    it('upserts and disables a grant only through the audited service RPC', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);

        await expect(upsertGrant()).resolves.toBe(true);
        const active = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(active.rows).toEqual([{ allowed: true }]);

        await expect(upsertGrant(USER_ID, false, null, 'b'.repeat(64)))
            .resolves.toBe(false);
        const disabled = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(disabled.rows).toEqual([{ allowed: false }]);

        const stored = await db.query<{
            enabled: boolean;
            audit_reference_hash: string;
        }>(
            `SELECT enabled, audit_reference_hash
             FROM public.analysis_beta_access_grants
             WHERE user_id = $1`,
            [USER_ID]
        );
        expect(stored.rows).toEqual([{
            enabled: false,
            audit_reference_hash: 'b'.repeat(64),
        }]);
    });

    it('rejects invalid grant audit/expiry without changing grant state', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await upsertGrant();

        await expect(upsertGrant(
            USER_ID,
            true,
            new Date(Date.now() - 1_000).toISOString()
        )).rejects.toThrow(/ANALYSIS_BETA_GRANT_INVALID/);
        await expect(upsertGrant(USER_ID, true, null, 'not-a-hash'))
            .rejects.toThrow(/ANALYSIS_BETA_GRANT_INVALID/);

        const active = await authenticatedQuery<{ allowed: boolean }>(
            USER_ID,
            'SELECT public.analysis_beta_has_access() AS allowed'
        );
        expect(active.rows).toEqual([{ allowed: true }]);
    });

    it('atomically holds the full reviewed pre-request target-profile budget', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();

        const held = await holdCredit();
        expect(held).toMatchObject({
            preflightId: PREFLIGHT_ID,
            requestId: null,
            lifecycleState: 'preflight_held',
            policyVersion: 'betatest-free-pool-v1',
            selectedPlanId: null,
            operationSlotMap: null,
            operationBudgetMap: null,
        });
        expect(held.allocationId).toMatch(/^[0-9a-f-]{36}$/);

        const stored = await db.query<{
            analysis_entry_channel: string;
            operation_family: string;
            credential_slot: string;
            reserved_usd: string;
            lifecycle_state: string;
        }>(
            `SELECT preflight.analysis_entry_channel,
                    reservation.operation_family,
                    reservation.credential_slot,
                    reservation.reserved_usd,
                    reservation.lifecycle_state
             FROM public.analysis_preflights AS preflight
             JOIN public.analysis_beta_pool_allocations AS allocation
               ON allocation.preflight_id = preflight.id
             JOIN public.analysis_beta_pool_reservations AS reservation
               ON reservation.allocation_id = allocation.id
             WHERE preflight.id = $1`,
            [PREFLIGHT_ID]
        );
        expect(stored.rows).toEqual([{
            analysis_entry_channel: 'betatest',
            operation_family: 'target-profile',
            credential_slot: 'primary',
            reserved_usd: '0.005200000000',
            lifecycle_state: 'preflight_held',
        }]);

        expect(await holdCredit()).toEqual(held);
    });

    it('conflicts on changed hold ownership, slot, or budget', async () => {
        await db.query(
            'INSERT INTO public.users (id) VALUES ($1), ($2)',
            [USER_ID, OTHER_USER_ID]
        );
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();

        await expect(holdCredit(PREFLIGHT_ID, OTHER_USER_ID))
            .rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(holdCredit(PREFLIGHT_ID, USER_ID, 'tertiary'))
            .rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(holdCredit(
            PREFLIGHT_ID,
            USER_ID,
            'primary',
            TARGET_PROFILE_BUDGET_USD + 0.0001
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
    });

    it('rejects ineligible/unauthorized holds before any durable state', async () => {
        await db.query(
            'INSERT INTO public.users (id) VALUES ($1), ($2)',
            [USER_ID, OTHER_USER_ID]
        );
        await seedEligiblePreflight();
        await upsertSnapshots();

        await expect(holdCredit()).rejects.toThrow(
            /ANALYSIS_BETA_ACCESS_UNAVAILABLE/
        );
        await upsertGrant();
        await db.query(
            `UPDATE public.analysis_preflights
             SET dispatch_state = 'reserved', dispatch_generation = 1,
                 dispatch_token = extensions.gen_random_uuid(),
                 dispatch_reserved_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        await expect(holdCredit()).rejects.toThrow(
            /ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE/
        );

        const state = await db.query<{
            allocations: number;
            channel: string;
        }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_allocations) AS allocations,
                analysis_entry_channel AS channel
             FROM public.analysis_preflights
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        expect(state.rows).toEqual([{ allocations: 0, channel: 'standard' }]);
    });

    it('fails closed for stale/unhealthy snapshots before marking the channel', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await db.exec(`
            UPDATE public.analysis_apify_credit_snapshots
            SET observed_at = observed_at - INTERVAL '10 minutes'
        `);

        await expect(holdCredit()).rejects.toThrow(
            /ANALYSIS_BETA_POOL_SNAPSHOT_STALE/
        );
        const state = await db.query<{ channel: string; allocations: number }>(
            `SELECT analysis_entry_channel AS channel,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_allocations) AS allocations
             FROM public.analysis_preflights
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        expect(state.rows).toEqual([{ channel: 'standard', allocations: 0 }]);
    });

    it('subtracts held reservations from sanitized effective headroom', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots(snapshotBatch((entry, index) => ({
            ...entry,
            monthlyLimitUsd: index === 0 ? 0.02 : entry.monthlyLimitUsd,
            monthlyUsageUsd: index === 0 ? 0.005 : entry.monthlyUsageUsd,
        })));

        await holdCredit();
        const pool = await loadPool();
        expect(pool[0]).toMatchObject({
            credentialSlot: 'primary',
            monthlyLimitUsd: 0.02,
            monthlyUsageUsd: 0.005,
            effectiveHeadroomUsd: 0.0098,
        });
        expect(JSON.stringify(pool)).not.toMatch(
            /allocationId|preflightId|requestId|userId|token|payload|raw/i
        );
    });

    it('serially rechecks locked headroom so a second hold cannot oversubscribe', async () => {
        // PGlite exposes one connection. This serialized replay proves the
        // post-commit recheck; the contract suite separately pins canonical
        // FOR UPDATE locking across all six rows for real PostgreSQL sessions.
        await db.query(
            'INSERT INTO public.users (id) VALUES ($1)',
            [USER_ID]
        );
        await seedEligiblePreflight(PREFLIGHT_ID);
        await seedEligiblePreflight(OTHER_PREFLIGHT_ID);
        await upsertGrant();
        await upsertSnapshots(snapshotBatch((entry, index) => ({
            ...entry,
            monthlyLimitUsd: index === 0 ? 0.009 : entry.monthlyLimitUsd,
            monthlyUsageUsd: index === 0 ? 0 : entry.monthlyUsageUsd,
        })));

        await holdCredit(PREFLIGHT_ID);
        await expect(holdCredit(OTHER_PREFLIGHT_ID)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/
        );
        const stored = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_allocations`
        );
        expect(stored.rows).toEqual([{ count: 1 }]);
    });

    it('activates all eight exact reservations and freezes request policy atomically', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        const held = await holdCredit();
        await seedPendingRequest();

        const slots = slotMap();
        const budgets = budgetMap();
        const active = await activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slots,
            budgets
        );
        expect(active).toMatchObject({
            allocationId: held.allocationId,
            preflightId: PREFLIGHT_ID,
            requestId: REQUEST_ID,
            lifecycleState: 'active',
            policyVersion: 'betatest-free-pool-v1',
            selectedPlanId: 'standard',
            operationSlotMap: slots,
            operationBudgetMap: budgets,
        });

        const stored = await db.query<{
            reservation_count: number;
            lifecycle_count: number;
            request_channel: string;
        }>(
            `SELECT
                pg_catalog.count(*)::INTEGER AS reservation_count,
                pg_catalog.count(*) FILTER (
                    WHERE reservation.lifecycle_state = 'active'
                )::INTEGER AS lifecycle_count,
                pg_catalog.min(request.analysis_entry_channel) AS request_channel
             FROM public.analysis_beta_pool_reservations AS reservation
             JOIN public.analysis_beta_pool_allocations AS allocation
               ON allocation.id = reservation.allocation_id
             JOIN public.analysis_requests AS request
               ON request.id = allocation.request_id`
        );
        expect(stored.rows).toEqual([{
            reservation_count: 8,
            lifecycle_count: 8,
            request_channel: 'betatest',
        }]);

        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET dispatch_state = 'enqueued', dispatch_generation = 1,
                 dispatch_reservation_token = extensions.gen_random_uuid(),
                 dispatch_reserved_at = pg_catalog.clock_timestamp(),
                 dispatched_at = pg_catalog.clock_timestamp(),
                 dispatch_task_name = 'task-1'
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(await activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slots,
            budgets
        )).toEqual(active);
    });

    it('conflicts on changed activation request, plan, slot map, or budget map', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();
        await activateCredit();

        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, status, pipeline_version, preflight_id,
                plan_access_mode_snapshot, selected_plan_id_snapshot
             ) VALUES ($1, $2, 'pending', 'v2', $3, 'production', 'standard')`,
            [OTHER_REQUEST_ID, USER_ID, PREFLIGHT_ID]
        );
        await expect(activateCredit(PREFLIGHT_ID, OTHER_REQUEST_ID))
            .rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'plus'
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slotMap({ 'profile-repair': 'septenary' })
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slotMap(),
            budgetMap({ 'candidate-likers': 0.02 })
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
    });

    it('rejects target-hold mismatches and incomplete/secondary maps before activation', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();

        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slotMap({ 'target-profile': 'tertiary' })
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            slotMap(),
            budgetMap({ 'target-profile': TARGET_PROFILE_BUDGET_USD + 0.0001 })
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        const secondary = slotMap({ 'profile-fallback': 'secondary' });
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            secondary
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_INVALID/);
        const incomplete = slotMap();
        delete incomplete['candidate-likers'];
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            incomplete
        )).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_INVALID/);

        const allocation = await db.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state
             FROM public.analysis_beta_pool_allocations`
        );
        expect(allocation.rows).toEqual([{ lifecycle_state: 'preflight_held' }]);
    });

    it('rejects a non-pending or already-dispatched request before activation', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET dispatch_state = 'reserved', dispatch_generation = 1,
                 dispatch_reservation_token = extensions.gen_random_uuid(),
                 dispatch_reserved_at = pg_catalog.clock_timestamp()
             WHERE request_id = $1`,
            [REQUEST_ID]
        );

        await expect(activateCredit()).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        const allocation = await db.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state
             FROM public.analysis_beta_pool_allocations`
        );
        expect(allocation.rows).toEqual([{ lifecycle_state: 'preflight_held' }]);
    });

    it('rechecks and locks the current grant before first activation', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();
        await upsertGrant(USER_ID, false, null, 'b'.repeat(64));

        await expect(activateCredit()).rejects.toThrow(
            /ANALYSIS_BETA_ACCESS_UNAVAILABLE/
        );
        const allocation = await db.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state
             FROM public.analysis_beta_pool_allocations`
        );
        expect(allocation.rows).toEqual([{ lifecycle_state: 'preflight_held' }]);
    });

    it('rejects a pending request whose background worker already started', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();
        await db.query(
            `UPDATE public.analysis_requests
             SET background_processing = TRUE
             WHERE id = $1`,
            [REQUEST_ID]
        );

        await expect(activateCredit()).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        const allocation = await db.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state
             FROM public.analysis_beta_pool_allocations`
        );
        expect(allocation.rows).toEqual([{ lifecycle_state: 'preflight_held' }]);
    });

    it('rejects a request with no durable initial job', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots();
        await holdCredit();
        await seedPendingRequest();
        await db.query(
            'DELETE FROM public.analysis_pipeline_jobs WHERE request_id = $1',
            [REQUEST_ID]
        );

        await expect(activateCredit()).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        const allocation = await db.query<{ lifecycle_state: string }>(
            `SELECT lifecycle_state
             FROM public.analysis_beta_pool_allocations`
        );
        expect(allocation.rows).toEqual([{ lifecycle_state: 'preflight_held' }]);
    });

    it('rechecks incremental seven-operation capacity without partial activation', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await seedEligiblePreflight();
        await upsertGrant();
        await upsertSnapshots(snapshotBatch(entry => ({
            ...entry,
            monthlyLimitUsd: 0.01,
            monthlyUsageUsd: 0,
        })));
        await holdCredit();
        await seedPendingRequest();

        const allPrimary = Object.fromEntries(
            OPERATIONS.map(operation => [operation, 'primary'])
        );
        const budgets = budgetMap(Object.fromEntries(
            OPERATIONS
                .filter(operation => operation !== 'target-profile')
                .map(operation => [operation, 0.001])
        ));
        await expect(activateCredit(
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            'standard',
            allPrimary,
            budgets
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);

        const state = await db.query<{
            lifecycle_state: string;
            reservation_count: number;
            request_channel: string;
        }>(
            `SELECT allocation.lifecycle_state,
                    pg_catalog.count(reservation.*)::INTEGER AS reservation_count,
                    pg_catalog.min(request.analysis_entry_channel) AS request_channel
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_beta_pool_reservations AS reservation
               ON reservation.allocation_id = allocation.id
             JOIN public.analysis_requests AS request ON request.id = $1
             GROUP BY allocation.lifecycle_state`,
            [REQUEST_ID]
        );
        expect(state.rows).toEqual([{
            lifecycle_state: 'preflight_held',
            reservation_count: 1,
            request_channel: 'standard',
        }]);
    });

    it('grants only the existing self-check and four service RPC surfaces', async () => {
        const privileges = await db.query<{
            grant_service: boolean;
            grant_authenticated: boolean;
            hold_service: boolean;
            hold_authenticated: boolean;
            activate_service: boolean;
            activate_authenticated: boolean;
            load_service: boolean;
            load_authenticated: boolean;
            self_authenticated: boolean;
        }>(`
            SELECT
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.upsert_analysis_beta_access_grant(uuid,boolean,timestamptz,text)',
                    'EXECUTE'
                ) AS grant_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.upsert_analysis_beta_access_grant(uuid,boolean,timestamptz,text)',
                    'EXECUTE'
                ) AS grant_authenticated,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.hold_analysis_beta_apify_preflight_credit(uuid,uuid,text,numeric,integer)',
                    'EXECUTE'
                ) AS hold_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.hold_analysis_beta_apify_preflight_credit(uuid,uuid,text,numeric,integer)',
                    'EXECUTE'
                ) AS hold_authenticated,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.activate_analysis_beta_apify_request_credit(uuid,uuid,uuid,text,jsonb,jsonb,integer)',
                    'EXECUTE'
                ) AS activate_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.activate_analysis_beta_apify_request_credit(uuid,uuid,uuid,text,jsonb,jsonb,integer)',
                    'EXECUTE'
                ) AS activate_authenticated,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.load_analysis_beta_apify_credit_pool(integer)',
                    'EXECUTE'
                ) AS load_service,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.load_analysis_beta_apify_credit_pool(integer)',
                    'EXECUTE'
                ) AS load_authenticated,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.analysis_beta_has_access()',
                    'EXECUTE'
                ) AS self_authenticated
        `);
        expect(privileges.rows).toEqual([{
            grant_service: true,
            grant_authenticated: false,
            hold_service: true,
            hold_authenticated: false,
            activate_service: true,
            activate_authenticated: false,
            load_service: true,
            load_authenticated: false,
            self_authenticated: true,
        }]);
    });
});
