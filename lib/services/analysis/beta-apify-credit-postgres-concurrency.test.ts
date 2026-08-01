import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This is intentionally a real PostgreSQL test.  It starts a uniquely named
// postgres:16 container unless a caller supplies the same URL-style opt-in
// convention used by the repository's other PostgreSQL concurrency fixtures.
const suppliedUrl = process.env.BETA_APIFY_POSTGRES_TEST_URL;
const containerName = `beta-apify-credit-${randomUUID().replaceAll('-', '')}`;
let databaseUrl = suppliedUrl;
let containerStarted = false;
let first: Client;
let second: Client;
let observer: Client;

const migrationFiles = [
    '20260802010000_add_betatest_apify_credit_pool.sql',
    '20260802010100_validate_betatest_entry_channel_constraints.sql',
    '20260802020000_add_betatest_apify_credit_reservations.sql',
    '20260802030000_bind_betatest_provider_policy.sql',
    '20260802030100_validate_betatest_provider_policy.sql',
    '20260802040000_settle_betatest_apify_credit_reservations.sql',
    '20260802050000_harden_betatest_apify_credit_capacity.sql',
].map(file => readFileSync(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8'));

function faithfulBootstrap(): string {
    // Do not duplicate a fragile reduced DDL here: extract the same complete
    // dependency fixture which the behavioral PGlite suite uses, then execute
    // the real forward migrations below on PostgreSQL.
    const source = readFileSync(new URL('./beta-apify-provider-guards-pglite.test.ts', import.meta.url), 'utf8');
    const matched = source.match(/const bootstrap = `([\s\S]*?)`;\n\ninterface JsonRow/);
    if (!matched?.[1]) throw new Error('BETA_APIFY_POSTGRES_BOOTSTRAP_MISSING');
    return matched[1];
}

async function waitForDatabase(url: string): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 60; i += 1) {
        const client = new Client({ connectionString: url });
        try {
            await client.connect();
            await client.end();
            return;
        } catch (error) {
            last = error;
            await client.end().catch(() => undefined);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw last ?? new Error('BETA_APIFY_POSTGRES_NOT_READY');
}

async function waitUntilBlocked(pid: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
        const result = await observer.query<{ blocked: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_stat_activity
                WHERE pid = $1 AND wait_event_type = 'Lock'
             ) AS blocked`,
            [pid],
        );
        if (result.rows[0]?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('BETA_APIFY_POSTGRES_LOCK_BARRIER_TIMEOUT');
}

function snapshots(limit = 1): string {
    const now = Date.now();
    return JSON.stringify(['primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary'].map(credentialSlot => ({
        credentialSlot,
        monthlyLimitUsd: credentialSlot === 'primary' ? limit : 1,
        monthlyUsageUsd: 0,
        billingCycleStartAt: new Date(now - 60_000).toISOString(),
        billingCycleEndAt: new Date(now + 86_400_000).toISOString(),
        observedAt: new Date(now - 1_000).toISOString(),
        healthState: 'healthy',
    })));
}

async function seedHold(client: Client, userId: string, preflightId: string, limit = 1): Promise<void> {
    await client.query('INSERT INTO public.users (id) VALUES ($1)', [userId]);
    await client.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, status, access_mode, target_instagram_id,
            target_followers_count, target_following_count, expires_at
         ) VALUES ($1, $2, 'pending', 'production', 'target.user', 120, 140,
            clock_timestamp() + interval '30 minutes')`,
        [preflightId, userId],
    );
    await client.query(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1, TRUE, clock_timestamp() + interval '1 hour', $2
        )`, [userId, 'a'.repeat(64)],
    );
    await client.query('SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::jsonb)', [snapshots(limit)]);
}

describe('beta Apify credit PostgreSQL 16 concurrency', () => {
    beforeAll(async () => {
        if (!databaseUrl) {
            const id = execFileSync('docker', [
                'run', '-d', '--rm', '--name', containerName,
                '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=beta_credit_test',
                '-p', '127.0.0.1::5432', 'postgres:16-alpine',
            ], { encoding: 'utf8' }).trim();
            if (!id) throw new Error('BETA_APIFY_POSTGRES_DOCKER_START_FAILED');
            containerStarted = true;
            const port = execFileSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' })
                .trim().split(':').at(-1);
            databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/beta_credit_test`;
        }
        await waitForDatabase(databaseUrl!);
        first = new Client({ connectionString: databaseUrl });
        second = new Client({ connectionString: databaseUrl });
        observer = new Client({ connectionString: databaseUrl });
        await Promise.all([first.connect(), second.connect(), observer.connect()]);
        await first.query(faithfulBootstrap());
        for (const migration of migrationFiles) await first.query(migration);
    }, 90_000);

    afterAll(async () => {
        await Promise.all([first?.end(), second?.end(), observer?.end()]);
        if (containerStarted) {
            execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
        }
    }, 30_000);

    it('sweep skips a same-user expired candidate while a real hold RPC is blocked at snapshots', async () => {
        const userId = randomUUID();
        const expiredPreflightId = randomUUID();
        const admissionPreflightId = randomUUID();
        await seedHold(first, userId, expiredPreflightId);
        await first.query(
            `SELECT public.hold_analysis_beta_apify_preflight_credit($1, $2, 'primary', 0.0052, 300)`,
            [expiredPreflightId, userId],
        );
        await first.query(`UPDATE public.analysis_preflights SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [expiredPreflightId]);
        await first.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count, expires_at
             ) VALUES ($1, $2, 'pending', 'production', 'new.target', 120, 140,
                clock_timestamp() + interval '30 minutes')`,
            [admissionPreflightId, userId],
        );

        // Admission takes user -> preflight -> grant before its canonical
        // snapshot loop.  Hold primary in a coordinator transaction so the
        // *actual* RPC is visibly blocked only after it owns the user lock.
        await observer.query('BEGIN');
        await observer.query(
            `SELECT credential_slot FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'primary' FOR UPDATE`,
        );
        const admissionPid = await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const admission = first.query(
            `SELECT public.hold_analysis_beta_apify_preflight_credit($1, $2, 'primary', 0.0052, 300)`,
            [admissionPreflightId, userId],
        );
        await waitUntilBlocked(admissionPid.rows[0]!.pid);

        // User-first SKIP LOCKED must return immediately: it cannot settle B
        // while A owns the same user, and A has not made a partial allocation.
        const skipped = await second.query(`SELECT public.recover_analysis_beta_apify_credit_allocations(10) AS result`);
        expect(skipped.rows[0]?.result).toEqual([]);
        expect((await observer.query<{ expired: number; admission: number }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_beta_pool_allocations WHERE preflight_id = $1) AS expired,
                (SELECT count(*)::int FROM public.analysis_beta_pool_allocations WHERE preflight_id = $2) AS admission`,
            [expiredPreflightId, admissionPreflightId],
        )).rows).toEqual([{ expired: 1, admission: 0 }]);

        await observer.query('COMMIT');
        await admission;
        await second.query(`SELECT public.recover_analysis_beta_apify_credit_allocations(10)`);
        const state = await first.query<{ preflight: string; state: string; capacity: string }>(
            `SELECT allocation.preflight_id::text AS preflight, allocation.lifecycle_state AS state,
                    (SELECT effective_capacity_usd::text
                     FROM public.analysis_beta_pool_effective_capacity_snapshot()
                     WHERE credential_slot = 'primary') AS capacity
             FROM public.analysis_beta_pool_allocations AS allocation
             WHERE allocation.preflight_id IN ($1, $2)
             ORDER BY allocation.preflight_id`,
            [expiredPreflightId, admissionPreflightId],
        );
        expect(state.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ preflight: expiredPreflightId, state: 'settled' }),
            expect.objectContaining({ preflight: admissionPreflightId, state: 'preflight_held' }),
        ]));
        expect(Number(state.rows[0]!.capacity)).toBeGreaterThanOrEqual(0);
    });

    it('serializes two primary-slot capacity contenders and commits only the fitting hold', async () => {
        const userA = randomUUID();
        const userB = randomUUID();
        const preflightA = randomUUID();
        const preflightB = randomUUID();
        // The preceding scenario retains one fitting hold; reset primary to
        // capacity for precisely that hold plus one of these contenders.
        await seedHold(first, userA, preflightA, 0.0104);
        await seedHold(first, userB, preflightB, 0.0104);
        await first.query('BEGIN');
        await first.query(`SELECT public.hold_analysis_beta_apify_preflight_credit($1, $2, 'primary', 0.0052, 300)`, [preflightA, userA]);
        const secondPid = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const contender = second.query(`SELECT public.hold_analysis_beta_apify_preflight_credit($1, $2, 'primary', 0.0052, 300)`, [preflightB, userB]);
        await waitUntilBlocked(secondPid.rows[0]!.pid);
        await first.query('COMMIT');
        await expect(contender).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);
        const state = await first.query<{ holds: number; capacity: string }>(
            `SELECT (SELECT count(*)::int FROM public.analysis_beta_pool_reservations
                     WHERE credential_slot = 'primary'
                       AND lifecycle_state IN ('preflight_held', 'active')) AS holds,
                    (SELECT effective_capacity_usd FROM public.analysis_beta_pool_effective_capacity_snapshot()
                     WHERE credential_slot = 'primary') AS capacity`,
        );
        expect(state.rows).toEqual([{ holds: 2, capacity: '0.000000000000' }]);
    });
});
