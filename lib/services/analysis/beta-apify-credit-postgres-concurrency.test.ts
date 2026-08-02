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
let retryExhaustionBeforeUpgrade: {
    channel: string;
    status: string;
    error_code: string | null;
    state: string;
    retry_recorded: boolean;
} | null = null;
let retryExhaustionAfterUpgrade: {
    channel: string;
    status: string;
    error_code: string | null;
    state: string;
    dispatch: string;
    blocked_recorded: boolean;
    completed_recorded: boolean;
    retry_recorded: boolean;
    validated: boolean;
} | null = null;

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
const terminalSettlementMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802090000_settle_betatest_terminal_credit.sql',
    import.meta.url,
), 'utf8');
const entryHardeningMigrations = [
    '20260802100000_harden_betatest_entry_lifecycle.sql',
    '20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
    '20260802100200_validate_betatest_entry_lifecycle.sql',
    '20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
    '20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
    '20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
].map(file => readFileSync(new URL(
    `../../../supabase/migrations/${file}`,
    import.meta.url,
), 'utf8'));
const observabilityMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802100600_add_betatest_pool_observability.sql',
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

async function captured<T>(promise: Promise<T>): Promise<{
    value: T | null;
    error: unknown;
}> {
    return promise.then(
        value => ({ value, error: null }),
        error => ({ value: null, error }),
    );
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

interface HardenedBetaCreateRow {
    preflight_id: string;
    created: boolean;
    preflight_status: string;
    prepare_generation: number;
    prepare_token: string;
    should_enqueue: boolean;
}

async function seedHardenedBetaUser(
    client: Client,
    userId: string,
    grantSeconds = 3_600,
): Promise<void> {
    await client.query(
        'INSERT INTO public.users(id) VALUES($1) ON CONFLICT(id) DO NOTHING',
        [userId],
    );
    await client.query(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1,TRUE,clock_timestamp()+$2*INTERVAL '1 second',$3
        )`,
        [userId, grantSeconds, 'e'.repeat(64)],
    );
    await client.query(
        'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::jsonb)',
        [snapshots(100)],
    );
}

async function createHardenedBeta(input: {
    client: Client;
    userId: string;
    idempotencyKey: string;
    prepareToken: string;
}): Promise<HardenedBetaCreateRow> {
    const created = await input.client.query<HardenedBetaCreateRow>(
        `SELECT *
         FROM public.create_or_replay_analysis_v2_betatest_preflight(
            $1,'owner@example.com','google','target.user',$2,
            '{}'::jsonb,'{}'::jsonb,'test','{}'::jsonb,'{}'::jsonb,$3
         )`,
        [input.userId, input.idempotencyKey, input.prepareToken],
    );
    return created.rows[0]!;
}

async function claimHardenedBeta(input: {
    client: Client;
    userId: string;
    preflightId: string;
    prepareToken: string;
    claimToken: string;
}): Promise<void> {
    await input.client.query(
        `UPDATE public.analysis_preflights
         SET target_followers_count=120,target_following_count=140
         WHERE id=$1`,
        [input.preflightId],
    );
    await input.client.query(
        `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
            $1,$2,1,$3
        )`,
        [input.preflightId, input.userId, input.prepareToken],
    );
    const claim = await input.client.query<{
        claimed: boolean;
        claim_disposition: string;
    }>(
        `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
            $1,$2,1,$3,$4,300
        )`,
        [
            input.preflightId,
            input.userId,
            input.prepareToken,
            input.claimToken,
        ],
    );
    expect(claim.rows).toEqual([{
        claimed: true,
        prepare_state: 'preparing',
        claim_disposition: 'claimed',
    }]);
}

async function prepareHardenedBeta(input: {
    client: Client;
    userId: string;
    preflightId: string;
    prepareToken: string;
    claimToken: string;
}): Promise<void> {
    await input.client.query(
        `SELECT public.prepare_analysis_beta_apify_preflight_credit(
            $1,$2,1,$3,$4,'primary',0.0052,300
        )`,
        [
            input.preflightId,
            input.userId,
            input.prepareToken,
            input.claimToken,
        ],
    );
}

async function markHardenedBetaReady(input: {
    client: Client;
    preflightId: string;
    admissionToken: string;
    planId?: PlanId;
}): Promise<void> {
    const planId = input.planId ?? 'basic';
    const snapshot = admissionSnapshotPayload();
    await input.client.query(
        `UPDATE public.analysis_apify_credit_snapshots
         SET monthly_limit_usd=100,monthly_usage_usd=0`,
    );
    await input.client.query(
        `UPDATE public.analysis_preflights
         SET status='ready',exclusion_decision='skip',target_is_private=FALSE,
             capacity_required_plan_id='basic',required_plan_id='basic',
             launch_status_snapshot=$2::jsonb,plan_cards_snapshot=$3::jsonb,
             pricing_version='earlybird-2026-07-v2',pricing_snapshot=$4::jsonb,
             policy_versions_snapshot=$5::jsonb,ready_at=clock_timestamp(),
             admission_status='ready',admission_generation=1,
             admission_selected_plan_id=$6,admission_token=$7,
             admission_refreshed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=$1`,
        [
            input.preflightId,
            JSON.stringify(snapshot.launch),
            JSON.stringify(snapshot.cards),
            JSON.stringify(snapshot.pricing),
            JSON.stringify(snapshot.policies),
            planId,
            input.admissionToken,
        ],
    );
}

async function seedActivatedBetaRequest(client: Client, snapshotLimit = 10): Promise<{
    allocationId: string;
    claimToken: string;
    requestId: string;
}> {
    const userId = randomUUID();
    const preflightId = randomUUID();
    const requestId = randomUUID();
    const claimToken = randomUUID();
    await seedHold(client, userId, preflightId, snapshotLimit);
    await client.query(
        `SELECT public.hold_analysis_beta_apify_preflight_credit(
            $1, $2, 'primary', 0.0052, 300
        )`,
        [preflightId, userId],
    );
    await client.query(
        `UPDATE public.analysis_apify_credit_snapshots
         SET monthly_limit_usd = $1, monthly_usage_usd = 0`,
        [snapshotLimit],
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

    const testSameUserPrepareCrossing = async () => {
        await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        const userId = randomUUID();
        await seedHardenedBetaUser(first, userId);
        const racer = new Client({ connectionString: databaseUrl });
        await racer.connect();
        const secondPid = (await second.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        const racerPid = (await racer.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        try {
            const firstPrepare = {
                prepareToken: randomUUID(), claimToken: randomUUID(),
                idempotencyKey: `parallel-prepare-a-${randomUUID()}`,
            };
            const secondPrepare = {
                prepareToken: randomUUID(), claimToken: randomUUID(),
                idempotencyKey: `parallel-prepare-b-${randomUUID()}`,
            };
            const createdA = await createHardenedBeta({
                client: first, userId, ...firstPrepare,
            });
            const createdB = await createHardenedBeta({
                client: first, userId, ...secondPrepare,
            });
            await claimHardenedBeta({
                client: first,userId,preflightId: createdA.preflight_id,
                prepareToken: firstPrepare.prepareToken,
                claimToken: firstPrepare.claimToken,
            });
            await claimHardenedBeta({
                client: first,userId,preflightId: createdB.preflight_id,
                prepareToken: secondPrepare.prepareToken,
                claimToken: secondPrepare.claimToken,
            });

            await first.query('BEGIN');
            await first.query(
                `SELECT credential_slot FROM public.analysis_apify_credit_snapshots
                 WHERE credential_slot='primary' FOR UPDATE`,
            );
            const parallelA = prepareHardenedBeta({
                client: second,userId,preflightId: createdA.preflight_id,
                prepareToken: firstPrepare.prepareToken,
                claimToken: firstPrepare.claimToken,
            });
            const parallelB = prepareHardenedBeta({
                client: racer,userId,preflightId: createdB.preflight_id,
                prepareToken: secondPrepare.prepareToken,
                claimToken: secondPrepare.claimToken,
            });
            await waitUntilBlocked(secondPid);
            await waitUntilBlocked(racerPid);
            await first.query('COMMIT');
            await expect(Promise.all([parallelA, parallelB])).resolves.toEqual([
                undefined, undefined,
            ]);
            expect((await first.query<{ prepared: number; allocations: number }>(
                `SELECT
                    (SELECT count(*)::int FROM public.analysis_preflights
                     WHERE id=ANY($1::uuid[]) AND beta_prepare_state='prepared') AS prepared,
                    (SELECT count(*)::int FROM public.analysis_beta_pool_allocations
                     WHERE preflight_id=ANY($1::uuid[])) AS allocations`,
                [[createdA.preflight_id, createdB.preflight_id]],
            )).rows).toEqual([{ prepared: 2, allocations: 2 }]);

            const expiring = {
                prepareToken: randomUUID(), claimToken: randomUUID(),
                idempotencyKey: `expiring-prepare-${randomUUID()}`,
            };
            const createdExpiring = await createHardenedBeta({
                client: first,userId,...expiring,
            });
            await claimHardenedBeta({
                client: first,userId,preflightId: createdExpiring.preflight_id,
                prepareToken: expiring.prepareToken,
                claimToken: expiring.claimToken,
            });
            await first.query(
                `UPDATE public.analysis_preflights
                 SET beta_prepare_lease_expires_at=clock_timestamp()+INTERVAL '350 milliseconds'
                 WHERE id=$1`,
                [createdExpiring.preflight_id],
            );
            await first.query('BEGIN');
            await first.query(
                `SELECT credential_slot FROM public.analysis_apify_credit_snapshots
                 WHERE credential_slot='primary' FOR UPDATE`,
            );
            const expiredPrepare = captured(prepareHardenedBeta({
                client: second,userId,preflightId: createdExpiring.preflight_id,
                prepareToken: expiring.prepareToken,
                claimToken: expiring.claimToken,
            }));
            await waitUntilBlocked(secondPid);
            await new Promise(resolve => setTimeout(resolve, 500));
            await first.query('COMMIT');
            expect(String((await expiredPrepare).error)).toContain(
                'ANALYSIS_BETA_PREPARE_FENCE_MISMATCH',
            );
            expect((await first.query<{
                state: string; allocations: number; reservations: number;
            }>(`SELECT preflight.beta_prepare_state AS state,
                    (SELECT count(*)::int FROM public.analysis_beta_pool_allocations
                     WHERE preflight_id=preflight.id) AS allocations,
                    (SELECT count(*)::int
                     FROM public.analysis_beta_pool_reservations AS reservation
                     JOIN public.analysis_beta_pool_allocations AS allocation
                       ON allocation.id=reservation.allocation_id
                     WHERE allocation.preflight_id=preflight.id) AS reservations
                 FROM public.analysis_preflights AS preflight WHERE preflight.id=$1`,
                [createdExpiring.preflight_id],
            )).rows).toEqual([{
                state: 'preparing', allocations: 0, reservations: 0,
            }]);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await racer.end();
        }
    };

    const testBetaCreateGrantExpiryCrossing = async () => {
        await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        const userId = randomUUID();
        const idempotencyKey = `advisory-expiry-${randomUUID()}`;
        await seedHardenedBetaUser(first, userId);
        await first.query(
            `UPDATE public.analysis_beta_access_grants
             SET expires_at=clock_timestamp()+INTERVAL '350 milliseconds'
             WHERE user_id=$1`,
            [userId],
        );
        const secondPid = (await second.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        try {
            await first.query('BEGIN');
            await first.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended(
                        'analysis-v2-preflight-global-hourly-budget',0
                    )
                )`,
            );
            const create = captured(createHardenedBeta({
                client: second,
                userId,
                idempotencyKey,
                prepareToken: randomUUID(),
            }));
            await waitUntilBlocked(secondPid);
            await new Promise(resolve => setTimeout(resolve, 500));
            await first.query('COMMIT');
            expect(String((await create).error)).toContain(
                'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            );
            expect((await first.query<{
                rows: number; beta_rows: number; ordinary_rows: number;
            }>(`SELECT
                    count(*)::int AS rows,
                    count(*) FILTER (
                        WHERE beta_entry_provenance IS NOT NULL
                    )::int AS beta_rows,
                    count(*) FILTER (
                        WHERE beta_entry_provenance IS NULL
                    )::int AS ordinary_rows
                 FROM public.analysis_preflights
                 WHERE user_id=$1 AND idempotency_key=$2`,
                [userId, idempotencyKey],
            )).rows).toEqual([{
                rows: 0, beta_rows: 0, ordinary_rows: 0,
            }]);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
        }
    };

    const testProviderLeaseExpiryCrossing = async () => {
        await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        const secondPid = (await second.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;

        const runProviderExpiry = async (fresh: boolean) => {
            const userId = randomUUID();
            const prepareToken = randomUUID();
            const prepareClaimToken = randomUUID();
            const providerClaimToken = randomUUID();
            await seedHardenedBetaUser(first, userId);
            const created = await createHardenedBeta({
                client: first,
                userId,
                idempotencyKey: `provider-expiry-${fresh ? 'fresh' : 'initial'}-${randomUUID()}`,
                prepareToken,
            });
            await claimHardenedBeta({
                client: first,userId,preflightId: created.preflight_id,
                prepareToken,claimToken: prepareClaimToken,
            });
            await prepareHardenedBeta({
                client: first,userId,preflightId: created.preflight_id,
                prepareToken,claimToken: prepareClaimToken,
            });
            if (fresh) {
                await first.query(
                    `UPDATE public.analysis_preflights
                     SET status='ready',consumed_request_id=NULL,
                         admission_status='processing',admission_generation=1,
                         admission_claim_token=$2,
                         admission_requested_at=clock_timestamp(),
                         admission_lease_expires_at=
                            clock_timestamp()+INTERVAL '350 milliseconds'
                     WHERE id=$1`,
                    [created.preflight_id, providerClaimToken],
                );
            } else {
                await first.query(
                    `UPDATE public.analysis_preflights
                     SET status='processing',lease_token=$2,
                         lease_expires_at=
                            clock_timestamp()+INTERVAL '350 milliseconds'
                     WHERE id=$1`,
                    [created.preflight_id, providerClaimToken],
                );
            }
            await first.query(
                `INSERT INTO public.analysis_preflight_provider_runs(
                    preflight_id,operation_key,input_hash,credential_slot,
                    max_charge_usd,status
                 ) VALUES($1,'serialization-blocker',$2,'primary',0.0001,'starting')`,
                [created.preflight_id, '9'.repeat(64)],
            );
            await first.query('BEGIN');
            await first.query(
                `UPDATE public.analysis_preflight_provider_runs
                 SET updated_at=clock_timestamp()
                 WHERE preflight_id=$1 AND operation_key='serialization-blocker'`,
                [created.preflight_id],
            );
            const authorization = captured(second.query(
                fresh
                    ? `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
                        $1,1,$2,$3,'primary',0.0026
                       )`
                    : `SELECT public.reserve_analysis_preflight_provider_run(
                        $1,$2,$3,'primary',0.0026
                       )`,
                [created.preflight_id, providerClaimToken, '8'.repeat(64)],
            ));
            await waitUntilBlocked(secondPid);
            await new Promise(resolve => setTimeout(resolve, 500));
            await first.query('COMMIT');
            expect(String((await authorization).error)).toContain(
                'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            );
            const operationKey = fresh
                ? 'target-profile-fresh-admission:g1'
                : 'target-profile-fallback';
            expect((await first.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM public.analysis_preflight_provider_runs
                 WHERE preflight_id=$1 AND operation_key=$2`,
                [created.preflight_id, operationKey],
            )).rows).toEqual([{ count: 0 }]);
        };

        try {
            await runProviderExpiry(false);
            await runProviderExpiry(true);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
        }
    };

    const testAdmissionGateAndExpiryCrossing = async () => {
        await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        const secondPid = (await second.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;

        const seedReady = async (userId: string) => {
            const prepareToken = randomUUID();
            const prepareClaimToken = randomUUID();
            const admissionToken = randomUUID();
            await seedHardenedBetaUser(first, userId);
            const created = await createHardenedBeta({
                client: first,
                userId,
                idempotencyKey: `admission-race-${randomUUID()}`,
                prepareToken,
            });
            await claimHardenedBeta({
                client: first,userId,preflightId: created.preflight_id,
                prepareToken,claimToken: prepareClaimToken,
            });
            await prepareHardenedBeta({
                client: first,userId,preflightId: created.preflight_id,
                prepareToken,claimToken: prepareClaimToken,
            });
            await markHardenedBetaReady({
                client: first,
                preflightId: created.preflight_id,
                admissionToken,
            });
            return {
                userId,
                preflightId: created.preflight_id,
                admissionToken,
            };
        };

        try {
            const gated = await seedReady(randomUUID());
            await first.query('BEGIN');
            await first.query('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
            const gateRejected = captured(admitReadyPlan({
                client: second,
                userId: gated.userId,
                preflightId: gated.preflightId,
                admissionToken: gated.admissionToken,
            }));
            await waitUntilBlocked(secondPid);
            await first.query('COMMIT');
            expect(String((await gateRejected).error)).toContain(
                'ANALYSIS_BETA_ACCESS_UNAVAILABLE',
            );
            expect((await first.query<{
                requests: number; jobs: number; policies: number;
                active_allocations: number; active_reservations: number;
            }>(`SELECT
                    (SELECT count(*)::int FROM public.analysis_requests
                     WHERE preflight_id=$1) AS requests,
                    (SELECT count(*)::int FROM public.analysis_pipeline_jobs AS job
                     JOIN public.analysis_requests AS request ON request.id=job.request_id
                     WHERE request.preflight_id=$1) AS jobs,
                    (SELECT count(*)::int FROM public.analysis_v2_provider_execution_policies AS policy
                     JOIN public.analysis_requests AS request ON request.id=policy.request_id
                     WHERE request.preflight_id=$1) AS policies,
                    (SELECT count(*)::int FROM public.analysis_beta_pool_allocations
                     WHERE preflight_id=$1 AND lifecycle_state='active') AS active_allocations,
                    (SELECT count(*)::int FROM public.analysis_beta_pool_reservations AS reservation
                     JOIN public.analysis_beta_pool_allocations AS allocation
                       ON allocation.id=reservation.allocation_id
                     WHERE allocation.preflight_id=$1
                       AND reservation.lifecycle_state='active') AS active_reservations`,
                [gated.preflightId],
            )).rows).toEqual([{
                requests: 0,jobs: 0,policies: 0,
                active_allocations: 0,active_reservations: 0,
            }]);

            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
            const admitted = await admitReadyPlan({
                client: first,
                userId: gated.userId,
                preflightId: gated.preflightId,
                admissionToken: gated.admissionToken,
            });
            expect(admitted.replayed).toBe(false);
            await first.query('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
            await expect(admitReadyPlan({
                client: second,
                userId: gated.userId,
                preflightId: gated.preflightId,
                admissionToken: gated.admissionToken,
            })).resolves.toEqual({ ...admitted, replayed: true });

            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
            const expiring = await seedReady(randomUUID());
            await first.query(
                `UPDATE public.analysis_beta_access_grants
                 SET expires_at=clock_timestamp()+INTERVAL '350 milliseconds'
                 WHERE user_id=$1`,
                [expiring.userId],
            );
            await first.query(
                `UPDATE public.analysis_preflights
                 SET expires_at=clock_timestamp()+INTERVAL '350 milliseconds'
                 WHERE id=$1`,
                [expiring.preflightId],
            );
            await first.query('BEGIN');
            await first.query(
                `SELECT credential_slot FROM public.analysis_apify_credit_snapshots
                 WHERE credential_slot='primary' FOR UPDATE`,
            );
            const expiredAdmission = captured(admitReadyPlan({
                client: second,
                userId: expiring.userId,
                preflightId: expiring.preflightId,
                admissionToken: expiring.admissionToken,
            }));
            await waitUntilBlocked(secondPid);
            await new Promise(resolve => setTimeout(resolve, 500));
            await first.query('COMMIT');
            expect(String((await expiredAdmission).error)).toMatch(
                /ANALYSIS_BETA_(?:ACCESS_UNAVAILABLE|REQUEST_NOT_ELIGIBLE)/,
            );
            expect((await first.query<{
                status: string; lifecycle: string; requests: number;
                jobs: number; policies: number; active_reservations: number;
            }>(`SELECT preflight.status,
                    allocation.lifecycle_state AS lifecycle,
                    (SELECT count(*)::int FROM public.analysis_requests
                     WHERE preflight_id=preflight.id) AS requests,
                    (SELECT count(*)::int FROM public.analysis_pipeline_jobs AS job
                     JOIN public.analysis_requests AS request ON request.id=job.request_id
                     WHERE request.preflight_id=preflight.id) AS jobs,
                    (SELECT count(*)::int FROM public.analysis_v2_provider_execution_policies AS policy
                     JOIN public.analysis_requests AS request ON request.id=policy.request_id
                     WHERE request.preflight_id=preflight.id) AS policies,
                    (SELECT count(*)::int FROM public.analysis_beta_pool_reservations AS reservation
                     WHERE reservation.allocation_id=allocation.id
                       AND reservation.lifecycle_state='active') AS active_reservations
                 FROM public.analysis_preflights AS preflight
                 JOIN public.analysis_beta_pool_allocations AS allocation
                   ON allocation.preflight_id=preflight.id
                 WHERE preflight.id=$1`,
                [expiring.preflightId],
            )).rows).toEqual([{
                status: 'ready',lifecycle: 'preflight_held',requests: 0,
                jobs: 0,policies: 0,active_reservations: 0,
            }]);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)')
                .catch(() => undefined);
        }
    };

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
        await first.query(terminalSettlementMigration);
    }, 30_000);

    it('enforces invocation lock bounds and leaves a timed-out settlement conservative', async () => {
        const boundedFunctions = [
            'settle_analysis_beta_apify_credit_allocation',
            'settle_analysis_beta_apify_request_credit',
            'settle_analysis_beta_apify_preflight_credit',
            'recover_analysis_beta_apify_credit_allocations',
            'archive_fully_settled_analysis_beta_apify_credit_allocations',
            'archive_settled_analysis_beta_apify_credit_allocations',
            'purge_expired_analysis_v2_preflights',
        ];
        const settings = await first.query<{
            proname: string;
            proconfig: string[];
        }>(
            `SELECT procedure.proname, procedure.proconfig
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = procedure.pronamespace
             WHERE namespace.nspname = 'public'
               AND procedure.proname = ANY($1::text[])
             ORDER BY procedure.proname`,
            [boundedFunctions],
        );
        expect(settings.rows).toHaveLength(boundedFunctions.length);
        for (const setting of settings.rows) {
            expect(setting.proconfig).toEqual(expect.arrayContaining([
                'lock_timeout=1s',
                'statement_timeout=5s',
            ]));
        }

        const seeded = await seedActivatedBetaRequest(first, 1000);
        await first.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [seeded.requestId],
        );
        const preflightId = (await first.query<{ preflight_id: string }>(
            `SELECT preflight_id::text AS preflight_id
             FROM public.analysis_beta_pool_allocations WHERE id = $1`,
            [seeded.allocationId],
        )).rows[0]!.preflight_id;

        let blockerOpen = false;
        let settlement: Promise<unknown> | null = null;
        try {
            await observer.query('BEGIN');
            blockerOpen = true;
            await observer.query(
                `SELECT id FROM public.analysis_preflights WHERE id = $1 FOR UPDATE`,
                [preflightId],
            );
            const settlementPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const startedAt = Date.now();
            settlement = second.query(
                `SELECT public.settle_analysis_beta_apify_request_credit($1)`,
                [seeded.requestId],
            );
            void settlement.catch(() => undefined);
            await waitUntilBlocked(settlementPid);
            await expect(settlement).rejects.toMatchObject({ code: '55P03' });
            const elapsedMs = Date.now() - startedAt;
            expect(elapsedMs).toBeGreaterThanOrEqual(750);
            expect(elapsedMs).toBeLessThan(3_000);

            const conservative = await first.query<{
                allocation_state: string;
                active_families: number;
            }>(
                `SELECT allocation.lifecycle_state AS allocation_state,
                        count(*) FILTER (
                            WHERE reservation.lifecycle_state = 'active'
                        )::int AS active_families
                 FROM public.analysis_beta_pool_allocations AS allocation
                 JOIN public.analysis_beta_pool_reservations AS reservation
                   ON reservation.allocation_id = allocation.id
                 WHERE allocation.id = $1
                 GROUP BY allocation.id`,
                [seeded.allocationId],
            );
            expect(conservative.rows).toEqual([{
                allocation_state: 'active',
                active_families: 8,
            }]);
            await observer.query('ROLLBACK');
            blockerOpen = false;
        } finally {
            if (settlement) await settlement.catch(() => undefined);
            if (blockerOpen) await observer.query('ROLLBACK').catch(() => undefined);
        }

        const retried = await second.query<{
            result: { lifecycleState: string; heldFamilies: number };
        }>(
            `SELECT public.settle_analysis_beta_apify_request_credit($1) AS result`,
            [seeded.requestId],
        );
        expect(retried.rows[0]!.result).toMatchObject({
            lifecycleState: 'settled',
            heldFamilies: 0,
        });
    }, 15_000);

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

    it('rechecks freshness after the snapshot barrier and rolls back post-check admission work', async () => {
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

        let snapshotLockOpen = false;
        let admission: Promise<PlanAdmissionResult> | null = null;
        try {
            await observer.query('BEGIN');
            snapshotLockOpen = true;
            await observer.query(
                `SELECT credential_slot FROM public.analysis_apify_credit_snapshots
                 WHERE credential_slot = 'primary' FOR UPDATE`,
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

            // Request/job rows have been staged in the blocked transaction,
            // but the admission becomes stale before snapshot activation ends.
            await new Promise(resolve => setTimeout(resolve, 2_500));
            await observer.query('COMMIT');
            snapshotLockOpen = false;
            await expect(admission).rejects.toThrow(/ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/);
        } finally {
            if (snapshotLockOpen) await observer.query('ROLLBACK').catch(() => undefined);
            if (admission) await admission.catch(() => undefined);
        }

        const durable = await first.query<{
            requests: number;
            jobs: number;
            policies: number;
            lifecycle: string;
            reservations: number;
        }>(
            `SELECT
                (SELECT count(*)::int FROM public.analysis_requests WHERE preflight_id=$1) AS requests,
                (SELECT count(*)::int FROM public.analysis_pipeline_jobs AS job
                 JOIN public.analysis_requests AS request ON request.id=job.request_id
                 WHERE request.preflight_id=$1) AS jobs,
                (SELECT count(*)::int FROM public.analysis_v2_provider_execution_policies AS policy
                 JOIN public.analysis_requests AS request ON request.id=policy.request_id
                 WHERE request.preflight_id=$1) AS policies,
                allocation.lifecycle_state AS lifecycle,
                (SELECT count(*)::int FROM public.analysis_beta_pool_reservations AS reservation
                 WHERE reservation.allocation_id=allocation.id) AS reservations
             FROM public.analysis_beta_pool_allocations AS allocation
             WHERE allocation.preflight_id=$1`,
            [preflightId],
        );
        expect(durable.rows).toEqual([{
            requests: 0,
            jobs: 0,
            policies: 0,
            lifecycle: 'preflight_held',
            reservations: 1,
        }]);
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

    it('replays one active plus seven settled families after partial terminal settlement', async () => {
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
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status
             ) SELECT $1, 'coordinator:bootstrap', $2, job.input_hash, $3,
                $4, 'apify', 'actor/test', 'tertiary', 0.68, 'starting'
             FROM public.analysis_pipeline_jobs AS job
             WHERE job.request_id=$1 AND job.job_key='coordinator:bootstrap'`,
            [
                admitted.requestId,
                `relationship-followers:${'c'.repeat(64)}`,
                randomUUID(),
                randomUUID(),
            ],
        );
        await first.query(
            `UPDATE public.analysis_requests SET status='failed' WHERE id=$1`,
            [admitted.requestId],
        );
        const partial = await first.query<{
            result: { lifecycleState: string; heldFamilies: number };
        }>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation(
                $1, 'request_terminal'
            ) AS result`,
            [admitted.allocationId],
        );
        expect(partial.rows[0]!.result).toMatchObject({
            lifecycleState: 'active',
            heldFamilies: 1,
        });

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
        const states = await first.query<{ state: string; count: number }>(
            `SELECT lifecycle_state AS state, count(*)::int AS count
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id=$1
             GROUP BY lifecycle_state
             ORDER BY lifecycle_state`,
            [admitted.allocationId],
        );
        expect(states.rows).toEqual([
            { state: 'active', count: 1 },
            { state: 'settled', count: 7 },
        ]);
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

    it('hands terminal request capacity to the next preflight without a provider refresh', async () => {
        const terminal = await seedActivatedBetaRequest(first, 1000);
        const nextUserId = randomUUID();
        const nextPreflightId = randomUUID();
        await seedHold(first, nextUserId, nextPreflightId, 1000);

        // Exhaust primary against the durable ledger without changing the
        // observation fence. The next hold must fail until targeted settlement
        // releases this request's exact target-profile reservation.
        await first.query(
            `UPDATE public.analysis_apify_credit_snapshots AS snapshot
             SET monthly_limit_usd = snapshot.monthly_limit_usd
                   - capacity.effective_capacity_usd
             FROM public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
             WHERE snapshot.credential_slot = 'primary'
               AND capacity.credential_slot = snapshot.credential_slot`,
        );
        const observation = (await first.query<{ observed_at: string }>(
            `SELECT observed_at::text AS observed_at
             FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'primary'`,
        )).rows[0]!.observed_at;
        await expect(first.query(
            `SELECT public.hold_analysis_beta_apify_preflight_credit(
                $1, $2, 'primary', 0.0052, 300
            )`,
            [nextPreflightId, nextUserId],
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);

        await first.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [terminal.requestId],
        );
        const settled = await first.query<{
            result: { lifecycleState: string; heldFamilies: number };
        }>(
            `SELECT public.settle_analysis_beta_apify_request_credit($1) AS result`,
            [terminal.requestId],
        );
        expect(settled.rows[0]!.result).toMatchObject({
            lifecycleState: 'settled',
            heldFamilies: 0,
        });

        const handedOff = await second.query<{
            result: { lifecycleState: string };
        }>(
            `SELECT public.hold_analysis_beta_apify_preflight_credit(
                $1, $2, 'primary', 0.0052, 300
            ) AS result`,
            [nextPreflightId, nextUserId],
        );
        expect(handedOff.rows[0]!.result).toMatchObject({
            lifecycleState: 'preflight_held',
        });
        expect((await first.query<{ observed_at: string; capacity: string }>(
            `SELECT snapshot.observed_at::text AS observed_at,
                    capacity.effective_capacity_usd::text AS capacity
             FROM public.analysis_apify_credit_snapshots AS snapshot
             JOIN public.analysis_beta_pool_effective_capacity_snapshot() AS capacity
               ON capacity.credential_slot = snapshot.credential_slot
             WHERE snapshot.credential_slot = 'primary'`,
        )).rows).toEqual([{ observed_at: observation, capacity: '0.000000000000' }]);
    });

    it('keeps replay while targeted settlement races recovery, then archives without deadlock', async () => {
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
        let settlementTransactionOpen = false;
        try {
            await first.query('BEGIN');
            settlementTransactionOpen = true;
            const settlement = await first.query<{
                result: { lifecycleState: string; heldFamilies: number };
            }>(
                `SELECT public.settle_analysis_beta_apify_request_credit($1) AS result`,
                [admitted.requestId],
            );
            expect(settlement.rows[0]!.result).toMatchObject({
                lifecycleState: 'settled',
                heldFamilies: 0,
            });

            // Recovery follows the same user-first fence and must skip this
            // uncommitted targeted settlement instead of double-processing it.
            const recovery = await second.query<{
                result: Array<{ allocationId: string }>;
            }>(
                `SELECT public.recover_analysis_beta_apify_credit_allocations(100) AS result`,
            );
            expect(recovery.rows[0]!.result.map(item => item.allocationId))
                .not.toContain(admitted.allocationId);
            await first.query('COMMIT');
            settlementTransactionOpen = false;
        } finally {
            if (settlementTransactionOpen) {
                await first.query('ROLLBACK').catch(() => undefined);
            }
        }

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
        // The first hour is intentionally retained for idempotent terminal
        // replay; settlement has already released capacity at this point.
        await first.query(
            `UPDATE public.analysis_beta_pool_allocations
             SET settled_at = clock_timestamp() - interval '2 hours'
             WHERE id = $1`,
            [admitted.allocationId],
        );

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

    describe('hardened beta entry lifecycle', () => {
        beforeAll(async () => {
            for (const migration of entryHardeningMigrations.slice(0, 3)) {
                await first.query(migration);
            }
            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
            const backfillUserId = randomUUID();
            const backfillToken = randomUUID();
            await seedHardenedBetaUser(first, backfillUserId);
            const backfillCreated = await createHardenedBeta({
                client: first,
                userId: backfillUserId,
                idempotencyKey: `retry-backfill-${randomUUID()}`,
                prepareToken: backfillToken,
            });
            await first.query(
                `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                    $1,$2,1,$3
                )`, [backfillCreated.preflight_id, backfillUserId, backfillToken],
            );
            await first.query(
                `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
                    $1,$2,1,$3
                )`, [backfillCreated.preflight_id, backfillUserId, backfillToken],
            );
            retryExhaustionBeforeUpgrade = (await first.query<{
                channel: string;
                status: string;
                error_code: string | null;
                state: string;
                retry_recorded: boolean;
            }>(`SELECT analysis_entry_channel AS channel,status,error_code,
                       beta_prepare_state AS state,
                       (beta_prepare_retry_exhausted_at IS NOT NULL) AS retry_recorded
                FROM public.analysis_preflights WHERE id=$1`,
            [backfillCreated.preflight_id])).rows[0] ?? null;

            for (const migration of entryHardeningMigrations.slice(3)) {
                await first.query(migration);
            }
            await first.query(observabilityMigration);
            retryExhaustionAfterUpgrade = (await first.query<{
                channel: string;
                status: string;
                error_code: string | null;
                state: string;
                dispatch: string;
                blocked_recorded: boolean;
                completed_recorded: boolean;
                retry_recorded: boolean;
                validated: boolean;
            }>(`SELECT preflight.analysis_entry_channel AS channel,preflight.status,
                       preflight.error_code,preflight.beta_prepare_state AS state,
                       preflight.beta_prepare_dispatch_state AS dispatch,
                       (preflight.blocked_at IS NOT NULL) AS blocked_recorded,
                       (preflight.beta_prepare_completed_at IS NOT NULL) AS completed_recorded,
                       (preflight.beta_prepare_retry_exhausted_at IS NOT NULL) AS retry_recorded,
                       constraint_row.convalidated AS validated
                FROM public.analysis_preflights AS preflight
                CROSS JOIN pg_catalog.pg_constraint AS constraint_row
                WHERE preflight.id=$1
                  AND constraint_row.conname='analysis_preflights_beta_prepare_shape_check'`,
            [backfillCreated.preflight_id])).rows[0] ?? null;
        }, 30_000);

        it('backfills the historical pending retry tombstone before validating', () => {
            expect(retryExhaustionBeforeUpgrade).toEqual({
                channel: 'standard',
                status: 'pending',
                error_code: null,
                state: 'reserved',
                retry_recorded: true,
            });
            expect(retryExhaustionAfterUpgrade).toEqual({
                channel: 'betatest',
                status: 'blocked',
                error_code: 'QUEUE_UNAVAILABLE',
                state: 'retry_exhausted',
                dispatch: 'completed',
                blocked_recorded: true,
                completed_recorded: true,
                retry_recorded: true,
                validated: true,
            });
        });

        it('exposes one aggregate-only pool health snapshot to service_role', async () => {
            const privileges = await first.query<{
                role_name: string;
                allowed: boolean;
            }>(`SELECT role_name,
                       pg_catalog.has_function_privilege(
                           role_name,
                           'public.load_analysis_beta_apify_pool_observability(integer)',
                           'EXECUTE'
                       ) AS allowed
                FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
                     AS roles(role_name)
                ORDER BY role_name`);
            expect(privileges.rows).toEqual([
                { role_name: 'anon', allowed: false },
                { role_name: 'authenticated', allowed: false },
                { role_name: 'service_role', allowed: true },
            ]);

            let roleSet = false;
            try {
                await first.query('SET ROLE service_role');
                roleSet = true;
                const aggregate = await first.query<{
                    result: Record<string, unknown>;
                }>(`SELECT public.load_analysis_beta_apify_pool_observability(300)
                           AS result`);
                const result = aggregate.rows[0]!.result;
                expect(Object.keys(result).sort()).toEqual([
                    'activeAllocationCount',
                    'observedAt',
                    'overcommittedSlotCount',
                    'runtimeEnabled',
                    'schemaVersion',
                    'settlementLagMs',
                    'staleSnapshotCount',
                    'totalEffectiveHeadroomUsd',
                ]);
                expect(result).toMatchObject({
                    schemaVersion: 1,
                    runtimeEnabled: true,
                });
                expect(result.staleSnapshotCount).toEqual(expect.any(Number));
                expect(Number(result.staleSnapshotCount)).toBeLessThanOrEqual(6);
                expect(result.overcommittedSlotCount).toEqual(expect.any(Number));
                expect(Number(result.overcommittedSlotCount)).toBeLessThanOrEqual(6);
                expect(JSON.stringify(result)).not.toMatch(
                    /(?:user|request|preflight|account|credential|provider).*id/i
                );
            } finally {
                if (roleSet) await first.query('RESET ROLE');
            }
        });

        it('terminalizes the retry ceiling and requires a new idempotency key', async () => {
            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
            const userId = randomUUID();
            const prepareToken = randomUUID();
            const alternateToken = randomUUID();
            const idempotencyKey = `retry-terminal-${randomUUID()}`;
            await seedHardenedBetaUser(first, userId);
            const created = await createHardenedBeta({
                client: first, userId, idempotencyKey, prepareToken,
            });
            await first.query(
                `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                    $1,$2,1,$3
                )`, [created.preflight_id, userId, prepareToken],
            );
            expect((await first.query<{ exhausted: boolean }>(
                `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
                    $1,$2,1,$3
                ) AS exhausted`, [created.preflight_id, userId, prepareToken],
            )).rows).toEqual([{ exhausted: true }]);

            const replay = await createHardenedBeta({
                client: first, userId, idempotencyKey, prepareToken: alternateToken,
            });
            expect(replay).toMatchObject({
                preflight_id: created.preflight_id,
                created: false,
                preflight_status: 'blocked',
                prepare_generation: 1,
                prepare_token: prepareToken,
                should_enqueue: false,
            });
            expect((await first.query<{
                claimed: boolean;
                prepare_state: string;
                claim_disposition: string;
            }>(`SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                    $1,$2,1,$3,$4,300
                )`, [created.preflight_id, userId, prepareToken, randomUUID()])).rows)
                .toEqual([{
                    claimed: false,
                    prepare_state: 'retry_exhausted',
                    claim_disposition: 'terminal',
                }]);
            expect((await first.query<{ result: string }>(
                `SELECT public.block_analysis_beta_preflight_capacity(
                    $1,$2,1,$3,NULL
                ) AS result`, [created.preflight_id, userId, prepareToken],
            )).rows).toEqual([{ result: 'retry_exhausted' }]);

            const retried = await createHardenedBeta({
                client: first,
                userId,
                idempotencyKey: `retry-new-key-${randomUUID()}`,
                prepareToken: alternateToken,
            });
            expect(retried).toMatchObject({
                created: true,
                preflight_status: 'pending',
                prepare_generation: 1,
                prepare_token: alternateToken,
                should_enqueue: true,
            });
            expect(retried.preflight_id).not.toBe(created.preflight_id);

            await first.query(
                `UPDATE public.analysis_preflights
                 SET expires_at=clock_timestamp()-INTERVAL '1 second'
                 WHERE id=$1`, [created.preflight_id],
            );
            await first.query('SELECT public.purge_expired_analysis_v2_preflights(10)');
            expect((await first.query<{
                status: string;
                state: string;
                error_code: string | null;
                retry_exhausted_at: string | null;
            }>(`SELECT status,beta_prepare_state AS state,error_code,
                       beta_prepare_retry_exhausted_at AS retry_exhausted_at
                FROM public.analysis_preflights WHERE id=$1`,
            [created.preflight_id])).rows).toEqual([{
                status: 'expired',
                state: 'expired',
                error_code: null,
                retry_exhausted_at: null,
            }]);
        });

        it('re-samples expiry after waiting on the preflight row lock', async () => {
            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
            const userId = randomUUID();
            const prepareToken = randomUUID();
            await seedHardenedBetaUser(first, userId);
            const created = await createHardenedBeta({
                client: first,
                userId,
                idempotencyKey: `retry-lock-expiry-${randomUUID()}`,
                prepareToken,
            });
            await first.query(
                `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                    $1,$2,1,$3
                )`, [created.preflight_id, userId, prepareToken],
            );
            await first.query(
                `UPDATE public.analysis_preflights
                 SET expires_at=clock_timestamp()+INTERVAL '350 milliseconds'
                 WHERE id=$1`, [created.preflight_id],
            );
            const secondPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            let transactionOpen = false;
            try {
                await first.query('BEGIN');
                transactionOpen = true;
                await first.query(
                    'SELECT id FROM public.analysis_preflights WHERE id=$1 FOR UPDATE',
                    [created.preflight_id],
                );
                const exhausted = second.query<{ exhausted: boolean }>(
                    `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
                        $1,$2,1,$3
                    ) AS exhausted`, [created.preflight_id, userId, prepareToken],
                );
                await waitUntilBlocked(secondPid);
                await new Promise(resolve => setTimeout(resolve, 500));
                await first.query('COMMIT');
                transactionOpen = false;

                expect((await exhausted).rows).toEqual([{ exhausted: true }]);
            } finally {
                if (transactionOpen) await first.query('ROLLBACK').catch(() => undefined);
            }
            expect((await first.query<{
                status: string;
                channel: string;
                state: string;
                error_code: string | null;
                retry_exhausted_at: string | null;
            }>(`SELECT status,analysis_entry_channel AS channel,
                       beta_prepare_state AS state,error_code,
                       beta_prepare_retry_exhausted_at AS retry_exhausted_at
                FROM public.analysis_preflights WHERE id=$1`,
            [created.preflight_id])).rows).toEqual([{
                status: 'expired',
                channel: 'betatest',
                state: 'expired',
                error_code: null,
                retry_exhausted_at: null,
            }]);
        }, 15_000);

        it('serializes hardened entry, revocation, prepare, block, and provider replay races', async () => {

        const userId = randomUUID();
        const prepareToken = randomUUID();
        const alternatePrepareToken = randomUUID();
        const prepareClaimToken = randomUUID();
        const providerClaimToken = randomUUID();
        const idempotencyKey = `beta-concurrency-${randomUUID()}`;
        const racer = new Client({ connectionString: databaseUrl });
        await racer.connect();

        interface HardenedCreateRow {
            preflight_id: string;
            created: boolean;
            preflight_status: string;
            prepare_generation: number;
            prepare_token: string;
            should_enqueue: boolean;
        }
        const createBeta = (
            client: Client,
            token: string,
            key = idempotencyKey,
        ) => client.query<HardenedCreateRow>(
            `SELECT *
             FROM public.create_or_replay_analysis_v2_betatest_preflight(
                $1,'owner@example.com','google','target.user',$2,
                '{}'::jsonb,'{}'::jsonb,'test','{}'::jsonb,'{}'::jsonb,$3
             )`,
            [userId, key, token],
        );
        const capture = async <T>(promise: Promise<T>): Promise<{
            value: T | null;
            error: unknown;
        }> => promise.then(
            value => ({ value, error: null }),
            error => ({ value: null, error }),
        );

        try {
            await first.query('INSERT INTO public.users(id) VALUES($1)', [userId]);
            await first.query(
                `SELECT public.upsert_analysis_beta_access_grant(
                    $1,TRUE,clock_timestamp()+INTERVAL '1 hour',$2
                )`,
                [userId, 'a'.repeat(64)],
            );
            await first.query(
                'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::jsonb)',
                [snapshots(100)],
            );

            // The first beta call holds the canonical users FOR UPDATE lock.
            // A second beta replay and an ordinary same-key create both wait;
            // after commit only the beta identity can survive.
            await first.query('BEGIN');
            const created = (await createBeta(first, prepareToken)).rows[0]!;
            const secondPid = (await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const racerPid = (await racer.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            )).rows[0]!.pid;
            const betaReplay = createBeta(second, alternatePrepareToken);
            const ordinaryRace = capture(racer.query(
                `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                    $1,'owner@example.com','google','target.user',$2,'production',
                    '{}'::jsonb,'{}'::jsonb,'test','{}'::jsonb,'{}'::jsonb
                 )`,
                [userId, idempotencyKey],
            ));
            await waitUntilBlocked(secondPid);
            await waitUntilBlocked(racerPid);
            await first.query('COMMIT');

            const replayed = (await betaReplay).rows[0]!;
            const ordinary = await ordinaryRace;
            expect(created).toMatchObject({
                created: true,
                prepare_generation: 1,
                prepare_token: prepareToken,
            });
            expect(replayed).toMatchObject({
                preflight_id: created.preflight_id,
                created: false,
                prepare_generation: 1,
                prepare_token: prepareToken,
            });
            expect(String(ordinary.error)).toContain(
                'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT'
            );
            expect((await first.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM public.analysis_preflights
                 WHERE user_id=$1 AND idempotency_key=$2`,
                [userId, idempotencyKey],
            )).rows).toEqual([{ count: 1 }]);

            await first.query(
                `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                    $1,$2,1,$3
                )`,
                [created.preflight_id, userId, prepareToken],
            );
            const claim = await first.query<{
                claimed: boolean;
                prepare_state: string;
                claim_disposition: string;
            }>(
                `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                    $1,$2,1,$3,$4,300
                )`,
                [
                    created.preflight_id,
                    userId,
                    prepareToken,
                    prepareClaimToken,
                ],
            );
            expect(claim.rows).toEqual([{
                claimed: true,
                prepare_state: 'preparing',
                claim_disposition: 'claimed',
            }]);

            // Keep the atomic hold+promotion uncommitted. Both the capacity
            // blocker and same-key replay must wait, then converge on prepared.
            await first.query('BEGIN');
            await first.query(
                `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                    $1,$2,1,$3,$4,'primary',0.0052,300
                )`,
                [
                    created.preflight_id,
                    userId,
                    prepareToken,
                    prepareClaimToken,
                ],
            );
            const blockRace = second.query<{ result: string }>(
                `SELECT public.block_analysis_beta_preflight_capacity(
                    $1,$2,1,$3,$4
                ) AS result`,
                [
                    created.preflight_id,
                    userId,
                    prepareToken,
                    prepareClaimToken,
                ],
            );
            const prepareReplay = createBeta(racer, alternatePrepareToken);
            await waitUntilBlocked(secondPid);
            await waitUntilBlocked(racerPid);
            await first.query('COMMIT');
            expect((await blockRace).rows).toEqual([{ result: 'prepared' }]);
            expect((await prepareReplay).rows[0]).toMatchObject({
                preflight_id: created.preflight_id,
                created: false,
                prepare_generation: 1,
                prepare_token: prepareToken,
                should_enqueue: false,
            });
            expect((await first.query<{
                state: string;
                allocations: number;
                reservations: number;
            }>(
                `SELECT preflight.beta_prepare_state AS state,
                    (SELECT count(*)::int
                     FROM public.analysis_beta_pool_allocations AS allocation
                     WHERE allocation.preflight_id=preflight.id) AS allocations,
                    (SELECT count(*)::int
                     FROM public.analysis_beta_pool_reservations AS reservation
                     JOIN public.analysis_beta_pool_allocations AS allocation
                       ON allocation.id=reservation.allocation_id
                     WHERE allocation.preflight_id=preflight.id) AS reservations
                 FROM public.analysis_preflights AS preflight
                 WHERE preflight.id=$1`,
                [created.preflight_id],
            )).rows).toEqual([{
                state: 'prepared', allocations: 1, reservations: 1,
            }]);

            await first.query(
                `UPDATE public.analysis_preflights
                 SET status='processing',lease_token=$2,
                     lease_expires_at=clock_timestamp()+INTERVAL '5 minutes'
                 WHERE id=$1`,
                [created.preflight_id, providerClaimToken],
            );
            const providerAuthorization = () => second.query<{
                result: { created: boolean };
            }>(
                `SELECT public.reserve_analysis_preflight_provider_run(
                    $1,$2,$3,'primary',0.0026
                ) AS result`,
                [created.preflight_id, providerClaimToken, 'b'.repeat(64)],
            );

            // A gate update must conflict with the authorization's FOR SHARE
            // read. The waiter observes disabled only after the setter commits.
            await first.query('BEGIN');
            await first.query('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
            const gatedAuthorization = capture(providerAuthorization());
            await waitUntilBlocked(secondPid);
            await first.query('COMMIT');
            expect(String((await gatedAuthorization).error)).toContain(
                'ANALYSIS_BETA_RUNTIME_DISABLED'
            );
            await first.query('SELECT public.set_analysis_beta_runtime_gate(TRUE)');

            // Canonical grant revocation takes its row UPDATE lock before the
            // authorization's FOR SHARE read and cannot race a new spend in.
            await first.query('BEGIN');
            await first.query(
                `SELECT public.upsert_analysis_beta_access_grant(
                    $1,FALSE,NULL,$2
                )`,
                [userId, 'c'.repeat(64)],
            );
            const revokedAuthorization = capture(providerAuthorization());
            await waitUntilBlocked(secondPid);
            await first.query('COMMIT');
            expect(String((await revokedAuthorization).error)).toContain(
                'ANALYSIS_BETA_RUNTIME_DISABLED'
            );
            expect((await first.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM public.analysis_preflight_provider_runs
                 WHERE preflight_id=$1`,
                [created.preflight_id],
            )).rows).toEqual([{ count: 0 }]);

            await first.query(
                `SELECT public.upsert_analysis_beta_access_grant(
                    $1,TRUE,clock_timestamp()+INTERVAL '1 hour',$2
                )`,
                [userId, 'd'.repeat(64)],
            );
            expect((await providerAuthorization()).rows[0]!.result)
                .toMatchObject({ created: true });
            await first.query('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
            expect((await providerAuthorization()).rows[0]!.result)
                .toMatchObject({ created: false });
            expect((await first.query<{ count: number }>(
                `SELECT count(*)::int AS count
                 FROM public.analysis_preflight_provider_runs
                 WHERE preflight_id=$1`,
                [created.preflight_id],
            )).rows).toEqual([{ count: 1 }]);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await racer.end();
        }
        }, 30_000);

        it(
            'serializes same-user prepares and rolls an atomic hold back when its claim expires behind snapshots',
            testSameUserPrepareCrossing,
            30_000,
        );
        it(
            'rolls beta create back when its grant expires behind the predecessor advisory barrier',
            testBetaCreateGrantExpiryCrossing,
            15_000,
        );
        it(
            'rejects initial and fresh provider authorization after their lease expires behind ledger serialization',
            testProviderLeaseExpiryCrossing,
            20_000,
        );
        it(
            'waits for gate-off admission, preserves consumed replay, and rolls activation back after snapshot-barrier expiry',
            testAdmissionGateAndExpiryCrossing,
            30_000,
        );
    });
});
