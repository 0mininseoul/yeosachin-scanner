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
        metadata: { generation: Number(generation), resourceVersion: `rv-${generation}` },
        spec: {
            template: { metadata: { name: 'preflight-revision', annotations: { 'autoscaling.knative.dev/maxScale': '2' } },
                spec: { serviceAccountName: 'worker@fixture-project.iam.gserviceaccount.com', containerConcurrency: 1, timeoutSeconds: 600,
                    containers: [{ image: `asia-northeast3-docker.pkg.dev/fixture-project/workers/preflight@sha256:${'a'.repeat(64)}`, env: [{ name: 'ROLE', value: 'preflight' }], resources: { limits: { cpu: '2', memory: '2Gi' } } }], }, },
            traffic: [{ revisionName: 'preflight-revision', percent: 0 }],
        },
        status: { observedGeneration: Number(generation), conditions: [{ type: 'Ready', status: 'True' }], latestCreatedRevisionName: 'preflight-revision', latestReadyRevisionName: 'preflight-revision', traffic: [{ revisionName: 'preflight-revision', percent: 0 }] },
    };
}

describe('protected platform adapters', () => {
    it('rejects an unallowlisted host before token acquisition', async () => {
        let tokens = 0;
        const fake = new FakeTransport(() => { throw new Error('transport must not run'); });
        const client = new AuthenticatedProtectedTransport({ transport: fake, tokenProvider: async () => { tokens += 1; return 'fixture'; } });
        await expect(client.request({
            method: 'GET', url: 'https://evil.example.invalid/', allowedHosts: new Set(['evil.example.invalid']), allowedPath: () => true, allowedMethods: ['GET'], allowedQueryKeys: [],
        })).rejects.toThrow('ADAPTER_NOT_ALLOWED');
        expect(tokens).toBe(0);
        expect(fake.requests).toHaveLength(0);
    });

    it('rejects redirects and malformed JSON with fixed adapter errors', async () => {
        const redirect = new FakeTransport(request => ({ status: 200, headers: {}, body: '{}', url: `${request.url}/redirect` }));
        const client = authenticated(redirect);
        await expect(client.json({ method: 'GET', url: 'https://run.googleapis.com/fixture', allowedHosts: new Set(['run.googleapis.com']), allowedPath: path => path === '/fixture', allowedMethods: ['GET'], allowedQueryKeys: [] })).rejects.toThrow('ADAPTER_REDIRECT');
        const malformed = new FakeTransport(request => ({ status: 200, headers: {}, body: '{', url: request.url }));
        const malformedClient = authenticated(malformed);
        await expect(malformedClient.json({ method: 'GET', url: 'https://run.googleapis.com/fixture', allowedHosts: new Set(['run.googleapis.com']), allowedPath: path => path === '/fixture', allowedMethods: ['GET'], allowedQueryKeys: [] })).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('uses Cloud Run metadata observations before PUT and exact no-traffic read-back', async () => {
        let gets = 0;
        const fake = new FakeTransport(request => {
            if (request.method === 'GET') { gets += 1; return response(request, 200, runService(gets >= 3 ? '3' : '2')); }
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
            'PUT /apis/serving.knative.dev/v1/namespaces/fixture-project/services/preflight-worker',
            'GET /apis/serving.knative.dev/v1/namespaces/fixture-project/services/preflight-worker',
        ]);
        expect(fake.requests[2]?.body).toContain('resourceVersion');
    });

    it('stages a revision from actual v1 runtime fields while preserving old traffic', async () => {
        let gets = 0;
        const runtime = {
            role: 'preflight' as const, service: 'preflight-worker', project, location: 'asia-northeast3',
            identity: { identity: 'worker@fixture-project.iam.gserviceaccount.com', project }, sourceSha: 'a'.repeat(40),
            environment: { ROLE: 'preflight' }, secretReferences: {}, settings: { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: 2 },
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid' }, noTraffic: true, providerAdmissionEnabled: true,
        };
        const revision = {
            metadata: { name: 'preflight-revision', generation: 1, annotations: { 'autoscaling.knative.dev/maxScale': '2' } },
            spec: { serviceAccountName: runtime.identity.identity, containerConcurrency: 1, timeoutSeconds: 600,
                containers: [{ image: `asia-northeast3-docker.pkg.dev/fixture-project/workers/preflight@sha256:${'a'.repeat(64)}`, env: [{ name: 'ROLE', value: 'preflight' }], resources: { limits: { cpu: '2', memory: '2Gi' } } }] },
            status: { observedGeneration: 1, imageDigest: `asia-northeast3-docker.pkg.dev/fixture-project/workers/preflight@sha256:${'a'.repeat(64)}`, conditions: [{ type: 'Ready', status: 'True' }] },
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes('/revisions/')) return response(request, 200, revision);
            if (request.method === 'GET') { gets += 1; return response(request, 200, runService(gets >= 3 ? '3' : '2')); }
            return response(request, 200, runService('3'));
        });
        const after = await new CloudRunAdapter({ transport: authenticated(fake) }).stageRevision({ runtime, revision: 'preflight-revision', expectedGeneration: '2', serviceBody: runService('3') });
        expect(after.noTraffic).toBe(true);
        expect(fake.requests.at(-1)?.url).toContain('/revisions/preflight-revision');
    });

    it('performs IAM etag read/write while preserving unrelated bindings', async () => {
        const current = {
            version: 3,
            etag: 'Bwfixture',
            bindings: [{ role: 'roles/owner', members: ['group:unrelated@example.invalid'], condition: { expression: 'request.time < timestamp(\"2099-01-01T00:00:00Z\")' } }],
        };
        let latest = current;
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, latest);
            latest = { version: 3, etag: 'Bwnext', bindings: JSON.parse(request.body!).policy.bindings };
            return response(request, 200, latest);
        });
        const adapter = new IamAdapter({ transport: authenticated(fake) });
        const input: ProtectedIamInput = {
            kind: 'queue', resource: queueResource, project,
            etag: 'Bwfixture', bindings: [{ role: 'roles/owner', member: 'group:unrelated@example.invalid', condition: { expression: 'request.time < timestamp(\"2099-01-01T00:00:00Z\")' } }], previous: null,
        };
        const result = await adapter.addBindings(input, [{ role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null }]);
        expect(result.bindings).toHaveLength(2);
        expect(result.bindings.some(binding => binding.member === 'group:unrelated@example.invalid')).toBe(true);
        expect(fake.requests.filter(request => request.url.endsWith(':setIamPolicy'))[0]?.body).toContain('Bwfixture');
        expect(fake.requests.filter(request => request.url.includes(':getIamPolicy'))[0]?.body).toContain('requestedPolicyVersion');
        expect(fake.requests.filter(request => request.url.includes(':getIamPolicy'))[0]?.url).not.toContain('?');
    });

    it('uses the Run GET IAM wire contract and accepts unconditioned v1/custom policies', async () => {
        let latest: Record<string, unknown> = {
            version: 1,
            etag: 'Bwrunfixture',
            bindings: [{ role: 'projects/fixture-project/roles/reviewer', members: ['allUsers'] }],
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, latest);
            const body = JSON.parse(request.body!);
            latest = { version: 3, etag: 'Bwrun-next', bindings: body.policy.bindings };
            return response(request, 200, latest);
        });
        const input: ProtectedIamInput = {
            kind: 'run', resource: serviceResource, project,
            etag: 'Bwrunfixture', bindings: [{ role: 'projects/fixture-project/roles/reviewer', member: 'allUsers', condition: null }], previous: null,
        };
        const result = await new IamAdapter({ transport: authenticated(fake) }).addBindings(input, [{
            role: 'organizations/123456789012/roles/conditionalReviewer', member: 'principalSet://iam.googleapis.com/locations/global/workforcePools/pool/attribute.department/engineering',
            condition: { expression: 'request.time < timestamp("2099-01-01T00:00:00Z")', location: 'global' },
        }]);
        expect(result.bindings.some(binding => binding.member === 'allUsers')).toBe(true);
        const get = fake.requests.find(request => request.url.includes(':getIamPolicy'))!;
        expect(get.method).toBe('GET');
        expect(get.body).toBeUndefined();
        expect(get.url).toContain('options.requestedPolicyVersion=3');
    });

    it('lists all Cloud Tasks pages and rejects a repeated token', async () => {
        let calls = 0;
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) {
                calls += 1;
                if (calls === 1) return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/a`, createTime: '2026-09-07T00:00:00.000Z', httpRequest: { body: 'YQ==' } }], nextPageToken: 'next' });
                return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/b`, createTime: '2026-09-07T00:00:01.000Z', httpRequest: { body: 'Yg==' } }] });
            }
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: { oidcToken: { serviceAccountEmail: 'caller@fixture-project.iam.gserviceaccount.com', audience: 'https://worker.example.invalid' } } });
        });
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: 'caller@fixture-project.iam.gserviceaccount.com', project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const client = new WorkPlaneClient({ transport: authenticated(fake) });
        const observed = await client.observeQueue(queue);
        expect(observed.tasks.map(task => task.name)).toEqual([`${queueResource}/tasks/a`, `${queueResource}/tasks/b`]);

        const repeated = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [], nextPageToken: 'same' });
            return response(request, 200, { state: 'PAUSED', rateLimits: {}, httpTarget: { oidcToken: { serviceAccountEmail: 'caller@fixture-project.iam.gserviceaccount.com', audience: 'https://worker.example.invalid' } } });
        });
        await expect(new WorkPlaneClient({ transport: authenticated(repeated) }).observeQueue(queue)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('pauses Scheduler through the real operation endpoint and reads state back', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: 'maintenance@example-project.iam.gserviceaccount.com', project } },
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const schedulerWire = { name: schedulerResource, state: 'PAUSED', lastAttemptTime: null, userUpdateTime: '2026-09-07T00:00:01.000Z', schedule: '* * * * *', httpTarget: { uri: 'https://worker.example.invalid/recover', oidcToken: { serviceAccountEmail: 'maintenance@fixture-project.iam.gserviceaccount.com', audience: 'https://worker.example.invalid' } } };
        const fake = new FakeTransport(request => {
            return response(request, 200, schedulerWire);
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async () => 1, now: () => 2_000 }).pauseScheduler(scheduler);
        expect(observed.state).toBe('PAUSED');
        expect(fake.requests[0]?.url).toContain(':pause');
    });

    it('preserves Cloud Tasks uriOverride, method, headers, and auth while changing only reviewed OIDC', async () => {
        const oldTarget = { url: 'https://worker.example.invalid/old', audience: 'https://worker.example.invalid', callerIdentity: { identity: 'caller-old@fixture-project.iam.gserviceaccount.com', project } };
        const desiredTarget = { url: 'https://worker.example.invalid/new', audience: 'https://worker.example.invalid', callerIdentity: { identity: 'caller-new@fixture-project.iam.gserviceaccount.com', project } };
        const override = { scheme: 'https', host: 'worker.example.invalid', pathOverride: { path: '/override' }, enforceMode: 'IF_NOT_EXISTS' };
        const input: ProtectedQueueInput = { resource: queueResource, project, location: 'asia-northeast3', target: desiredTarget, configuration: { maxConcurrentDispatches: 2, httpTarget: { uriOverride: override } } };
        const wire = (target: typeof oldTarget) => ({ state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: { uriOverride: override, httpMethod: 'POST', headerOverrides: [{ header: 'X-Reviewed', value: 'yes' }], oidcToken: { serviceAccountEmail: target.callerIdentity.identity, audience: target.audience } } });
        let patchSeen = false;
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [] });
            if (request.method === 'PATCH') {
                const body = JSON.parse(request.body!);
                expect(body.httpTarget).toMatchObject({ uriOverride: override, httpMethod: 'POST', headerOverrides: [{ header: 'X-Reviewed', value: 'yes' }] });
                expect(body.httpTarget.oidcToken.serviceAccountEmail).toBe(desiredTarget.callerIdentity.identity);
                patchSeen = true;
                return response(request, 200, wire(desiredTarget));
            }
            return response(request, 200, wire(patchSeen ? desiredTarget : oldTarget));
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake) }).updateQueueTarget({ input, expectedOldTarget: oldTarget, desiredTarget });
        expect(observed.target).toEqual(desiredTarget);
    });

    it('preserves Scheduler HTTP method and headers while aligning OIDC target', async () => {
        const oldTarget = { uri: 'https://worker.example.invalid/old', audience: 'https://worker.example.invalid', identity: { identity: 'maintenance-old@fixture-project.iam.gserviceaccount.com', project } };
        const desiredTarget = { uri: 'https://worker.example.invalid/new', audience: 'https://worker.example.invalid', identity: { identity: 'maintenance-new@fixture-project.iam.gserviceaccount.com', project } };
        const input: ProtectedSchedulerInput = { resource: schedulerResource, project, location: 'asia-northeast3', target: desiredTarget, configuration: { schedule: '* * * * *', method: 'POST' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null };
        const wire = (target: typeof oldTarget) => ({ name: schedulerResource, state: 'PAUSED', lastAttemptTime: null, userUpdateTime: '2026-09-07T00:00:01.000Z', schedule: '* * * * *', httpTarget: { uri: target.uri, httpMethod: 'POST', headers: { 'X-Reviewed': 'yes' }, oidcToken: { serviceAccountEmail: target.identity.identity, audience: target.audience } } });
        let gets = 0;
        const fake = new FakeTransport(request => {
            if (request.method === 'PATCH') {
                const body = JSON.parse(request.body!);
                expect(body.httpTarget).toMatchObject({ httpMethod: 'POST', headers: { 'X-Reviewed': 'yes' } });
                expect(body.httpTarget.oidcToken.serviceAccountEmail).toBe(desiredTarget.identity.identity);
                return response(request, 200, wire(desiredTarget));
            }
            gets += 1;
            return response(request, 200, wire(gets === 1 ? oldTarget : desiredTarget));
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async () => 1, now: () => 2_000 }).updateSchedulerTarget({ input, expectedOldTarget: oldTarget, desiredTarget });
        expect(observed.target).toEqual(desiredTarget);
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
            publicReadinessOrigin: 'https://public.example.invalid',
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

    it('binds Vercel deployment ownership and safely moves an existing alias', async () => {
        const teamId = 'team-fixture';
        const projectId = 'project-fixture';
        const deploymentId = 'dpl-desired';
        const oldDeploymentId = 'dpl-old';
        const sourceSha = 'a'.repeat(40);
        let aliasDeployment = oldDeploymentId;
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname === `/v13/deployments/${deploymentId}`) return response(request, 200, {
                id: deploymentId, readyState: 'READY', project: { id: projectId }, team: { id: teamId },
                gitSource: { type: 'github', repoId: 7, ref: 'main', sha: sourceSha }, target: 'production', alias: [],
            });
            if (url.pathname === `/v4/aliases/desired.example.invalid`) return response(request, 200, { alias: 'desired.example.invalid', projectId, deploymentId: aliasDeployment });
            if (url.pathname === `/v2/deployments/${deploymentId}/aliases` && request.method === 'POST') {
                expect(JSON.parse(request.body!)).toEqual({ alias: 'desired.example.invalid', redirect: null });
                aliasDeployment = deploymentId;
                return response(request, 200, { alias: 'desired.example.invalid', deploymentId, projectId });
            }
            if (url.pathname === `/v2/deployments/${deploymentId}/aliases`) return response(request, 200, { aliases: [{ alias: 'desired.example.invalid' }] });
            throw new Error(`unexpected fixture request ${request.method} ${request.url}`);
        });
        const adapter = new VercelAdapter({ transport: authenticated(fake), publicReadinessOrigin: 'https://public.example.invalid', readinessFetcher: vi.fn() });
        const aliases = await adapter.assignAlias({ projectId, teamId, deploymentId, expectedOldDeploymentId: oldDeploymentId, expectedSourceSha: sourceSha, alias: 'desired.example.invalid' });
        expect(aliases).toEqual(['desired.example.invalid']);
        const deploymentRequest = fake.requests.find(request => request.url.includes('/v13/deployments/'))!;
        expect(deploymentRequest.url).toContain('withGitRepoInfo=true');
        expect(deploymentRequest.url).toContain('slug=project-fixture');
        expect(deploymentRequest.url).not.toContain('projectId=');
    });

    it('rejects an alias owned by an unrelated deployment before POST', async () => {
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname.includes('/v13/deployments/')) return response(request, 200, { id: 'dpl-desired', readyState: 'READY', project: { id: 'project-fixture' }, team: { id: 'team-fixture' }, gitSource: { sha: 'a'.repeat(40) } });
            return response(request, 200, { alias: 'desired.example.invalid', projectId: 'project-fixture', deploymentId: 'dpl-other' });
        });
        const adapter = new VercelAdapter({ transport: authenticated(fake), publicReadinessOrigin: 'https://public.example.invalid', readinessFetcher: vi.fn() });
        await expect(adapter.assignAlias({ projectId: 'project-fixture', teamId: 'team-fixture', deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', expectedSourceSha: 'a'.repeat(40), alias: 'desired.example.invalid' })).rejects.toThrow('OBSERVATION_RACE');
        expect(fake.requests.some(request => request.method === 'POST')).toBe(false);
    });

    it('does not expose protected response values through parse failures', () => {
        expect(() => parseProtectedObject('{"fixtureProtected":"value"}')).not.toThrow();
    });
});
