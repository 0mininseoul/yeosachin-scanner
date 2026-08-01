import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAnalysisPlan, PLAN_IDS, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import { getBetaApifyOperationBudgetCatalog } from './beta-apify-operation-budget';

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
const frozenBudgetMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802060000_expose_betatest_frozen_provider_budgets.sql',
    import.meta.url,
), 'utf8');
const wireRuntimeMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802070000_wire_betatest_preflight_credit_runtime.sql',
    import.meta.url,
), 'utf8');
const planAdmissionMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802080000_admit_betatest_apify_plan.sql',
    import.meta.url,
), 'utf8');
const betaSlots = {
    'target-profile': 'primary',
    'relationship-followers': 'tertiary',
    'relationship-following': 'quaternary',
    'profile-fallback': 'quinary',
    'profile-repair': 'septenary',
    'target-likers': 'senary',
    'target-comments': 'tertiary',
    'candidate-likers': 'quaternary',
} as const;
const betaBudgets = {
    'target-profile': 0.0052,
    'relationship-followers': 0.02,
    'relationship-following': 0.02,
    'profile-fallback': 0.02,
    'profile-repair': 0.02,
    'target-likers': 0.02,
    'target-comments': 0.02,
    'candidate-likers': 0.02,
} as const;

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

interface MigrationLockObservation {
    blockingPids: number[];
    locks: Array<{
        relation_name: string;
        mode: string;
        granted: boolean;
    }>;
}

async function waitForMigrationRelationLock(pid: number): Promise<MigrationLockObservation> {
    for (let i = 0; i < 100; i += 1) {
        const activity = await observer.query<{
            wait_event_type: string | null;
            blocking_pids: number[];
        }>(
            `SELECT activity.wait_event_type,
                    pg_catalog.pg_blocking_pids(activity.pid) AS blocking_pids
             FROM pg_catalog.pg_stat_activity AS activity
             WHERE activity.pid = $1`,
            [pid],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') {
            const locks = await observer.query<{
                relation_name: string;
                mode: string;
                granted: boolean;
            }>(
                `SELECT relation.relname AS relation_name,
                        relation_lock.mode, relation_lock.granted
                 FROM pg_catalog.pg_locks AS relation_lock
                 JOIN pg_catalog.pg_class AS relation
                   ON relation.oid = relation_lock.relation
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = relation.relnamespace
                 WHERE relation_lock.pid = $1
                   AND namespace.nspname = 'public'
                   AND relation.relname IN (
                        'analysis_beta_pool_allocations',
                        'analysis_beta_pool_reservations'
                   )
                 ORDER BY relation.relname, relation_lock.mode`,
                [pid],
            );
            return {
                blockingPids: activity.rows[0].blocking_pids,
                locks: locks.rows,
            };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('BETA_APIFY_POSTGRES_MIGRATION_LOCK_TIMEOUT');
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
    await client.query('INSERT INTO public.users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
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

interface PlanAdmissionResult {
    requestId: string;
    initialJobKey: 'coordinator:bootstrap';
    allocationId: string;
    replayed: boolean;
}

function admissionSnapshotPayload() {
    const launch = Object.fromEntries(PLAN_IDS.map(planId => [planId, 'production']));
    const cards = Object.fromEntries(PLAN_IDS.map((planId, index) => {
        const plan = getAnalysisPlan(planId);
        return [planId, {
            launchStatus: 'production',
            relationshipCapacity: plan.relationshipCapacity,
            detailedMutualLimit: plan.detailedMutualLimit,
            selectionState: index === 0 ? 'required' : 'available_upgrade',
            unavailableReason: null,
        }];
    }));
    const pricing = Object.fromEntries(PLAN_IDS.map(planId => [planId, {
        status: planId === 'plus' ? 'deferred' : 'quoted',
        currency: 'KRW',
        amountKrw: planId === 'basic' ? 6900 : planId === 'standard' ? 9900 : null,
    }]));
    return { launch, cards, pricing, policies: { riskPolicy: 'v29' } };
}

async function seedReadyAdmission(input: {
    client: Client;
    userId: string;
    preflightId: string;
    admissionToken: string;
    planId?: PlanId;
    snapshotLimit?: number;
    refreshedAgeSeconds?: number;
}): Promise<void> {
    const planId = input.planId ?? 'basic';
    const snapshot = admissionSnapshotPayload();
    await seedHold(input.client, input.userId, input.preflightId, input.snapshotLimit ?? 10);
    await input.client.query(
        `SELECT public.hold_analysis_beta_apify_preflight_credit(
            $1, $2, 'primary', 0.0052, 300
        )`,
        [input.preflightId, input.userId],
    );
    await input.client.query(
        `UPDATE public.analysis_apify_credit_snapshots
         SET monthly_limit_usd = $1, monthly_usage_usd = 0`,
        [input.snapshotLimit ?? 10],
    );
    await input.client.query(
        `UPDATE public.analysis_preflights
         SET status = 'ready', exclusion_decision = 'skip', target_is_private = FALSE,
             capacity_required_plan_id = 'basic', required_plan_id = 'basic',
             launch_status_snapshot = $2::jsonb, plan_cards_snapshot = $3::jsonb,
             pricing_version = 'earlybird-2026-07-v2', pricing_snapshot = $4::jsonb,
             policy_versions_snapshot = $5::jsonb, ready_at = clock_timestamp(),
             admission_status = 'ready', admission_generation = 1,
             admission_selected_plan_id = $6, admission_token = $7,
             admission_refreshed_at = clock_timestamp() - $8 * interval '1 second',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [
            input.preflightId,
            JSON.stringify(snapshot.launch),
            JSON.stringify(snapshot.cards),
            JSON.stringify(snapshot.pricing),
            JSON.stringify(snapshot.policies),
            planId,
            input.admissionToken,
            input.refreshedAgeSeconds ?? 0,
        ],
    );
}

async function admitReadyPlan(input: {
    client: Client;
    userId: string;
    preflightId: string;
    admissionToken: string;
    planId?: PlanId;
    slots?: Record<string, string>;
}): Promise<PlanAdmissionResult> {
    const planId = input.planId ?? 'basic';
    const admitted = await input.client.query<{ result: PlanAdmissionResult }>(
        `SELECT public.admit_analysis_v2_betatest_plan(
            $1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, 300
        ) AS result`,
        [
            input.preflightId,
            input.userId,
            input.admissionToken,
            planId,
            JSON.stringify(input.slots ?? betaSlots),
            JSON.stringify(getBetaApifyOperationBudgetCatalog(planId, {})),
        ],
    );
    return admitted.rows[0]!.result;
}

async function seedActivatedBetaRequest(client: Client): Promise<{
    allocationId: string;
    claimToken: string;
    requestId: string;
}> {
    const userId = randomUUID();
    const preflightId = randomUUID();
    const requestId = randomUUID();
    const claimToken = randomUUID();
    await seedHold(client, userId, preflightId, 10);
    await client.query(
        `SELECT public.hold_analysis_beta_apify_preflight_credit(
            $1, $2, 'primary', 0.0052, 300
        )`,
        [preflightId, userId],
    );
    await client.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, status, background_processing,
            pipeline_version, preflight_id, plan_access_mode_snapshot,
            test_entitlement_jti_hash, selected_plan_id_snapshot,
            analysis_scope_snapshot
         ) VALUES (
            $1, $2, 'target.user', 'pending', FALSE, 'v2', $3,
            'production', NULL, 'standard', $4::jsonb
         )`,
        [
            requestId,
            userId,
            preflightId,
            JSON.stringify({
                relationshipCapacity: { followers: 300, following: 300 },
                detailedMutualLimit: 300,
            }),
        ],
    );
    await client.query(
        `UPDATE public.analysis_preflights
         SET status = 'consumed', consumed_request_id = $2
         WHERE id = $1`,
        [preflightId, requestId],
    );
    await client.query(
        `INSERT INTO public.analysis_pipeline_jobs (request_id, job_key)
         VALUES ($1, 'collect')`,
        [requestId],
    );
    const activated = await client.query<{
        result: { allocationId: string };
    }>(
        `SELECT public.activate_analysis_beta_apify_request_credit(
            $1, $2, $3, 'standard', $4::jsonb, $5::jsonb, 300
        ) AS result`,
        [
            preflightId,
            requestId,
            userId,
            JSON.stringify(betaSlots),
            JSON.stringify(betaBudgets),
        ],
    );
    await client.query(
        `UPDATE public.analysis_pipeline_jobs
         SET status = 'processing', dispatch_state = 'dispatched',
             dispatch_generation = 1, dispatched_at = clock_timestamp(),
             lease_token = $2,
             lease_expires_at = clock_timestamp() + interval '5 minutes'
         WHERE request_id = $1 AND job_key = 'collect'`,
        [requestId, claimToken],
    );
    return {
        allocationId: activated.rows[0]!.result.allocationId,
        claimToken,
        requestId,
    };
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
        try {
            const clients = [first, second, observer]
                .filter((client): client is Client => Boolean(client));
            await Promise.allSettled(clients.map(client => client.end()));
        } finally {
            if (containerStarted) {
                try {
                    execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
                } catch {
                    // `--rm` may already have removed a container that exited unexpectedly.
                }
            }
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

    it('waits at the canonical allocation fence while terminal settlement remains open', async () => {
        const seeded = await seedActivatedBetaRequest(first);
        const reservationToken = randomUUID();
        await first.query(
            `SELECT public.reserve_analysis_v2_provider_run(
                $1, 'collect', $2, $3, $4, 'apify', 'actor/test',
                'tertiary', 0.01, $5
            )`,
            [
                seeded.requestId,
                seeded.claimToken,
                `relationship-followers:${'c'.repeat(64)}`,
                'd'.repeat(64),
                reservationToken,
            ],
        );
        await first.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [seeded.requestId],
        );

        let firstTransactionOpen = false;
        let secondTransactionOpen = false;
        let migrationApply: Promise<unknown> | null = null;
        try {
            await first.query('BEGIN');
            firstTransactionOpen = true;
            const settlement = await first.query<{
                result: { lifecycleState: string; heldFamilies: number };
            }>(
                `SELECT public.settle_analysis_beta_apify_credit_allocation(
                    $1, 'request_terminal'
                ) AS result`,
                [seeded.allocationId],
            );
            expect(settlement.rows[0]?.result).toMatchObject({
                lifecycleState: 'active',
                heldFamilies: 1,
            });

            await second.query('BEGIN');
            secondTransactionOpen = true;
            const firstPid = (await first.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const secondPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const migrationStartedAt = Date.now();
            migrationApply = second.query(frozenBudgetMigration);
            const observation = await waitForMigrationRelationLock(secondPid);
            expect(observation.blockingPids).toContain(firstPid);
            expect(observation.locks.find(lock => (
                lock.relation_name === 'analysis_beta_pool_allocations'
                && lock.granted === false
            ))).toMatchObject({
                mode: 'ExclusiveLock',
                granted: false,
            });
            expect(observation.locks.some(lock => (
                lock.mode === 'ShareRowExclusiveLock'
            ))).toBe(false);
            expect(observation.locks.filter(lock => (
                lock.relation_name === 'analysis_beta_pool_reservations'
            ))).toEqual([]);

            await first.query('COMMIT');
            firstTransactionOpen = false;
            await migrationApply;
            await second.query('COMMIT');
            secondTransactionOpen = false;
            expect(Date.now() - migrationStartedAt).toBeLessThan(5_000);
        } finally {
            if (firstTransactionOpen) {
                await first.query('ROLLBACK').catch(() => undefined);
            }
            if (migrationApply) {
                await migrationApply.catch(() => undefined);
            }
            if (secondTransactionOpen) {
                await second.query('ROLLBACK').catch(() => undefined);
            }
        }

        const partial = await first.query<{
            allocation_state: string;
            active_count: number;
            settled_count: number;
        }>(
            `SELECT allocation.lifecycle_state AS allocation_state,
                    count(*) FILTER (
                        WHERE reservation.lifecycle_state = 'active'
                    )::int AS active_count,
                    count(*) FILTER (
                        WHERE reservation.lifecycle_state = 'settled'
                    )::int AS settled_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_beta_pool_reservations AS reservation
               ON reservation.allocation_id = allocation.id
             WHERE allocation.id = $1
             GROUP BY allocation.id`,
            [seeded.allocationId],
        );
        expect(partial.rows).toEqual([{
            allocation_state: 'active',
            active_count: 1,
            settled_count: 7,
        }]);
        const trigger = await first.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM pg_catalog.pg_trigger
             WHERE tgname = 'activate_analysis_beta_pool_reservations'
               AND NOT tgisinternal`,
        );
        expect(trigger.rows).toEqual([{ count: 1 }]);

        const future = await seedActivatedBetaRequest(first);
        const futureReservations = await first.query<{
            state: string;
            count: number;
        }>(
            `SELECT lifecycle_state AS state, count(*)::int AS count
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id = $1
             GROUP BY lifecycle_state`,
            [future.allocationId],
        );
        expect(futureReservations.rows).toEqual([{ state: 'active', count: 8 }]);

        // Finish the real forward chain only after the 0600 relation-lock
        // behavior above has been observed. Subsequent cases exercise the
        // worker wiring and the atomic 0800 admission boundary on PostgreSQL.
        await first.query(wireRuntimeMigration);
        await first.query(planAdmissionMigration);
    }, 30_000);

    it('samples database time after the grant barrier and rejects an admission that crosses two minutes', async () => {
        const userId = randomUUID();
        const preflightId = randomUUID();
        const admissionToken = randomUUID();
        await seedReadyAdmission({
            client: first,
            userId,
            preflightId,
            admissionToken,
            refreshedAgeSeconds: 118,
        });

        let grantLockOpen = false;
        let admission: Promise<PlanAdmissionResult> | null = null;
        try {
            await observer.query('BEGIN');
            grantLockOpen = true;
            await observer.query(
                `SELECT user_id FROM public.analysis_beta_access_grants
                 WHERE user_id = $1 FOR UPDATE`,
                [userId],
            );
            const admissionPid = (await first.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            admission = admitReadyPlan({
                client: first,
                userId,
                preflightId,
                admissionToken,
            });
            void admission.catch(() => undefined);
            await waitUntilBlocked(admissionPid);

            // The preflight was fresh when the function began. It becomes
            // older than two minutes while blocked on the authoritative grant.
            await new Promise(resolve => setTimeout(resolve, 2_500));
            await observer.query('COMMIT');
            grantLockOpen = false;
            await expect(admission).rejects.toThrow(/ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/);
        } finally {
            if (grantLockOpen) await observer.query('ROLLBACK').catch(() => undefined);
            if (admission) await admission.catch(() => undefined);
        }

        const durable = await first.query<{
            requests: number;
            jobs: number;
            state: string;
        }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_requests WHERE preflight_id = $1) AS requests,
                (SELECT count(*)::int FROM public.analysis_pipeline_jobs AS job
                 JOIN public.analysis_requests AS request ON request.id = job.request_id
                 WHERE request.preflight_id = $1) AS jobs,
                (SELECT lifecycle_state FROM public.analysis_beta_pool_allocations
                 WHERE preflight_id = $1) AS state`,
            [preflightId],
        );
        expect(durable.rows).toEqual([{ requests: 0, jobs: 0, state: 'preflight_held' }]);
    }, 15_000);

    it('turns concurrent calls for one preflight into one admission plus immutable replay', async () => {
        const userId = randomUUID();
        const preflightId = randomUUID();
        const admissionToken = randomUUID();
        await seedReadyAdmission({ client: first, userId, preflightId, admissionToken });

        let winnerTransactionOpen = false;
        let contender: Promise<PlanAdmissionResult> | null = null;
        try {
            await first.query('BEGIN');
            winnerTransactionOpen = true;
            const winner = await admitReadyPlan({
                client: first,
                userId,
                preflightId,
                admissionToken,
            });
            expect(winner.replayed).toBe(false);

            const contenderPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            contender = admitReadyPlan({
                client: second,
                userId,
                preflightId,
                admissionToken,
                // A racing caller may replan, but replay must use stored maps.
                slots: { ...betaSlots, 'target-comments': 'senary' },
            });
            void contender.catch(() => undefined);
            await waitUntilBlocked(contenderPid);
            await first.query('COMMIT');
            winnerTransactionOpen = false;

            const replay = await contender;
            expect(replay).toMatchObject({
                requestId: winner.requestId,
                allocationId: winner.allocationId,
                initialJobKey: 'coordinator:bootstrap',
                replayed: true,
            });
        } finally {
            if (winnerTransactionOpen) await first.query('ROLLBACK').catch(() => undefined);
            if (contender) await contender.catch(() => undefined);
        }

        const counts = await first.query<{ requests: number; jobs: number; policies: number }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_requests WHERE preflight_id = $1) AS requests,
                (SELECT count(*)::int FROM public.analysis_pipeline_jobs AS job
                 JOIN public.analysis_requests AS request ON request.id = job.request_id
                 WHERE request.preflight_id = $1) AS jobs,
                (SELECT count(*)::int FROM public.analysis_v2_provider_execution_policies AS policy
                 JOIN public.analysis_requests AS request ON request.id = policy.request_id
                 WHERE request.preflight_id = $1) AS policies`,
            [preflightId],
        );
        expect(counts.rows).toEqual([{ requests: 1, jobs: 1, policies: 1 }]);
    });

    it('serializes separate admissions for one user and leaves the loser recoverable', async () => {
        const userId = randomUUID();
        const preflightA = randomUUID();
        const preflightB = randomUUID();
        const tokenA = randomUUID();
        const tokenB = randomUUID();
        await seedReadyAdmission({ client: first, userId, preflightId: preflightA, admissionToken: tokenA });
        await seedReadyAdmission({ client: first, userId, preflightId: preflightB, admissionToken: tokenB });

        let winnerTransactionOpen = false;
        let contender: Promise<PlanAdmissionResult> | null = null;
        try {
            await first.query('BEGIN');
            winnerTransactionOpen = true;
            await admitReadyPlan({
                client: first,
                userId,
                preflightId: preflightA,
                admissionToken: tokenA,
            });
            const contenderPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            contender = admitReadyPlan({
                client: second,
                userId,
                preflightId: preflightB,
                admissionToken: tokenB,
            });
            void contender.catch(() => undefined);
            await waitUntilBlocked(contenderPid);
            await first.query('COMMIT');
            winnerTransactionOpen = false;
            await expect(contender).rejects.toThrow(/ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/);
        } finally {
            if (winnerTransactionOpen) await first.query('ROLLBACK').catch(() => undefined);
            if (contender) await contender.catch(() => undefined);
        }

        const state = await first.query<{
            requests: number;
            loser_preflight: string;
            loser_allocation: string;
        }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_requests WHERE user_id = $1) AS requests,
                (SELECT status FROM public.analysis_preflights WHERE id = $2) AS loser_preflight,
                (SELECT lifecycle_state FROM public.analysis_beta_pool_allocations
                 WHERE preflight_id = $2) AS loser_allocation`,
            [userId, preflightB],
        );
        expect(state.rows).toEqual([{
            requests: 1,
            loser_preflight: 'ready',
            loser_allocation: 'preflight_held',
        }]);
    });

    it('serializes shared pool headroom and rolls back the non-fitting admission', async () => {
        const userA = randomUUID();
        const userB = randomUUID();
        const preflightA = randomUUID();
        const preflightB = randomUUID();
        const tokenA = randomUUID();
        const tokenB = randomUUID();
        await seedReadyAdmission({ client: first, userId: userA, preflightId: preflightA, admissionToken: tokenA });
        await seedReadyAdmission({ client: first, userId: userB, preflightId: preflightB, admissionToken: tokenB });

        const oneActivationHeadroom = {
            primary: 0,
            tertiary: 0.914,
            quaternary: 2.23,
            quinary: 0.782600000001,
            senary: 0.93,
            septenary: 0.81,
        } as const;
        for (const [slot, desiredHeadroom] of Object.entries(oneActivationHeadroom)) {
            await first.query(
                `UPDATE public.analysis_apify_credit_snapshots AS snapshot
                 SET monthly_limit_usd = snapshot.monthly_limit_usd
                       - capacity.effective_capacity_usd + $2
                 FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
                 WHERE snapshot.credential_slot = $1
                   AND capacity.credential_slot = snapshot.credential_slot`,
                [slot, desiredHeadroom],
            );
        }

        let winnerTransactionOpen = false;
        let contender: Promise<PlanAdmissionResult> | null = null;
        try {
            await first.query('BEGIN');
            winnerTransactionOpen = true;
            await admitReadyPlan({
                client: first,
                userId: userA,
                preflightId: preflightA,
                admissionToken: tokenA,
            });
            const contenderPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            contender = admitReadyPlan({
                client: second,
                userId: userB,
                preflightId: preflightB,
                admissionToken: tokenB,
            });
            void contender.catch(() => undefined);
            await waitUntilBlocked(contenderPid);
            await first.query('COMMIT');
            winnerTransactionOpen = false;
            await expect(contender).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);
        } finally {
            if (winnerTransactionOpen) await first.query('ROLLBACK').catch(() => undefined);
            if (contender) await contender.catch(() => undefined);
        }

        const state = await first.query<{
            requests: number;
            winner_state: string;
            loser_state: string;
        }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_requests
                 WHERE preflight_id IN ($1, $2)) AS requests,
                (SELECT lifecycle_state FROM public.analysis_beta_pool_allocations
                 WHERE preflight_id = $1) AS winner_state,
                (SELECT lifecycle_state FROM public.analysis_beta_pool_allocations
                 WHERE preflight_id = $2) AS loser_state`,
            [preflightA, preflightB],
        );
        expect(state.rows).toEqual([{
            requests: 1,
            winner_state: 'active',
            loser_state: 'preflight_held',
        }]);
    });

    it('keeps terminal replay available through settlement and then archives without deadlock', async () => {
        const userId = randomUUID();
        const preflightId = randomUUID();
        const admissionToken = randomUUID();
        await seedReadyAdmission({
            client: first,
            userId,
            preflightId,
            admissionToken,
            snapshotLimit: 100,
        });
        const admitted = await admitReadyPlan({
            client: first,
            userId,
            preflightId,
            admissionToken,
        });
        await first.query(
            `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
            [admitted.requestId],
        );
        await first.query(
            `SELECT public.settle_analysis_beta_apify_credit_allocation(
                $1, 'request_terminal'
            )`,
            [admitted.allocationId],
        );

        const replay = await first.query<{ result: PlanAdmissionResult }>(
            `SELECT public.load_analysis_v2_betatest_plan_replay(
                $1, $2, $3, 1, 'basic'
            ) AS result`,
            [preflightId, userId, admissionToken],
        );
        expect(replay.rows[0]!.result).toMatchObject({
            requestId: admitted.requestId,
            allocationId: admitted.allocationId,
            replayed: true,
        });

        // Hold the same user fence: archive must skip instead of forming a
        // reverse lock cycle, then succeed immediately after release.
        await first.query('BEGIN');
        await first.query('SELECT id FROM public.users WHERE id = $1 FOR UPDATE', [userId]);
        const skipped = await second.query<{ result: number }>(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(100) AS result`,
        );
        expect(skipped.rows[0]!.result).toBeGreaterThanOrEqual(0);
        await first.query('COMMIT');
        await second.query(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(100)`,
        );

        const archived = await first.query<{ live: number; archived: number }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_beta_pool_allocations
                 WHERE id = $1) AS live,
                (SELECT count(*)::int FROM public.analysis_beta_pool_reservation_archive
                 WHERE allocation_id = $1) AS archived`,
            [admitted.allocationId],
        );
        expect(archived.rows).toEqual([{ live: 0, archived: 8 }]);
    }, 15_000);
});
