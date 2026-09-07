import { describe, expect, it, vi } from 'vitest';
import {
    AuthenticatedProtectedTransport,
    parseProtectedObject,
    type ProtectedHttpRequest,
    type ProtectedHttpResponse,
    type ProtectedTransport,
} from './platform';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { VercelAdapter } from './vercel';
import { canonicalDigest, type ProtectedIamInput, type ProtectedQueueInput, type ProtectedSchedulerInput } from './contracts';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';

class FakeTransport implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];
    constructor(private readonly responder: (request: ProtectedHttpRequest) => ProtectedHttpResponse | Promise<ProtectedHttpResponse>) {}

    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        return this.responder(request);
    }
}

function authenticated(fake: ProtectedTransport, token = 'fixture-token'): AuthenticatedProtectedTransport {
    return new AuthenticatedProtectedTransport({ transport: fake, tokenProvider: async () => token, timeoutMs: 2_000 });
}

function response(request: ProtectedHttpRequest, status: number, value: unknown): ProtectedHttpResponse {
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), url: request.url };
}

const project = 'fixture-project';
const serviceResource = `projects/${project}/locations/asia-northeast3/services/preflight-worker`;
const queueResource = `projects/${project}/locations/asia-northeast3/queues/preflight`;
const schedulerResource = `projects/${project}/locations/asia-northeast3/jobs/preflight-recovery`;

function runService(generation = '2') {
    return {
        metadata: { generation, resourceVersion: generation },
        spec: {
            template: {
                metadata: { name: 'preflight-revision', annotations: { 'capacity.runtimeDigest': 'a'.repeat(64), 'capacity.buildDigest': 'b'.repeat(64) }, labels: { 'capacity.sourceSha': 'c'.repeat(40) } },
                spec: {},
            },
            traffic: [{ revisionName: 'preflight-revision', percent: 0 }],
        },
        status: { latestCreatedRevisionName: 'preflight-revision', latestReadyRevisionName: 'preflight-revision', traffic: [{ revisionName: 'preflight-revision', percent: 0 }] },
    };
}

describe('protected platform adapters', () => {
    it('rejects an unallowlisted host before token acquisition', async () => {
        let tokens = 0;
        const fake = new FakeTransport(() => { throw new Error('transport must not run'); });
        const client = new AuthenticatedProtectedTransport({ transport: fake, tokenProvider: async () => { tokens += 1; return 'fixture'; } });
        await expect(client.request({
            method: 'GET', url: 'https://evil.example.invalid/', allowedHosts: new Set(['evil.example.invalid']), allowedPath: () => true,
        })).rejects.toThrow('ADAPTER_NOT_ALLOWED');
        expect(tokens).toBe(0);
        expect(fake.requests).toHaveLength(0);
    });

    it('rejects redirects and malformed JSON with fixed adapter errors', async () => {
        const redirect = new FakeTransport(request => ({ status: 200, headers: {}, body: '{}', url: `${request.url}/redirect` }));
        const client = authenticated(redirect);
        await expect(client.json({ method: 'GET', url: 'https://run.googleapis.com/fixture', allowedHosts: new Set(['run.googleapis.com']), allowedPath: path => path === '/fixture' })).rejects.toThrow('ADAPTER_REDIRECT');
        const malformed = new FakeTransport(request => ({ status: 200, headers: {}, body: '{', url: request.url }));
        const malformedClient = authenticated(malformed);
        await expect(malformedClient.json({ method: 'GET', url: 'https://run.googleapis.com/fixture', allowedHosts: new Set(['run.googleapis.com']), allowedPath: path => path === '/fixture' })).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('uses Cloud Run metadata observations before PATCH and exact no-traffic read-back', async () => {
        const fake = new FakeTransport(request => {
            if (request.method === 'GET') return response(request, 200, runService('2'));
            return response(request, 200, runService('3'));
        });
        const adapter = new CloudRunAdapter({ transport: authenticated(fake) });
        const before = await adapter.getService(serviceResource);
        expect(before.generation).toBe('2');
        const after = await adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), updateMask: 'template' });
        expect(after.noTraffic).toBe(true);
        expect(fake.requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
            'GET /apis/serving.knative.dev/v1/namespaces/fixture-project/services/preflight-worker',
            'GET /apis/serving.knative.dev/v1/namespaces/fixture-project/services/preflight-worker',
            'PATCH /apis/serving.knative.dev/v1/namespaces/fixture-project/services/preflight-worker',
        ]);
        expect(fake.requests[2]?.url).toContain('updateMask=template');
    });

    it('performs IAM etag read/write while preserving unrelated bindings', async () => {
        const current = {
            etag: 'Bwfixture',
            bindings: [{ role: 'roles/owner', member: 'group:unrelated@example.invalid', condition: null }],
        };
        const fake = new FakeTransport(request => {
            if (request.url.endsWith(':getIamPolicy')) return response(request, 200, current);
            return response(request, 200, { etag: 'Bwnext', bindings: JSON.parse(request.body!).policy.bindings });
        });
        const adapter = new IamAdapter({ transport: authenticated(fake) });
        const input: ProtectedIamInput = {
            kind: 'queue', resource: queueResource, project,
            etag: 'Bwfixture', bindings: current.bindings, previous: null,
        };
        const result = await adapter.addBindings(input, [{ role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null }]);
        expect(result.bindings).toHaveLength(2);
        expect(result.bindings.some(binding => binding.member === 'group:unrelated@example.invalid')).toBe(true);
        expect(fake.requests.filter(request => request.url.endsWith(':setIamPolicy'))[0]?.body).toContain('Bwfixture');
    });

    it('lists all Cloud Tasks pages and rejects a repeated token', async () => {
        let calls = 0;
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) {
                calls += 1;
                if (calls === 1) return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/a`, createTime: '2026-09-07T00:00:00.000Z', httpRequest: { body: 'YQ==' } }], nextPageToken: 'next' });
                return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/b`, createTime: '2026-09-07T00:00:01.000Z', httpRequest: { body: 'Yg==' } }] });
            }
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 } });
        });
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: 'caller@example-project.iam.gserviceaccount.com', project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const client = new WorkPlaneClient({ transport: authenticated(fake) });
        const observed = await client.observeQueue(queue);
        expect(observed.tasks.map(task => task.name)).toEqual([`${queueResource}/tasks/a`, `${queueResource}/tasks/b`]);

        const repeated = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [], nextPageToken: 'same' });
            return response(request, 200, { state: 'PAUSED', rateLimits: {} });
        });
        await expect(new WorkPlaneClient({ transport: authenticated(repeated) }).observeQueue(queue)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('pauses Scheduler through the real operation endpoint and reads state back', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: 'maintenance@example-project.iam.gserviceaccount.com', project } },
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const fake = new FakeTransport(request => {
            if (request.method === 'POST') return response(request, 200, { name: schedulerResource, state: 'PAUSED', updateTime: '2026-09-07T00:00:01.000Z', status: {}, schedule: '* * * * *' });
            return response(request, 200, { name: schedulerResource, state: 'PAUSED', updateTime: '2026-09-07T00:00:01.000Z', status: {}, schedule: '* * * * *' });
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake) }).pauseScheduler(scheduler);
        expect(observed.state).toBe('PAUSED');
        expect(fake.requests[0]?.url).toContain(':pause');
    });

    it('parses strict raw readiness before asserting expected closed gates', async () => {
        const sourceSha = 'a'.repeat(40);
        const preflightFingerprint = 'b'.repeat(64);
        const paidFingerprint = 'c'.repeat(64);
        const readiness = {
            schemaVersion: 'analysis-public-freeze-readiness-v3', ready: true, stage: 'initial', freezeMode: 'drain-and-block', publicFreezeEnabled: true,
            sourceSha, legacyTargetResource: 'fixture-target',
            preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
            preflightProducerConfigFingerprint: preflightFingerprint, preflightProducerConfigReady: true,
            paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
            paidProducerConfigFingerprint: paidFingerprint, paidProducerConfigReady: true,
            routes: {
                '/api/analysis/start': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
                '/api/analysis/step': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
                '/api/analysis/run': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
            },
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
        };
        const fake = new FakeTransport(request => response(request, 200, {}));
        const adapter = new VercelAdapter({
            transport: authenticated(fake),
            readinessFetcher: vi.fn(async () => ({ status: 200, headers: {}, body: JSON.stringify(readiness), url: 'https://public.example.invalid/api/analysis/capacity/readiness' })),
        });
        const result = await adapter.readPublicReadiness({
            url: 'https://public.example.invalid/api/analysis/capacity/readiness',
            expected: {
                sourceSha, legacyTargetResource: 'fixture-target',
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: paidFingerprint,
                analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
            },
        });
        expect(result.ready).toBe(true);
    });

    it('does not expose protected response values through parse failures', () => {
        expect(() => parseProtectedObject('{"fixtureProtected":"value"}')).not.toThrow();
    });
});
