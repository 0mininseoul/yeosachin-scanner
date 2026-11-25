import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createGeminiGenerationLimiter } from '@/lib/services/ai/gemini-generation-limiter';
import { ProcessWideAnalysisV2SchedulerArbiter, type AnalysisV2SchedulerRuntimeOptions } from '@/lib/services/analysis/v2-ai-scheduler-runtime';
import { ApifyActorSemaphore } from '@/lib/services/instagram/providers/apify-actor-semaphore';
import { parseAnalysisV2TaskPayload } from '@/lib/services/analysis/v2-tasks';
import { earlybirdFulfillmentStore } from '@/lib/services/earlybird/fulfillment-store';
import { POST as paidWorker } from '@/app/api/analysis/v2/worker/route';
import { ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION, ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER } from '@/lib/services/analysis/v2-worker-task-contract';
import { databaseCounters, sharedStandardFailureSummary, sharedStandardMeasurements } from './fixtures/standard-shared-measurements';
import { createSharedStandardDatabase } from './fixtures/standard-shared-database';
import { configureSharedStandard } from './fixtures/standard-shared-environment';
import { StandardSharedQueue } from './fixtures/standard-shared-queue';
import { createFixtureObjects, createFixtureR2 } from './fixtures/standard-media';
import { createSharedImageSource } from './fixtures/standard-shared-image-source';
import { private90ModelStage } from './fixtures/private90-observations.mjs';
import { syntheticGeneration } from './fixtures/standard-vertex';
import { SyntheticApify, target, type SyntheticActorStart } from './fixtures/standard-providers';
import {
    seedSharedStandardOwners, startSharedStandardPreflight, prepareSharedStandardOrder, admitSharedStandard,
    processSharedStandardPreflight, processSharedStandardBlite, processSharedStandardFresh,
    sharedStandardAdmissionEnv, type SharedStandardOwner
} from './fixtures/standard-shared-admission';
import { settleSharedActorReceipts, verifySharedStandardRequest, sharedStandardEffects } from './fixtures/standard-shared-verification';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn(), from: vi.fn(), session: vi.fn(), queue: vi.fn(), apify: vi.fn(), objects: vi.fn(),
    r2: vi.fn(), source: vi.fn(), model: vi.fn(),
}));
// Each local queue worker has the same process-local semaphores as a Cloud Run instance.
vi.mock('@/lib/services/ai/gemini-generation-limiter', async original => {
    const actual = await original<typeof import('@/lib/services/ai/gemini-generation-limiter')>();
    return { ...actual, getGeminiGenerationLimiter: () => workerCapacity.getStore()?.gemini ?? actual.getGeminiGenerationLimiter() };
});
vi.mock('@/lib/services/analysis/v2-ai-scheduler-runtime', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-ai-scheduler-runtime')>();
    return {
        ...actual, runAnalysisV2FairAiScheduler: <T>(input: AnalysisV2SchedulerRuntimeOptions<T>) =>
            actual.runAnalysisV2FairAiScheduler(input, workerCapacity.getStore()?.scheduler)
    };
});
vi.mock('@/lib/services/instagram/providers/apify-actor-semaphore', async original => {
    const actual = await original<typeof import('@/lib/services/instagram/providers/apify-actor-semaphore')>();
    return { ...actual, getApifyActorSemaphore: () => workerCapacity.getStore()?.apify ?? actual.getApifyActorSemaphore() };
});
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: boundary.rpc, from: boundary.from } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: boundary.session }));
vi.mock('@/lib/services/analysis/background-tasks', async original => ({
    ...await original<typeof import('@/lib/services/analysis/background-tasks')>(),
    createCloudTasksClient: () => boundary.queue(),
}));
vi.mock('apify-client', async original => ({ ...await original<typeof import('apify-client')>(), ApifyClient: class { constructor() { return boundary.apify(); } } }));
vi.mock('@/lib/services/analysis/v2-media-artifact-store', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-media-artifact-store')>();
    return {
        ...actual, createConfiguredAnalysisV2MediaArtifactStore: () => actual.createAnalysisV2MediaArtifactStore({
            objects: boundary.objects(), registry: actual.createAnalysisV2MediaArtifactRegistry({ rpc: boundary.rpc }),
        })
    };
});
vi.mock('@/lib/services/analysis/v2-source-media-archive', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-source-media-archive')>();
    return {
        ...actual, createConfiguredAnalysisV2SourceMediaArchiveStore: () =>
            actual.createAnalysisV2SourceMediaArchiveStore({ objects: boundary.objects() })
    };
});
vi.mock('@/lib/services/media/secure-image-fetch', async original => ({
    ...await original<typeof import('@/lib/services/media/secure-image-fetch')>(),
    downloadSecureImage: async (url: string) => ({ bytes: await boundary.source(url), contentType: 'image/png' }),
}));
vi.mock('@aws-sdk/client-s3', async original => ({
    ...await original<typeof import('@aws-sdk/client-s3')>(), S3Client: class { send = boundary.r2; },
}));
vi.mock('google-auth-library', async original => ({
    ...await original<typeof import('google-auth-library')>(),
    OAuth2Client: class {
        async verifyIdToken({ idToken, audience }: { idToken: string; audience: string }) {
            if (idToken !== 'synthetic-queue' || audience !== 'https://fixture.invalid') throw new Error('FIXTURE_OIDC_INVALID');
            return { getPayload: () => ({ email_verified: true, email: 'fixture@fixture-project.iam.gserviceaccount.com' }) };
        }
    },
}));
vi.mock('@/lib/services/google/credentials', () => ({ prepareGoogleApplicationCredentials: () => undefined }));
vi.mock('@google/genai/node', async original => ({
    ...await original<typeof import('@google/genai/node')>(), GoogleGenAI: class {
        models;
        constructor(options: { fetch: typeof fetch }) {
            const transport = options.fetch;
            this.models = {
                generateContent: async (input: unknown) => {
                    await transport('https://vertex.fixture.invalid');
                    return boundary.model(input);
                }
            };
        }
    }
}));
// Keep the call site when the production worker normalizes an unexpected error.
vi.mock('@/lib/services/analysis/v2-production-executors', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-production-executors')>();
    return {
        ...actual, getAnalysisV2ProductionExecutorRegistry: () => {
            const registry = actual.getAnalysisV2ProductionExecutorRegistry();
            return Object.fromEntries(Object.entries(registry).map(([stage, execute]) => [stage,
                async (context: never) => {
                    try { return await execute(context); }
                    catch (error) {
                        const code = safeCode(error);
                        if (!['ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING', 'ANALYSIS_V2_AI_CAPACITY_PENDING'].includes(code)) {
                            const frame = error instanceof Error ? error.stack?.match(/(?:lib|tests)\/[a-zA-Z0-9_./-]+\.ts:\d+/)?.[0] : undefined;
                            marker('stage-error', { stage, code, frame });
                        }
                        throw error;
                    }
                }]));
        }
    };
});
vi.mock('@/lib/observability/server', async original => ({
    ...await original<typeof import('@/lib/observability/server')>(), operationalLogger: { emit: () => undefined },
}));
vi.mock('next/navigation', async original => {
    const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
    return {
        ...await original<typeof import('next/navigation')>(), useRouter: () => router,
        useSearchParams: () => new URLSearchParams('pipeline=v2')
    };
});

function createWorkerCapacity() {
    return { gemini: createGeminiGenerationLimiter(), scheduler: new ProcessWideAnalysisV2SchedulerArbiter(), apify: new ApifyActorSemaphore() };
}
const workerCapacity = new AsyncLocalStorage<ReturnType<typeof createWorkerCapacity>>();
const auth = new AsyncLocalStorage<SharedStandardOwner | null>();
const requestScope = new AsyncLocalStorage<string>();
const activeTask = new AsyncLocalStorage<Record<string, unknown>>();
function safeCode(value: unknown) {
    const word = value instanceof Error ? value.message.split(/[:\s]/)[0] : '';
    return /^[A-Z][A-Z0-9_]{1,95}$/.test(word) ? word : 'UNCLASSIFIED';
}
function marker(label: string, data: object) { console.info(label, JSON.stringify(data)); }

async function completeWave<T>(tasks: Promise<T>[]) {
    const results = await Promise.allSettled(tasks);
    return results.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    });
}

it('publishes simultaneous paid Standard requests through one database and queue', async () => {
    configureSharedStandard();
    for (const [key, value] of Object.entries(sharedStandardAdmissionEnv)) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', async (url: unknown) => {
        if (url === 'https://vertex.fixture.invalid') return new Response();
        throw new Error('SHARED_STANDARD_EGRESS_DENIED');
    });
    const publicCount = Number(process.env.SHARED_STANDARD_PUBLIC ?? 1);
    const observedTiming = process.env.SHARED_STANDARD_TIMING === 'observed';
    const ownersCount = Number(process.env.SHARED_STANDARD_OWNERS ?? 16);
    const workers = Number(process.env.SHARED_STANDARD_WORKERS ?? 8);
    expect([2, 16]).toContain(ownersCount);
    expect([8, 16, 20]).toContain(workers);
    const slots = workers === 8 ? 8 : workers === 16 ? 48 : 56;
    const recovery = process.env.SHARED_STANDARD_SCENARIO === 'recovery';
    const db = await createSharedStandardDatabase(slots);
    try {
        const { rpc, from } = db.client();
        const errors: Record<string, number> = {};
        let injectedTimeouts = 0;
        let timeoutRequest: string | undefined;
        let resumedTimedOutRead = false;
        let injectedWorker429s = 0;
        boundary.rpc.mockImplementation(async (name, args) => {
            if (recovery && injectedTimeouts === 0 && name === 'load_analysis_v2_profile_fetch_for_consumer'
                && args.p_consumer_job_key === 'track:profile-ai:batch:0') {
                injectedTimeouts++;
                timeoutRequest = requestScope.getStore();
                return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
            }
            const reply = await rpc(name, args);
            if (timeoutRequest && timeoutRequest === requestScope.getStore() && !reply.error
                && name === 'load_analysis_v2_profile_fetch_for_consumer'
                && args.p_consumer_job_key === 'track:profile-ai:batch:0') resumedTimedOutRead = true;
            if (reply.error) {
                const key = [name, reply.error.code, safeCode(new Error(reply.error.message))].join('.');
                errors[key] = (errors[key] ?? 0) + 1;
            }
            return reply;
        });
        boundary.from.mockImplementation(from);
        boundary.session.mockImplementation(async () => {
            const user = auth.getStore() ?? null;
            return { ...db.client(user?.id ?? null), auth: { getUser: async () => ({ data: { user }, error: null }) } };
        });
        const owners = await seedSharedStandardOwners(db, ownersCount, target);
        const asOwner = <T>(owner: SharedStandardOwner | null, run: () => Promise<T>) => auth.run(owner, run);
        const queue = new StandardSharedQueue(observedTiming);
        boundary.queue.mockReturnValue(queue.client);
        const actorStarts = new Map<string, SyntheticActorStart[]>();
        // 401.674 retained Apify admission-seconds across 16 runs. This uniform delay
        // is a stress assumption, since the source did not time each actor on the wire.
        const actorDelayMs = observedTiming ? Math.round(401_674 / 16 * (recovery ? 1.25 : 1)) : 0;
        const provider = new SyntheticApify(1, 1, publicCount, start => {
            const scope = requestScope.getStore();
            if (!scope) throw new Error('MISSING_ACTOR_REQUEST_SCOPE');
            if (!actorStarts.has(scope)) actorStarts.set(scope, []);
            actorStarts.get(scope)!.push(start);
        }, () => activeTask.getStore() ? actorDelayMs : 0);
        boundary.apify.mockReturnValue(provider);
        boundary.r2.mockImplementation(createFixtureR2());
        boundary.objects.mockReturnValue(createFixtureObjects());
        boundary.source.mockImplementation(createSharedImageSource());
        const deliverPaid = (payload: Record<string, unknown>) => paidWorker(new Request('https://fixture.invalid/api/analysis/v2/worker', {
            method: 'POST', body: JSON.stringify(payload), headers: {
                'Content-Type': 'application/json', authorization: 'Bearer synthetic-queue',
                [ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER]: String(ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION),
                'x-cloudtasks-taskretrycount': String(queue.retryCount(payload)),
            },
        }));
        const models = new Map<string, number>();
        let activeModels = 0;
        let peakModels = 0;
        const duplicatedDuringModel = new Set<string>();
        boundary.model.mockImplementation(async input => {
            const scope = requestScope.getStore();
            if (!scope) throw new Error('MISSING_MODEL_REQUEST_SCOPE');
            models.set(scope, (models.get(scope) ?? 0) + 1);
            // Per-stage means from the 351 timed SDK attempts of the November 25 paid run.
            // Historic SDK time includes some admission wait, so this is a stress input.
            const observedMs: Record<string, number> = {
                features: 30889, resolver: 35915, gender_triage: 12226,
                partner: 5797, narrative: 21595, private_names: 12316
            };
            const stage = private90ModelStage(input);
            const delay = observedTiming ? observedMs[stage] : 100;
            if (!delay) throw new Error('SHARED_UNCALIBRATED_MODEL_STAGE');
            activeModels++;
            peakModels = Math.max(peakModels, activeModels);
            try {
                const task = activeTask.getStore();
                if (task && !duplicatedDuringModel.has(scope)) {
                    duplicatedDuringModel.add(scope);
                    const duplicate = await deliverPaid(task);
                    expect(duplicate.status).toBe(409);
                    expect((await duplicate.json()).code).toBe('JOB_LEASE_BUSY');
                }
                await sleep(delay * (recovery ? 1.25 : 1));
                return syntheticGeneration(input, 'female', 'female', recovery && publicCount >= 4);
            } finally {
                activeModels--;
            }
        });
        const ioBefore = await databaseCounters(db);
        const firstAt = performance.now();
        try {
            const runs = await completeWave(owners.map(owner => startSharedStandardPreflight(owner, asOwner)));
            expect(new Set(runs.map(run => run.preflightId)).size).toBe(ownersCount);
            const preflightWorkers = [createWorkerCapacity()];
            await queue.drain(p => typeof p.preflightId === 'string' && p.kind !== 'fresh_admission', preflightWorkers.length, async (payload, worker) => {
                await workerCapacity.run(preflightWorkers[worker]!, () => requestScope.run(String(payload.preflightId), async () => {
                    if (payload.kind === 'precheckout_blite') await processSharedStandardBlite(payload);
                    else await processSharedStandardPreflight(payload);
                }));
            });
            marker('preflight-ready', { count: ownersCount });
            const paidStart = performance.now();
            const payment = ownersCount === 2 ? 'webhook' : 'fixture';
            const orders = await completeWave(runs.map(run => prepareSharedStandardOrder(run, asOwner, { db, payment })));
            const paidWorkers = Array.from({ length: workers }, createWorkerCapacity);
            await queue.drain(p => p.kind === 'fresh_admission', workers, async (payload, worker) => {
                await workerCapacity.run(paidWorkers[worker]!, () =>
                    requestScope.run(String(payload.preflightId), () => processSharedStandardFresh(payload)));
            });
            const admitted = await completeWave(orders.map(admitSharedStandard));
            expect(new Set(admitted.map(run => run.requestId)).size).toBe(ownersCount);
            const paidRequests = new Set(admitted.map(run => run.requestId));
            marker('accepted', { count: ownersCount, queue: queue.size });
            const stageCounts: Record<string, number> = {};
            const sample = new Map<string, Record<string, unknown>>();
            let continuations = 0;
            let queueRetries = 0;
            const retryCodes: Record<string, number> = {};
            const deliveries = await queue.drain(() => true, workers, async (payload, worker) => {
                const task = parseAnalysisV2TaskPayload(payload);
                if (!paidRequests.has(task.requestId)) throw new Error('SHARED_UNEXPECTED_OWNER');
                await requestScope.run(task.requestId, async () => {
                    const stage = task.jobKey.replace(/:\d+$/, ':batch');
                    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
                    // A Cloud Run 429 refuses the delivery before the handler acquires a job.
                    const rejectAtIngress = recovery && injectedWorker429s === 0 && task.jobKey === 'coordinator:bootstrap';
                    if (rejectAtIngress) injectedWorker429s++;
                    const response = rejectAtIngress
                        ? Response.json({ code: 'WORKER_INGRESS_429' }, { status: 429 })
                        : await workerCapacity.run(paidWorkers[worker]!, () => activeTask.run(payload, () => deliverPaid(payload)));
                    const result = await response.json();
                    const waitForCapacity = response.status === 503 && ['ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING', 'ANALYSIS_V2_AI_CAPACITY_PENDING'].includes(result.code);
                    const waitForDispatch = response.status === 409 && ['JOB_DISPATCH_NOT_READY', 'JOB_LEASE_BUSY'].includes(result.code);
                    const retryableWorkerError = response.status === 500 && /^[A-Z][A-Z0-9_]+$/.test(result.code);
                    if (response.status === 429 || waitForCapacity || waitForDispatch || retryableWorkerError) {
                        retryCodes[result.code] = (retryCodes[result.code] ?? 0) + 1;
                        queueRetries++;
                        queue.retry(payload);
                        return;
                    }
                    if (result.status === 'continuation') { continuations++; return; }
                    if (result.status === 'stale_delivery' || result.status === 'already_terminal') return;
                    if (!response.ok || result.status !== 'completed') {
                        throw new Error('SHARED_WORKER_' + stage + ':' + (result.errorCode ?? result.code ?? result.status));
                    }
                    if (task.jobKey === 'track:profile-ai:batch:0') sample.set(task.requestId, payload);
                });
            });
            expect(queue.size).toBe(0);
            expect(sample.size).toBe(ownersCount);
            expect(duplicatedDuringModel.size).toBe(ownersCount);
            const startsBeforeReplay = provider.starts.length;
            const modelsBeforeReplay = boundary.model.mock.calls.length;
            const finishedMs = Math.round(performance.now() - paidStart);
            await earlybirdFulfillmentStore.reconcile(100);
            await settleSharedActorReceipts(db);
            const proofs = [];
            for (const [i, run] of admitted.entries()) {
                const before = await sharedStandardEffects(db, run.requestId, run.orderId, run.owner.id);
                const duplicate = await deliverPaid(sample.get(run.requestId)!);
                expect((await duplicate.json()).status).toBe('already_terminal');
                expect(await sharedStandardEffects(db, run.requestId, run.orderId, run.owner.id)).toEqual(before);
                proofs.push(await verifySharedStandardRequest({
                    db, requestId: run.requestId, orderId: run.orderId, preflightId: run.preflightId,
                    paymentMode: ownersCount <= 2 ? 'webhook' : 'fixture', ownerId: run.owner.id, otherOwnerId: owners[(i + 1) % owners.length]?.id,
                    modelCalls: models.get(run.requestId) ?? 0, expectedPublic: publicCount, expectedPrivate: 1,
                    paidActorStarts: actorStarts.get(run.requestId) ?? [], preflightActorStarts: actorStarts.get(run.preflightId) ?? [],
                    asUser: (id, fn) => asOwner(id ? owners.find(o => o.id === id) ?? null : null, fn),
                }));
            }
            expect(provider.starts.length).toBe(startsBeforeReplay);
            expect(proofs.reduce((n, p) => n + p.actorReceipts.paid.matched + p.actorReceipts.preflight.matched, 0)).toBe(provider.starts.length);
            expect(boundary.model.mock.calls.length).toBe(modelsBeforeReplay);
            const measurements = await sharedStandardMeasurements(db, admitted.map(run => run.requestId));
            expect(measurements.times).toHaveLength(ownersCount);
            expect(measurements.times.every(t => t.admissionMs >= 0 && t.paymentMs >= t.admissionMs && t.ownerReadyMs >= t.paymentMs && t.ownerReadyMs <= 3_600_000)).toBe(true);
            expect(injectedTimeouts).toBe(recovery ? 1 : 0);
            expect(resumedTimedOutRead).toBe(recovery);
            expect(injectedWorker429s).toBe(recovery ? 1 : 0);
            expect(Object.keys(errors).filter(error => error.startsWith('claim_analysis_lifecycle_event.'))).toEqual([]);
            const lifecycle = await db.query<{ started: number; completed: number }>(`
                SELECT count(*) FILTER (WHERE event_name = 'analysis_started')::int AS started,
                       count(*) FILTER (WHERE event_name = 'analysis_completed')::int AS completed
                FROM analysis_lifecycle_events WHERE request_id=ANY($1::uuid[])
            `, [admitted.map(run => run.requestId)]);
            expect(lifecycle.rows[0]).toEqual({ started: ownersCount, completed: ownersCount });
            const ioAfter = await databaseCounters(db);
            const pgDelta = {
                blocksRead: ioAfter.read - ioBefore.read, bufferHits: ioAfter.hit - ioBefore.hit,
                tempBytes: ioAfter.tempBytes - ioBefore.tempBytes, deadlocks: ioAfter.deadlocks - ioBefore.deadlocks
            };
            const report = {
                status: 'verified', retryPolicy: queue.retryPolicy, dispatchBurst: queue.burst, lifecycle: lifecycle.rows[0], pgDelta, retryCodes, owners: ownersCount, workers, slots, publicCount, observedTiming, actorDelayMs, recovery, injectedTimeouts, resumedTimedOutRead, injectedWorker429s, ...measurements, deliveries, continuations, queueRetries, peakWorkers: queue.peakWorkers,
                paidStartToDrainMs: finishedMs, firstPreflightToVerifiedMs: Math.round(performance.now() - firstAt),
                syntheticActorStarts: provider.starts.length, syntheticModelCalls: [...models.values()].reduce((a, b) => a + b, 0),
                peakModels, duplicatesDuringModel: duplicatedDuringModel.size, duplicatesAfterModel: sample.size, duplicateCreates: queue.duplicateCreates, stageCounts, errors, proofs
            };
            marker('shared-standard-complete', report);
            if (process.env.SHARED_STANDARD_RECEIPT) writeFileSync(process.env.SHARED_STANDARD_RECEIPT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        } catch (error) {
            const reason = error instanceof Error && /^SHARED_WORKER_[a-z0-9:.-]+:[A-Z_0-9]+$/.test(error.message)
                ? error.message : safeCode(error);
            const failure = {
                status: 'failed', retryPolicy: queue.retryPolicy, reason, owners: ownersCount, workers, slots,
                publicCount, observedTiming, recovery, injectedTimeouts, resumedTimedOutRead, injectedWorker429s, elapsedMs: Math.round(performance.now() - firstAt),
                errors, ...await sharedStandardFailureSummary(db)
            };
            marker('shared-standard-stopped', failure);
            if (process.env.SHARED_STANDARD_RECEIPT) writeFileSync(process.env.SHARED_STANDARD_RECEIPT, JSON.stringify(failure, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            throw error;
        }
    } finally {
        await db.close();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    }
});
