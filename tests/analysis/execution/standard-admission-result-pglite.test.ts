import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
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
import { assertOwnerPage } from './fixtures/standard-result-page';
import { processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';
import { parseAnalysisV2TaskPayload } from '@/lib/services/analysis/v2-tasks';
import { SyntheticApify, target, candidate } from './fixtures/standard-providers';
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
import { withDevStandardArchiveApproval, withVerifiedDevStandardArchive } from '@/lib/services/dev-ui/standard-archive-runtime';
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
}));
vi.mock('google-auth-library', async original => ({
    ...(await original<typeof import('google-auth-library')>()),
    GoogleAuth: class { async getClient() { return { request: runtime.kmsOrBucket }; } },
}));
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
        createTask: async ({ task }: { task: { httpRequest: { body: string } } }) => {
            runtime.queue.push(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString('utf8')));
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
            actual.createAnalysisV2MediaArtifactStore({ objects: runtime.objects() }),
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

async function seedOwner(db: PGlite) {
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
        target,
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
    vi.clearAllMocks();
});

const deliveryScenarios = ['first', 'second', 'timeout', 'terminal receipt timeout'] as const;
type Scenario = typeof deliveryScenarios[number] | 'archive_capture' | 'archive_replay';

async function runStandardRequest(
    db: PGlite,
    user: Awaited<ReturnType<typeof seedOwner>>,
    scenario: Scenario,
    privateCopySession = false,
) {
    const isReplay = scenario === 'archive_replay';
    const blite = process.env.PRECHECKOUT_BLITE_ENABLED === 'true';
    const capturedBlite = blite && scenario === 'archive_capture';
    const otherId = randomUUID();
    vi.stubEnv('DEV_UI_TEST_USER_IDS', [user.id, otherId].join(','));
    runtime.user = user;
    const client = localDatabaseClient(db);
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
        const out = await client.rpc(n, a);
        if (out.error && !out.error.message.includes('FENCE'))
            sqlErrors.push(n + ': ' + out.error.message);
        return out;
    });
    runtime.admin.from.mockImplementation(client.from);
    runtime.session.mockImplementation(async () => ({
        ...localDatabaseClient(db, runtime.user?.id ?? null),
        auth: { getUser: async () => ({ data: { user: runtime.user }, error: null }) },
    }));
    const apify = new SyntheticApify();
    runtime.apify.mockClear().mockImplementation(() => {
        if (isReplay) throw new Error('Unexpected Apify access during archive replay');
        return apify;
    });
    runtime.objects.mockReturnValue(createFixtureObjects());
    runtime.r2.mockImplementation(createFixtureR2());
    const sourcePng = await makeSourcePng();
    runtime.png.mockClear().mockImplementation(() => {
        if (isReplay) throw new Error('Unexpected source image download during archive replay');
        return sourcePng;
    });
    runtime.model.mockImplementation(syntheticGeneration);
    const attempt = randomUUID();
    const newPreflight = () => start(request('', 'POST', { targetInstagramId: target }, attempt));
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
    const modelCallsBefore = runtime.model.mock.calls.length;
    const stateStore = createSupabaseAnalysisV2DagStateStore();
    const worker = {
        stateStore,
        executors: createAnalysisV2ProductionExecutorRegistry(),
        progressReporter: createAnalysisV2ProgressReporter({
            reloadState: (id) => stateStore.load(id),
        }),
    };
    while (runtime.queue.length) {
        if (++steps > 24) throw new Error('Unexpected repeated task delivery');
        const payload = runtime.queue.shift()!;
        const delivery = parseAnalysisV2TaskPayload(payload);
        const outcome = await runDelivery(() =>
            processAnalysisV2TaskDelivery(delivery, worker),
        );
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
            runtime.queue.unshift(payload); // Cloud Tasks retries the same delivery.
            continue;
        }
        if (outcome.status === 'continuation' && scenario === 'timeout') {
            expect(outcome.errorCode).toBe('ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT');
            expect(outcome.pendingRecoveryCount).toBe(0);
            expect(runtime.model.mock.calls.length).toBe(modelCallsBefore);
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
        expect(outcome.status, delivery.jobKey + ' ' + JSON.stringify(outcome)).toBe('completed');
        expect(outcome).toMatchObject({ pendingRecoveryCount: 0 });
        const before = await totals();
        const calls = [apify.starts.length, runtime.model.mock.calls.length, runtime.queue.length];
        expect((await processAnalysisV2TaskDelivery(delivery)).status).toBe('already_terminal');
        expect([apify.starts.length, runtime.model.mock.calls.length, runtime.queue.length]).toEqual(
            calls,
        );
        expect(await totals()).toEqual(before);
    }
    expect(continued).toBe(scenario === 'timeout' ? 1 : 0);
    expect(receiptRedeliveries).toBe(scenario === 'terminal receipt timeout' ? 1 : 0);
    if (receiptRedeliveries) {
        expect(receiptCalls).toHaveLength(3);
        expect(receiptCalls[2].p_claim_token).not.toBe(receiptCalls[0].p_claim_token);
        expect(receiptCalls[2]).toEqual({
            ...receiptCalls[0],
            p_claim_token: receiptCalls[2].p_claim_token,
        });
    }
    expect(producerHashes.length).toBeGreaterThanOrEqual(1 + continued);
    expect(producerHashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(producerHashes).size).toBe(1);
    const page = await resultPage();
    expect(page.status).toBe(200);
    const body = await page.json();
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
    expect(steps).toBe(12 + continued + receiptRedeliveries);
    const expectedActors = isReplay ? 0 : 9;
    expect(apify.starts).toHaveLength(expectedActors);
    expect(runtime.model.mock.calls.length - modelCallsBefore).toBe(3);
    expect(await totals()).toMatchObject({
        consumed: 1,
        requests: 1,
        grants: 1,
        actors: expectedActors,
        models: capturedBlite ? 4 : 3,
        settled: capturedBlite ? 4 : 3,
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
        ready: 2,
        sealed: 1,
        policy: 'ai-stage-policy-v2.11',
        usage_rows: 3,
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

it.each([false, true])('replays sealed synthetic inputs through owner result and image without Apify or source downloads (B-lite %s)', async (blite) => {
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
        const source = await runStandardRequest(db, user, 'archive_capture');
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
        const destination = await runStandardRequest(db, user, 'archive_replay');
        expect(destination.requestId).not.toBe(source.requestId);
        expect(destination.grantId).not.toBe(source.grantId);
        expect(destination.imageHash).toBe(source.imageHash);
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
            return runStandardRequest(nextDb, owner, 'archive_replay', true);
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
