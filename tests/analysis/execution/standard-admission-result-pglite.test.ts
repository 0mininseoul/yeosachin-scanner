import { private90StageImages } from './fixtures/private90-stage-images';
import { readStandardQaResultProof, enrollStandardQaResultProof } from '@/lib/services/dev-ui/standard-qa-result-proof';
import type { ResultImageCaptureSource } from '@/lib/services/media/result-image-capture';
import { createFeatureAnalysisResultIdentity, type FeatureAnalysisInput } from '@/lib/services/ai/v2-staged-analysis';
import type { AnalysisV2ReverseLikeCollector } from '@/lib/services/analysis/v2-ai-scoring-executors';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach, beforeAll } from 'vitest';
import { writeSync } from 'node:fs';
import { describePrivate90Failure, emptyPrivate90Failure } from './fixtures/private90-worker-failure.mjs';
import { private90OuterFailure, type Private90OuterEvent } from './fixtures/private90-reverse-scope';
import { private90VertexLedger } from './fixtures/private90-vertex-ledger';
import { verifyPrivate90Images } from './fixtures/private90-result-images';
import { createRequire } from 'node:module';
import { newPrivate90Observations, safePrivate90Observations, private90Job, private90ModelStage,
    safePrivate90ModelError, safePrivate90Sql, safePrivate90WorkerCode } from './fixtures/private90-observations.mjs';
import { bootstrapStandardArchiveSource, createStandardArchiveDatabase } from './fixtures/standard-archive-source';
import { prepareStandardArchiveVertex } from './fixtures/standard-archive-vertex';
import { expirySecretResource } from '@/lib/services/dev-ui/standard-qa-copy-expiry';
import { withVerifiedStandardQaCopy } from '@/lib/services/dev-ui/standard-qa-copy';
import type { PGlite } from '@electric-sql/pglite';
import { GET as readResult } from '@/app/api/analysis/v2/result/[requestId]/route';
import { GET as readImage } from '@/app/api/image-proxy/route';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { createStandardDatabase, localDatabaseClient } from './fixtures/standard-database';
import { syntheticGeneration } from './fixtures/standard-vertex';
import { createFixtureObjects, createFixtureR2, makeSourcePng } from './fixtures/standard-media';
import { createAnalysisV2ProductionExecutorRegistry } from '@/lib/services/analysis/v2-production-executors';
import { createSupabaseAnalysisV2DagStateStore } from '@/lib/services/analysis/v2-dag-state-store';
import { createAnalysisV2ProgressReporter } from '@/lib/services/analysis/v2-progress-reporter';
import { verifyDevProfileReadyRead } from './fixtures/dev-standard-profile-media-ready-checks';
import { assertOwnerPage } from './fixtures/standard-result-page';
import { type AnalysisV2JobHandler, classifyAnalysisV2JobFailure, executeAnalysisV2DagJob, processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';
import { parseAnalysisV2TaskPayload } from '@/lib/services/analysis/v2-tasks';
import { SyntheticApify, target, candidate, privateCandidate } from './fixtures/standard-providers';
import { POST as start } from '@/app/api/analysis/preflight/route';
import { PATCH as update } from '@/app/api/analysis/preflight/[preflightId]/route';
import { POST as entitle } from '@/app/api/analysis/preflight/[preflightId]/entitle/route';
import { runPrecheckoutBlite } from '@/lib/services/precheckout/blite-runner';
import { enqueuePrecheckoutBliteTask } from '@/lib/services/analysis/preflight-tasks';
import { processPreflight } from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { getApprovedDevLiveDelivery } from '@/lib/services/dev-ui/live-analysis';
import { createDevStandardArchiveStore } from '@/lib/services/dev-ui/standard-archive-store';
import { openStandardQaCopyForJob, verifyExpiredStandardQaCopy, withCloudStandardQaFixture } from '@/lib/services/dev-ui/standard-qa-copy-cloud';
import { readDevStandardArchivedProfiles } from '@/lib/services/analysis/v2-standard-archive-replay';
import { exportStandardQaCopy } from '@/lib/services/dev-ui/standard-qa-copy';
import { currentDevStandardArchive, withDevStandardArchiveApproval, withVerifiedDevStandardArchive, type StandardQaFixtureOperation } from '@/lib/services/dev-ui/standard-archive-runtime';
import { withDevLiveProviderApproval } from '@/lib/services/dev-ui/live-budget';
import {
    APIFY_CREDENTIAL_TOKEN_ENV,
    APIFY_FREE_CREDENTIAL_SLOTS,
} from '@/lib/services/instagram/providers/types';
import { DEV_UI_APP_ORIGIN, DEV_LIVE_STANDARD_START_PLAN } from '@/lib/constants/dev-ui';
import registry from '@/config/dev-ui-deployment.json';

const runtime = vi.hoisted(() => ({
    admin: { rpc: vi.fn(), from: vi.fn() },
    session: vi.fn(),
    user: null as null | {
        id: string;
        email: string;
        app_metadata: Record<string, string>;
    },
    apify: vi.fn(),
    objects: vi.fn(),
    archiveObjects: vi.fn(),
    kmsOrBucket: vi.fn(),
    r2: vi.fn(),
    png: vi.fn(),
    model: vi.fn(),
    queue: [] as Record<string, string | number>[],
    due: new WeakMap<object, number>(),
    genderOuter: null as null | ((account:string,event:Private90OuterEvent,op:string)=>void),
    featureOuter: null as null | ((input:FeatureAnalysisInput,event:Private90OuterEvent)=>void),
    featureProbe: null as null | ((input:FeatureAnalysisInput, state:'start'|'return'|'error', error?:unknown) => void),
    stageImages: null as null | Awaited<ReturnType<typeof private90StageImages>>,
    imageProbe: null as null | ((sources: readonly ResultImageCaptureSource[]) => void),
    reverseProbe: null as null | ((input: Parameters<AnalysisV2ReverseLikeCollector['collect']>[0]) => Promise<void>),
    vertexReceipts: null as null | { byRequest: WeakMap<object,string>; sent: string[]; byOperation:Map<string,Set<string>> },
}));
vi.mock('@/lib/services/analysis/v2-result-store', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-result-store')>();
    const store = actual.analysisV2ResultStore;
    return { ...actual, analysisV2ResultStore: { ...store,
        checkpointFeatureBatch(input: Parameters<typeof store.checkpointFeatureBatch>[0]) {
            const proof = runtime.stageImages;
            if (!proof) return store.checkpointFeatureBatch(input);
            const rows = input.rows.map(row => row.classification === 'verified_female' ? {
                ...row, profileImageUrl: proof.project('female', row.candidateId, row.profileImageUrl),
            } : row);
            return store.checkpointFeatureBatch({ ...input, rows });
        },
        checkpointPrivateNames(input: Parameters<typeof store.checkpointPrivateNames>[0]) {
            const proof = runtime.stageImages;
            if (!proof) return store.checkpointPrivateNames(input);
            const rows = input.rows.map(row => ({
                ...row, profileImageUrl: proof.project('private', row.candidateId, row.profileImageUrl),
            }));
            return store.checkpointPrivateNames({ ...input, rows });
        },
    } };
});
vi.mock('@/lib/services/media/result-image-capture', async original => {
    const actual = await original<typeof import('@/lib/services/media/result-image-capture')>();
    return { ...actual, async captureResultImageSources(input: Parameters<typeof actual.captureResultImageSources>[0]) {
        runtime.imageProbe?.(input.sources);
        return actual.captureResultImageSources(input);
    } };
});
vi.mock('@/lib/services/analysis/v2-ai-stage-runtime', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-ai-stage-runtime')>();
    return { ...actual, createDurableAnalysisV2AiStageRuntime(...args: Parameters<typeof actual.createDurableAnalysisV2AiStageRuntime>) {
        const stages = actual.createDurableAnalysisV2AiStageRuntime(...args);
        const gender = stages.profileGender;
        if (!gender) return stages;
        return { ...stages, profileGender: { ...gender, async run(...params:Parameters<typeof gender.run>) {
            const group = params[1];
            const note = (account:string,e:Private90OuterEvent) => runtime.genderOuter?.(account,e,group.operationKey);
            group.accountIds.forEach(account => note(account,'genderStart'));
            try {
                const rows = await gender.run(...params);
                group.accountIds.forEach((account,i) => {
                    const row = rows[i];
                    if (!row) return note(account,'genderCardinality');
                    if (row.source==='safe_fallback') note(account,'genderSafeFallback');
                    const sex = row.result.assessment.inferredGender;
                    note(account,sex==='female'?'genderFemale':sex==='male'?'genderMale':'genderUnknown');
                });
                return rows;
            } catch (error) { group.accountIds.forEach(account => note(account,private90OuterFailure('gender',error))); throw error; }
        } }, async features(...params:Parameters<typeof stages.features>) {
            runtime.featureOuter?.(params[0],'featureOuterStart');
            try {
                const row = await stages.features(...params);
                runtime.featureOuter?.(params[0],row.result.finalGenderDecision==='verified_female'?'featureOuterFemale':'featureOuterUnresolved');
                return row;
            } catch (error) { runtime.featureOuter?.(params[0],private90OuterFailure('featureOuter',error)); throw error; }
        } };
    } };
});
vi.mock('@/lib/services/ai/v2-staged-analysis', async original => {
    const actual = await original<typeof import('@/lib/services/ai/v2-staged-analysis')>();
    return { ...actual, async featureAnalysis(...args: Parameters<typeof actual.featureAnalysis>) {
        runtime.featureProbe?.(args[0],'start');
        try {
            const result = await actual.featureAnalysis(...args);
            runtime.featureProbe?.(args[0],'return');
            return result;
        } catch (error) {
            runtime.featureProbe?.(args[0],'error',error);
            throw error;
        }
    } };
});
vi.mock('@/lib/services/analysis/v2-ai-scoring-runtime-deps', async original => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-ai-scoring-runtime-deps')>();
    return { ...actual, createAnalysisV2ReverseLikeCollector(...args: Parameters<typeof actual.createAnalysisV2ReverseLikeCollector>) {
        const collector = actual.createAnalysisV2ReverseLikeCollector(...args);
        return { async collect(input: Parameters<AnalysisV2ReverseLikeCollector['collect']>[0]) {
            await runtime.reverseProbe?.(input);
            return collector.collect(input);
        } };
    } };
});
vi.mock('google-auth-library', async original => ({
    ...(await original<typeof import('google-auth-library')>()),
    GoogleAuth: class { async getClient() { return { request: runtime.kmsOrBucket }; } },
}));
vi.mock('@/lib/services/dev-ui/live-budget', async original => {
    const actual = await original<typeof import('@/lib/services/dev-ui/live-budget')>();
    return {
        ...actual,
        async reserveDevLiveVertexAttempt(...args: Parameters<typeof actual.reserveDevLiveVertexAttempt>) {
            const receipt = await actual.reserveDevLiveVertexAttempt(...args);
            runtime.vertexReceipts?.byRequest.set(args[1], receipt.reservationId);
            if (runtime.vertexReceipts && args[3]) {
                const op=args[3].operationKey;
                const ids = runtime.vertexReceipts.byOperation.get(op) ?? new Set();
                ids.add(receipt.reservationId);
                runtime.vertexReceipts.byOperation.set(op,ids);
            }
            return receipt;
        },
    };
});
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: runtime.admin }));
vi.mock('@/lib/supabase/server', () => ({ createClient: runtime.session }));
vi.mock('@/lib/services/dev-ui/live-runtime', async (original) => ({
    ...(await original<typeof import('@/lib/services/dev-ui/live-runtime')>()),
    assertDevLiveWebRuntime: () => undefined,
    assertDevLiveImageRuntime: () => undefined,
    devLiveWorkerRequestBoundary: () => 'dev-worker',
}));
vi.mock('@/lib/services/analysis/background-tasks', async (original) => ({
    ...(await original<typeof import('@/lib/services/analysis/background-tasks')>()),
    createCloudTasksClient: async () => ({
        queuePath: (...s: string[]) => 'projects/' + s[0] + '/locations/' + s[1] + '/queues/' + s[2],
        taskPath: (p: string, l: string, q: string, t: string) =>
            'projects/' + p + '/locations/' + l + '/queues/' + q + '/tasks/' + t,
        createTask: async ({ task }: { task: { httpRequest: { body: string }; scheduleTime?: { seconds: number; nanos?: number } } }) => {
            const payload = JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString('utf8'));
            runtime.queue.push(payload);
            if (task.scheduleTime) {
                const { seconds, nanos = 0 } = task.scheduleTime;
                runtime.due.set(payload, seconds * 1_000 + nanos / 1_000_000);
            }
            return [{}];
        },
    }),
}));
vi.mock('apify-client', async (original) => ({
    ...(await original<typeof import('apify-client')>()),
    ApifyClient: class {
        constructor() {
            return runtime.apify();
        }
    },
}));

vi.mock('@/lib/services/analysis/v2-media-artifact-store', async (original) => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-media-artifact-store')>();
    return {
        ...actual,
        createGoogleCloudPrivateMediaObjectClient: ({ bucketName }: { bucketName: string }) => runtime.archiveObjects(bucketName),
        createConfiguredAnalysisV2MediaArtifactStore: () =>
            actual.createAnalysisV2MediaArtifactStore({
                objects: runtime.objects(),
                registry: actual.createAnalysisV2MediaArtifactRegistry(runtime.admin),
            }),
    };
});
vi.mock('@/lib/services/analysis/v2-source-media-archive', async (original) => {
    const actual = await original<typeof import('@/lib/services/analysis/v2-source-media-archive')>();
    return {
        ...actual,
        createConfiguredAnalysisV2SourceMediaArchiveStore: () =>
            actual.createAnalysisV2SourceMediaArchiveStore({ objects: runtime.objects() }),
    };
});
vi.mock('@/lib/services/media/secure-image-fetch', async (original) => ({
    ...(await original<typeof import('@/lib/services/media/secure-image-fetch')>()),
    downloadSecureImage: async () => ({ bytes: runtime.png(), contentType: 'image/png' }),
}));
vi.mock('@aws-sdk/client-s3', async (original) => ({
    ...(await original<typeof import('@aws-sdk/client-s3')>()),
    S3Client: class {
        send = runtime.r2;
    },
}));
// Cloud credentials must never be materialized from the host environment by this offline test.
vi.mock('@/lib/services/google/credentials', () => ({ prepareGoogleApplicationCredentials: () => undefined }));
vi.mock('@google/genai/node', async (original) => ({
    ...(await original<typeof import('@google/genai/node')>()),
    GoogleGenAI: class {
        models;
        constructor(options: { fetch: typeof fetch }) {
            const transport = options.fetch;
            this.models = {
                generateContent: async (input: unknown) => {
                    await transport('https://vertex.fixture.invalid');
                    if (runtime.vertexReceipts) {
                        const id = runtime.vertexReceipts.byRequest.get(input as object);
                        if (id) runtime.vertexReceipts.sent.push(id);
                    }
                    return runtime.model(input);
                },
            };
        }
    },
}));

vi.mock('@/lib/observability/server', async (original) => ({
    ...(await original<typeof import('@/lib/observability/server')>()),
    operationalLogger: { emit: () => undefined },
}));
vi.mock('next/navigation', async (original) => {
    const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
    return {
        ...(await original<typeof import('next/navigation')>()),
        useRouter: () => router,
        useSearchParams: () => new URLSearchParams('devAnalysis=live'),
    };
});
beforeAll(async () => {
    if (!process.env.PRIVATE90_FULL_REPLAY) return;
    const local = await vi.importActual<typeof import('./fixtures/private90-admin')>('@/lib/supabase/admin');
    local.bindPrivate90Admin(runtime.admin);
    // Exercise the cloud reader's importActual boundary. Production lazy imports must resolve
    // the isolated database even when Vitest's module mock does not intercept them.
    await vi.importActual('@/lib/services/analysis/v2-media-artifact-store');
    vi.doUnmock('@/lib/supabase/admin');
});

const appOrigin = DEV_UI_APP_ORIGIN;
function configure() {
    const env: Record<string, string> = {
        DEPLOYMENT_ROLE: 'dev',
        NEXT_PUBLIC_DEPLOYMENT_ROLE: 'dev',
        VERCEL_PROJECT_ID: registry.deployments[0]!.vercelProjectId,
        NEXT_PUBLIC_APP_URL: DEV_UI_APP_ORIGIN,
        DEV_UI_ALLOWED_KAKAO_EMAIL: 'owner@example.invalid',
        GOOGLE_CLOUD_PROJECT: 'fixture-project',
        ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
        ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
        ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: 'test-fixture-assets',
        ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
        ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: 'local-fixture',
        ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY: 'local-fixture',
        IMAGE_PROXY_SIGNING_SECRET: 'synthetic-signing-only-'.repeat(3),
        ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET: 'fixture-object-'.repeat(3),
        NEXT_PUBLIC_SUPABASE_URL: 'https://' + registry.deployments[0]!.supabaseProjectRef + '.supabase.co',
        DEV_LIVE_ANALYSIS_ARMED: 'true',
        DEV_LIVE_STANDARD_PROFILE_READY_REUSE_ENABLED: 'true',
        DEV_LIVE_ANALYSIS_MODE: 'owner_start',
        DEV_LIVE_STANDARD_COLLECTION_MODE: 'live_apify',
        DEV_LIVE_STANDARD_TARGET: target,
        DEV_LIVE_PREFLIGHT_ORIGIN: 'https://fixture.invalid',
        DEV_LIVE_PAID_ORIGIN: 'https://fixture.invalid',
        ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
        ANALYSIS_TEST_ENTITLEMENT_SECRET: Buffer.alloc(32, 52).toString('base64url'),
        ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: Buffer.alloc(32, 41).toString('base64'),
        PREFLIGHT_PROFILE_PROVIDER: 'apify_pool',
        PREFLIGHT_APIFY_API_TOKEN_SLOTS: APIFY_FREE_CREDENTIAL_SLOTS.join(','),
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'secondary',
        PRECHECKOUT_BLITE_ENABLED: 'false',
        PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
        SCRAPER_FOLLOWERS: 'apify',
        SCRAPER_FOLLOWING: 'apify',
    };
    for (const name of Object.values(APIFY_CREDENTIAL_TOKEN_ENV)) env[name] = 'offline-fixture';
    for (const policy of [
        'GENDER_RESOLUTION',
        'NARRATIVE_V28',
        'AI_MICROBATCH_V29',
        'GENDER_SUMMARY_QUALITY_V211',
        'AI_SCHEDULER',
    ]) {
        env['ANALYSIS_V2_' + policy + '_ROLLOUT'] = 'test_entitlement';
    }
    for (const [prefix, path] of [
        ['PREFLIGHT', 'preflight'],
        ['ANALYSIS_V2', 'v2'],
    ]) {
        Object.assign(
            env,
            Object.fromEntries(
                Object.entries({
                    CALLER_AUTH_MODE: 'adc',
                    ENABLED: 'true',
                    PROJECT: 'fixture-project',
                    LOCATION: 'asia-northeast3',
                    QUEUE: 'fixture-queue',
                    SERVICE_ACCOUNT_EMAIL: 'fixture@fixture-project.iam.gserviceaccount.com',
                    TARGET_URL: 'https://fixture.invalid/api/analysis/' + path + '/worker',
                    OIDC_AUDIENCE: 'https://fixture.invalid',
                }).map(([key, value]) => [prefix + '_TASKS_' + key, value]),
            ),
        );
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', async (url: unknown) => {
        if (url === 'https://vertex.fixture.invalid') return new Response();
        throw new Error('External network is disabled in Standard fixture');
    });
}

async function seedOwner(db: PGlite, requestTarget = target) {
    const user = {
        id: randomUUID(),
        email: 'owner@example.invalid',
        identities: [
            { provider: 'kakao', identity_data: { email: 'owner@example.invalid', email_verified: true } },
        ],
        app_metadata: { provider: 'kakao', analysis_test_runner_v1: 'basic' },
    };
    await db.query('INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,$3)', [
        user.id,
        user.email,
        JSON.stringify(user.app_metadata),
    ]);
    await db.query(
        "INSERT INTO auth.identities VALUES($1,'kakao',jsonb_build_object('email',$2::text,'email_verified',true))",
        [user.id, user.email],
    );
    await db.exec(
        "INSERT INTO account_ledger_rollout_state(singleton,paid_ever_state,classification_command_version,classification_completed_at) VALUES(true,'active','dev-live-basic-v1',now())",
    );
    await db.query("SELECT * FROM provision_e2e_test_runner_v1($1,$2,'basic','dev-live-basic-v1')", [
        user.id,
        user.email,
    ]);
    await db.query(
        `INSERT INTO account_classification_audit(account_id,command_version,reason_code,previous_account_class,previous_traffic_class,
        previous_lifecycle,next_account_class,next_traffic_class,next_lifecycle) VALUES($1,'dev-live-basic-v1','DEV_LIVE_BASIC_TESTER','production','external','active','e2e_test','e2e_test','active')`,
        [user.id],
    );
    await db.query('INSERT INTO dev_live_budget.standard_owner_policy(target_instagram_id) VALUES($1)', [
        requestTarget,
    ]);
    return user;
}

function request(path: string, method: string, body: unknown, attempt?: string) {
    return new NextRequest(appOrigin + '/api/analysis/preflight' + path + '?devAnalysis=live', {
        method,
        headers: {
            origin: appOrigin,
            'content-type': 'application/json',
            ...(attempt
                ? { 'x-dev-live-plan': DEV_LIVE_STANDARD_START_PLAN, 'x-dev-live-attempt-id': attempt }
                : {}),
        },
        body: JSON.stringify(body),
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    runtime.queue.length = 0;
    runtime.user = null;
    runtime.vertexReceipts = null;
    runtime.reverseProbe = null;
    runtime.imageProbe = null;
    runtime.stageImages = null;
    runtime.featureProbe = null;
    runtime.genderOuter = null;
    runtime.featureOuter = null;
    vi.clearAllMocks();
});

const deliveryScenarios = ['first', 'second', 'timeout', 'terminal receipt timeout', 'resume ready individually', 'resume ready together'] as const;
type Private90Observations = ReturnType<typeof newPrivate90Observations>;
type Scenario = typeof deliveryScenarios[number] | 'archive_capture' | 'archive_replay';
type RoutingScenario = 'unchanged' | 'changed_triage' | 'changed_shortlist';

async function runStandardRequest(
    db: PGlite,
    user: Awaited<ReturnType<typeof seedOwner>>,
    scenario: Scenario,
    routing: RoutingScenario = 'unchanged',
    privateCopySession = false,
    privateReplay?: {
        target: string;
        profileBatches: readonly number[];
        generate: typeof syntheticGeneration;
        reverseScope: Awaited<ReturnType<typeof prepareStandardArchiveVertex>>['reverseScope'];
        imageScope: Awaited<ReturnType<typeof prepareStandardArchiveVertex>>['imageScope'];
        stageImages: Awaited<ReturnType<typeof private90StageImages>>;
        observed: Private90Observations;
    },
) {
    const observed = privateReplay?.observed;
    runtime.genderOuter = privateReplay?.reverseScope.accountEvent ?? null;
    runtime.featureOuter = privateReplay ? (input,event) => {
        const probe=privateReplay.reverseScope;
        const id=probe.selectionOwner(input.media);
        if (id && probe.expected.has(id)) probe.event(id,event,createFeatureAnalysisResultIdentity(input,'ai-stage-policy-v2.11').operationKey);
    } : null;
    runtime.featureProbe = privateReplay ? (input,state,error) => {
        const probe = privateReplay.reverseScope;
        const id = probe.selectionOwner(input.media);
        if (!id || !probe.expected.has(id)) return;
        if (state === 'start') probe.event(id,'featureStart',createFeatureAnalysisResultIdentity(input,'ai-stage-policy-v2.11').operationKey);
        else probe.event(id,state === 'return' ? 'featureReturned' : probe.featureFailure(error));
    } : null;
    runtime.stageImages = privateReplay?.stageImages ?? null;
    runtime.imageProbe = privateReplay ? sources => {
        Object.assign(privateReplay.observed, privateReplay.stageImages.counts(), privateReplay.imageScope(sources));
    } : null;
    runtime.reverseProbe = privateReplay ? async input => {
        Object.assign(privateReplay.observed, await privateReplay.reverseScope.compare(db,input.requestId,input.candidates,runtime.vertexReceipts?.byOperation));
    } : null;
    runtime.vertexReceipts = observed ? { byRequest: new WeakMap(), sent: [], byOperation:new Map() } : null;
    const isReplay = scenario === 'archive_replay';
    const changeTriageOnReplay = routing !== 'unchanged';
    const blite = process.env.PRECHECKOUT_BLITE_ENABLED === 'true';
    const capturedBlite = blite && scenario === 'archive_capture';
    const otherId = randomUUID();
    vi.stubEnv('DEV_UI_TEST_USER_IDS', [user.id, otherId].join(','));
    runtime.user = user;
    const client = localDatabaseClient(db);
    const resumeReady = scenario === 'resume ready individually' || scenario === 'resume ready together';
    if (scenario === 'resume ready individually') vi.stubEnv('DEV_LIVE_STANDARD_PROFILE_READY_REUSE_ENABLED', 'false');
    let interruptFeature = resumeReady;
    const readyReadBatches = new Set<number>();
    let readyTriageClaims = 0;
    let readSnapshotWithTriage = 0;
    let testedProfileReadyRead = false;
    let timeouts = 0;
    const receiptCalls: Record<string, unknown>[] = [];
    const producerHashes: string[] = [];
    const sqlErrors: string[] = [];
    runtime.admin.rpc.mockImplementation(async (n, a) => {
        if (
            n === 'load_analysis_v2_profile_fetch_for_consumer' &&
            a.p_consumer_job_key === 'track:profile-ai:batch:0'
        ) {
            producerHashes.push(a.p_expected_producer_input_hash);
            if (scenario === 'timeout' && timeouts === 0) {
                timeouts++;
                return {
                    data: null,
                    error: { code: '57014', message: 'canceling statement due to statement timeout' },
                };
            }
        }
        if (scenario === 'terminal receipt timeout' &&
            n === 'checkpoint_analysis_v2_provider_run_terminal' &&
            a.p_job_key === 'track:profiles:batch:0') {
            receiptCalls.push({ ...a });
            if (receiptCalls.length <= 2) return {
                data: null,
                error: { code: '57014', message: 'canceling statement due to statement timeout' },
            };
        }
        if (interruptFeature && n === 'claim_analysis_v2_scheduler_operation' && a.p_stage === 'featureAnalysis') {
            return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
        }
        const out = await client.rpc(n, a).catch(error => {
            if (observed) observed.sqlState = safePrivate90Sql(error?.code);
            throw error;
        });
        if (!out.error && observed) {
            if (n === 'load_analysis_v2_media_artifact') observed.mediaRegistryLoads++;
            if (n === 'register_analysis_v2_media_artifact') observed.mediaRegistryRegistrations++;
        }
        if (out.error && observed) observed.sqlState = safePrivate90Sql(out.error.code);
        if (n === 'load_dev_standard_profile_media_ready_v1' && !out.error) {
            const ready = out.data as { readyOperations: Array<{stage: string}> };
            if (privateReplay) {
                const { jobStage, jobBatch } = private90Job(a.p_job_key);
                if (a.p_request_id !== result.requestId || jobStage !== 'profile_ai' || jobBatch === null
                    || !privateReplay.profileBatches.includes(jobBatch)) throw new Error('PRIVATE90_PROFILE_READY_SCOPE');
                readyReadBatches.add(jobBatch);
                privateReplay.observed.profileReadyReads++;
                privateReplay.observed.profileReadyReadBatches = readyReadBatches.size;
                privateReplay.observed.profileReadyRowsReturned += ready.readyOperations.length;
            }
            if (ready.readyOperations.some(row => row.stage === 'genderTriage')) readSnapshotWithTriage++;
            if (scenario === 'first' && !testedProfileReadyRead) {
                testedProfileReadyRead = true;
                await verifyDevProfileReadyRead(db, a);
            }
        }
        if (n === 'claim_analysis_v2_scheduler_operation' && a.p_stage === 'genderTriage') {
            const row = Array.isArray(out.data) ? out.data[0] : out.data;
            if (row?.decision === 'ready') readyTriageClaims++;
        }
        if (n === 'checkpoint_dev_standard_replay_scope_note_v1' && out.data === true) {
            // The real worker issued the call above. Probe replay under that same live claim.
            expect((await client.rpc(n, a)).data).toBe(true);
            const unchanged = a.p_added === 0 && a.p_removed === 0 && a.p_unverified === 0;
            const conflicting = await client.rpc(n, { ...a, p_added: unchanged ? 1 : 0, p_removed: 0, p_unverified: 0 });
            expect(conflicting.error?.message).toBe('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
            const read = await client.rpc('read_dev_standard_replay_scope_note_v1', { p_request_id: a.p_request_id, p_user_id: user.id });
            expect(read).toEqual({ data: null, error: null });
        }
        if (n === 'read_dev_standard_replay_scope_note_v1' && out.data) {
            const unauthorized = await client.rpc(n, { ...a, p_user_id: otherId });
            expect(unauthorized).toEqual({ data: null, error: null });
        }
        if (out.error && !out.error.message.includes('FENCE'))
            sqlErrors.push(observed ? 'rpc_error' : n + ': ' + out.error.message);
        return out;
    });
    runtime.admin.from.mockImplementation(client.from);
    runtime.session.mockImplementation(async () => ({
        ...localDatabaseClient(db, runtime.user?.id ?? null),
        auth: { getUser: async () => ({ data: { user: runtime.user }, error: null }) },
    }));
    // Five posts leave one feature image beyond triage. Private-copy fixtures also cross the 100-name batch boundary.
    const syntheticPrivateCount = changeTriageOnReplay ? 1 : process.env.PRIVATE90_FULL_REPLAY === 'synthetic' ? 101 : 0;
    const privateNameChunks = Math.ceil(syntheticPrivateCount / 100);
    const apify = new SyntheticApify(changeTriageOnReplay ? 5 : 1, syntheticPrivateCount);
    runtime.apify.mockClear().mockImplementation(() => {
        if (privateReplay) privateReplay.observed.apifyCalls++;
        if (isReplay) throw new Error('Unexpected Apify access during archive replay');
        return apify;
    });
    runtime.objects.mockReturnValue(createFixtureObjects());
    runtime.r2.mockImplementation(createFixtureR2());
    const sourcePng = await makeSourcePng();
    runtime.png.mockClear().mockImplementation(() => {
        if (privateReplay) privateReplay.observed.sourceDownloads++;
        if (isReplay) throw new Error('Unexpected source image download during archive replay');
        return sourcePng;
    });
    runtime.model.mockImplementation(input => {
        if (!privateReplay) return syntheticGeneration(input,
            changeTriageOnReplay && !isReplay ? 'male' : 'female', routing === 'changed_triage' ? 'male' : 'female');
        privateReplay.observed.fixedVertexCalls++;
        privateReplay.observed.modelStage = private90ModelStage(input);
        try { return privateReplay.generate(input); } catch (error) {
            privateReplay.observed.modelError = safePrivate90ModelError(error instanceof Error ? error.message : undefined);
            throw error;
        }
    });
    if (privateReplay) privateReplay.observed.providerCountersActive = 1;
    const modelCallCount = () => privateReplay?.observed.fixedVertexCalls ?? runtime.model.mock.calls.length;
    const attempt = randomUUID();
    const newPreflight = () => start(request('', 'POST', { targetInstagramId: privateReplay?.target ?? target }, attempt));
    const created = await newPreflight();
    const first = await created.json();
    expect(created.status, first.code).toBe(202);
    const preflightId: string = first.preflightId;
    const replay = await newPreflight();
    expect(replay.status).toBe(200);
    expect((await replay.json()).preflightId).toBe(preflightId);
    const ctx = { params: Promise.resolve({ preflightId }) };
    expect(runtime.queue).toHaveLength(1);
    const task = runtime.queue.shift()!;
    const approval = await getApprovedDevLiveDelivery({ preflightId });
    if (approval?.planId !== 'standard') throw new Error('Missing synthetic Standard approval');
    expect(Boolean(approval.archiveReplay)).toBe(isReplay);
    const runDelivery = <T>(operation: () => T) =>
        withDevLiveProviderApproval(approval, () => privateCopySession ? operation() : withDevStandardArchiveApproval(approval, operation));
    vi.stubEnv('DEV_LIVE_WORKLOAD', 'preflight');
    vi.stubEnv('K_SERVICE', 'dev-live-preflight');
    const preflight = () =>
        runDelivery(() =>
            processPreflight(preflightId, {
                enqueueBliteInference: (id, dispatchGeneration, dispatchToken) =>
                    enqueuePrecheckoutBliteTask(id, { dispatchGeneration, dispatchToken }),
                dispatchFence: {
                    generation: Number(task.generation),
                    reservationToken: String(task.reservationToken),
                },
            }),
        );
    expect(await preflight()).toBe('ready');
    if (capturedBlite) {
        expect(runtime.queue).toHaveLength(1);
        const preview = runtime.queue.shift()!;
        expect(preview.kind).toBe('precheckout_blite');
        const infer = () => runDelivery(() => runPrecheckoutBlite(preflightId, {
            dispatchGeneration: Number(preview.dispatchGeneration),
            dispatchToken: String(preview.dispatchToken),
        }));
        expect(await infer()).toBe('complete');
    }
    expect(await preflight()).toBe('noop');
    let previewDto: unknown = null;
    if (isReplay || scenario === 'archive_capture') {
        const preview = await db.query<{ active: boolean; state: string; dto: unknown; attempt_count: number }>(`
            SELECT p.precheckout_blite_cohort AS active, c.state, c.dto, c.attempt_count
            FROM analysis_preflights p JOIN precheckout_blite_cache c ON c.preflight_id=p.id
            WHERE p.id=$1
        `, [preflightId]);
        if (blite) {
            expect(preview.rows).toHaveLength(1);
            expect(preview.rows[0]).toMatchObject({
                active: true, state: 'complete', attempt_count: isReplay ? 0 : 1,
                dto: { persona: { headline: expect.any(String) } },
            });
            previewDto = preview.rows[0]!.dto;
        } else {
            expect(preview.rows).toEqual([]);
        }
        expect(runtime.queue).toHaveLength(0);
    }
    const patch = await update(request('/' + preflightId, 'PATCH', { decision: 'skip' }), ctx);
    expect(patch.status).toBe(204);
    const consume = () =>
        entitle(request('/' + preflightId + '/entitle', 'POST', { planId: 'standard' }), ctx);
    const pending = await consume();
    expect((await pending.json()).status).toBe('admission_pending');
    expect(pending.status).toBe(202);
    expect(runtime.queue).toHaveLength(1);
    const fresh = runtime.queue.shift()!;
    vi.stubEnv('DEV_LIVE_WORKLOAD', 'paid');
    vi.stubEnv('K_SERVICE', 'dev-live-paid');
    const getProfile = vi.fn(async () => {
        throw new Error('SCRAPING_SCHEMA_ERROR: synthetic public profile unavailable');
    });
    const freshJob = () =>
        runDelivery(() =>
            processAnalysisV2FreshAdmission(
                runtime.admin,
                {
                    preflightId,
                    generation: Number(fresh.generation),
                    dispatchGeneration: Number(fresh.dispatchGeneration),
                    dispatchToken: String(fresh.dispatchToken),
                },
                { getProfile },
            ),
        );
    expect(await freshJob()).toBe('ready');
    expect(await freshJob()).toBe('noop');
    expect(getProfile).toHaveBeenCalledTimes(isReplay ? 0 : 1);
    const accepted = await consume();
    const result = await accepted.json();
    expect(accepted.status, result.code).toBe(201);
    expect((await (await consume()).json()).requestId).toBe(result.requestId);
    expect(runtime.queue).toHaveLength(1);
    const resultPage = () =>
        readResult(
            new Request(
                appOrigin + '/api/analysis/v2/result/' + result.requestId + '?devAnalysis=live',
            ),
            { params: Promise.resolve({ requestId: result.requestId }) },
        );
    const hidden = await resultPage();
    expect(hidden.status).toBe(404);
    expect((await hidden.json()).code).toBe('RESULT_PENDING');
    const totals = async () =>
        (
            await db.query<Record<string, number>>(
                `SELECT
    (SELECT count(*)::int FROM analysis_v2_test_entitlement_consumptions WHERE request_id=$2) AS consumed,
    (SELECT count(*)::int FROM analysis_requests WHERE id=$2) AS requests,
    (SELECT count(*)::int FROM dev_live_budget.owner_starts WHERE grant_id=$3) AS grants,
    (SELECT count(*)::int FROM dev_live_budget.reservations WHERE grant_id=$3 AND provider='apify') AS actors,
    (SELECT count(*)::int FROM dev_live_budget.reservations WHERE grant_id=$3 AND provider='vertex') AS models,
    (SELECT count(*)::int FROM dev_live_budget.reservations WHERE grant_id=$3 AND provider='vertex' AND actual_micros IS NOT NULL) AS settled,
    (SELECT coalesce(sum(apify_committed_micros),0)::int FROM dev_live_budget.grants WHERE grant_id=$3) AS apify_committed,
    (SELECT coalesce(sum(reserved_micros),0)::int FROM dev_live_budget.reservations WHERE grant_id=$3 AND provider='apify') AS apify_reserved,
    (SELECT coalesce(sum(ai_committed_micros),0)::int FROM dev_live_budget.grants WHERE grant_id=$3) AS debit,
    (SELECT analysis_count FROM public.users WHERE id=$1) AS quota`,
                [user.id, result.requestId, approval.id],
            )
        ).rows[0];
    let steps = 0;
    let continued = 0;
    let receiptRedeliveries = 0;
    const modelCallsBefore = modelCallCount();
    if (privateReplay) expect(modelCallsBefore).toBe(0);
    const stateStore = createSupabaseAnalysisV2DagStateStore();
    const worker = {
        stateStore,
        executors: createAnalysisV2ProductionExecutorRegistry(),
        progressReporter: createAnalysisV2ProgressReporter({
            reloadState: (id) => stateStore.load(id),
        }),
    };
    // Observe the actual error before the worker maps it to a stable public code.
    const diagnosticHandler: AnalysisV2JobHandler = async claim => {
        try {
            return await executeAnalysisV2DagJob(claim, {
                ...worker, onPhase: phase => { if (observed) observed.executorPhase = phase; },
            });
        } catch (error) {
            if (observed) Object.assign(observed, describePrivate90Failure(error));
            throw error;
        }
    };
    const deliveryDependencies = observed ? { ...worker, handler: diagnosticHandler } : worker;
    while (runtime.queue.length) {
        if (observed) observed.assertion = 'queue_limit';
        if (++steps > 24 + (privateReplay?.profileBatches.length ?? 0) * 36) throw new Error('Unexpected repeated task delivery');
        let next = 0;
        if (observed) {
            // Deliver other ready jobs first. Both Cloud Tasks scheduleTime and the SQL scheduler fence apply.
            const due = runtime.queue.map(task => runtime.due.get(task) ?? 0);
            next = due.indexOf(Math.min(...due));
            const delay = due[next]! - Date.now();
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        }
        const [payload] = runtime.queue.splice(next, 1);
        if (observed) {
            Object.assign(observed, emptyPrivate90Failure(), private90Job(payload!.jobKey));
            observed.executorPhase = 'handler';
            observed.assertion = 'task_parse';
            observed.deliveryStatus = 'running';
            observed.disposition = 'none';
            observed.workerCode = 'none';
            observed.sqlState = 'none';
        }
        const delivery = parseAnalysisV2TaskPayload(payload!);
        if (privateReplay) {
            privateReplay.observed.phase = 'worker';
            privateReplay.observed.cause = 'worker_stage';
        }
        if (observed) observed.assertion = 'worker_return';
        const verifyFeatureImages = changeTriageOnReplay && isReplay && delivery.jobKey === 'track:profile-ai:batch:0';
        const outcome = await runDelivery(async () => {
            if (!verifyFeatureImages) return processAnalysisV2TaskDelivery(delivery, deliveryDependencies);
            const archive = currentDevStandardArchive()!;
            const load = vi.spyOn(archive, 'load');
            const result = await processAnalysisV2TaskDelivery(delivery, deliveryDependencies);
            const imageReads = load.mock.calls.flatMap(([kind], index) =>
                kind === 'ai-image' ? [load.mock.settledResults[index]!.type] : []);
            expect(imageReads).toEqual(Array(6).fill('fulfilled'));
            return result;
        }).catch(error => {
            if (observed) {
                const failure = classifyAnalysisV2JobFailure(error);
                observed.deliveryStatus = 'threw';
                observed.disposition = failure.disposition;
                observed.workerCode = safePrivate90WorkerCode(failure.code);
                if (error && typeof error === 'object' && 'code' in error) observed.sqlState = safePrivate90Sql(error.code);
            }
            throw error;
        });
        if (observed) {
            observed.deliveryStatus = outcome.status;
            observed.disposition = ({ completed: 'completed', continuation: 'deferred', already_terminal: 'already_terminal',
                failed: 'permanent', retry: 'transient' })[outcome.status];
            if ('errorCode' in outcome) {
                observed.workerCode = safePrivate90WorkerCode(outcome.errorCode);
                if (outcome.errorCode === 'JOB_ATTEMPTS_EXHAUSTED') observed.disposition = 'exhausted';
            }
        }
        if (privateReplay && (outcome.status === 'failed' || outcome.status === 'retry')) {
            if (privateReplay.observed.sqlState !== 'none') privateReplay.observed.cause = 'worker_sql';
            if (privateReplay.observed.modelError !== 'none') privateReplay.observed.cause = 'model_routing';
            if (outcome.errorCode === 'DEV_STANDARD_ARCHIVE_UNAVAILABLE') {
                privateReplay.observed.cause = 'missing_keyed_media';
                if (observed?.jobStage === 'reverse_likes' && observed.reverseCompared) {
                    privateReplay.observed.cause = observed.reverseActualHashMatch ? 'archive_unavailable' : 'reverse_scope';
                }
                if (observed?.jobStage === 'finalize' && observed.imageScopeCompared) {
                    privateReplay.observed.cause = observed.imageScopeMismatched ? 'final_image_identity' : 'archive_unavailable';
                }
            }
            if (outcome.errorCode.includes('TIMEOUT')) privateReplay.observed.cause = 'timeout';
        }
        const capacityRetry = outcome.status === 'retry' && [
            'ANALYSIS_V2_AI_CAPACITY_PENDING', 'ANALYSIS_V2_PROVIDER_ADMISSION_CAPACITY_PENDING',
            'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT', 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE', 'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING',
        ].includes(outcome.errorCode);
        if (observed && (outcome.status === 'continuation' || capacityRetry)) {
            let task = payload!;
            if (outcome.status === 'continuation') {
                observed.continuations++;
                observed.assertion = 'recovery_fanout';
                expect(outcome.pendingRecoveryCount).toBe(0);
                observed.assertion = 'continuation_successor';
                const successor = runtime.queue.find(t => t.jobKey === delivery.jobKey && t.generation === delivery.generation + 1);
                expect(Boolean(successor)).toBe(true);
                task = successor!;
            } else {
                observed.retries++;
                runtime.queue.push(task); // Cloud Tasks redelivers the same unacknowledged payload.
            }
            observed.assertion = 'dispatch_fence';
            const due = await db.query<{ ms: number }>(`
                SELECT greatest(0,ceil(1000*extract(epoch FROM
                    (greatest(scheduler_not_before_at,lease_expires_at)-clock_timestamp()))))::int AS ms
                FROM analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2 AND status='pending'
                    AND dispatch_generation=$3 AND dispatch_reservation_token=$4
            `, [delivery.requestId, delivery.jobKey, task.generation, task.reservationToken]);
            expect(due.rows.length).toBe(1);
            runtime.due.set(task, Math.max(runtime.due.get(task) ?? 0, Date.now() + due.rows[0]!.ms + (capacityRetry ? 1000 : 20)));
            continue;
        }
        if (scenario === 'terminal receipt timeout' && outcome.status === 'retry') {
            expect(outcome.errorCode).toBe('ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR');
            expect(receiptRedeliveries).toBe(0);
            receiptRedeliveries++;
            expect(receiptCalls).toHaveLength(2);
            expect(receiptCalls[1]).toEqual(receiptCalls[0]);
            const telemetry = await db.query(
                'SELECT 1 FROM analysis_v2_profile_fetch_telemetry WHERE request_id=$1 AND job_key=$2',
                [delivery.requestId, delivery.jobKey],
            );
            expect(telemetry.rows).toHaveLength(0);
            runtime.queue.unshift(payload!); // Cloud Tasks retries the same delivery.
            continue;
        }
        if (outcome.status === 'continuation' && (scenario === 'timeout' || resumeReady)) {
            expect(continued).toBe(0);
            expect(outcome.errorCode).toBe(resumeReady
                ? 'ANALYSIS_V2_AI_CAPACITY_PENDING' : 'ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT');
            expect(outcome.pendingRecoveryCount).toBe(0);
            expect(runtime.model.mock.calls.length).toBe(modelCallsBefore + (resumeReady ? 1 : 0));
            interruptFeature = false;
            expect(runtime.queue).toContainEqual(
                expect.objectContaining({
                    jobKey: delivery.jobKey,
                    generation: delivery.generation + 1,
                }),
            );
            await expect(processAnalysisV2TaskDelivery(delivery)).rejects.toThrow(/FENCE/);
            const due = await db.query<{ wait_ms: number }>(
                `SELECT greatest(0,ceil(1000 * extract(epoch FROM
            (scheduler_not_before_at-clock_timestamp()))))::int AS wait_ms FROM analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2`,
                [delivery.requestId, delivery.jobKey],
            );
            await new Promise((resolve) => setTimeout(resolve, due.rows[0]!.wait_ms + 20));
            continued++;
            continue;
        }
        expect(outcome.status, [delivery.jobKey, JSON.stringify(outcome), ...sqlErrors].join(' ')).toBe('completed');
        if (observed) observed.assertion = 'recovery_fanout';
        expect(outcome).toMatchObject({ pendingRecoveryCount: 0 });
        if (routing === 'changed_shortlist' && isReplay && delivery.jobKey === 'track:reverse-likes:collect') {
            const reverse = await db.query(
                'SELECT reverse_like_status, component_score::double precision FROM analysis_v2_reverse_like_rows WHERE request_id=$1',
                [result.requestId],
            );
            expect(reverse.rows).toEqual([{ reverse_like_status: 'not_collected', component_score: 0 }]);
        }
        const before = await totals();
        const calls = [apify.starts.length, modelCallCount(), runtime.queue.length];
        if (observed) observed.assertion = 'terminal_duplicate';
        expect((await processAnalysisV2TaskDelivery(delivery)).status).toBe('already_terminal');
        if (observed) observed.assertion = 'duplicate_side_effects';
        expect([apify.starts.length, modelCallCount(), runtime.queue.length]).toEqual(
            calls,
        );
        if (observed) observed.assertion = 'duplicate_ledger';
        expect(await totals()).toEqual(before);
        if (privateReplay) {
            if (/^track:profile-ai:batch:\d+$/.test(delivery.jobKey)) privateReplay.observed.completedProfileBatches++;
            privateReplay.observed.workerJobs++;
            privateReplay.observed.duplicateDeliveries++;
            // No completed delivery needs to keep a second copy of image buffers or RPC arguments.
            runtime.model.mockClear();
            runtime.admin.rpc.mockClear();
            runtime.admin.from.mockClear();
            runtime.r2.mockClear();
        }
    }
    expect(continued).toBe(scenario === 'timeout' || resumeReady ? 1 : 0);
    if (scenario === 'first') expect(testedProfileReadyRead).toBe(true);
    if (resumeReady) {
        expect(readyTriageClaims).toBe(scenario === 'resume ready individually' ? 1 : 0);
        expect(readSnapshotWithTriage).toBe(scenario === 'resume ready together' ? 1 : 0);
    }
    expect(receiptRedeliveries).toBe(scenario === 'terminal receipt timeout' ? 1 : 0);
    if (receiptRedeliveries) {
        expect(receiptCalls).toHaveLength(3);
        expect(receiptCalls[2].p_claim_token).not.toBe(receiptCalls[0].p_claim_token);
        expect(receiptCalls[2]).toEqual({
            ...receiptCalls[0],
            p_claim_token: receiptCalls[2].p_claim_token,
        });
    }
    if (observed) observed.assertion = 'private_source_hash';
    expect(producerHashes.length).toBeGreaterThanOrEqual(1 + continued);
    expect(producerHashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(producerHashes).size).toBe(1);
    if (observed) observed.assertion = 'owner_result';
    const page = await resultPage();
    if (changeTriageOnReplay) {
        const calls = runtime.model.mock.calls.slice(modelCallsBefore);
        const newCandidate = isReplay && routing === 'changed_shortlist';
        expect(calls).toHaveLength(isReplay ? 3 : 2);
        const modelSchemas = calls.map(([input]) => input.config.responseJsonSchema.properties ?? {});
        expect(modelSchemas.filter(schema => 'accounts' in schema)).toHaveLength(1);
        expect(modelSchemas.filter(schema => 'gender' in schema)).toHaveLength(isReplay ? 1 : 0);
        const { rows } = await db.query(`
            SELECT (SELECT count(*)::int FROM analysis_v2_result_summaries WHERE request_id=$1) AS published,
                   (SELECT count(*)::int FROM analysis_progress_events
                    WHERE request_id=$1 AND event_code='ANALYSIS_COMPLETED') AS completed,
                   (SELECT count(*)::int FROM analysis_v2_scheduler_operations
                    WHERE request_id=$1 AND stage='featureAnalysis' AND status='ready') AS feature_operations,
                   (SELECT count(*)::int FROM analysis_v2_profile_media_inputs
                    WHERE request_id=$1 AND stage='feature_remainder') AS feature_inputs,
                   (SELECT count(*)::int FROM gemini_token_usage WHERE request_id=$1) AS usage_rows,
                   (SELECT sum(actual_micros)::int FROM dev_live_budget.reservations
                    WHERE grant_id=$2 AND provider='vertex') AS settled_cost,
                   (SELECT last_error_code FROM analysis_pipeline_jobs
                    WHERE request_id=$1 AND job_key='track:profile-ai:batch:0') AS error_code
        `, [result.requestId, approval.id]);
        const budget = await totals();
        expect(rows).toEqual([{
            published: 1,
            completed: 1,
            feature_operations: isReplay ? 1 : 0,
            feature_inputs: isReplay ? 1 : 0,
            usage_rows: calls.length,
            settled_cost: budget.debit,
            error_code: null,
        }]);
        expect(page.status).toBe(200);
        if (isReplay) {
            expect(runtime.apify).not.toHaveBeenCalled();
            expect(runtime.png).not.toHaveBeenCalled();
            expect(budget).toMatchObject({
                consumed: 1, grants: 1, requests: 1, actors: 0, models: calls.length, settled: calls.length,
                apify_reserved: 0, apify_committed: 0, quota: 0,
            });
        }
        const body = await page.json();
        expect(body.femaleAccounts).toHaveLength(newCandidate ? 1 : 0);
        expect(body.privateAccounts).toHaveLength(1);
        expect(body.replayScopeDelta).toEqual(newCandidate ? { added: 1, removed: 0, unverified: 0 } : undefined);
        const images = [new URL(body.summary.targetProfileImage, appOrigin).href];
        images.push(await assertOwnerPage(result.requestId, privateCandidate, 'private', newCandidate));
        if (newCandidate) {
            const publicCandidate = body.femaleAccounts[0];
            expect(publicCandidate).toMatchObject({ instagramId: candidate, displayScore: 6.7, riskBand: 'caution' });
            expect((publicCandidate.highRiskNarrative ?? []).join(' ')).not.toContain(target + '님→' + candidate + '님 좋아요');
            images.push(await assertOwnerPage(result.requestId, candidate, 'public', true));
        }
        for (const url of images) {
            const image = await readImage(new NextRequest(url));
            expect(image.status).toBe(200);
            expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format).toBe('webp');
        }
        runtime.user = { ...user, id: otherId };
        expect((await resultPage()).status).toBe(404);
        for (const url of images) expect((await readImage(new NextRequest(url))).status).toBe(403);
        runtime.user = null;
        expect((await resultPage()).status).toBe(401);
        for (const url of images) expect((await readImage(new NextRequest(url))).status).toBe(401);
        expect(sqlErrors).toEqual([]);
        return {
            grantId: approval.id,
            approvedAt: approval.approvedAt,
            requestId: result.requestId as string,
            previewDto,
            imageHash: null,
        };
    }
    expect(page.status).toBe(200);
    const body = await page.json();
    expect(body.replayScopeDelta).toBeUndefined();
    if (privateReplay) {
        const observed = privateReplay.observed;
        observed.phase = 'result';
        observed.cause = 'publication_count';
        observed.assertion = 'publication';
        const counts = (await db.query<{ published: number; images: number; manifests: number; usage: number; cloned: number; batches: number }>(`
            SELECT (SELECT count(*)::int FROM analysis_progress_events WHERE request_id=$1 AND event_code='ANALYSIS_COMPLETED') AS published,
                   (SELECT count(*)::int FROM analysis_v2_result_image_objects WHERE request_id=$1 AND status='ready') AS images,
                   (SELECT count(*)::int FROM analysis_v2_result_image_manifests WHERE request_id=$1 AND sealed_at IS NOT NULL) AS manifests,
                   (SELECT count(*)::int FROM gemini_token_usage WHERE request_id=$1) AS usage,
                   (SELECT count(*)::int FROM analysis_v2_provider_runs WHERE request_id=$1) AS cloned,
                   (SELECT count(*)::int FROM analysis_pipeline_jobs
                    WHERE request_id=$1 AND job_key LIKE 'track:profile-ai:batch:%' AND status='completed') AS batches
        `, [result.requestId])).rows[0]!;
        observed.assertion = 'profile_ready_reads';
        expect(observed.profileReadyReads).toBeGreaterThan(0);
        expect([...readyReadBatches].sort((a, b) => a - b)).toEqual(privateReplay.profileBatches);
        observed.assertion = 'publication';
        expect(observed.completedProfileBatches).toBe(counts.batches);
        observed.published = counts.published;
        observed.readyImages = counts.images;
        expect(observed.apifyCalls).toBe(runtime.apify.mock.calls.length);
        expect(observed.sourceDownloads).toBe(runtime.png.mock.calls.length);
        expect(counts).toMatchObject({ published: 1, manifests: 1, cloned: 0, batches: privateReplay.profileBatches.length });
        expect(counts.images).toBeGreaterThan(0);
        expect(observed.fixedVertexCalls).toBeGreaterThan(0);
        expect(observed.mediaRegistryLoads).toBeGreaterThan(0);
        expect(observed.mediaRegistryRegistrations).toBeGreaterThan(0);
        expect(observed).toMatchObject({ reverseCompared:1,reverseSourceHashMatch:1,reverseActualHashMatch:1,reverseMissing:0,reverseExtra:0 });
        expect(observed).toMatchObject({
            imageScopeCompared: 1, imageScopeMismatched: 0, imageScopePlanMissing: 0,
            imageScopePlanExtra: 0, imageScopePlanDuplicate: 0,
        });
        expect(observed.stageProofRowsApplied).toBe(observed.imageScopePlanned - 1);
        expect(counts.images).toBe(observed.imageScopePlanned);
        observed.cause = 'model_routing';
        expect(observed.modelError).toBe('none');
        observed.cause = 'ledger_mismatch';
        expect(counts.usage).toBe(observed.fixedVertexCalls);
        expect(observed.apifyCalls).toBe(0);
        expect(observed.sourceDownloads).toBe(0);
        observed.cause = 'ledger_mismatch';
        observed.assertion = 'vertex_ledger';
        const sentIds = runtime.vertexReceipts!.sent;
        expect(sentIds.length).toBe(observed.fixedVertexCalls);
        expect(new Set(sentIds).size).toBe(sentIds.length);
        const ledger = await private90VertexLedger(db, approval.id, sentIds);
        Object.assign(observed, { ledgerChecked: 1, positiveSettlements: ledger.positive, unusedHolds: ledger.unused,
            unresolvedHolds: ledger.unresolved, duplicatePositive: ledger.duplicate, orphanPositive: ledger.orphan });
        expect(ledger).toMatchObject({ positive: observed.fixedVertexCalls, unresolved: 0, duplicate: 0, orphan: 0 });
        expect(await totals()).toMatchObject({
            consumed: 1, requests: 1, grants: 1, actors: 0, apify_reserved: 0, apify_committed: 0, quota: 0,
            models: ledger.positive + ledger.unused, settled: ledger.positive + ledger.unused, debit: ledger.debit,
        });
        // Keep the selected identity, signed locator and image bytes inside this process.
        const member = body.femaleAccounts.find((item: { profileImage?: string }) => Boolean(item.profileImage));
        expect(Boolean(member)).toBe(true);
        observed.phase = 'owner_image';
        observed.assertion = 'image';
        await verifyPrivate90Images(result.requestId, body, observed);
        expect(observed.webpVerified).toBe(counts.images);
        observed.cause = 'owner_access';
        const locator = await assertOwnerPage(result.requestId, member.instagramId);
        const ownerImage = await readImage(new NextRequest(locator));
        expect(observed.webpVerified).toBe(observed.imageScopePlanned);
        observed.ownerResult = page.status;
        observed.ownerImage = ownerImage.status;
        expect(ownerImage.status).toBe(200);
        expect((await sharp(Buffer.from(await ownerImage.arrayBuffer())).metadata()).format).toBe('webp');
        runtime.user = { ...user, id: otherId };
        observed.otherResult = (await resultPage()).status;
        observed.otherImage = (await readImage(new NextRequest(locator))).status;
        runtime.user = null;
        observed.anonymousResult = (await resultPage()).status;
        observed.anonymousImage = (await readImage(new NextRequest(locator))).status;
        expect([observed.otherResult, observed.otherImage, observed.anonymousResult, observed.anonymousImage])
            .toEqual([404, 403, 401, 401]);
        expect(sqlErrors.length).toBe(0);
        return { grantId: approval.id, approvedAt: approval.approvedAt, previewDto: null,
            requestId: result.requestId as string, imageHash: '' };
    }
    expect(body.femaleAccounts).toHaveLength(1);
    const row = body.femaleAccounts[0];
    expect(row.instagramId).toBe(candidate);
    expect(row.highRiskNarrative).toHaveLength(2);
    expect(row).toMatchObject({ displayScore: 7.2, riskBand: 'high_risk' });
    expect(row.highRiskNarrative[0]).toContain(candidate + '님');
    expect(row.highRiskNarrative[1]).toContain(target + '님');
    expect(row.highRiskNarrative.join(' ')).not.toContain('님님');
    expect(row.highRiskNarrative[1]).toContain(candidate + '님→' + target + '님 좋아요·댓글');
    expect(row.highRiskNarrative[1]).toContain(target + '님→' + candidate + '님 좋아요');
    expect(row.highRiskNarrative[1].length).toBeLessThanOrEqual(180);
    expect(steps).toBe(12 + privateNameChunks + continued + receiptRedeliveries);
    const expectedActors = isReplay ? 0 : 9;
    expect(apify.starts).toHaveLength(expectedActors);
    expect(runtime.model.mock.calls.length - modelCallsBefore).toBe(3 + privateNameChunks);
    expect(await totals()).toMatchObject({
        consumed: 1,
        requests: 1,
        grants: 1,
        actors: expectedActors,
        models: (capturedBlite ? 4 : 3) + privateNameChunks,
        settled: (capturedBlite ? 4 : 3) + privateNameChunks,
        quota: 0,
    });
    expect(
        (
            await db.query(
                `SELECT
    (SELECT count(*)::int FROM analysis_progress_events WHERE request_id=$1 AND event_code='ANALYSIS_COMPLETED') AS published,
    (SELECT count(*)::int FROM analysis_v2_result_image_objects WHERE request_id=$1 AND status='ready') AS ready,
    (SELECT count(*)::int FROM analysis_v2_result_image_manifests WHERE request_id=$1 AND sealed_at IS NOT NULL) AS sealed,
    (SELECT policy_versions_snapshot->>'aiStage' FROM analysis_requests WHERE id=$1) AS policy,
    (SELECT count(*)::int FROM gemini_token_usage WHERE request_id=$1) AS usage_rows,
    (SELECT sum(actual_micros)::int FROM dev_live_budget.reservations WHERE grant_id=$2 AND provider='vertex') AS settled_cost`,
                [result.requestId, approval.id],
            )
        ).rows[0],
    ).toMatchObject({
        published: 1,
        ready: 2 + syntheticPrivateCount,
        sealed: 1,
        policy: 'ai-stage-policy-v2.11',
        usage_rows: 3 + privateNameChunks,
        settled_cost: (await totals()).debit,
    });
    const budget = await totals();
    expect(budget.debit).toBeGreaterThan(0);
    if (isReplay) {
        expect(budget.apify_reserved).toBe(0);
        expect(runtime.apify).not.toHaveBeenCalled();
        expect(runtime.png).not.toHaveBeenCalled();
    } else {
        expect(budget.apify_reserved).toBeGreaterThan(0);
    }
    expect(budget.apify_committed).toBe(budget.apify_reserved);
    const imageUrl = await assertOwnerPage(result.requestId, row.instagramId);
    const imageRequest = () => new NextRequest(imageUrl);
    const image = await readImage(imageRequest());
    expect(image.status).toBe(200);
    const bytes = Buffer.from(await image.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe('webp');
    runtime.user = { ...user, id: otherId };
    expect((await resultPage()).status).toBe(404);
    expect((await readImage(imageRequest())).status).toBe(403);
    runtime.user = null;
    expect((await resultPage()).status).toBe(401);
    expect((await readImage(imageRequest())).status).toBe(401);
    expect(sqlErrors).toEqual([]);
    return {
        grantId: approval.id,
        approvedAt: approval.approvedAt,
        previewDto,
        requestId: result.requestId as string,
        imageHash: createHash('sha256').update(bytes).digest('hex'),
    };
}

it.each(deliveryScenarios)(
    'publishes one Dev Standard request from a fresh database (%s)',
    async (scenario) => {
        configure();
        const db = await createStandardDatabase();
        try {
            await runStandardRequest(db, await seedOwner(db), scenario);
        } finally {
            await db.close();
        }
    },
    60_000,
);

async function exerciseArchiveReplay(blite: boolean, routing: RoutingScenario = 'unchanged') {
    configure();
    const db = await createStandardDatabase();
    try {
        const user = await seedOwner(db);
        runtime.archiveObjects.mockReturnValue(createFixtureObjects());
        vi.stubEnv('PRECHECKOUT_BLITE_ENABLED', String(blite));
        vi.stubEnv('PRECHECKOUT_BLITE_ROLLOUT_PERCENT', blite ? '100' : '0');
        vi.stubEnv('DEV_LIVE_STANDARD_COLLECTION_MODE', 'archive_capture');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SLOT', '1'.repeat(32));
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_KEY', Buffer.alloc(32, 71).toString('base64'));
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_BUCKET', 'fixture-project-dev-live-media');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE', new Date(Date.now() - 60_000).toISOString());
        const source = await runStandardRequest(db, user, 'archive_capture', routing);
        await withVerifiedDevStandardArchive(target, coverage => {
            expect(coverage.profileBatches).toEqual([0]);
        });
        const sourceReceipts = async () => (await db.query<{
            receipts: number;
            succeeded: number;
            usage: string | null;
        }>(`
            SELECT count(*)::int AS receipts,
                   count(*) FILTER (WHERE status='succeeded')::int AS succeeded,
                   sum(actual_usage_usd)::text AS usage
            FROM analysis_v2_provider_runs WHERE request_id=$1
        `, [source.requestId])).rows[0]!;
        const original = await sourceReceipts();
        expect(original.receipts).toBeGreaterThan(0);
        expect(original.succeeded).toBe(original.receipts);
        vi.stubEnv('DEV_LIVE_STANDARD_COLLECTION_MODE', 'archive_replay');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SOURCE_APPROVAL', source.grantId);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_REPLAY_ENABLED', 'true');
        // A second owner admission is subject to the normal ten-second preflight limit.
        const nextStart = await db.query<{ wait_ms: number }>(`
            SELECT greatest(0, ceil(1000 * extract(epoch FROM
                  (p.created_at + interval '10 seconds' - clock_timestamp()))))::int AS wait_ms
            FROM analysis_preflights p WHERE p.consumed_request_id=$1
        `, [source.requestId]);
        await new Promise(resolve => setTimeout(resolve, nextStart.rows[0]!.wait_ms + 20));
        const destination = await runStandardRequest(db, user, 'archive_replay', routing);
        expect(destination.requestId).not.toBe(source.requestId);
        expect(destination.grantId).not.toBe(source.grantId);
        if (routing !== 'unchanged') {
            const { rows } = await db.query(`
                SELECT s.operation_key = d.operation_key AS same_model_input,
                       s.result_json->'results'->0->>'accountId' = d.result_json->'results'->0->>'accountId' AS same_account_input,
                       st.input->>'archiveSha256' = dt.input->>'archiveSha256' AS same_triage_images,
                       s.result_json#>>'{results,0,result,routingDecision}' AS source_route,
                       d.result_json#>>'{results,0,result,routingDecision}' AS replay_route
                FROM analysis_v2_scheduler_operations s
                JOIN analysis_v2_scheduler_operations d ON d.request_id=$2 AND d.job_key=s.job_key AND d.stage=s.stage
                JOIN analysis_v2_profile_media_inputs st ON st.request_id=s.request_id AND st.job_key=s.job_key AND st.stage='triage'
                JOIN analysis_v2_profile_media_inputs dt ON dt.request_id=d.request_id AND dt.job_key=d.job_key
                                                       AND dt.stage=st.stage AND dt.ordinal=st.ordinal
                WHERE s.request_id=$1 AND s.stage='genderTriage' AND s.status='ready' AND d.status='ready'
            `, [source.requestId, destination.requestId]);
            expect(rows).toEqual([{
                same_model_input: true,
                same_account_input: true,
                same_triage_images: true,
                source_route: 'exclude_high_confidence_male',
                replay_route: 'route_to_feature_analysis',
            }]);
        } else {
            expect(destination.imageHash).toBe(source.imageHash);
        }
        expect(destination.previewDto).toEqual(source.previewDto);
        expect(await sourceReceipts()).toEqual(original);
        const { rows } = await db.query(`
            SELECT (SELECT count(*)::int FROM dev_live_budget.standard_archive_replay_grants
                    WHERE grant_id=$1 AND source_grant_id=$2) AS bindings,
                   (SELECT count(*)::int FROM analysis_v2_provider_runs WHERE request_id=$3) AS cloned_runs
        `, [destination.grantId, source.grantId, destination.requestId]);
        expect(rows).toEqual([{ bindings: 1, cloned_runs: 0 }]);

        const expired = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(source.approvedAt) + 86_400_001);
        try {
            await expect(withVerifiedDevStandardArchive(target, () => true))
                .rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        } finally {
            expired.mockRestore();
        }
    } finally {
        await db.close();
    }
}

it.each([false, true])('replays sealed synthetic inputs through owner result and image without Apify or source downloads (B-lite %s)', async blite => {
    await exerciseArchiveReplay(blite);
}, 90_000);

it('publishes after a changed triage decision using all sealed feature images', async () => {
    await exerciseArchiveReplay(false, 'changed_triage');
}, 90_000);

it('publishes a changed reverse shortlist and shows the coverage note and candidate images to the owner', async () => {
    await exerciseArchiveReplay(false, 'changed_shortlist');
}, 90_000);


it('replays a separately sealed copy through the owner image using independent synthetic PGlite lineage', async () => {
    configure();
    const liveBucket = 'fixture-qa-dev-live-media';
    const copyBucket = 'fixture-project-dev-qa-copy';
    const kms = 'projects/fixture-project/locations/us-central1/keyRings/fixture/cryptoKeys/fixture';
    let sourceObjects = createFixtureObjects();
    const copyObjects = createFixtureObjects();
    runtime.archiveObjects.mockImplementation((name: string) => {
        if (name === liveBucket) return sourceObjects;
        if (name === copyBucket) return copyObjects;
        throw new Error('Unexpected bucket');
    });
    let wrapped: { ciphertext: string; plaintext: string; aad: string } | undefined;
    let wrapping = 0;
    let secretBytes = randomBytes(32);
    let deadlineOffset = 0;
    const expirySecret = 'projects/100001/secrets/private-fixture';
    const secretUrl = 'https://secretmanager.googleapis.com/v1/' + expirySecret;
    runtime.kmsOrBucket.mockImplementation(async ({ url, data }) => {
        if (url === secretUrl) return { data: {
            name: expirySecret, expireTime: new Date(Date.parse(process.env.DEV_STANDARD_QA_COPY_APPROVED_AT!) + 90 * 86_400_000 + deadlineOffset).toISOString(),
            replication: { userManaged: { replicas: [{ location: 'us-central1' }] } },
        } };
        if (url === secretUrl + '/versions/1:access') return { data: { name: expirySecret + '/versions/1', payload: { data: secretBytes.toString('base64') } } };
        if (url === 'https://storage.googleapis.com/storage/v1/b/' + liveBucket) return { data: { projectNumber: '100001', location: 'US-CENTRAL1' } };
        if (url === 'https://storage.googleapis.com/storage/v1/b/' + copyBucket) return { data: {
            projectNumber: '100001', location: 'US-CENTRAL1', storageClass: 'STANDARD',
            iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
            lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 90 } }] },
        } };
        if (url === 'https://cloudkms.googleapis.com/v1/' + kms + ':encrypt') {
            wrapping++;
            wrapped = { ciphertext: randomBytes(48).toString('base64'), plaintext: data.plaintext, aad: data.additionalAuthenticatedData };
            return { data: { name: kms + '/cryptoKeyVersions/1', ciphertext: wrapped.ciphertext } };
        }
        if (url === 'https://cloudkms.googleapis.com/v1/' + kms + ':decrypt' && wrapped
            && data.ciphertext === wrapped.ciphertext && data.additionalAuthenticatedData === wrapped.aad) {
            return { data: { plaintext: wrapped.plaintext } };
        }
        throw new Error('Unexpected offline cloud request');
    });
    function captureConfig() {
        const slot = randomBytes(16).toString('hex');
        const key = randomBytes(32).toString('base64');
        vi.stubEnv('PRECHECKOUT_BLITE_ENABLED', 'true');
        vi.stubEnv('PRECHECKOUT_BLITE_ROLLOUT_PERCENT', '100');
        vi.stubEnv('DEV_LIVE_STANDARD_COLLECTION_MODE', 'archive_capture');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SLOT', slot);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_KEY', key);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_BUCKET', liveBucket);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE', new Date(Date.now() - 60_000).toISOString());
        return { key, slot };
    }

    const archiveDb = await createStandardDatabase();
    const config = captureConfig();
    let sourceTime = Date.now();
    const live = createDevStandardArchiveStore({ ...config, bucketName: liveBucket, objects: sourceObjects, now: () => sourceTime });
    try {
        const capture = await runStandardRequest(archiveDb, await seedOwner(archiveDb), 'archive_capture');
        sourceTime = Date.now();
        const approvedAt = new Date(sourceTime).toISOString();
        vi.stubEnv('DEV_STANDARD_QA_COPY_APPROVAL', randomUUID());
        vi.stubEnv('DEV_STANDARD_QA_COPY_SOURCE_APPROVAL', capture.grantId);
        vi.stubEnv('DEV_STANDARD_QA_COPY_APPROVED_AT', approvedAt);
        vi.stubEnv('DEV_STANDARD_QA_COPY_PROJECT', 'fixture-project');
        vi.stubEnv('DEV_LIVE_GCP_PROJECT', 'fixture-project');
        vi.stubEnv('DEV_LIVE_GCP_PROJECT_NUMBER', '100001');
        vi.stubEnv('DEV_STANDARD_QA_COPY_PROJECT_NUMBER', '100001');
        vi.stubEnv('DEV_STANDARD_QA_COPY_BUCKET', copyBucket);
        vi.stubEnv('DEV_STANDARD_QA_COPY_APPROVED_SOURCE_BUCKET', liveBucket);
        vi.stubEnv('DEV_STANDARD_QA_COPY_KMS_KEY', kms);
        vi.stubEnv('DEV_STANDARD_QA_COPY_EXPIRY_SECRET_VERSION', expirySecret + '/versions/1');
        vi.stubEnv('DEV_STANDARD_QA_COPY_DAYS', '90');
        const { policy, destination } = await openStandardQaCopyForJob('export');
        const result = await exportStandardQaCopy(policy, live, destination);
        expect(result.profileBatches).toBe(1);
        if (process.env.PRIVATE90_FULL_REPLAY === 'synthetic') {
            const receipts = await archiveDb.query<{ sourceFingerprint: string; webpSha256: string }>(
                'SELECT source_fingerprint AS "sourceFingerprint", sha256 AS "webpSha256" FROM analysis_v2_result_image_objects WHERE request_id=$1 AND status=\'ready\' ORDER BY sort_ordinal',
                [capture.requestId]);
            await enrollStandardQaResultProof(policy, destination, receipts.rows);
        }
        sourceTime = Date.parse(capture.approvedAt) + 86_400_001;
        await expect(live.openSealedArchive()).rejects.toThrow('EXPIRED');
    } finally {
        await archiveDb.close();
    }

    // Nothing from the first account or DB survives. The reference SQL receipts in
    // this independent DB are generated from the deterministic synthetic providers.
    sourceObjects = createFixtureObjects();
    vi.unstubAllGlobals();
    configure();
    if (process.env.PRIVATE90_FULL_REPLAY === 'synthetic') {
        runtime.archiveObjects.mockImplementation((name: string) => {
            if (name !== copyBucket) throw new Error('Original capture unavailable');
            return copyObjects;
        });
        return reportPrivate90(async observed => {
            const { policy, destination } = await openStandardQaCopyForJob('read');
            await withVerifiedStandardQaCopy(policy, destination, async (coverage, reader) => {
                const proof = await readStandardQaResultProof(policy, destination);
                await runPrivate90Fixture(target, coverage.profileBatches, reader, observed, proof);
                expect(observed.stageProofDirectDrift).toBe(observed.stageProofRows - 1);
                expect(observed.stageProofRowsApplied).toBe(observed.publicImages + observed.privateImages);
            });
        });
    }
    const nextDb = await createStandardDatabase();
    try {
        captureConfig();
        const owner = await seedOwner(nextDb);
        const reference = await runStandardRequest(nextDb, owner, 'archive_capture');
        expect(reference.grantId).not.toBe(process.env.DEV_STANDARD_QA_COPY_SOURCE_APPROVAL);
        vi.stubEnv('DEV_LIVE_STANDARD_COLLECTION_MODE', 'archive_replay');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SOURCE_APPROVAL', reference.grantId);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_REPLAY_ENABLED', 'true');
        const limit = await nextDb.query<{ wait_ms: number }>(`
            SELECT greatest(0,ceil(1000*extract(epoch FROM (created_at + interval '10 seconds' - clock_timestamp()))))::int AS wait_ms
            FROM analysis_preflights WHERE consumed_request_id=$1`, [reference.requestId]);
        await new Promise(resolve => setTimeout(resolve, limit.rows[0]!.wait_ms + 20));
        // Once the independent mock history is ready, only the new copy bucket is accessible.
        runtime.archiveObjects.mockImplementation((name: string) => {
            if (name !== copyBucket) throw new Error('Original capture unavailable');
            return copyObjects;
        });
        const result = await withCloudStandardQaFixture(async coverage => {
            expect(coverage.profileBatches).toEqual([0]);
            // The target-profile provider identity includes the original input hash.
            // Reference only the authenticated proof in this disposable synthetic ledger.
            const job = 'track:target-evidence:collect';
            const proof = await readDevStandardArchivedProfiles({ target, jobKey: job, batch: null, usernames: [target] });
            const seeded = await nextDb.query(`
                UPDATE analysis_v2_provider_runs SET operation_key=$1, input_hash=$2
                WHERE request_id=$3 AND job_key=$4 AND operation_key LIKE 'target-profile:%'
            `, [proof.providerOperationKey, proof.providerInputHash, reference.requestId, job]);
            expect(seeded.affectedRows).toBe(1);
            return runStandardRequest(nextDb, owner, 'archive_replay', 'unchanged', true);
        });
        expect(result.imageHash).toBe(reference.imageHash);
        expect(result.previewDto).toEqual(reference.previewDto);
        expect(wrapping).toBe(1);
        const rightKey = secretBytes;
        secretBytes = randomBytes(32);
        await expect(withCloudStandardQaFixture(() => true)).rejects.toThrow();
        secretBytes = rightKey;
        deadlineOffset = 1;
        await expect(withCloudStandardQaFixture(() => true)).rejects.toThrow('EXPIRY_SECRET_INVALID');
        deadlineOffset = 0;
        await expect(verifyExpiredStandardQaCopy('revoked')).rejects.toThrow('EARLY');
        const expiry = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(process.env.DEV_STANDARD_QA_COPY_APPROVED_AT!) + 90 * 86_400_000);
        try {
            await expect(withCloudStandardQaFixture(() => true)).rejects.toThrow('UNAVAILABLE');
            runtime.kmsOrBucket.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 404 });
            await expect(verifyExpiredStandardQaCopy('revoked')).resolves.toBe('revoked');
            runtime.kmsOrBucket.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200 });
            await expect(verifyExpiredStandardQaCopy('revoked')).rejects.toThrow('ACCESS_UNVERIFIED');
            runtime.kmsOrBucket.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 200, data: {} }).mockResolvedValueOnce({
                status: 400, data: { error: { errors: [{ reason: 'invalidArgument' }] } },
            });
            await expect(verifyExpiredStandardQaCopy('deleted')).resolves.toBe('versions_absent_soft_delete_unverified');
            runtime.kmsOrBucket.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 200, data: { items: [{ kind: 'storage#object' }] } });
            await expect(verifyExpiredStandardQaCopy('deleted')).rejects.toThrow('DELETION_PENDING');
            runtime.kmsOrBucket.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 200, data: {} }).mockResolvedValueOnce({ status: 200, data: {} });
            await expect(verifyExpiredStandardQaCopy('deleted')).resolves.toBe('deleted');
        } finally {
            expiry.mockRestore();
        }
    } finally {
        await nextDb.close();
    }
}, 120_000);


type PrivateReader = Parameters<StandardQaFixtureOperation<unknown>>[1];

async function runPrivate90Fixture(
    requestTarget: string, profileBatches: readonly number[], reader: PrivateReader, observed: Private90Observations, proof: unknown,
) {
    const archive = currentDevStandardArchive();
    if (archive?.mode !== 'replay' || archive.target !== requestTarget) throw new Error('PRIVATE90_READER_REQUIRED');
    observed.profileBatches = profileBatches.length;
    const blite = await archive.load('preflight-blite-policy-v1', [requestTarget]);
    if (typeof blite !== 'boolean') throw new Error('PRIVATE90_BLITE_POLICY_INVALID');
    vi.unstubAllGlobals();
    configure();
    vi.stubEnv('DEV_LIVE_STANDARD_TARGET', requestTarget);
    vi.stubEnv('PRECHECKOUT_BLITE_ENABLED', String(blite));
    vi.stubEnv('PRECHECKOUT_BLITE_ROLLOUT_PERCENT', blite ? '100' : '0');
    const db = await createStandardArchiveDatabase();
    try {
        observed.phase = 'source_ledger';
        observed.cause = 'source_receipts';
        const owner = await seedOwner(db, requestTarget);
        const source = await bootstrapStandardArchiveSource(db, { ownerId: owner.id, target: requestTarget, reader, profileBatches });
        observed.sourceReceipts = source.receiptCount;
        vi.stubEnv('DEV_LIVE_STANDARD_COLLECTION_MODE', 'archive_replay');
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SLOT', randomBytes(16).toString('hex'));
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_SOURCE_APPROVAL', source.grantId);
        vi.stubEnv('DEV_LIVE_STANDARD_ARCHIVE_REPLAY_ENABLED', 'true');
        observed.phase = 'fixed_model';
        observed.cause = 'sealed_model_inputs';
        observed.cause = 'result_stage_proof';
        const stageImages = await private90StageImages({ reader, target: requestTarget, batches: profileBatches, proof });
        Object.assign(observed, stageImages.counts());
        observed.cause = 'sealed_model_inputs';
        const model = await prepareStandardArchiveVertex({ target: requestTarget, reader, profileBatches });
        Object.assign(observed,model.reverseScope.sourceCounts());
        observed.publicProfilesInspected = model.counts().profiles;
        observed.missingFeatureInputs = model.counts().missingRemainder;
        observed.phase = 'admission';
        observed.cause = 'preflight_admission';
        const due = await db.query<{ ms: number }>(`
            SELECT greatest(0,ceil(1000*extract(epoch FROM
                (created_at + interval '10 seconds' - clock_timestamp()))))::int AS ms
            FROM analysis_preflights WHERE consumed_request_id=$1
        `, [source.requestId]);
        await new Promise(resolve => setTimeout(resolve, due.rows[0]!.ms + 20));
        await runStandardRequest(db, owner, 'archive_replay', 'unchanged', true, {
            target: requestTarget, generate: model.generate, reverseScope:model.reverseScope, imageScope:model.imageScope, stageImages, profileBatches, observed,
        });
        observed.phase = 'complete';
        observed.assertion = 'none';
        observed.cause = 'none';
    } finally {
        await db.close();
    }
}

async function reportPrivate90(run: (observed: Private90Observations) => Promise<void>) {
    // Vitest threads can override execArgv. Install the same guard in this worker before opening any reader.
    createRequire(import.meta.url)(process.cwd() + '/scripts/dev-standard-private90-egress.cjs');
    const observed = newPrivate90Observations();
    try {
        await run(observed);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'PRIVATE90_NETWORK_DENIED') observed.cause = 'network_denied';
        if (message === 'DEV_STANDARD_ARCHIVE_UNAVAILABLE' || message === 'OFFLINE_STANDARD_VERTEX_SEALED_INPUT_MISSING')
            observed.cause = 'missing_keyed_media';
        if (message.startsWith('OFFLINE_STANDARD_VERTEX_') && observed.cause !== 'missing_keyed_media')
            observed.cause = 'model_routing';
        if (message.startsWith('Offline Standard source bootstrap failed at local ')) observed.cause = 'source_admission';
        throw new Error('PRIVATE90_FULL_REPLAY_FAILED');
    } finally {
        writeSync(3, JSON.stringify(safePrivate90Observations(observed)));
    }
}

it.skipIf(process.env.PRIVATE90_FULL_REPLAY !== 'cloud')('runs the authorized private90 copy through the isolated Standard worker', async () => {
    await reportPrivate90(async observed => {
        if (process.env.DEPLOYMENT_ROLE !== 'dev' || !process.env.CLOUD_RUN_JOB) throw new Error('PRIVATE90_DEV_JOB_REQUIRED');
        const bucket = process.env.DEV_STANDARD_QA_COPY_BUCKET!;
        const key = process.env.DEV_STANDARD_QA_COPY_KMS_KEY!;
        const { Compute } = await vi.importActual<typeof import('google-auth-library')>('google-auth-library');
        // Bind credentials to the Cloud Run metadata service. The reader principal needs read and decrypt only.
        const credential = new Compute({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const bucketPath = '/storage/v1/b/' + encodeURIComponent(bucket);
        const downloadPath = '/download' + bucketPath + '/o/';
        const expiry = expirySecretResource(process.env.DEV_STANDARD_QA_COPY_EXPIRY_SECRET_VERSION!,
            process.env.DEV_STANDARD_QA_COPY_PROJECT!, process.env.DEV_STANDARD_QA_COPY_PROJECT_NUMBER!, key.split('/')[3]!);
        if (expiry.regional) throw new Error('PRIVATE90_EXPIRY_LOCATION_INVALID');
        const requestReadOnly = <T>(opts: { url: string; method?: string }) => {
            const url = new URL(opts.url);
            const gcs = url.origin === 'https://storage.googleapis.com' && (opts.method ?? 'GET') === 'GET'
                && (url.pathname === bucketPath || url.pathname === bucketPath + '/o'
                    || url.pathname.startsWith(bucketPath + '/o/') || url.pathname.startsWith(downloadPath));
            const kms = opts.method === 'POST' && url.origin === 'https://cloudkms.googleapis.com'
                && url.pathname === '/v1/' + key + ':decrypt';
            const expiryRead = (opts.method ?? 'GET') === 'GET'
                && (url.href === expiry.url || url.href === expiry.url + '/versions/1:access');
            if (!gcs && !kms && !expiryRead) throw new Error('PRIVATE90_NETWORK_DENIED');
            return credential.request<T>({ ...opts, url: url.href, redirect: 'error' });
        };
        const { createGoogleCloudPrivateMediaObjectClient } =
            await vi.importActual<typeof import('@/lib/services/analysis/v2-media-artifact-store')>('@/lib/services/analysis/v2-media-artifact-store');
        runtime.kmsOrBucket.mockImplementation(requestReadOnly);
        runtime.archiveObjects.mockImplementation((name: string) => {
            if (name !== bucket) throw new Error('PRIVATE90_BUCKET_DENIED');
            return createGoogleCloudPrivateMediaObjectClient({ bucketName: bucket, requester: { request: requestReadOnly } });
        });
        const { policy, destination } = await openStandardQaCopyForJob('read');
        await withVerifiedStandardQaCopy(policy, destination, async (coverage, reader) => {
            observed.cause = 'result_stage_proof';
            const proof = await readStandardQaResultProof(policy, destination);
            await runPrivate90Fixture(policy.target, coverage.profileBatches, reader, observed, proof);
        });
    });
}, 3_600_000);
