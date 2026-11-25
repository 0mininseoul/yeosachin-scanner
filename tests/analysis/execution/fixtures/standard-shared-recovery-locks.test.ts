import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { StandardConnection, StandardDatabase } from './standard-database';
import { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';

type Job = Awaited<ReturnType<typeof seedProcessingJob>>;
type Competitor = 'reserve' | 'checkpoint' | 'admission';
const jobKey = 'track:relationships:collect';
const operationKey = 'relationship-followers:' + 'b'.repeat(64);
const hash = 'c'.repeat(64);
const runId = 'fixtureRun123';
const followers = JSON.stringify([{ username: 'fixture', is_private: false, is_verified: false, full_name: null, profile_pic_url: null }]);
const resolveSql = `SELECT public.resolve_analysis_v2_recovery_provider_run(
    $1,$2,$3,$4,$5,'apify','fixture-actor','secondary',0.1) IS NULL AS no_source`;
const reserveSql = `SELECT public.reserve_analysis_v2_provider_run(
    $1,$2,$3,$4,$5,'apify','fixture-actor','secondary',0.1,$6) IS NOT NULL AS reserved`;

async function prepareJob(db: Awaited<ReturnType<typeof createSharedStandardDatabase>>) {
    const job = await seedProcessingJob(db);
    await db.query(`UPDATE public.analysis_preflights AS preflight
        SET status='consumed', consumed_at=now(), consumed_request_id=request.id, exclusion_decision='skip',
            target_followers_count=1, target_following_count=0, target_is_private=false, ready_at=now(),
            capacity_required_plan_id='basic', required_plan_id='basic', plan_cards_snapshot=request.plan_cards_snapshot
        FROM public.analysis_requests AS request WHERE request.id=$1 AND preflight.id=request.preflight_id`, [job.requestId]);
    await db.query(`UPDATE public.analysis_pipeline_jobs SET job_key=$2,kind='collection',batch=NULL
        WHERE request_id=$1 AND job_key=$3`, [job.requestId, jobKey, job.jobKey]);
    return { ...job, jobKey };
}

function argumentsFor(job: Job) { return [job.requestId, job.jobKey, job.jobClaimToken, operationKey, hash]; }

async function prepareEvidence(db: StandardDatabase, job: Job) {
    const token = randomUUID();
    await db.query(reserveSql, [...argumentsFor(job), token]);
    const run = [job.requestId, job.jobKey, job.jobClaimToken, operationKey, token, runId];
    await db.query('SELECT public.checkpoint_analysis_v2_provider_run_started($1,$2,$3,$4,$5,$6) IS NOT NULL', run);
    await db.query("SELECT public.checkpoint_analysis_v2_provider_run_terminal($1,$2,$3,$4,$5,$6,'succeeded',0) IS NOT NULL", run);
    return token;
}

async function compete(tx: StandardConnection, job: Job, kind: Competitor, token: string) {
    const args = argumentsFor(job);
    // Only the private identity/hash helpers run as the fixture installer.
    const { rows: [input] } = await tx.query<{ admission_id: string; result_hash: string }>(`SELECT
        public.analysis_provider_admission_expected_id('paid','apify','secondary',$1,$2,$3) AS admission_id,
        public.analysis_v2_relationship_rows_hash('followers',$4) AS result_hash`,
        [job.requestId, job.jobKey, operationKey, followers]);
    await tx.exec('SET LOCAL ROLE service_role');
    if (kind === 'reserve') {
        const { rows } = await tx.query(reserveSql, [...args, token]);
        expect(rows[0].reserved).toBe(true);
    } else if (kind === 'checkpoint') {
        const { rows } = await tx.query(`SELECT public.checkpoint_analysis_v2_relationship_side(
            $1,$2,$3,repeat('a',64),'followers',1,$5,$8,
            'apify',$6,$4,$7) IS NOT NULL AS saved`, [...args, runId, followers, input.result_hash]);
        expect(rows[0].saved).toBe(true);
    } else {
        const { rows } = await tx.query(`SELECT public.acquire_analysis_provider_admission(
            $6,
            'paid','apify','secondary','paid:apify:secondary:relationship',$1,$2,$4,$3,$3,NULL,$5,120
        ) ->> 'outcome' AS outcome`, [...args.slice(0, 4), token, input.admission_id]);
        expect(['acquired', 'already_acquired']).toContain(rows[0].outcome);
    }
}

async function waitForParentBlock(db: StandardDatabase, waiter: number, blocker: number) {
    const deadline = Date.now() + 2_000;
    do {
        const { rows } = await db.query<{ blocked: boolean }>(
            'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker]);
        if (rows[0].blocked) return;
        await delay(5);
    } while (Date.now() < deadline);
    throw new Error('Resolver did not wait for the request fence');
}

function sqlstate(error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
    throw error;
}

// Pause one RPC at its real request-row fence. The other session enters the unmodified
// public resolver. A third session checks its actual child lock while the parent is blocked.
async function race(db: StandardDatabase, job: Job, kind: Competitor, token: string) {
    const locked = Promise.withResolvers<number>();
    const resolving = Promise.withResolvers<number>();
    let childProbe = '';
    const writer = db.transaction(async tx => {
        await tx.exec("SET LOCAL statement_timeout='5s'; SET LOCAL deadlock_timeout='100ms'");
        if (kind !== 'admission') await tx.query(
            'SELECT 1 FROM public.analysis_preflights WHERE consumed_request_id=$1 FOR UPDATE', [job.requestId]);
        const lock = kind === 'admission' ? 'FOR SHARE' : 'FOR UPDATE';
        const { rows: [backend] } = await tx.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid FROM public.analysis_requests WHERE id=$1 ' + lock, [job.requestId]);
        locked.resolve(backend.pid);
        await waitForParentBlock(db, await resolving.promise, backend.pid);
        try {
            await db.transaction(session => session.query(`SELECT 1 FROM public.analysis_pipeline_jobs
                WHERE request_id=$1 AND job_key=$2 FOR UPDATE NOWAIT`, [job.requestId, job.jobKey]));
            childProbe = 'free';
        } catch (error) { childProbe = sqlstate(error); }
        await compete(tx, job, kind, token);
    }).then(() => 'ok', sqlstate);
    const resolver = db.transaction(async tx => {
        await tx.exec("SET LOCAL statement_timeout='5s'; SET LOCAL deadlock_timeout='100ms'");
        await locked.promise;
        const { rows: [backend] } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        resolving.resolve(backend.pid);
        await tx.exec('SET LOCAL ROLE service_role');
        const { rows } = await tx.query(resolveSql, argumentsFor(job));
        expect(rows[0].no_source).toBe(true);
    }).then(() => 'ok', sqlstate);
    return { results: (await Promise.all([writer, resolver])).sort(), childProbe };
}

async function recoveryContract(db: StandardDatabase) {
    const { rows } = await db.query(`SELECT proname,
        CASE WHEN proname <> 'resolve_analysis_v2_recovery_provider_run_pre_pfe' THEN md5(prosrc) END AS body,
        proconfig, prosecdef, proacl::text AS grants
        FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace
          AND (proname = 'resolve_analysis_v2_exact_recovery_provider_run'
               OR proname LIKE 'resolve_analysis_v2_recovery_provider_run%') ORDER BY proname`);
    expect(rows).toHaveLength(7);
    return rows;
}

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'reproduces the recovery resolver child/parent deadlock against three public RPCs and verifies the parent fence',
    async () => {
        const db = await createSharedStandardDatabase(8, { providerRecoveryParentFence: false });
        try {
            const job = await prepareJob(db);
            const token = await prepareEvidence(db, job);
            const contract = await recoveryContract(db);
            const overlay = readFileSync('supabase/migrations/20261126032000_order_analysis_provider_recovery_parent_fence.sql', 'utf8');
            for (const patched of [false, true]) {
                if (patched) { await db.exec(overlay); await db.exec(overlay); }
                for (const kind of ['reserve', 'checkpoint', 'admission'] as const) {
                    const actual = await race(db, job, kind, token);
                    expect(actual, kind).toEqual(patched
                        ? { results: ['ok', 'ok'], childProbe: 'free' }
                        : { results: ['40P01', 'ok'], childProbe: '55P03' });
                }
                expect(await recoveryContract(db)).toEqual(contract);
                const { rows: [ledger] } = await db.query(`SELECT
                    (SELECT count(*)::int FROM public.analysis_v2_provider_runs WHERE request_id=$1) AS runs,
                    (SELECT count(*)::int FROM public.analysis_v2_recovery_provider_run_adoptions WHERE request_id=$1) AS adoptions`,
                    [job.requestId]);
                expect(ledger).toEqual({ runs: 1, adoptions: 0 });
                const wrongClaim = [...argumentsFor(job)];
                wrongClaim[2] = randomUUID();
                await expect(db.query(resolveSql, wrongClaim)).rejects.toMatchObject({
                    code: 'P0001', message: 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_FENCE_MISMATCH',
                });
            }
        } finally { await db.close(); }
    }, 45_000,
);
