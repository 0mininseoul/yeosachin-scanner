import { describe, expect, it, vi } from 'vitest';
import {
    AuthenticatedProtectedTransport,
    AuthenticatedReceiverProbe,
    issueReceiverProbeAuthority,
    parseProtectedObject,
    type ProtectedHttpRequest,
    type ProtectedHttpResponse,
    type ProtectedTransport,
} from './platform';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { VercelAdapter } from './vercel';
import { issueLeaseCheck } from './lease-capability';
import { createFixturePacket } from './fixtures';
import { EpochJournal, type JournalStorage } from './journal';
import { issueCoordinatorCapability } from './packet';
import { canonicalDigest, canonicalRuntimeInputDigest, EpochError, type EpochTransition, type ProtectedIamInput, type ProtectedQueueInput, type ProtectedSchedulerInput } from './contracts';
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

async function durableProbeAuthority(ownerDigest = 'b'.repeat(64), options: Readonly<{ now?: { value: number }; leaseMs?: number }> = {}, operation = 'probe.malformed', resource = serviceResource) {
    const packet = createFixturePacket();
    const header = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-08T00:00:00.000Z',
    } as const;
    const storage = new MemoryStorage();
    const now = options.now ?? { value: 100_000 };
    const journal = new EpochJournal(storage, { header, now: () => now.value, leaseMs: options.leaseMs ?? 10_000 });
    await journal.ensureHeader();
    const lease = await journal.acquire(ownerDigest);
    const capability = issueCoordinatorCapability(packet, ownerDigest);
    const check = issueLeaseCheck({ packet, capability, ownerDigest, lease, operation, resource, journal });
    return { packet, storage, journal, lease, check, now };
}

function durableAbortedTransition(journal: EpochJournal, lockFence: string): EpochTransition {
    const value = canonicalDigest('aborted-probe-transition');
    return {
        sequence: 1, epochIdDigest: journal.epochIdDigest, fromState: null, toState: null,
        stateVersion: 1, lockFence, preconditionDigest: value, mutationDigest: value,
        postconditionDigest: value, proofDigest: value, nativeConcurrencyTokenDigest: value,
        resourceObservationDigest: value, resultCode: 'ABORTED', recordedAt: '2026-09-08T00:00:01.000Z',
    };
}

class MemoryStorage implements JournalStorage {
    private readonly values = new Map<string, { generation: string; value: unknown }>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        const current = this.values.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        const stored = { generation: '1', value };
        this.values.set(key, stored);
        return stored;
    }
    async list(prefix: string) { return [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, ...value })); }
    seed(key: string, value: unknown): void { this.values.set(key, { generation: '1', value }); }
}

const project = 'example-project';
const serviceResource = `projects/${project}/locations/asia-northeast3/services/preflight-worker`;
const queueResource = `projects/${project}/locations/asia-northeast3/queues/preflight`;
const schedulerResource = `projects/${project}/locations/asia-northeast3/jobs/preflight-recovery`;

function authority(operation: string | readonly string[], resource: string | readonly string[], ownerDigest = 'b'.repeat(64)) {
    const packet = createFixturePacket();
    const header = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-08T00:00:00.000Z',
    } as const;
    const storage = new MemoryStorage();
    const journal = new EpochJournal(storage, { header, now: () => 100_000 });
    const lease = {
        generation: '1',
        lock: { epochHeaderDigest: journal.epochHeaderDigest, ownerDigest, lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' },
    };
    storage.seed(journal.headerKey, header);
    storage.seed(journal.lockKey, lease.lock);
    const check = issueLeaseCheck({ packet, capability: issueCoordinatorCapability(packet, ownerDigest), ownerDigest, lease, operation, resource, journal });
    return { packet, journal, lease, check };
}

const adapterAuthority = authority([
    'cloud-run.stage', 'cloud-run.promote', 'iam.set', 'iam.add', 'iam.remove',
    'queue.pause', 'queue.resume', 'queue.target', 'scheduler.pause', 'scheduler.resume', 'scheduler.target', 'alias.assign', 'probe.malformed',
], [
    'desired.example.invalid', serviceResource, queueResource, schedulerResource,
    ...(['paid-worker', 'preflight-worker'] as const).flatMap(service => [`projects/${project}/locations/asia-northeast3/services/${service}`]),
    ...(['paid', 'preflight'] as const).flatMap(role => [`projects/${project}/locations/asia-northeast3/queues/${role}`, `projects/${project}/locations/asia-northeast3/jobs/${role}-recovery`]),
    ...(['preflight', 'paid'] as const).flatMap(role => [
        `projects/${project}/locations/asia-northeast3/services/${role}-worker`,
        `projects/${project}/locations/asia-northeast3/queues/${role}`,
        `projects/${project}/locations/asia-northeast3/jobs/${role}-recovery`,
        `projects/${project}/locations/asia-northeast3/services/${role}-worker`,
        `projects/${project}/serviceAccounts/${role}-task-caller-old@${project}.iam.gserviceaccount.com`,
        `projects/${project}/serviceAccounts/${role}-task-caller-desired@${project}.iam.gserviceaccount.com`,
    ]),
], 'b'.repeat(64));
const noLease = adapterAuthority.check;

function runService(generation = '2', traffic = [{ revisionName: 'preflight-revision', percent: 0 }]) {
    return {
        metadata: { generation: Number(generation), resourceVersion: `rv-${generation}` },
        spec: {
            template: { metadata: { name: 'preflight-revision', annotations: { 'autoscaling.knative.dev/maxScale': '2' } },
                spec: { serviceAccountName: `worker@${project}.iam.gserviceaccount.com`, containerConcurrency: 1, timeoutSeconds: 600,
                    containers: [{ image: `asia-northeast3-docker.pkg.dev/${project}/workers/preflight@sha256:${'a'.repeat(64)}`, env: [{ name: 'ROLE', value: 'preflight' }], resources: { limits: { cpu: '2', memory: '2Gi' } } }], }, },
            traffic,
        },
        status: { url: 'https://worker.example.invalid/', observedGeneration: Number(generation), conditions: [{ type: 'Ready', status: 'True' }], latestCreatedRevisionName: 'preflight-revision', latestReadyRevisionName: 'preflight-revision', traffic },
    };
}

describe('protected platform adapters', () => {
    const pauseEvidence = (resource: string) => ({ resource, operation: 'PAUSE', observedAtMs: 1 });
    const pauseProvenance = (resource: string) => ({ resource, pauseEpochMs: 1, observedAtMs: 1, source: 'fixture-pause-log', evidence: pauseEvidence(resource), evidenceDigest: canonicalDigest(pauseEvidence(resource)), complete: true as const });

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
        const after = await adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), operation: 'cloud-run.stage', updateMask: 'template', leaseCheck: noLease });
        expect(after.noTraffic).toBe(true);
        expect(fake.requests.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
            `GET /apis/serving.knative.dev/v1/namespaces/${project}/services/preflight-worker`,
            `GET /apis/serving.knative.dev/v1/namespaces/${project}/services/preflight-worker`,
            `PUT /apis/serving.knative.dev/v1/namespaces/${project}/services/preflight-worker`,
            `GET /apis/serving.knative.dev/v1/namespaces/${project}/services/preflight-worker`,
        ]);
        expect(fake.requests[2]?.body).toContain('resourceVersion');
    });

    it('accepts an idempotent Cloud Run PUT only after exact spec read-back', async () => {
        const service = runService('2');
        const fake = new FakeTransport(request => {
            if (request.method === 'PUT') return response(request, 200, service);
            return response(request, 200, service);
        });
        const observed = await new CloudRunAdapter({ transport: authenticated(fake) }).applyService({
            resource: serviceResource, expectedGeneration: '2', body: service, operation: 'cloud-run.stage', leaseCheck: noLease,
        });
        expect(observed.generation).toBe('2');
        expect(observed.resourceVersion).toBe('rv-2');
    });

    it('rejects absent and forged Cloud Run lease authorities before provider access', async () => {
        const fake = new FakeTransport(() => { throw new Error('provider must not run'); });
        const adapter = new CloudRunAdapter({ transport: authenticated(fake) });
        await expect(adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), operation: 'cloud-run.stage' })).rejects.toThrow('LOCK_LOST');
        const forged = async (): Promise<void> => undefined;
        await expect(adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), operation: 'cloud-run.stage', leaseCheck: forged })).rejects.toThrow('LOCK_LOST');
        expect(fake.requests).toHaveLength(0);
    });

    it('binds a lost lease to the initiating Cloud Run operation, not a later owner', async () => {
        let mutated = false;
        const fake = new FakeTransport(request => {
            if (request.method === 'PUT') {
                mutated = true;
                return response(request, 200, runService('3'));
            }
            return response(request, 200, runService(mutated ? '3' : '2'));
        });
        const adapter = new CloudRunAdapter({ transport: authenticated(fake) });
        let releaseOld!: () => void;
        const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
        const oldAuthority = authority('cloud-run.stage', serviceResource, 'b'.repeat(64));
        let oldChecks = 0;
        oldAuthority.journal.readValidatedState = (async () => {
            oldChecks += 1;
            if (oldChecks === 1) await oldGate;
            throw new EpochError('LOCK_LOST');
        }) as typeof oldAuthority.journal.readValidatedState;
        let newChecks = 0;
        const newAuthority = authority('cloud-run.stage', serviceResource, 'c'.repeat(64));
        const newReadState = newAuthority.journal.readValidatedState.bind(newAuthority.journal);
        newAuthority.journal.readValidatedState = (async (lease) => { newChecks += 1; return newReadState(lease); }) as typeof newAuthority.journal.readValidatedState;
        const oldOperation = adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), operation: 'cloud-run.stage', leaseCheck: oldAuthority.check });
        const newOperation = adapter.applyService({ resource: serviceResource, expectedGeneration: '2', body: runService('3'), operation: 'cloud-run.stage', leaseCheck: newAuthority.check });
        await expect(newOperation).resolves.toMatchObject({ generation: '3' });
        releaseOld();
        await expect(oldOperation).rejects.toThrow('LOCK_LOST');
        expect(newChecks).toBeGreaterThan(0);
        expect(oldChecks).toBe(1);
    });

    it('requires independent Cloud Run status traffic evidence', async () => {
        const service = runService();
        delete (service.status as Record<string, unknown>).traffic;
        const fake = new FakeTransport(request => response(request, 200, service));
        await expect(new CloudRunAdapter({ transport: authenticated(fake) }).getService(serviceResource)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('keeps secret references separate from nonsecret environment in a full v1 runtime', async () => {
        const service = runService();
        const container = service.spec.template.spec.containers[0] as Record<string, unknown>;
        container.env = [
            { name: 'ROLE', value: 'preflight' },
            ...Array.from({ length: 13 }, (_, index) => ({
                name: `SECRET_${index}`,
                valueFrom: { secretKeyRef: { name: 'fixture-secret', key: String(index + 1) } },
            })),
        ];
        const fake = new FakeTransport(request => response(request, 200, service));
        const observed = await new CloudRunAdapter({ transport: authenticated(fake) }).getService(serviceResource);
        expect(observed.environment).toEqual({ ROLE: 'preflight' });
        expect(Object.keys(observed.secretReferences)).toHaveLength(13);
        expect(observed.secretReferences.SECRET_0).toBe('fixture-secret:1');
        expect(Object.keys(observed.environment).some(name => name.startsWith('SECRET_'))).toBe(false);
    });

    it('rejects duplicate names spanning plain and secret environment maps', async () => {
        const service = runService();
        (service.spec.template.spec.containers[0] as Record<string, unknown>).env = [
            { name: 'ROLE', value: 'preflight' },
            { name: 'ROLE', valueFrom: { secretKeyRef: { name: 'fixture-secret', key: '1' } } },
        ];
        const fake = new FakeTransport(request => response(request, 200, service));
        await expect(new CloudRunAdapter({ transport: authenticated(fake) }).getService(serviceResource)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('stages a revision from actual v1 runtime fields while preserving old traffic', async () => {
        let gets = 0;
        const runtime = {
            role: 'preflight' as const, service: 'preflight-worker', project, location: 'asia-northeast3',
            identity: { identity: `worker@${project}.iam.gserviceaccount.com`, project }, sourceSha: 'a'.repeat(40),
            environment: { ROLE: 'preflight' }, secretReferences: {}, settings: { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: 2 },
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid' }, noTraffic: true, providerAdmissionEnabled: true,
        };
        const revision = {
            metadata: { name: 'preflight-revision', generation: 1, resourceVersion: 'revision-rv-1', annotations: { 'autoscaling.knative.dev/maxScale': '2' } },
            spec: { serviceAccountName: runtime.identity.identity, containerConcurrency: 1, timeoutSeconds: 600,
                containers: [{ image: `asia-northeast3-docker.pkg.dev/${project}/workers/preflight@sha256:${'a'.repeat(64)}`, env: [{ name: 'ROLE', value: 'preflight' }], resources: { limits: { cpu: '2', memory: '2Gi' } } }] },
            status: { observedGeneration: 1, imageDigest: `asia-northeast3-docker.pkg.dev/${project}/workers/preflight@sha256:${'a'.repeat(64)}`, conditions: [{ type: 'Ready', status: 'True' }] },
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes('/revisions/')) return response(request, 200, revision);
            if (request.method === 'GET') { gets += 1; return response(request, 200, runService(gets >= 3 ? '3' : '2')); }
            return response(request, 200, runService('3'));
        });
        const after = await new CloudRunAdapter({ transport: authenticated(fake) }).stageRevision({ runtime, revision: 'preflight-revision', expectedGeneration: '2', serviceBody: runService('3'), leaseCheck: noLease });
        expect(after.noTraffic).toBe(true);
        expect(fake.requests.at(-1)?.url).toContain('/revisions/preflight-revision');
        const revisionObserved = await new CloudRunAdapter({ transport: authenticated(new FakeTransport(request => response(request, 200, revision))) }).observeRevision(project, 'asia-northeast3', 'preflight-revision');
        expect(revisionObserved.runtimeDigest).toBe(canonicalRuntimeInputDigest(runtime));
        expect(revisionObserved.buildDigest).toBe(canonicalDigest({ image: revision.spec.containers[0].image }));
    });

    it('keeps one immutable runtime digest across OLD100, staged DESIRED0, and DESIRED100', async () => {
        const oldTraffic = [{ revisionName: 'old-revision', percent: 100 }];
        const stagedTraffic = [...oldTraffic, { revisionName: 'preflight-revision', percent: 0 }];
        const promotedTraffic = [{ revisionName: 'preflight-revision', percent: 100 }];
        let phase: 'old' | 'staged' | 'promoted' = 'old';
        const runtime = {
            role: 'preflight' as const, service: 'preflight-worker', project, location: 'asia-northeast3',
            identity: { identity: `worker@${project}.iam.gserviceaccount.com`, project }, sourceSha: 'a'.repeat(40),
            environment: { ROLE: 'preflight' }, secretReferences: {}, settings: { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: 2 },
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid' }, noTraffic: true, providerAdmissionEnabled: true,
        };
        const revision = {
            metadata: { name: 'preflight-revision', generation: 1, resourceVersion: 'revision-rv-1', annotations: { 'autoscaling.knative.dev/maxScale': '2' } },
            spec: { serviceAccountName: runtime.identity.identity, containerConcurrency: 1, timeoutSeconds: 600,
                containers: [{ image: `asia-northeast3-docker.pkg.dev/${project}/workers/preflight@sha256:${'a'.repeat(64)}`, env: [{ name: 'ROLE', value: 'preflight' }], resources: { limits: { cpu: '2', memory: '2Gi' } } }] },
            status: { observedGeneration: 1, imageDigest: `asia-northeast3-docker.pkg.dev/${project}/workers/preflight@sha256:${'a'.repeat(64)}`, conditions: [{ type: 'Ready', status: 'True' }] },
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes('/revisions/')) return response(request, 200, revision);
            if (request.method === 'PUT') {
                const body = JSON.parse(request.body!) as { spec: { traffic: Array<{ revisionName: string; percent: number }> } };
                const traffic = body.spec.traffic;
                phase = traffic.some(entry => entry.revisionName === 'preflight-revision' && entry.percent === 100) ? 'promoted' : 'staged';
                return response(request, 200, runService(phase === 'promoted' ? '4' : '3', phase === 'promoted' ? promotedTraffic : stagedTraffic));
            }
            if (phase === 'old') return response(request, 200, runService('2', oldTraffic));
            if (phase === 'staged') return response(request, 200, runService('3', stagedTraffic));
            return response(request, 200, runService('4', promotedTraffic));
        });
        const adapter = new CloudRunAdapter({ transport: authenticated(fake) });
        const staged = await adapter.stageRevision({ runtime, revision: 'preflight-revision', expectedGeneration: '2', serviceBody: runService('3', stagedTraffic), leaseCheck: noLease });
        expect(staged.traffic).toEqual([
            { revisionName: 'old-revision', percent: 100, tag: null },
            { revisionName: 'preflight-revision', percent: 0, tag: null },
        ]);
        const promoted = await adapter.setTraffic({ resource: serviceResource, expectedGeneration: '3', expectedRevision: 'preflight-revision', expectedPercent: 100, traffic: promotedTraffic, leaseCheck: noLease });
        expect(promoted.traffic).toEqual([{ revisionName: 'preflight-revision', percent: 100, tag: null }]);
        expect(staged.runtimeDigest).toBe(promoted.runtimeDigest);
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
        const result = await adapter.addBindings(input, [{ role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null }], noLease);
        expect(result.bindings).toHaveLength(2);
        expect(result.bindings.some(binding => binding.member === 'group:unrelated@example.invalid')).toBe(true);
        expect(fake.requests.filter(request => request.url.endsWith(':setIamPolicy'))[0]?.body).toContain('Bwfixture');
        expect(fake.requests.filter(request => request.url.includes(':getIamPolicy'))[0]?.body).toContain('requestedPolicyVersion');
        expect(fake.requests.filter(request => request.url.includes(':getIamPolicy'))[0]?.url).not.toContain('?');
    });

    it('fences a real IAM mutation after deferred token minting when the journal is ABORTED', async () => {
        const input: ProtectedIamInput = {
            kind: 'queue', resource: queueResource, project,
            etag: 'Bwfixture', bindings: [], previous: null,
        };
        const current = { version: 3, etag: 'Bwfixture', bindings: [] };
        let posts = 0;
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, current);
            posts += 1;
            return response(request, 200, current);
        });
        const durable = await durableProbeAuthority('b'.repeat(64), {}, 'iam.add', queueResource);
        let tokenCalls = 0;
        let tokenStarted!: () => void;
        const tokenStartedPromise = new Promise<void>(resolve => { tokenStarted = resolve; });
        let releaseToken!: () => void;
        const deferredToken = new Promise<string>(resolve => { releaseToken = () => resolve('fixture-token'); });
        const transport = new AuthenticatedProtectedTransport({
            transport: fake,
            tokenProvider: async () => {
                tokenCalls += 1;
                if (tokenCalls === 3) {
                    tokenStarted();
                    return deferredToken;
                }
                return 'fixture-token';
            },
            timeoutMs: 2_000,
        });
        const operation = new IamAdapter({ transport }).addBindings(input, [{
            role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null,
        }], durable.check);
        await tokenStartedPromise;
        await durable.journal.append(durable.lease, durableAbortedTransition(durable.journal, durable.lease.lock.lockFence));
        releaseToken();
        await expect(operation).rejects.toThrow('ABORTED_EPOCH');
        expect(tokenCalls).toBe(3);
        expect(posts).toBe(0);
    });

    it('fences a real IAM mutation after deferred token minting when the lease is taken over', async () => {
        const input: ProtectedIamInput = {
            kind: 'queue', resource: queueResource, project,
            etag: 'Bwfixture', bindings: [], previous: null,
        };
        const current = { version: 3, etag: 'Bwfixture', bindings: [] };
        let posts = 0;
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, current);
            posts += 1;
            return response(request, 200, current);
        });
        const now = { value: 100_000 };
        const durable = await durableProbeAuthority('b'.repeat(64), { now, leaseMs: 100 }, 'iam.add', queueResource);
        let tokenCalls = 0;
        let tokenStarted!: () => void;
        const tokenStartedPromise = new Promise<void>(resolve => { tokenStarted = resolve; });
        let releaseToken!: () => void;
        const deferredToken = new Promise<string>(resolve => { releaseToken = () => resolve('fixture-token'); });
        const transport = new AuthenticatedProtectedTransport({
            transport: fake,
            tokenProvider: async () => {
                tokenCalls += 1;
                if (tokenCalls === 3) {
                    tokenStarted();
                    return deferredToken;
                }
                return 'fixture-token';
            },
            timeoutMs: 2_000,
        });
        const operation = new IamAdapter({ transport }).addBindings(input, [{
            role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null,
        }], durable.check);
        await tokenStartedPromise;
        now.value = 100_101;
        await durable.journal.acquire('c'.repeat(64));
        releaseToken();
        await expect(operation).rejects.toThrow('LOCK_LOST');
        expect(tokenCalls).toBe(3);
        expect(posts).toBe(0);
    });

    it('does not let an iam.add capability relabel public full-policy replacement', async () => {
        const input: ProtectedIamInput = {
            kind: 'queue', resource: queueResource, project,
            etag: 'Bwfixture', bindings: [{ role: 'roles/cloudtasks.enqueuer', member: 'serviceAccount:worker@example-project.iam.gserviceaccount.com', condition: null }], previous: null,
        };
        const fake = new FakeTransport(() => { throw new Error('provider must not run'); });
        const adapter = new IamAdapter({ transport: authenticated(fake) });
        const addAuthority = authority('iam.add', queueResource, 'b'.repeat(64));
        await expect(adapter.setPolicy(input, { resource: input.resource, project, etag: input.etag, bindings: [] }, addAuthority.check)).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        expect(fake.requests).toHaveLength(0);
    });

    it('keeps receiver probe credentials bound to the reviewed target and audience', async () => {
        let tokens = 0;
        const fake = new FakeTransport(request => response(request, 400, { code: 'INVALID_REQUEST' }));
        const packet = adapterAuthority.packet;
        const target = packet.protectedInputs.desired.runtime.paid.target;
        const callerIdentity = packet.protectedInputs.desired.queues.paid.target.callerIdentity.identity;
        const authority = issueReceiverProbeAuthority({ packet, role: 'paid', ownerDigest: 'b'.repeat(64), lease: adapterAuthority.lease, leaseCheck: adapterAuthority.check });
        const probe = new AuthenticatedReceiverProbe({ transport: fake, authority, tokenProvider: async binding => { tokens += 1; expect(binding).toEqual({ audience: target.audience, callerIdentity }); return 'fixture-id-token'; } });
        await expect(probe.malformedBody()).resolves.toEqual({ status: 400, code: 'INVALID_REQUEST' });
        expect(tokens).toBe(1);
        expect(fake.requests[0]?.body).toBe('{');
        expect(() => new AuthenticatedReceiverProbe({ transport: fake, authority: Object.freeze({}), tokenProvider: async () => 'fixture-id-token' })).toThrow('CAPABILITY_INVALID');
    });

    it('rechecks a real durable ABORTED journal after deferred token minting and never POSTs', async () => {
        let posts = 0;
        const fake = new FakeTransport(request => {
            if (request.method === 'POST') posts += 1;
            return response(request, 400, { code: 'INVALID_REQUEST' });
        });
        const durable = await durableProbeAuthority();
        const authority = issueReceiverProbeAuthority({ packet: durable.packet, role: 'preflight', ownerDigest: 'b'.repeat(64), lease: durable.lease, leaseCheck: durable.check });
        let tokenStarted!: () => void;
        const tokenStartedPromise = new Promise<void>(resolve => { tokenStarted = resolve; });
        let releaseToken!: () => void;
        const token = new Promise<string>(resolve => { releaseToken = () => resolve('fixture-id-token'); });
        const probe = new AuthenticatedReceiverProbe({
            transport: fake,
            authority,
            tokenProvider: async () => { tokenStarted(); return token; },
        });
        const operation = probe.malformedBody();
        await tokenStartedPromise;
        await durable.journal.append(durable.lease, durableAbortedTransition(durable.journal, durable.lease.lock.lockFence));
        releaseToken();
        await expect(operation).rejects.toThrow('ABORTED_EPOCH');
        expect(posts).toBe(0);
    });

    it('rechecks a real new-owner takeover after deferred token minting and never POSTs the stale owner', async () => {
        let posts = 0;
        const fake = new FakeTransport(request => {
            if (request.method === 'POST') posts += 1;
            return response(request, 400, { code: 'INVALID_REQUEST' });
        });
        const now = { value: 100_000 };
        const durable = await durableProbeAuthority('b'.repeat(64), { now, leaseMs: 100 });
        const authority = issueReceiverProbeAuthority({ packet: durable.packet, role: 'preflight', ownerDigest: 'b'.repeat(64), lease: durable.lease, leaseCheck: durable.check });
        let tokenStarted!: () => void;
        const tokenStartedPromise = new Promise<void>(resolve => { tokenStarted = resolve; });
        let releaseToken!: () => void;
        const token = new Promise<string>(resolve => { releaseToken = () => resolve('fixture-id-token'); });
        const probe = new AuthenticatedReceiverProbe({
            transport: fake,
            authority,
            tokenProvider: async () => { tokenStarted(); return token; },
        });
        const operation = probe.malformedBody();
        await tokenStartedPromise;
        now.value = 100_101;
        await durable.journal.acquire('c'.repeat(64));
        releaseToken();
        await expect(operation).rejects.toThrow('LOCK_LOST');
        expect(posts).toBe(0);
    });

    it('uses the Run GET IAM wire contract and accepts unconditioned v1/custom policies', async () => {
        let latest: Record<string, unknown> = {
            version: 1,
            etag: 'Bwrunfixture',
            bindings: [{ role: `projects/${project}/roles/reviewer`, members: ['allUsers'] }],
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, latest);
            const body = JSON.parse(request.body!);
            latest = { version: 3, etag: 'Bwrun-next', bindings: body.policy.bindings };
            return response(request, 200, latest);
        });
        const input: ProtectedIamInput = {
            kind: 'run', resource: serviceResource, project,
            etag: 'Bwrunfixture', bindings: [{ role: `projects/${project}/roles/reviewer`, member: 'allUsers', condition: null }], previous: null,
        };
        const result = await new IamAdapter({ transport: authenticated(fake) }).addBindings(input, [{
            role: 'organizations/123456789012/roles/conditionalReviewer', member: 'principalSet://iam.googleapis.com/locations/global/workforcePools/pool/attribute.department/engineering',
            condition: { expression: 'request.time < timestamp("2099-01-01T00:00:00Z")', location: 'global' },
        }], noLease);
        expect(result.bindings.some(binding => binding.member === 'allUsers')).toBe(true);
        const get = fake.requests.find(request => request.url.includes(':getIamPolicy'))!;
        expect(get.method).toBe('GET');
        expect(get.body).toBeUndefined();
        expect(new URL(get.url).hostname).toBe('asia-northeast3-run.googleapis.com');
        expect(new URL(get.url).pathname).toBe(`/v2/${serviceResource}:getIamPolicy`);
        expect(get.url).toContain('options.requestedPolicyVersion=3');
    });

    it('accepts an empty IAM policy with omitted bindings and preserves audit config', async () => {
        const auditConfigs = [{ service: 'fixture.googleapis.com', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }];
        let latest: Record<string, unknown> = { version: 1, etag: 'Bwempty', auditConfigs };
        const fake = new FakeTransport(request => {
            if (request.url.includes(':getIamPolicy')) return response(request, 200, latest);
            const body = JSON.parse(request.body!);
            latest = { version: 3, etag: 'Bwempty-next', bindings: body.policy.bindings, auditConfigs: body.policy.auditConfigs };
            return response(request, 200, latest);
        });
        const input: ProtectedIamInput = {
            kind: 'run', resource: serviceResource, project,
            etag: 'Bwempty', bindings: [], previous: null,
        };
        const result = await new IamAdapter({ transport: authenticated(fake) }).addBindings(input, [], noLease);
        expect(result.bindings).toEqual([]);
        const set = fake.requests.find(request => request.url.includes(':setIamPolicy'))!;
        expect(JSON.parse(set.body!).policy.auditConfigs).toEqual(auditConfigs);
    });

    it('lists all Cloud Tasks pages and rejects a repeated token', async () => {
        let calls = 0;
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) {
                calls += 1;
                if (calls === 1) return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/a`, createTime: '2026-09-07T00:00:00.000Z', httpRequest: { body: 'YQ==' } }], nextPageToken: 'next' });
                return response(request, 200, { tasks: [{ name: `${queueResource}/tasks/b`, createTime: '2026-09-07T00:00:01.000Z', httpRequest: { body: 'Yg==' } }] });
            }
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: { oidcToken: { serviceAccountEmail: `caller@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } } });
        });
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const client = new WorkPlaneClient({ transport: authenticated(fake) });
        const observed = await client.observeQueue(queue);
        expect(observed.tasks.map(task => task.name)).toEqual([`${queueResource}/tasks/a`, `${queueResource}/tasks/b`]);

        const repeated = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [], nextPageToken: 'same' });
            return response(request, 200, { state: 'PAUSED', rateLimits: {}, httpTarget: { oidcToken: { serviceAccountEmail: `caller@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } } });
        });
        await expect(new WorkPlaneClient({ transport: authenticated(repeated) }).observeQueue(queue)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');

        const emptyTerminal = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [], nextPageToken: '' });
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: { oidcToken: { serviceAccountEmail: `caller@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } } });
        });
        await expect(new WorkPlaneClient({ transport: authenticated(emptyTerminal) }).observeQueue(queue)).resolves.toMatchObject({ tasks: [] });
    });

    it('keeps absent Cloud Tasks httpTarget explicit and never creates a reviewed override', async () => {
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [] });
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 } });
        });
        const client = new WorkPlaneClient({ transport: authenticated(fake) });
        const observed = await client.observeQueue(queue);
        expect(observed.httpTargetPresent).toBe(false);
        expect(observed.target).toBeNull();
        await expect(client.updateQueueTarget({ input: queue, expectedOldTarget: queue.target, desiredTarget: { ...queue.target, callerIdentity: { identity: `caller-new@${project}.iam.gserviceaccount.com`, project } }, leaseCheck: noLease })).rejects.toThrow('OBSERVATION_RACE');
        expect(fake.requests.some(request => request.method === 'PATCH')).toBe(false);
    });

    it('permits state mutation for a queue whose optional httpTarget is explicitly absent', async () => {
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        let state: 'PAUSED' | 'RUNNING' = 'PAUSED';
        const fake = new FakeTransport(request => {
            if (request.method === 'POST') {
                state = 'RUNNING';
                return response(request, 200, {});
            }
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [], nextPageToken: '' });
            return response(request, 200, { state, rateLimits: { maxConcurrentDispatches: 2 } });
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake) }).resumeQueue(queue, noLease);
        expect(observed.state).toBe('RUNNING');
        expect(observed.target).toBeNull();
        expect(fake.requests.some(request => request.method === 'POST')).toBe(true);
    });

    it('rejects the non-wire Cloud Tasks enforceMode spelling', async () => {
        const override = { scheme: 'https', host: 'worker.example.invalid', enforceMode: 'IF_NOT_EXISTS' };
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { httpTarget: { uriOverride: override } },
        };
        const fake = new FakeTransport(request => response(request, 200, {
            state: 'PAUSED', httpTarget: { oidcToken: { serviceAccountEmail: `caller@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' }, uriOverride: override },
        }));
        await expect(new WorkPlaneClient({ transport: authenticated(fake) }).observeQueue(queue)).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('rejects Cloud Tasks HTTP wire drift against the reviewed target contract', async () => {
        const override = { scheme: 'https', host: 'worker.example.invalid', pathOverride: { path: '/reviewed' }, uriOverrideEnforceMode: 'IF_NOT_EXISTS' };
        const expectedWire = { uriOverride: override, httpMethod: 'POST', headerOverrides: [{ header: 'X-Reviewed', value: 'yes' }] };
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2, httpTarget: expectedWire },
        };
        const fake = new FakeTransport(request => {
            if (request.url.includes('/tasks?')) return response(request, 200, { tasks: [] });
            return response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: {
                ...expectedWire, headerOverrides: [{ header: 'X-Reviewed', value: 'drifted' }],
                oidcToken: { serviceAccountEmail: `caller@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' },
            } });
        });
        await expect(new WorkPlaneClient({ transport: authenticated(fake) }).observeQueue(queue)).rejects.toThrow('RESOURCE_INVALID');
    });

    it('rejects a Cloud Tasks queue selector containing an underscore before transport', async () => {
        const queue: ProtectedQueueInput = {
            resource: `projects/${project}/locations/asia-northeast3/queues/queue_name`, project, location: 'asia-northeast3',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const fake = new FakeTransport(request => request.url.includes('/tasks?')
            ? response(request, 200, { tasks: [] })
            : response(request, 200, { state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 } }));
        await expect(new WorkPlaneClient({ transport: authenticated(fake) }).observeQueue(queue)).rejects.toThrow('RESOURCE_INVALID');
        expect(fake.requests).toHaveLength(0);
    });

    it('pauses Scheduler through the real operation endpoint and reads state back', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: `maintenance@${project}.iam.gserviceaccount.com`, project } },
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        let schedulerState: 'PAUSED' | 'ENABLED' = 'ENABLED';
        const fake = new FakeTransport(request => {
            if (request.method === 'POST') schedulerState = 'PAUSED';
            const schedulerWire = { name: schedulerResource, state: schedulerState, lastAttemptTime: null, userUpdateTime: '2026-09-07T00:00:01.000Z', schedule: '* * * * *', httpTarget: { uri: 'https://worker.example.invalid/recover', oidcToken: { serviceAccountEmail: `maintenance@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } } };
            return response(request, 200, schedulerWire);
        });
        const observed = await new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async ({ resource }) => pauseProvenance(resource), now: () => 2_000 }).pauseScheduler(scheduler, noLease);
        expect(observed.state).toBe('PAUSED');
        expect(fake.requests.find(request => request.method === 'POST')?.url).toContain(':pause');
    });

    it('does not treat the current Scheduler updateTime as independent pause provenance', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: `maintenance@${project}.iam.gserviceaccount.com`, project } },
            configuration: { schedule: '* * * * *', method: 'POST' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const fake = new FakeTransport(request => response(request, 200, {
            name: schedulerResource, state: 'PAUSED', lastAttemptTime: null, updateTime: '1970-01-01T00:00:01.000Z',
            schedule: '* * * * *', httpTarget: { uri: scheduler.target.uri, oidcToken: { serviceAccountEmail: `maintenance@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } },
        }));
        await expect(new WorkPlaneClient({ transport: authenticated(fake), defaultPauseProvenance: true, now: () => 2_000 }).observeScheduler(scheduler)).rejects.toThrow('EVIDENCE_UNAVAILABLE');
    });

    it('rejects pause provenance whose evidence object is not resource-correlated', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: `maintenance@${project}.iam.gserviceaccount.com`, project } },
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const schedulerWire = { name: schedulerResource, state: 'PAUSED', lastAttemptTime: null, userUpdateTime: '2026-09-07T00:00:01.000Z', schedule: '* * * * *', httpTarget: { uri: 'https://worker.example.invalid/recover', oidcToken: { serviceAccountEmail: `maintenance@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } } };
        const fake = new FakeTransport(request => response(request, 200, schedulerWire));
        const evidence = { resource: `projects/${project}/locations/asia-northeast3/jobs/other`, operation: 'PAUSE', observedAtMs: 1 };
        await expect(new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async ({ resource }) => ({ resource, pauseEpochMs: 1, observedAtMs: 1, source: 'fixture-pause-log', evidence, evidenceDigest: canonicalDigest(evidence), complete: true }), now: () => 2_000 }).observeScheduler(scheduler)).rejects.toThrow('EVIDENCE_UNAVAILABLE');
    });

    it('validates queue and scheduler resource scope before state mutation', async () => {
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'wrong-location',
            target: { url: 'https://worker.example.invalid', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller@${project}.iam.gserviceaccount.com`, project } },
            configuration: { maxConcurrentDispatches: 2 },
        };
        const queueFake = new FakeTransport(() => { throw new Error('queue mutation must not run'); });
        await expect(new WorkPlaneClient({ transport: authenticated(queueFake) }).pauseQueue(queue, noLease)).rejects.toThrow('RESOURCE_INVALID');
        expect(queueFake.requests).toHaveLength(0);

        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'wrong-location',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: `maintenance@${project}.iam.gserviceaccount.com`, project } },
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const schedulerFake = new FakeTransport(() => { throw new Error('scheduler mutation must not run'); });
        await expect(new WorkPlaneClient({ transport: authenticated(schedulerFake, 'fixture-token'), pauseProvenance: async ({ resource }) => pauseProvenance(resource) }).pauseScheduler(scheduler, noLease)).rejects.toThrow('RESOURCE_INVALID');
        expect(schedulerFake.requests).toHaveLength(0);
    });

    it('preserves Cloud Tasks uriOverride, method, headers, and auth while changing only reviewed OIDC', async () => {
        const oldTarget = { url: 'https://worker.example.invalid/old', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller-old@${project}.iam.gserviceaccount.com`, project } };
        const desiredTarget = { url: 'https://worker.example.invalid/new', audience: 'https://worker.example.invalid', callerIdentity: { identity: `caller-new@${project}.iam.gserviceaccount.com`, project } };
        const override = { scheme: 'https', host: 'worker.example.invalid', pathOverride: { path: '/override' }, uriOverrideEnforceMode: 'IF_NOT_EXISTS' };
        const expectedWire = { uriOverride: override, httpMethod: 'POST', headerOverrides: [{ header: 'X-Reviewed', value: 'yes' }] };
        const input: ProtectedQueueInput = { resource: queueResource, project, location: 'asia-northeast3', target: desiredTarget, configuration: { maxConcurrentDispatches: 2, httpTarget: expectedWire } };
        const wire = (target: typeof oldTarget) => ({ state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 }, httpTarget: { ...expectedWire, oidcToken: { serviceAccountEmail: target.callerIdentity.identity, audience: target.audience } } });
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
        const observed = await new WorkPlaneClient({ transport: authenticated(fake) }).updateQueueTarget({ input, expectedOldTarget: oldTarget, desiredTarget, leaseCheck: noLease });
        expect(observed.target).toMatchObject({
            url: null,
            audience: desiredTarget.audience,
            callerIdentity: desiredTarget.callerIdentity,
            uriOverride: override,
        });
    });

    it('preserves Scheduler HTTP method and headers while aligning OIDC target', async () => {
        const oldTarget = { uri: 'https://worker.example.invalid/old', audience: 'https://worker.example.invalid', identity: { identity: `maintenance-old@${project}.iam.gserviceaccount.com`, project } };
        const desiredTarget = { uri: 'https://worker.example.invalid/new', audience: 'https://worker.example.invalid', identity: { identity: `maintenance-new@${project}.iam.gserviceaccount.com`, project } };
        const input: ProtectedSchedulerInput = { resource: schedulerResource, project, location: 'asia-northeast3', target: desiredTarget, configuration: { schedule: '* * * * *', method: 'POST', httpTarget: { httpMethod: 'POST', headers: { 'X-Reviewed': 'yes' } } }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null };
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
        const observed = await new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async ({ resource }) => pauseProvenance(resource), now: () => 2_000 }).updateSchedulerTarget({ input, expectedOldTarget: oldTarget, desiredTarget, leaseCheck: noLease });
        expect(observed.target).toEqual(desiredTarget);
    });

    it('rejects Scheduler HTTP wire drift against the reviewed job contract', async () => {
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3',
            target: { uri: 'https://worker.example.invalid/recover', audience: 'https://worker.example.invalid', identity: { identity: `maintenance@${project}.iam.gserviceaccount.com`, project } },
            configuration: { schedule: '* * * * *', method: 'POST', httpTarget: { httpMethod: 'POST', headers: { 'X-Reviewed': 'yes' } } },
            state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        const fake = new FakeTransport(request => response(request, 200, {
            name: schedulerResource, state: 'PAUSED', lastAttemptTime: null, schedule: '* * * * *',
            httpTarget: { uri: scheduler.target.uri, httpMethod: 'POST', headers: { 'X-Reviewed': 'drifted' }, oidcToken: { serviceAccountEmail: `maintenance@${project}.iam.gserviceaccount.com`, audience: 'https://worker.example.invalid' } },
        }));
        await expect(new WorkPlaneClient({ transport: authenticated(fake), pauseProvenance: async ({ resource }) => pauseProvenance(resource), now: () => 2_000 }).observeScheduler(scheduler)).rejects.toThrow('RESOURCE_INVALID');
    });

    it('does not emit duplicate queue or scheduler mutations when the reviewed target is already exact', async () => {
        const oldQueueTarget = {
            url: 'https://worker.example.invalid',
            audience: 'https://worker.example.invalid',
            callerIdentity: { identity: `caller-old@${project}.iam.gserviceaccount.com`, project },
        };
        const desiredQueueTarget = {
            ...oldQueueTarget,
            callerIdentity: { identity: `caller-new@${project}.iam.gserviceaccount.com`, project },
        };
        const queue: ProtectedQueueInput = {
            resource: queueResource, project, location: 'asia-northeast3', target: desiredQueueTarget,
            configuration: { maxConcurrentDispatches: 2 },
        };
        const oldSchedulerTarget = {
            uri: 'https://worker.example.invalid/recover',
            audience: 'https://worker.example.invalid',
            identity: { identity: `maintenance-old@${project}.iam.gserviceaccount.com`, project },
        };
        const desiredSchedulerTarget = {
            ...oldSchedulerTarget,
            identity: { identity: `maintenance-new@${project}.iam.gserviceaccount.com`, project },
        };
        const scheduler: ProtectedSchedulerInput = {
            resource: schedulerResource, project, location: 'asia-northeast3', target: desiredSchedulerTarget,
            configuration: { schedule: '* * * * *' }, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
        };
        let queueIdentity = oldQueueTarget.callerIdentity.identity;
        let schedulerIdentity = oldSchedulerTarget.identity.identity;
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname.endsWith('/tasks')) return response(request, 200, { tasks: [] });
            if (request.method === 'PATCH' && url.pathname.includes('/queues/')) queueIdentity = desiredQueueTarget.callerIdentity.identity;
            if (url.pathname.includes('/queues/')) return response(request, 200, {
                state: 'PAUSED', rateLimits: { maxConcurrentDispatches: 2 },
                httpTarget: { oidcToken: { serviceAccountEmail: queueIdentity, audience: oldQueueTarget.audience } },
            });
            if (request.method === 'PATCH') schedulerIdentity = desiredSchedulerTarget.identity.identity;
            return response(request, 200, {
                name: schedulerResource, state: 'PAUSED', lastAttemptTime: null,
                schedule: '* * * * *', httpTarget: { uri: oldSchedulerTarget.uri, oidcToken: { serviceAccountEmail: schedulerIdentity, audience: oldSchedulerTarget.audience } },
            });
        });
        const client = new WorkPlaneClient({
            transport: authenticated(fake),
            pauseProvenance: async ({ resource }) => pauseProvenance(resource),
            now: () => 2_000,
        });
        const queueArguments = { input: queue, expectedOldTarget: oldQueueTarget, desiredTarget: desiredQueueTarget, leaseCheck: noLease };
        const schedulerArguments = { input: scheduler, expectedOldTarget: oldSchedulerTarget, desiredTarget: desiredSchedulerTarget, leaseCheck: noLease };
        await expect(client.updateQueueTarget(queueArguments)).resolves.toMatchObject({ state: 'PAUSED' });
        await expect(client.updateQueueTarget(queueArguments)).resolves.toMatchObject({ state: 'PAUSED' });
        await expect(client.updateSchedulerTarget(schedulerArguments)).resolves.toMatchObject({ state: 'PAUSED' });
        await expect(client.updateSchedulerTarget(schedulerArguments)).resolves.toMatchObject({ state: 'PAUSED' });
        expect(fake.requests.filter(request => request.method === 'PATCH')).toHaveLength(2);
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
            readinessFetcher: vi.fn(async (url: string) => ({ status: 200, headers: {}, body: JSON.stringify(readiness), url })),
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
        const immutable = await adapter.readDeploymentReadiness({
            deployment: { id: 'dpl-desired', sourceSha, readyState: 'READY', origin: 'https://immutable.example.invalid', target: null, aliasNames: [], digest: 'e'.repeat(64) },
            expected: {
                sourceSha, legacyTargetResource: 'fixture-target',
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: paidFingerprint,
                analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
            },
        });
        expect(immutable.ready).toBe(true);
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
                id: deploymentId, url: 'desired-fixture.vercel.app', readyState: 'READY', project: { id: projectId }, team: { id: teamId },
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
        const aliases = await adapter.assignAlias({ projectId, teamId, deploymentId, expectedOldDeploymentId: oldDeploymentId, expectedSourceSha: sourceSha, alias: 'desired.example.invalid', leaseCheck: noLease });
        expect(aliases).toEqual(['desired.example.invalid']);
        const deploymentRequest = fake.requests.find(request => request.url.includes('/v13/deployments/'))!;
        expect(deploymentRequest.url).toContain('withGitRepoInfo=true');
        expect(deploymentRequest.url).not.toContain('slug=');
        expect(deploymentRequest.url).not.toContain('projectId=');
    });

    it('rejects an alias owned by an unrelated deployment before POST', async () => {
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname.includes('/v13/deployments/')) return response(request, 200, { id: 'dpl-desired', url: 'desired-fixture.vercel.app', readyState: 'READY', project: { id: 'project-fixture' }, team: { id: 'team-fixture' }, gitSource: { sha: 'a'.repeat(40) } });
            return response(request, 200, { alias: 'desired.example.invalid', projectId: 'project-fixture', deploymentId: 'dpl-other' });
        });
        const adapter = new VercelAdapter({ transport: authenticated(fake), publicReadinessOrigin: 'https://public.example.invalid', readinessFetcher: vi.fn() });
        await expect(adapter.assignAlias({ projectId: 'project-fixture', teamId: 'team-fixture', deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', expectedSourceSha: 'a'.repeat(40), alias: 'desired.example.invalid', leaseCheck: noLease })).rejects.toThrow('OBSERVATION_RACE');
        expect(fake.requests.some(request => request.method === 'POST')).toBe(false);
    });

    it('rejects a missing alias owner before POST', async () => {
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname.includes('/v13/deployments/')) return response(request, 200, { id: 'dpl-desired', url: 'desired-fixture.vercel.app', readyState: 'READY', project: { id: 'project-fixture' }, team: { id: 'team-fixture' }, gitSource: { sha: 'a'.repeat(40) } });
            return response(request, 404, {});
        });
        const adapter = new VercelAdapter({ transport: authenticated(fake), publicReadinessOrigin: 'https://public.example.invalid', readinessFetcher: vi.fn() });
        await expect(adapter.assignAlias({ projectId: 'project-fixture', teamId: 'team-fixture', deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', expectedSourceSha: 'a'.repeat(40), alias: 'desired.example.invalid', leaseCheck: noLease })).rejects.toThrow('OBSERVATION_RACE');
        expect(fake.requests.some(request => request.method === 'POST')).toBe(false);
    });

    it('does not expose protected response values through parse failures', () => {
        expect(() => parseProtectedObject('{"fixtureProtected":"value"}')).not.toThrow();
    });
});
