import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { startOrResumeApifyActor, type ApifyClientLike } from '@/lib/services/instagram/providers/apify-relationship';
import { localDatabaseClient, type StandardConnection, type StandardDatabase } from './standard-database';
import { createAnalysisProviderAdmissionStore } from '@/lib/services/analysis/provider-admission-store';
import { withAnalysisProviderAdmissionCheckpoint } from '@/lib/services/analysis/provider-admission-checkpoint';
import { createAnalysisV2ProviderRunStore } from '@/lib/services/analysis/v2-provider-run-store';
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

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'recovers one known provider start while the normal start checkpoint is blocked by a parent lock',
    async () => {
        const db = await createSharedStandardDatabase();
        try {
            const job = await prepareJob(db);
            const client = localDatabaseClient(db);
            const admission = createAnalysisProviderAdmissionStore({ rpc: client.rpc });
            const claim = { workloadRole: 'paid' as const, requestId: job.requestId, jobKey, operationKey, claimToken: job.jobClaimToken };
            const originalLease = await admission.acquire({
                ...claim, jobClaimToken: claim.claimToken, logicalProvider: 'apify', credentialSlot: 'secondary',
                budgetKey: 'paid:apify:secondary:relationship', leaseSeconds: 30,
            });
            const token = randomUUID();
            await db.query(reserveSql, [...argumentsFor(job), token]);
            const args = [job.requestId, job.jobKey, job.jobClaimToken, operationKey, token, runId];
            const started = 'SELECT public.checkpoint_analysis_v2_provider_run_started($1,$2,$3,$4,$5,$6)';
            const receipt = 'SELECT public.record_analysis_v2_provider_run_started_receipt($1,$2,$3,$4,$5,$6,$7) AS recorded';
            const receiptArgs = [...argumentsFor(job), token, runId];
            await db.transaction(async blocker => {
                await blocker.query('SELECT FROM public.analysis_requests WHERE id=$1 FOR UPDATE', [job.requestId]);
                for (let attempt = 0; attempt < 2; attempt++) {
                    await expect(db.transaction(async worker => {
                        await worker.exec("SET LOCAL statement_timeout='150ms'; SET LOCAL ROLE service_role");
                        await worker.query(started, args);
                    })).rejects.toMatchObject({ code: '57014' });
                }
                const { rows } = await db.query('SELECT status,run_id FROM public.analysis_v2_provider_runs WHERE reservation_token=$1', [token]);
                expect(rows).toEqual([{ status: 'starting', run_id: null }]);
                for (const altered of [
                    [randomUUID(), ...receiptArgs.slice(1)],
                    [...receiptArgs.slice(0, 2), randomUUID(), ...receiptArgs.slice(3)],
                    [...receiptArgs.slice(0, 4), 'd'.repeat(64), token, runId],
                    [...receiptArgs.slice(0, 5), randomUUID(), runId],
                ]) {
                    await expect(db.query(receipt, altered)).rejects.toThrow('FENCE_MISMATCH');
                }
                await db.transaction(async worker => {
                    await worker.exec("SET LOCAL statement_timeout='250ms'; SET LOCAL ROLE service_role");
                    expect((await worker.query(receipt, receiptArgs)).rows).toEqual([{ recorded: true }]);
                });
            });
            await expect(db.transaction(async tx => {
                await tx.exec('SET LOCAL ROLE authenticated');
                await tx.query(receipt, receiptArgs);
            })).rejects.toMatchObject({ code: '42501' });
            await expect(db.query(receipt, [...receiptArgs.slice(0, -1), 'differentRunId'])).rejects.toThrow('RUN_CONFLICT');
            expect((await db.query(receipt, receiptArgs)).rows).toEqual([{ recorded: true }]);
            const other = await prepareJob(db);
            const otherToken = randomUUID();
            await db.query(reserveSql, [...argumentsFor(other), otherToken]);
            await expect(db.query(receipt, [...argumentsFor(other), otherToken, runId])).rejects.toThrow('RUN_CONFLICT');
            const persisted = await db.query('SELECT status,run_id,actual_usage_usd,usage_reconciled_at FROM public.analysis_v2_provider_runs WHERE reservation_token=$1', [token]);
            expect(persisted.rows).toEqual([{ status: 'running', run_id: runId, actual_usage_usd: null, usage_reconciled_at: null }]);
            await expect(db.query(started, [args[0], args[1], randomUUID(), ...args.slice(3)])).rejects.toThrow('FENCE_MISMATCH');
            await db.query(started, args);
            // The queued successor receives a new job claim after the old admission
            // expired. It must adopt the original recorded Actor and the same budget slot.
            const nextClaim = randomUUID();
            await db.query("UPDATE public.analysis_pipeline_jobs SET lease_token=$2 WHERE request_id=$1 AND job_key=$3",
                [job.requestId, nextClaim, jobKey]);
            await db.query("UPDATE public.analysis_provider_admission_leases SET acquired_at=now()-interval '2 minutes', expires_at=now()-interval '1 minute' WHERE admission_id=$1",
                [originalLease.admissionId]);
            const resumed = await createAnalysisV2ProviderRunStore(client).bindAdapterCheckpoint({
                ...claim, claimToken: nextClaim, inputHash: hash, logicalProvider: 'apify',
                credentialSlot: 'secondary', actorId: 'fixture-actor', maxChargeUsd: 0.1,
            });
            expect(resumed.stored?.reservationToken).toBe(token);
            const checkpoint = await withAnalysisProviderAdmissionCheckpoint({
                ...claim, claimToken: nextClaim, checkpoint: resumed.checkpoint, storedStatus: 'running',
                store: admission, env: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            });
            expect(checkpoint.resumeRunId).toBe(runId);
            const start = vi.fn();
            const waitForFinish = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'testDataset' });
            const run = vi.fn(() => ({ waitForFinish }));
            await startOrResumeApifyActor({ actor: () => ({ start }), run } as unknown as ApifyClientLike,
                'fixture-actor', {}, {
                    logicalProvider: 'apify', credentialSlot: 'secondary', timeoutSecs: 30, maxItems: 1,
                    maxTotalChargeUsd: 0.1,
                }, { ...checkpoint, recordUsage: vi.fn() });
            expect(run).toHaveBeenCalledExactlyOnceWith(runId);
            expect(waitForFinish).toHaveBeenCalledOnce();
            expect(start).not.toHaveBeenCalled();
            const { rows: [final] } = await db.query(`SELECT r.status, r.run_id, r.actual_usage_usd,
                l.state, l.fence FROM public.analysis_v2_provider_runs r
                JOIN public.analysis_provider_admission_leases l USING (request_id,job_key,operation_key)
                WHERE r.reservation_token=$1`, [token]);
            expect(final).toEqual({ status: 'succeeded', run_id: runId, actual_usage_usd: null, state: 'released', fence: '3' });

        } finally {
            await db.close();
        }
    }, 90_000,
);
