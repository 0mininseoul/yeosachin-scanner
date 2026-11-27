import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { qaWorkerConfig, assertQaCloudIdentity } from '../../../services/dev-standard-qa-worker/config';
import { number, origin, project, runQaDelivery, service, taskPath, type QaRole } from '../../../services/dev-standard-qa-worker/scope';
import { bundleQaWorker } from '../../../services/dev-standard-qa-worker/build.mjs';
import { queueName } from '../../../services/dev-standard-qa-worker/queue-name.mjs';
import { qaWorkerDeployment } from '../../../services/dev-standard-qa-worker/deployment-env.mjs';
import { getPreflightTasksConfig } from '@/lib/services/analysis/preflight-tasks';
import { getAnalysisV2TasksConfig } from '@/lib/services/analysis/v2-tasks';

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
import { supabaseAdmin as scopedAdmin } from '../../../services/dev-standard-qa-worker/admin';
import { handleQaWorker } from '../../../services/dev-standard-qa-worker/handler';
import { operationalLogger as qaLogger } from '../../../services/dev-standard-qa-worker/outcome-log';

const wave = 'b'.repeat(64);
it('writes only registered paid-route outcomes to the QA worker log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const fields = { operation: 'worker', disposition: 'capacity_handoff', analysis_request_id: randomUUID(),
            job_key: 'coordinator:bootstrap', error_code: 'UNREGISTERED_FIXTURE', payload: 'fixture' };
        qaLogger.emit({ severity: 'info', event: 'analysis_v2.worker_completed', fields });
        qaLogger.emit({ severity: 'warn', event: 'analysis_v2.worker_retry',
            fields: { ...fields, disposition: 'transient', error_code: 'JOB_DISPATCH_NOT_READY' } });
        qaLogger.emit({ severity: 'info', event: 'result_feedback.persisted', fields });
        expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
            { event: 'analysis_v2.worker_completed', disposition: 'capacity_handoff' },
            { event: 'analysis_v2.worker_retry', disposition: 'transient', error_code: 'JOB_DISPATCH_NOT_READY' },
        ]);
    } finally { log.mockRestore(); }
});
function settings(role: QaRole): NodeJS.ProcessEnv {
    const { environment } = qaWorkerDeployment(role, wave);
    return { ...environment, NODE_ENV: 'production', K_SERVICE: service(role), K_REVISION: service(role) + '-00001-abc' };
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('pins each role to the Dev project, queue, OIDC audience, resource buckets and existing machine identity', async () => {
    for (const role of ['preflight', 'paid'] as const) {
        const env = settings(role);
        expect(qaWorkerConfig(env).role).toBe(role);
        const config = role === 'paid' ? getAnalysisV2TasksConfig(env) : getPreflightTasksConfig(env);
        expect(config?.queue).toBe(queueName(role, wave));
        expect(env).toMatchObject({ PRECHECKOUT_BLITE_ENABLED: 'false', PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '0',
            VERTEX_AI_PER_ORDER_BUDGET_USD: '2', VERTEX_AI_DAILY_BUDGET_USD: '2' });
        expect(env).not.toHaveProperty('PREFLIGHT_PROFILE_PROVIDER');
        expect(Object.keys(qaWorkerDeployment(role, wave).secretRefs)).toHaveLength(role === 'paid' ? 7 : 2);
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
    const req = (data: unknown, queue = queueName(role, wave)) => new Request(origin(role) + taskPath(role), {
        method: 'POST', headers: { host: new URL(origin(role)).host, 'x-cloudtasks-queuename': queue }, body: JSON.stringify(data),
    });
    expect((await handleQaWorker(req(payload, 'other-queue'))).status).toBe(403);
    expect((await handleQaWorker(req(payload, service(role)))).status).toBe(403);
    expect((await handleQaWorker(req(payload, queueName(role, 'a'.repeat(64))))).status).toBe(403);
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

it('sends all model cost transitions only to the private six-seat ledger for the active request', async () => {
    const requestId = randomUUID();
    await runQaDelivery({ role: 'paid', wave, slot: 1, requestId, logicalStage: 'featureAnalysis' }, async () => {
        for (const action of ['reserve', 'settle', 'cancel']) {
            const key = { p_reservation_key: requestId + ':feature:1' };
            const args = action === 'reserve' ? { ...key, p_run_id: requestId } : key;
            await scopedAdmin.rpc(action + '_vertex_ai_budget', args);
            expect(mocks.rpc).toHaveBeenLastCalledWith(action + '_dev_cloud_six_vertex_budget_v1', { ...args, p_wave: wave }, undefined);
            expect(() => scopedAdmin.rpc(action + '_vertex_ai_budget', { ...args, p_reservation_key: randomUUID() + ':feature:1' }))
                .toThrow('SCOPE_REJECTED');
        }
        expect(() => scopedAdmin.rpc('snapshot_vertex_ai_budget')).toThrow('SCOPE_REJECTED');
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
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
