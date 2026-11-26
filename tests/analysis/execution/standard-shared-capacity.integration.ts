import { channel } from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { isAiStageName } from '@/lib/services/ai/stage-policy';
import { createGeminiGenerationLimiter } from '@/lib/services/ai/gemini-generation-limiter';
import { ProcessWideAnalysisV2SchedulerArbiter, type AnalysisV2SchedulerRuntimeOptions } from '@/lib/services/analysis/v2-ai-scheduler-runtime';
import { ApifyActorSemaphore } from '@/lib/services/instagram/providers/apify-actor-semaphore';
import { parseAnalysisV2TaskPayload } from '@/lib/services/analysis/v2-tasks';
import { startSharedStandardMaintenance } from './fixtures/standard-shared-maintenance';
import { POST as paidWorker } from '@/app/api/analysis/v2/worker/route';
import { ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION, ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER } from '@/lib/services/analysis/v2-worker-task-contract';
import { databaseCounters, sharedStandardStopEvidence, sharedStandardMeasurements } from './fixtures/standard-shared-measurements';
import { createSharedStandardDatabase } from './fixtures/standard-shared-database';
import { readSharedResolverLedger, SharedResolverObservation } from './fixtures/standard-shared-resolver-observation';
import { sharedStandardCapacity } from './fixtures/standard-shared-capacities.mjs';
import { configureSharedStandard } from './fixtures/standard-shared-environment';
import { StandardSharedQueue } from './fixtures/standard-shared-queue';
import { createFixtureObjects, createFixtureR2 } from './fixtures/standard-media';
import { createSharedImageSource } from './fixtures/standard-shared-image-source';
import { private90ModelStage } from './fixtures/private90-observations.mjs';
import { syntheticGeneration } from './fixtures/standard-vertex';
import { SyntheticApify, target, type SyntheticActorStart } from './fixtures/standard-providers';
import {
    seedSharedStandardOwners, startSharedStandardPreflight, prepareSharedStandardOrder, admitSharedStandard,
    prepareSharedAutomaticOrders, readSharedAutomaticOrders, checkSharedReadyHandoffFences, sharedPublicProfile, captureSharedPaymentAfter, completeWave,
    processSharedStandardPreflight, processSharedStandardBlite, processSharedStandardFresh,
    sharedStandardAdmissionEnv, type SharedStandardOwner
} from './fixtures/standard-shared-admission';
import { countVerifiedResultEmailClaims, observeSharedOwnerReads, settleSharedActorReceipts, verifySharedStandardRequest, sharedStandardEffects } from './fixtures/standard-shared-verification';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn(), from: vi.fn(), session: vi.fn(), queue: vi.fn(), apify: vi.fn(), objects: vi.fn(),
    r2: vi.fn(), source: vi.fn(), model: vi.fn(), freshProfile: vi.fn(),
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
vi.mock('next/server', async original => {
    const actual = await original<typeof import('next/server')>();
    return { ...actual, after: (task: Parameters<typeof actual.after>[0]) => {
        if (!captureSharedPaymentAfter(task)) actual.after(task);
    } };
});
vi.mock('@/lib/services/analysis/background-tasks', async original => ({
    ...await original<typeof import('@/lib/services/analysis/background-tasks')>(),
    createCloudTasksClient: () => boundary.queue(),
}));
vi.mock('@/lib/services/instagram/providers/selfhosted', async original => ({
    ...await original<typeof import('@/lib/services/instagram/providers/selfhosted')>(),
    getSelfHostedAdmissionProfileSummary: (username: string) => boundary.freshProfile(username),
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
                generateContent: (input: unknown) => {
                    const signal = (input as { config?: { abortSignal?: AbortSignal } }).config?.abortSignal;
                    const generate = async () => {
                        await transport('https://vertex.fixture.invalid', { signal });
                        return boundary.model(input);
                    };
                    return private90ModelStage(input) === 'resolver' ? resolverObservation.sdk(signal, generate) : generate();
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
let resolverObservation: SharedResolverObservation;
function safeCode(value: unknown) {
    const word = value instanceof Error ? value.message.split(/[:\s]/)[0] : '';
    return /^[A-Z][A-Z0-9_]{1,95}$/.test(word) ? word : 'UNCLASSIFIED';
}
function marker(label: string, data: object) { console.info(label, JSON.stringify(data)); }

it('publishes simultaneous paid Standard requests through one database and queue', async () => {
    resolverObservation = new SharedResolverObservation();
    configureSharedStandard();
    for (const [key, value] of Object.entries(sharedStandardAdmissionEnv)) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', async (url: unknown) => {
        if (url === 'https://vertex.fixture.invalid') {
            resolverObservation.wire();
            return new Response();
        }
        throw new Error('SHARED_STANDARD_EGRESS_DENIED');
    });
    const publicCount = Number(process.env.SHARED_STANDARD_PUBLIC ?? 1);
    const observedTiming = process.env.SHARED_STANDARD_TIMING === 'observed';
    const ownersCount = Number(process.env.SHARED_STANDARD_OWNERS ?? 16);
    const capacity = sharedStandardCapacity(process.env.SHARED_STANDARD_PRESET ?? '8');
    const { slots, workers } = capacity;
    expect(Number.isInteger(ownersCount) && ownersCount >= 1 && ownersCount <= 16).toBe(true);
    if (process.env.SHARED_STANDARD_WORKERS !== undefined) expect(Number(process.env.SHARED_STANDARD_WORKERS)).toBe(workers);
    const recovery = process.env.SHARED_STANDARD_SCENARIO === 'recovery';
    const productionPaid = process.env.SHARED_STANDARD_DELIVERY === 'production-paid';
    const automaticPayments = productionPaid && ownersCount <= 10;
    const checkoutEvidence = automaticPayments ? 'signed_webhook_automatic_fulfillment'
        : ownersCount <= 10 ? 'signed_webhook_operator_admission' : 'synthetic_paid_receipt_operator_admission';
    if (automaticPayments) {
        vi.stubEnv('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED', 'true');
        vi.stubEnv('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE', new Date(Date.now() - 60_000).toISOString());
    }
    const coverage99 = productionPaid || process.env.DEV_LIVE_STANDARD_RESOLVER_MODE === 'admitted';
    const approvedOwners = new Set<string>();
    const expandedOwners = new Set<string>();
    const logicalLeaseOwners = new Set<string>();
    const dispatchAuthorizedOwners = new Set<string>();
    const tokenLogEvents: Record<string, number> = {};
    const tokenLogChannel = channel('yeosachin.gemini-token-log');
    function observeTokenLog(message: unknown) {
        const event = message as { stage?: unknown; outcome?: string } | undefined;
        if (!event || !isAiStageName(event.stage)
            || !['audit_committed_then_aborted', 'audit_committed_fenced', 'insert_acknowledged',
                'insert_error_response', 'insert_threw'].includes(event.outcome ?? '')) return;
        const key = event.stage + '.' + event.outcome;
        tokenLogEvents[key] = (tokenLogEvents[key] ?? 0) + 1;
    }
    const admissionEvents: Record<string, number> = {};
    const continuationSetups = { acquire_lease: 0, reserve_attempt: 0 };
    const continuationChannel = channel('yeosachin.standard.resolver-continuation');
    function observeContinuation(message: unknown) {
        const phase = (message as { phase?: unknown } | undefined)?.phase;
        if (phase === 'acquire_lease' || phase === 'reserve_attempt') continuationSetups[phase]++;
    }
    const admissionChannel = channel('yeosachin.standard.resolver-admission');
    function observeAdmission(message: unknown) {
        const event = message as { reason?: string; outcome?: string } | undefined;
        if (!event || !['worker_stage', 'worker_shared', 'global_resolver', 'global_shared'].includes(event.reason ?? '')
            || !['contended', 'skipped', 'admitted_after_wait'].includes(event.outcome ?? '')) return;
        const key = event.reason + '.' + event.outcome;
        admissionEvents[key] = (admissionEvents[key] ?? 0) + 1;
    }
    // The production database retains its legacy entry points. Only the explicitly
    // approved paid handler may call the expanded allocator.
    const db = productionPaid
        ? await createSharedStandardDatabase(8, { production: true })
        : await createSharedStandardDatabase(capacity.preset);
    tokenLogChannel.subscribe(observeTokenLog);
    admissionChannel.subscribe(observeAdmission);
    continuationChannel.subscribe(observeContinuation);
    try {
        if (productionPaid) {
            await db.exec(readFileSync('supabase/operations/20261126_expand_paid_standard_vertex.sql', 'utf8'));
        }
        if (automaticPayments) {
            await db.query(`UPDATE paid_analysis_capacity_policy SET max_active=$1, validation_ref='automatic-webhook-offline'`,
                [ownersCount]);
        }
        const { rpc, from } = db.client();
        const errors: Record<string, number> = {};
        let injectedTimeouts = 0;
        let timeoutRequest: string | undefined;
        let resumedTimedOutRead = false;
        let injectedWorker429s = 0;
        // Exercise a lost commercial handoff separately from the full-size throughput trial.
        const injectFreshHandoffLoss = recovery && automaticPayments && ownersCount <= 2;
        let lostFreshDelivery: string | undefined;
        let probedFreshHandoff = false;
        let freshProbeFailure: Error | undefined;
        const publishedHandoffs = new Set<string>();
        let publishedHandoffCalls = 0;
        const readyHandoffs = new Set<string>();
        const freshProfileReads = new Set<string>();
        boundary.freshProfile.mockImplementation((username: string) => {
            const preflight = requestScope.getStore();
            if (!preflight || freshProfileReads.has(preflight)) throw new Error('SHARED_DUPLICATE_FRESH_PROFILE_READ');
            freshProfileReads.add(preflight);
            return sharedPublicProfile(username);
        });
        boundary.rpc.mockImplementation(async (name, args) => {
            if (recovery && injectedTimeouts === 0 && name === 'load_analysis_v2_profile_fetch_for_consumer'
                && args.p_consumer_job_key === 'track:profile-ai:batch:0') {
                injectedTimeouts++;
                timeoutRequest = requestScope.getStore();
                return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
            }
            if (name === 'handoff_ready_signed_paid_fulfillment_v1' && automaticPayments && ownersCount <= 2 && !probedFreshHandoff) {
                probedFreshHandoff = true;
                try {
                    await checkSharedReadyHandoffFences(db, args);
                } catch (error) {
                    const problem = error as { code?: string; constraint?: string };
                    const detail = [problem.code, problem.constraint].filter(part => part && /^[a-zA-Z0-9_]+$/.test(part)).join(':');
                    freshProbeFailure = new Error('SHARED_FRESH_HANDOFF_NEGATIVE_PROBE:' + detail);
                    throw freshProbeFailure;
                }
            }
            const reply = await rpc(name, args);
            if (name === 'complete_published_capacity_order_v1') {
                publishedHandoffCalls++;
                if (reply.data === true) publishedHandoffs.add(args.p_request_id);
            }
            if (name === 'handoff_ready_signed_paid_fulfillment_v1' && !reply.error && typeof reply.data === 'string') {
                readyHandoffs.add(reply.data);
                if (injectFreshHandoffLoss && !lostFreshDelivery) {
                    lostFreshDelivery = args.p_preflight_id;
                    return { data: null, error: { code: '08006', message: 'synthetic response loss after commit' } };
                }
            }
            if (name === 'paid_standard_capacity_approved_v1' && reply.data === true) {
                approvedOwners.add(args.p_request_id);
            }
            if (name === 'acquire_paid_standard_gemini_lease_v1' && !reply.error
                && Array.isArray(reply.data) && reply.data.some(row => row.outcome === 'acquired')) {
                expandedOwners.add(args.p_request_id);
            }
            if (name === 'acquire_paid_standard_provider_admission_v1' && !reply.error && reply.data
                && typeof reply.data === 'object' && 'outcome' in reply.data && reply.data.outcome === 'acquired') {
                logicalLeaseOwners.add(args.p_request_id);
            }
            if (name === 'authorize_paid_standard_vertex_dispatch_v1' && !reply.error && reply.data === true) {
                dispatchAuthorizedOwners.add(args.p_request_id);
            }
            if ((name === 'reserve_analysis_v2_ai_attempt' || name === 'reserve_paid_standard_ai_attempt_v1') && !reply.error && reply.data && typeof reply.data === 'object'
                && 'created' in reply.data && reply.data.created === true) {
                resolverObservation.bindReservation(args.p_request_id, args.p_operation_key, args.p_attempt);
            }
            if (timeoutRequest && timeoutRequest === requestScope.getStore() && !reply.error
                && name === 'load_analysis_v2_profile_fetch_for_consumer'
                && args.p_consumer_job_key === 'track:profile-ai:batch:0') resumedTimedOutRead = true;
            if (reply.error) {
                const key = [name, reply.error.code, reply.error.constraint ?? safeCode(new Error(reply.error.message))].join('.');
                errors[key] = (errors[key] ?? 0) + 1;
            }
            return reply;
        });
        boundary.from.mockImplementation(from);
        boundary.session.mockImplementation(async () => {
            const user = auth.getStore() ?? null;
            return { ...db.client(user?.id ?? null), auth: { getUser: async () => ({ data: { user }, error: null }) } };
        });
        const identities = await seedSharedStandardOwners(db, Math.max(2, ownersCount), target);
        const owners = identities.slice(0, ownersCount);
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
                try {
                    await sleep(delay * (recovery ? 1.25 : 1), undefined, { signal: input.config?.abortSignal });
                } catch (error) {
                    resolverObservation.waitRejected(error);
                    throw error;
                }
                return resolverObservation.response(syntheticGeneration(input, 'female', 'female', recovery && publicCount >= 4));
            } finally {
                activeModels--;
            }
        });
        const ioBefore = await databaseCounters(db);
        const firstAt = performance.now();
        let lateOwners = 0;
        let ownersWithLedgerIssues = 0;
        let sharedLedgerIssues: string[] = [];
        let belowCoverage = false;
        let ownerReadOverHour = false;
        let directPublicationMissing = false;
        let ownerObserver: ReturnType<typeof observeSharedOwnerReads> | undefined;
        let maintenance: ReturnType<typeof startSharedStandardMaintenance> | undefined;
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
            const periodicFulfillment = productionPaid && observedTiming;
            const payment = ownersCount <= 10 ? 'webhook' : 'fixture';
            const automatic = automaticPayments ? await prepareSharedAutomaticOrders(runs, asOwner, db) : null;
            const orders = automatic?.orders ?? await completeWave(runs.map(run => prepareSharedStandardOrder(run, asOwner, { db, payment })));
            const instanceCount = 'instances' in capacity ? capacity.instances : workers;
            const instances = Array.from({ length: instanceCount }, createWorkerCapacity);
            // Round-robin request lanes, with an independent limiter only per instance.
            const paidWorkers = Array.from({ length: workers }, (_, lane) => instances[lane % instances.length]!);
            const enablePaidWorker = () => {
                vi.stubEnv('NODE_ENV', 'production');
                vi.stubEnv('K_SERVICE', 'analysis-paid-worker');
                vi.stubEnv('ANALYSIS_WORKLOAD_ROLE', 'paid');
                vi.stubEnv('PAID_STANDARD_VERTEX_CAPACITY_MODE', 'expanded128');
            };
            if (automatic) enablePaidWorker();
            await queue.drain(p => p.kind === 'fresh_admission', workers, async (payload, worker) => {
                await workerCapacity.run(paidWorkers[worker]!, () => requestScope.run(String(payload.preflightId), async () => {
                    if (!automatic) { await processSharedStandardFresh(payload); return; }
                    const reply = await deliverPaid(payload);
                    if (freshProbeFailure) throw freshProbeFailure;
                    if (!reply.ok && lostFreshDelivery === payload.preflightId && queue.retryCount(payload) === 0) {
                        queue.retry(payload);
                        return;
                    }
                    expect(reply.status).toBe(200);
                    expect(['ready','noop']).toContain((await reply.json()).status);
                    const duplicate = await deliverPaid(payload);
                    expect(duplicate.status).toBe(200);
                    expect((await duplicate.json()).status).toBe('noop');
                }));
            });
            const admitted = automatic ? await readSharedAutomaticOrders(orders, db) : await completeWave(orders.map(admitSharedStandard));
            if (productionPaid && !automatic) enablePaidWorker();
            if (automatic) {
                expect(readyHandoffs.size).toBe(orders.length);
                expect(freshProfileReads.size).toBe(orders.length);
                expect(Boolean(lostFreshDelivery)).toBe(injectFreshHandoffLoss);
                expect(probedFreshHandoff).toBe(ownersCount <= 2);
            }
            expect(new Set(admitted.map(run => run.requestId)).size).toBe(ownersCount);
            const paidRequests = new Set(admitted.map(run => run.requestId));
            marker('accepted', { count: ownersCount, queue: queue.size });
            const stageCounts: Record<string, number> = {};
            const sample = new Map<string, Record<string, unknown>>();
            let continuations = 0;
            let queueRetries = 0;
            const retryCodes: Record<string, number> = {};
            const asUser = <T>(id: string | null, fn: () => Promise<T>) =>
                asOwner(id ? identities.find(owner => owner.id === id) ?? null : null, fn);
            const observer = observeSharedOwnerReads(db, admitted, asUser, publicCount, 1);
            ownerObserver = observer;
            const recoveryClock = startSharedStandardMaintenance(observer.scan, paidStart);
            maintenance = recoveryClock;
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
                    if (task.jobKey === 'coordinator:finalize') {
                        if (periodicFulfillment) await observer.scan();
                        else await recoveryClock.reconcile();
                    }
                });
            });
            const finishedMs = Math.round(performance.now() - paidStart);
            const requestIds = admitted.map(run => run.requestId);
            if (periodicFulfillment) {
                const waitUntil = performance.now() + 6 * 60_000;
                // A completed first order already reads while other owners' workers continue.
                // This guard only bounds the final periodic handoff after all workers drain.
                while (observer.remaining > 0) {
                    await observer.scan();
                    if (!observer.remaining) break;
                    if (performance.now() >= waitUntil) throw new Error('SHARED_PERIODIC_FULFILLMENT_INCOMPLETE');
                    await sleep(2_000);
                }
            } else {
                await recoveryClock.reconcile();
            }
            const postDrainFulfillmentWaitMs = Math.round(performance.now() - paidStart) - finishedMs;
            await maintenance.stop();
            const ownerReads = await observer.finish();
            if (productionPaid) {
                expect(approvedOwners.size).toBe(admitted.length);
                for (const owners of [expandedOwners, logicalLeaseOwners, dispatchAuthorizedOwners]) {
                    expect(owners.size).toBe(admitted.length);
                    expect(admitted.every(({ requestId }) => owners.has(requestId))).toBe(true);
                }
                expect(admitted.every(({ requestId }) => approvedOwners.has(requestId))).toBe(true);
                // Owner page rendering uses the test React bundle.
                vi.stubEnv('NODE_ENV', 'test');
            }
            expect(queue.size).toBe(0);
            expect(sample.size).toBe(ownersCount);
            expect(duplicatedDuringModel.size).toBe(ownersCount);
            const startsBeforeReplay = provider.starts.length;
            const modelsBeforeReplay = boundary.model.mock.calls.length;
            await maintenance.sweep();
            sharedLedgerIssues = await settleSharedActorReceipts(db);
            if (maintenance.passes.some(pass => pass.failed > 0)) sharedLedgerIssues.push('provider_recovery_failed');
            const resolverEvidence = resolverObservation.report(await readSharedResolverLedger(db, requestIds), requestIds);
            if (Object.values(resolverEvidence.issues).some(count => count > 0)) sharedLedgerIssues.push('resolver_sdk_ledger_mismatch');
            const proofs = [];
            for (const [i, run] of admitted.entries()) {
                const before = await sharedStandardEffects(db, run.requestId, run.orderId, run.owner.id);
                const duplicate = await deliverPaid(sample.get(run.requestId)!);
                expect((await duplicate.json()).status).toBe('already_terminal');
                expect(await sharedStandardEffects(db, run.requestId, run.orderId, run.owner.id)).toEqual(before);
                proofs.push(await verifySharedStandardRequest({
                    db, requestId: run.requestId, orderId: run.orderId, preflightId: run.preflightId,
                    paymentMode: payment, ownerId: run.owner.id, otherOwnerId: identities[(i + 1) % identities.length]!.id,
                    provenUnsentCutoffs: coverage99 ? resolverEvidence.unsentCancelledByOwner[i] : 0,
                    modelCalls: models.get(run.requestId) ?? 0, expectedPublic: publicCount, expectedPrivate: 1,
                    paidActorStarts: actorStarts.get(run.requestId) ?? [], preflightActorStarts: actorStarts.get(run.preflightId) ?? [],
                    asUser,
                }, ownerReads.get(run.requestId)!));
            }
            ownersWithLedgerIssues = proofs.filter(proof => proof.ledgerIssues.length > 0).length;
            expect(provider.starts.length).toBe(startsBeforeReplay);
            const matchedActorStarts = proofs.reduce((n, proof) => n + proof.actorReceipts.paid.matched + proof.actorReceipts.preflight.matched, 0);
            if (matchedActorStarts !== provider.starts.length) sharedLedgerIssues.push('actor_start_count_mismatch');
            expect(boundary.model.mock.calls.length).toBe(modelsBeforeReplay);
            const verifiedResultEmailClaims = automaticPayments ? await countVerifiedResultEmailClaims(db, requestIds) : 0;
            const measurements = await sharedStandardMeasurements(db, requestIds);
            expect(measurements.times).toHaveLength(ownersCount);
            if (measurements.tokenLogsByOwnerAndStage.some(row =>
                row.completedAttempts !== row.tokenLogRows || row.attemptTokens !== row.loggedTokens)) {
                sharedLedgerIssues.push('token_log_stage_mismatch');
            }
            if (coverage99) {
                expect(measurements.resolutionByOwner).toHaveLength(ownersCount);
                for (const owner of measurements.resolutionByOwner) {
                    expect(owner).toMatchObject({ recorded: true, finalized: true, verifiedBaselineMutations: 0 });
                    expect(owner.appliedWithProof).toBe(owner.applied);
                }
            }
            expect(measurements.times.every(t => t.admissionMs >= 0 && t.paymentMs >= t.admissionMs && t.ownerReadyMs >= t.paymentMs)).toBe(true);
            if (automaticPayments) {
                expect(measurements.times.every(t => t.queueWaitMs !== null && t.queueWaitMs >= 0
                    && t.startToPublicationMs !== null && t.startToPublicationMs >= t.admissionMs
                    && t.startToFulfillmentMs !== null && t.startToFulfillmentMs >= t.startToPublicationMs
                    && Math.abs(t.queueWaitMs + t.startToFulfillmentMs - t.ownerReadyMs) <= 1)).toBe(true);
            }
            const times = measurements.times.map((time, i) => {
                const { startToLastOwnerWebpMs, paidToLastOwnerWebpMs } = ownerReads.get(requestIds[i]!)!;
                expect(paidToLastOwnerWebpMs).toBeGreaterThanOrEqual(time.ownerReadyMs);
                if (automaticPayments) {
                    expect(startToLastOwnerWebpMs).not.toBeNull();
                    expect(startToLastOwnerWebpMs!).toBeGreaterThanOrEqual(time.startToFulfillmentMs!);
                    expect(Math.abs(paidToLastOwnerWebpMs - time.queueWaitMs! - startToLastOwnerWebpMs!)).toBeLessThanOrEqual(2);
                }
                const withinHour = (automaticPayments ? startToLastOwnerWebpMs! : paidToLastOwnerWebpMs) <= 3_600_000;
                return { ...time, startToOwnerReadyMs: startToLastOwnerWebpMs, paidToLastOwnerWebpMs, withinHour };
            });
            lateOwners = times.filter(time => !time.withinHour).length;
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
            if (coverage99) {
                const { rows: features } = await db.query<{ completed: number }>(`
                    SELECT count(a.operation_key)::int AS completed
                    FROM unnest($1::uuid[]) AS owner(id)
                    LEFT JOIN analysis_v2_ai_attempts a ON a.request_id=owner.id AND a.stage='featureAnalysis'
                        AND a.status='success' AND a.usage_complete AND a.terminalized_at IS NOT NULL
                    GROUP BY owner.id
                `, [requestIds]);
                expect(features.map(row => row.completed)).toEqual(Array(ownersCount).fill(publicCount));
            }
            const eligible = Number(measurements.resolution.eligible);
            const ready = Number(measurements.resolution.ready);
            const expectedEligiblePerOwner = recovery && [240, 600].includes(publicCount) ? publicCount / 2 : null;
            const ownersBelowCoverage = coverage99 ? measurements.resolutionByOwner.filter(owner => {
                const count = Number(owner.eligible);
                return count <= 0 || (expectedEligiblePerOwner !== null && count !== expectedEligiblePerOwner)
                    || Number(owner.ready) * 100 < count * 99;
            }).length : 0;
            const coverageBelowTarget = coverage99 && (eligible <= 0 || ready * 100 < eligible * 99
                || ownersBelowCoverage > 0);
            // Also retain the older whole-harness bound, including the serial DOM/negative checks.
            const paidStartToLastReadMs = Math.round(performance.now() - paidStart);
            ownerReadOverHour = coverage99 && lateOwners > 0;
            directPublicationMissing = automaticPayments && publishedHandoffs.size !== ownersCount;
            const report = {
                status: directPublicationMissing ? 'completed_without_direct_order_handoff' : ownersWithLedgerIssues || sharedLedgerIssues.length ? 'published_with_ledger_issues' : lateOwners || ownerReadOverHour ? 'completed_over_target' : coverageBelowTarget ? 'completed_below_coverage' : 'verified',
                hourMeasurement: automaticPayments ? 'capacity_start_to_last_owner_webp' : 'payment_to_last_owner_webp',
                productionPaid, checkoutEvidence, verifiedResultEmailClaims, ...(automatic ? { automaticPayment: automatic.evidence } : {}),
                approvedPaidOwners: approvedOwners.size, expandedPaidOwners: expandedOwners.size,
                logicalLeaseOwners: logicalLeaseOwners.size, dispatchAuthorizedOwners: dispatchAuthorizedOwners.size,
                tokenLogEvents, coverage99, coverageBelowTarget, expectedEligiblePerOwner, ownersBelowCoverage, admissionEvents, continuationSetups, ownerReadOverHour, paidStartToLastReadMs,
                ownersWithLedgerIssues, sharedLedgerIssues, lateOwners, maintenance: maintenance.passes, retryPolicy: queue.retryPolicy, dispatchBurst: queue.burst, lifecycle: lifecycle.rows[0], pgDelta, retryCodes, owners: ownersCount, workers, slots, capacityPreset: capacity, resolverGraceMs: Number(process.env.STANDARD_SHARED_RESOLVER_GRACE_MS ?? 0), publicCount, observedTiming, actorDelayMs, recovery, injectedTimeouts, resumedTimedOutRead, injectedWorker429s, ...measurements, times, deliveries, continuations, queueRetries, peakWorkers: queue.peakWorkers,
                paidStartToDrainMs: finishedMs, periodicFulfillment, readyHandoffs: readyHandoffs.size, freshProfileReads: freshProfileReads.size, publishedHandoffs: publishedHandoffs.size, publishedHandoffCalls,
                lostFreshHandoffResponse: Boolean(lostFreshDelivery), probedFreshHandoff, postDrainFulfillmentWaitMs, firstPreflightToVerifiedMs: Math.round(performance.now() - firstAt),
                syntheticActorStarts: provider.starts.length, syntheticModelCalls: [...models.values()].reduce((a, b) => a + b, 0),
                resolverEvidence, peakModels, duplicatesDuringModel: duplicatedDuringModel.size, duplicatesAfterModel: sample.size, duplicateCreates: queue.duplicateCreates, stageCounts, errors, proofs
            };
            marker('shared-standard-complete', report);
            if (process.env.SHARED_STANDARD_RECEIPT) writeFileSync(process.env.SHARED_STANDARD_RECEIPT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            belowCoverage = coverageBelowTarget;
        } catch (error) {
            // Preserve the original failure and the state left by any in-flight maintenance.
            await maintenance?.stop().catch(() => undefined);
            await ownerObserver?.stop();
            const reason = error instanceof Error && /^SHARED_WORKER_[a-z0-9:.-]+:[A-Z_0-9]+$/.test(error.message)
                ? error.message : safeCode(error);
            const failure = {
                status: 'failed', productionPaid, checkoutEvidence, approvedPaidOwners: approvedOwners.size, expandedPaidOwners: expandedOwners.size,
                logicalLeaseOwners: logicalLeaseOwners.size, dispatchAuthorizedOwners: dispatchAuthorizedOwners.size,
                tokenLogEvents, coverage99, admissionEvents, continuationSetups, maintenance: maintenance?.passes ?? [], retryPolicy: queue.retryPolicy, reason, owners: ownersCount, workers, slots, capacityPreset: capacity, resolverGraceMs: Number(process.env.STANDARD_SHARED_RESOLVER_GRACE_MS ?? 0),
                publicCount, observedTiming, recovery, injectedTimeouts, resumedTimedOutRead, injectedWorker429s, elapsedMs: Math.round(performance.now() - firstAt),
                errors, ...await sharedStandardStopEvidence(db, resolverObservation)
            };
            marker('shared-standard-stopped', failure);
            if (process.env.SHARED_STANDARD_RECEIPT) {
                try {
                    writeFileSync(process.env.SHARED_STANDARD_RECEIPT, JSON.stringify(failure, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
                } catch {
                    marker('shared-standard-receipt-write-failed', { reason });
                }
            }
            throw error;
        }
        // Keep all owner and cost proofs even when the measured deadline was missed.
        expect(directPublicationMissing, 'SHARED_DIRECT_PUBLISHED_ORDER_HANDOFF_MISSING').toBe(false);
        expect(sharedLedgerIssues, 'SHARED_ACCOUNTING_UNRESOLVED').toEqual([]);
        expect(ownersWithLedgerIssues, 'SHARED_ACCOUNTING_UNRESOLVED').toBe(0);
        expect(belowCoverage, 'SHARED_RESOLVER_COVERAGE_BELOW_99_PERCENT').toBe(false);
        expect(ownerReadOverHour, 'SHARED_OWNER_READ_HOUR_EXCEEDED').toBe(false);
        expect(lateOwners, 'SHARED_OWNER_HOUR_EXCEEDED').toBe(0);
    } finally {
        tokenLogChannel.unsubscribe(observeTokenLog);
        admissionChannel.unsubscribe(observeAdmission);
        continuationChannel.unsubscribe(observeContinuation);
        resolverObservation.dispose();
        await db.close();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    }
});
