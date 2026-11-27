import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { qaWorkerConfig, assertQaCloudIdentity } from '../../../services/dev-standard-qa-worker/config';
import { dbOrigin, number, origin, project, region, service, taskPath, type QaRole } from '../../../services/dev-standard-qa-worker/scope';
import { bundleQaWorker } from '../../../services/dev-standard-qa-worker/build.mjs';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn(), paid: vi.fn(), preflight: vi.fn() }));
vi.mock('@/app/api/analysis/v2/worker/route', () => ({ POST: mocks.paid }));
vi.mock('@/app/api/analysis/preflight/worker/route', () => ({ POST: mocks.preflight }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock('@/lib/services/analysis/preflight-tasks', async original => ({
    ...await original<typeof import('@/lib/services/analysis/preflight-tasks')>(), verifyPreflightTaskAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/v2-tasks', async original => ({
    ...await original<typeof import('@/lib/services/analysis/v2-tasks')>(), verifyAnalysisV2TaskAuthorization: mocks.verify,
}));
import { handleQaWorker } from '../../../services/dev-standard-qa-worker/handler';

const wave = 'b'.repeat(64);
function settings(role: QaRole) {
    const env: NodeJS.ProcessEnv = {
        ANALYSIS_WORKLOAD_ROLE: role, NODE_ENV: 'production', K_SERVICE: service(role), K_REVISION: service(role) + '-00001-abc',
        GOOGLE_CLOUD_PROJECT: project, DEV_STANDARD_QA_PROJECT_NUMBER: number, DEV_STANDARD_QA_WAVE: wave,
        NEXT_PUBLIC_SUPABASE_URL: dbOrigin, ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
        SCRAPER_PROFILE: 'apify', SCRAPER_PROFILES_BATCH: 'apify', SCRAPER_FOLLOWERS: 'apify', SCRAPER_FOLLOWING: 'apify',
        SCRAPER_FALLBACK: 'false', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', VERTEX_AI_BUDGET_GUARD_ENABLED: 'true', VERTEX_AI_BUDGET_STORE: 'supabase',
        ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: project + '-dev-live-media', ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: project + '-dev-live-results',
        ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
        PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128', PAID_STANDARD_PROCESS_FEATURE_SLOTS: '4',
        ANALYSIS_V2_WORKER_ENABLED: 'true', ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
    };
    const prefix = role === 'paid' ? 'ANALYSIS_V2_TASKS_' : 'PREFLIGHT_TASKS_';
    for (const [key, value] of Object.entries({
        ENABLED: 'true', PROJECT: project, LOCATION: region, QUEUE: service(role),
        SERVICE_ACCOUNT_EMAIL: 'dev-live-' + role + '-invoker@' + project + '.iam.gserviceaccount.com',
        CALLER_AUTH_MODE: 'adc', TARGET_URL: origin(role) + taskPath(role), OIDC_AUDIENCE: origin(role),
    })) env[prefix + key] = value;
    return env;
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('pins each role to the Dev project, queue, OIDC audience, resource buckets and existing machine identity', async () => {
    for (const role of ['preflight', 'paid'] as const) {
        const env = settings(role);
        expect(qaWorkerConfig(env).role).toBe(role);
        for (const override of [{ K_SERVICE: 'analysis-paid-worker' }, { APIFY_API_TOKEN: 'not-an-inert-placeholder' },
            { NEXT_PUBLIC_SUPABASE_URL: 'https://wrong.invalid' }, { SCRAPER_FALLBACK: 'true' },
            { [(role === 'paid' ? 'ANALYSIS_V2' : 'PREFLIGHT') + '_TASKS_QUEUE']: 'other-queue' }]) {
            expect(() => qaWorkerConfig({ ...env, ...override })).toThrow('CONFIG_REJECTED');
        }
        const identity = vi.fn<typeof fetch>(async url => {
            const p = String(url);
            const value = p.endsWith('project/project-id') ? project : p.endsWith('numeric-project-id') ? number
                : 'dev-live-' + role + '@' + project + '.iam.gserviceaccount.com';
            return new Response(value, { headers: { 'Metadata-Flavor': 'Google' } });
        });
        await expect(assertQaCloudIdentity(role, identity)).resolves.toBeUndefined();
        await expect(assertQaCloudIdentity(role, async () => new Response('incorrect'))).rejects.toThrow('IDENTITY_REJECTED');
    }
});

it('requires the canonical queue, OIDC and DB wave membership before passing a fenced delivery to its route', async () => {
    const role = 'preflight';
    const env = settings(role);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'GOOGLE_APPLICATION_CREDENTIALS']) vi.stubEnv(key, undefined);
    const id = randomUUID();
    const payload = { workloadRole: role, preflightId: id, generation: 1, reservationToken: randomUUID() };
    const req = (data: unknown, queue = service(role)) => new Request(origin(role) + taskPath(role), {
        method: 'POST', headers: { host: new URL(origin(role)).host, 'x-cloudtasks-queuename': queue }, body: JSON.stringify(data),
    });
    expect((await handleQaWorker(req(payload, 'other-queue'))).status).toBe(403);
    expect(mocks.verify).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValue(false);
    expect((await handleQaWorker(req(payload))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValue(true);
    expect((await handleQaWorker(req({ ...payload, reservationToken: undefined }))).status).toBe(400);
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect((await handleQaWorker(req(payload))).status).toBe(403);
    expect(mocks.preflight).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: 2, error: null });
    mocks.preflight.mockResolvedValue(new Response(null, { status: 200 }));
    expect((await handleQaWorker(req(payload))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith('dev_cloud_six_scope_v1', { p_wave: wave, p_preflight_id: id });
    expect(mocks.paid).not.toHaveBeenCalled();
});

it('bundles both actual routes and storage clients with the QA providers and enforces egress before module loading', async () => {
    const result = await bundleQaWorker();
    expect(result.outputFiles![0]!.contents.byteLength).toBeGreaterThan(0);
    const preload = path.resolve('services/dev-standard-qa-worker/egress.cjs');
    const script = `(async () => {
        for (const host of ['api.apify.com', 'aiplatform.googleapis.com', 'instagram.com', 'scontent.cdninstagram.com', 'api.resend.com']) {
            try { await fetch('https://' + host); process.exit(2); } catch(e) { if (e.message !== 'DEV_STANDARD_QA_NETWORK_DENIED') process.exit(3); }
            try { require('node:net').connect(443, host); process.exit(4); } catch(e) { if (e.message !== 'DEV_STANDARD_QA_NETWORK_DENIED') process.exit(5); }
        }
        const body = await (await fetch('data:,standard-cloud-six-vertex')).text();
        if (body !== 'standard-cloud-six-vertex') process.exit(6);
    })().catch(() => process.exit(1));`;
    execFileSync(process.execPath, ['--require', preload, '-e', script], { timeout: 5000, stdio: 'pipe' });
    const file = readFileSync('services/dev-standard-qa-worker/Dockerfile', 'utf8');
    expect(file).toContain('["node","--require","./egress.cjs","worker.cjs"]');
});
