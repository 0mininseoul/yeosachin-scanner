import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.PREFLIGHT_EXCLUSION_POSTGRES_TEST_URL;
const suppliedMarker = process.env.PREFLIGHT_EXCLUSION_POSTGRES_TEST_MARKER;
const marker = 'local-ephemeral-preflight-exclusion-only';
const describePostgres = isSafePreflightExclusionPostgresTestTarget(databaseUrl, suppliedMarker)
    ? describe
    : describe.skip;

const landingLeadsMigration = readFileSync(
    new URL('../../../supabase/migrations/20260719160000_add_landing_leads.sql', import.meta.url),
    'utf8',
);
const inputContextMigration = readFileSync(
    new URL('../../../supabase/migrations/20260725021500_add_landing_lead_input_context.sql', import.meta.url),
    'utf8',
);
const journeyMigration = readFileSync(
    new URL('../../../supabase/migrations/20260909095950_add_landing_lead_journey_contract.sql', import.meta.url),
    'utf8',
);
const atomicExclusionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260909150000_atomic_preflight_exclusion_landing.sql', import.meta.url),
    'utf8',
);

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const ownerPreflightId = '223e4567-e89b-42d3-a456-426614174000';
const ownerJourneyId = '323e4567-e89b-42d3-a456-426614174000';
const anonymousPreflightId = '423e4567-e89b-42d3-a456-426614174000';
const anonymousJourneyId = '523e4567-e89b-42d3-a456-426614174000';
const anonymousClaimHash = 'a'.repeat(64);

export function isSafePreflightExclusionPostgresTestTarget(
    connectionString: string | undefined,
    supplied: string | undefined,
): boolean {
    if (!connectionString || supplied !== marker) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/preflight_exclusion_landing_concurrency_test';
    } catch {
        return false;
    }
}

async function bootstrap(pool: Pool): Promise<void> {
    await pool.query(`
        DROP SCHEMA IF EXISTS public CASCADE;
        DROP SCHEMA IF EXISTS extensions CASCADE;
        DROP SCHEMA IF EXISTS auth CASCADE;
        CREATE SCHEMA public;
        CREATE SCHEMA extensions;
        CREATE SCHEMA auth;
        CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
        DO $$
        BEGIN
            CREATE ROLE anon NOLOGIN;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        DO $$
        BEGIN
            CREATE ROLE authenticated NOLOGIN;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        DO $$
        BEGIN
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        CREATE FUNCTION auth.uid()
        RETURNS UUID LANGUAGE sql STABLE
        AS $$ SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID $$;
        CREATE FUNCTION public.analysis_beta_has_access()
        RETURNS BOOLEAN LANGUAGE sql STABLE
        AS $$ SELECT TRUE $$;
        CREATE FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
        RETURNS BOOLEAN LANGUAGE sql
        AS $$ SELECT TRUE $$;
        CREATE TABLE public.users(
            id UUID PRIMARY KEY,
            lifecycle TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE public.analysis_preflights(
            id UUID PRIMARY KEY,
            user_id UUID,
            claim_token_hash VARCHAR(64),
            claim_expires_at TIMESTAMPTZ,
            status TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            exclusion_decision TEXT NOT NULL DEFAULT 'pending',
            excluded_instagram_id TEXT,
            exclusion_decided_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
            target_instagram_id TEXT NOT NULL,
            beta_entry_provenance TEXT
        );
        GRANT USAGE ON SCHEMA public, extensions, auth TO anon, authenticated, service_role;
    `);
    await pool.query('INSERT INTO public.users(id) VALUES ($1)', [ownerId]);
    await pool.query(landingLeadsMigration);
    await pool.query(inputContextMigration);
    await pool.query(journeyMigration);
    await pool.query(atomicExclusionMigration);
}

async function seedPreflight(
    pool: Pool,
    input: {
        id: string;
        journeyId: string;
        userId: string | null;
        claimHash: string | null;
        expiration: string;
        claimExpiration: string | null;
    },
): Promise<void> {
    await pool.query(
        `INSERT INTO public.analysis_preflights(
            id, user_id, claim_token_hash, claim_expires_at,
            status, expires_at, target_instagram_id
        ) VALUES ($1, $2, $3, $4,
            'ready', pg_catalog.clock_timestamp() + $5::INTERVAL, 'target.user')`,
        [input.id, input.userId, input.claimHash, input.claimExpiration, input.expiration],
    );
    await pool.query(
        `INSERT INTO public.landing_leads(journey_id, instagram_id, input_context)
         VALUES ($1, 'target.user', 'target')`,
        [input.journeyId],
    );
    await pool.query(
        `SELECT public.bind_landing_lead_journey_to_preflight($1, $2)`,
        [input.journeyId, input.id],
    );
}

async function waitForLockWait(pool: Pool, blockedPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        const result = await pool.query<{
            wait_event_type: string | null;
            blocking_pids: number[];
        }>(
            `SELECT wait_event_type,
                    pg_catalog.pg_blocking_pids(pid) AS blocking_pids
             FROM pg_catalog.pg_stat_activity
             WHERE pid = $1`,
            [blockedPid],
        );
        const row = result.rows[0];
        if (row?.wait_event_type === 'Lock' && row.blocking_pids.includes(blockerPid)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('PREFLIGHT_EXCLUSION_POSTGRES_LOCK_BARRIER_TIMEOUT');
}

async function callAtomic(
    client: PoolClient,
    role: 'anon' | 'authenticated',
    input: {
        preflightId: string;
        userId: string | null;
        claimHash: string | null;
    },
): Promise<boolean> {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query(
            "SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, TRUE)",
            [input.userId ?? ''],
        );
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await client.query<{ decision: boolean }>(
            `SELECT public.set_analysis_v2_preflight_exclusion_with_landing(
                $1::UUID, $2::UUID, $3::VARCHAR, 'exclude'::TEXT, 'excluded.user'::TEXT
            ) AS decision`,
            [input.preflightId, input.userId, input.claimHash],
        );
        await client.query('COMMIT');
        if (result.rows[0]?.decision === undefined) {
            throw new Error('PREFLIGHT_EXCLUSION_POSTGRES_EMPTY_RESULT');
        }
        return result.rows[0].decision;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function expectExpiryAfterLockWait(
    pool: Pool,
    input: {
        role: 'anon' | 'authenticated';
        preflightId: string;
        userId: string | null;
        claimHash: string | null;
        error: string;
    },
): Promise<void> {
    const blocker = await pool.connect();
    const blocked = await pool.connect();
    let blockedCall: Promise<boolean> | undefined;
    try {
        await blocker.query(
            "SELECT pg_catalog.set_config('application_name', $1, FALSE)",
            ['preflight-exclusion-lock-blocker'],
        );
        await blocked.query(
            "SELECT pg_catalog.set_config('application_name', $1, FALSE)",
            ['preflight-exclusion-lock-waiter'],
        );
        await blocker.query('BEGIN');
        await blocker.query(
            `SELECT id FROM public.analysis_preflights WHERE id = $1::UUID FOR UPDATE`,
            [input.preflightId],
        );
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const blockedPid = (await blocked.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

        blockedCall = callAtomic(blocked, input.role, input);
        await waitForLockWait(pool, blockedPid, blockerPid);
        // The first clock sample happened before this wait. Keep the row lock
        // held past both short TTLs so only the post-lock sample can reject it.
        await new Promise(resolve => setTimeout(resolve, 450));
        await blocker.query('ROLLBACK');
        await expect(blockedCall).rejects.toMatchObject({
            message: expect.stringContaining(input.error),
        });
    } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blockedCall?.catch(() => undefined);
        await blocked.query('ROLLBACK').catch(() => undefined);
        blocked.release();
        blocker.release();
    }
}

describe('preflight exclusion PostgreSQL destructive-test target guard', () => {
    it('accepts only an explicit loopback disposable database and marker', () => {
        expect(isSafePreflightExclusionPostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/preflight_exclusion_landing_concurrency_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/preflight_exclusion_landing_concurrency_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/preflight_exclusion_landing_concurrency_test', undefined],
    ])('rejects an unsafe target or absent marker', (connectionString, supplied) => {
        expect(isSafePreflightExclusionPostgresTestTarget(connectionString, supplied)).toBe(false);
    });
});

describePostgres('preflight exclusion PostgreSQL lock-wait expiry', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        await bootstrap(pool);
        await seedPreflight(pool, {
            id: ownerPreflightId,
            journeyId: ownerJourneyId,
            userId: ownerId,
            claimHash: null,
            expiration: '250 milliseconds',
            claimExpiration: null,
        });
        await seedPreflight(pool, {
            id: anonymousPreflightId,
            journeyId: anonymousJourneyId,
            userId: null,
            claimHash: anonymousClaimHash,
            expiration: '10 minutes',
            // Leave enough time for the owner case and lock barrier to finish;
            // the test narrows this TTL immediately before the anonymous call.
            claimExpiration: '3 seconds',
        });
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('uses separate sessions and rejects owner or anonymous expiry after lock acquisition', async () => {
        await expectExpiryAfterLockWait(pool, {
            role: 'authenticated',
            preflightId: ownerPreflightId,
            userId: ownerId,
            claimHash: null,
            error: 'ANALYSIS_V2_PREFLIGHT_EXPIRED',
        });
        await pool.query(
            `UPDATE public.analysis_preflights
             SET claim_expires_at = pg_catalog.clock_timestamp() + INTERVAL '250 milliseconds'
             WHERE id = $1::UUID`,
            [anonymousPreflightId],
        );
        await expectExpiryAfterLockWait(pool, {
            role: 'anon',
            preflightId: anonymousPreflightId,
            userId: null,
            claimHash: anonymousClaimHash,
            error: 'ANONYMOUS_PREFLIGHT_CLAIM_INVALID',
        });

        const rows = await pool.query<{
            id: string;
            exclusion_decision: string;
            excluded_count: number;
        }>(
            `SELECT preflight.id, preflight.exclusion_decision,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads AS lead
                     WHERE lead.source_preflight_id = preflight.id
                       AND lead.input_context = 'excluded') AS excluded_count
             FROM public.analysis_preflights AS preflight
             WHERE preflight.id IN ($1::UUID, $2::UUID)
             ORDER BY preflight.id`,
            [ownerPreflightId, anonymousPreflightId],
        );
        expect(rows.rows).toEqual([
            { id: anonymousPreflightId, exclusion_decision: 'pending', excluded_count: 0 },
            { id: ownerPreflightId, exclusion_decision: 'pending', excluded_count: 0 },
        ]);
    }, 15_000);
});
