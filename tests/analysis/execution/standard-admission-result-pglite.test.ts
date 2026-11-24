import { randomUUID } from 'node:crypto';
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
import { processPreflight } from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { getApprovedDevLiveDelivery } from '@/lib/services/dev-ui/live-analysis';
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
    r2: vi.fn(),
    png: vi.fn(),
    model: vi.fn(),
    queue: [] as Record<string, string | number>[],
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

it.each(['first', 'second', 'timeout'])(
    'publishes one Dev Standard request from a fresh database (%s)',
    async (scenario) => {
        configure();
        const db = await createStandardDatabase();
        try {
            const user = await seedOwner(db);
            const otherId = randomUUID();
            vi.stubEnv('DEV_UI_TEST_USER_IDS', [user.id, otherId].join(','));
            runtime.user = user;
            const client = localDatabaseClient(db);
            let timeouts = 0;
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
            runtime.apify.mockReturnValue(apify);
            runtime.objects.mockReturnValue(createFixtureObjects());
            runtime.r2.mockImplementation(createFixtureR2());
            runtime.png.mockReturnValue(await makeSourcePng());
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
            expect(approval?.planId).toBe('standard');
            vi.stubEnv('DEV_LIVE_WORKLOAD', 'preflight');
            const preflight = () =>
                withDevLiveProviderApproval(approval, () =>
                    processPreflight(preflightId, {
                        dispatchFence: {
                            generation: Number(task.generation),
                            reservationToken: String(task.reservationToken),
                        },
                    }),
                );
            expect(await preflight()).toBe('ready');
            expect(await preflight()).toBe('noop');
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
                withDevLiveProviderApproval(approval, () =>
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
            expect(getProfile).toHaveBeenCalledTimes(1);
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
            (SELECT count(*)::int FROM analysis_v2_test_entitlement_consumptions) AS consumed,
            (SELECT count(*)::int FROM analysis_requests) AS requests,
            (SELECT count(*)::int FROM dev_live_budget.owner_starts) AS grants,
            (SELECT count(*)::int FROM dev_live_budget.reservations WHERE provider='apify') AS actors,
            (SELECT count(*)::int FROM dev_live_budget.reservations WHERE provider='vertex') AS models,
            (SELECT count(*)::int FROM dev_live_budget.reservations WHERE provider='vertex' AND actual_micros IS NOT NULL) AS settled,
            (SELECT coalesce(sum(apify_committed_micros),0)::int FROM dev_live_budget.grants) AS apify_committed,
            (SELECT coalesce(sum(reserved_micros),0)::int FROM dev_live_budget.reservations WHERE provider='apify') AS apify_reserved,
            (SELECT coalesce(sum(ai_committed_micros),0)::int FROM dev_live_budget.grants) AS debit,
            (SELECT analysis_count FROM public.users WHERE id=$1) AS quota`,
                        [user.id],
                    )
                ).rows[0];
            let steps = 0;
            let continued = 0;
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
                const delivery = parseAnalysisV2TaskPayload(runtime.queue.shift());
                const outcome = await withDevLiveProviderApproval(approval, () =>
                    processAnalysisV2TaskDelivery(delivery, worker),
                );
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
            expect(steps).toBe(12 + continued);
            expect(apify.starts).toHaveLength(9);
            expect(runtime.model.mock.calls.length - modelCallsBefore).toBe(3);
            expect(await totals()).toMatchObject({
                consumed: 1,
                requests: 1,
                grants: 1,
                actors: 9,
                models: 3,
                settled: 3,
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
            (SELECT sum(actual_micros)::int FROM dev_live_budget.reservations WHERE provider='vertex') AS settled_cost`,
                        [result.requestId],
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
            expect(budget.apify_reserved).toBeGreaterThan(0);
            expect(budget.apify_committed).toBe(budget.apify_reserved);
            const imageUrl = await assertOwnerPage(result.requestId, row.instagramId);
            const imageRequest = () => new NextRequest(imageUrl);
            const image = await readImage(imageRequest());
            expect(image.status).toBe(200);
            expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format).toBe('webp');
            runtime.user = { ...user, id: otherId };
            expect((await resultPage()).status).toBe(404);
            expect((await readImage(imageRequest())).status).toBe(403);
            runtime.user = null;
            expect((await resultPage()).status).toBe(401);
            expect((await readImage(imageRequest())).status).toBe(401);
            expect(sqlErrors).toEqual([]);
        } finally {
            await db.close();
        }
    },
    60_000,
);
