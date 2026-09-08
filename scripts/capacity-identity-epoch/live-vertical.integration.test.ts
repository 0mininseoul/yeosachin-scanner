import { describe, expect, it } from 'vitest';
import { createFixturePacket, FIXTURE_ZERO_WORK_SELECTOR_DIGESTS } from './fixtures';
import { canonicalDigest, EpochError, type CapacityEpochPacket, type EpochHeader, type ProtectedIamBinding, type ProtectedQueueInput, type ProtectedRuntimeInput, type ProtectedSchedulerInput, type Role } from './contracts';
import { EpochJournal } from './journal';
import { GcsJournalStorage, type GcsHttpRequest, type GcsHttpResponse, type GcsTransport } from './gcs';
import { AuthenticatedProtectedTransport, AuthenticatedReceiverProbe, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient, type PauseProvenance } from './work-planes';
import { VercelAdapter } from './vercel';
import { EpochCoordinator, LiveEpochControlPlane } from './coordinator';
import { issueCoordinatorCapability } from './packet';
import { buildLiveBootstrap, validateServiceBodies } from './bootstrap';
import { evidenceSelectorDigest, type LiveZeroWorkSources, type SupabaseLedgerSource } from './live-evidence';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';

export class FakeGcsTransport implements GcsTransport {
    readonly requests: GcsHttpRequest[] = [];
    readonly writes: GcsHttpRequest[] = [];
    private readonly objects = new Map<string, { generation: string; value: unknown }>();
    private generation = 0;
    failJournalSequence: number | undefined;

    async request(request: GcsHttpRequest): Promise<GcsHttpResponse> {
        this.requests.push(request);
        if (request.method !== 'GET') this.writes.push(request);
        const url = new URL(request.url);
        const query = url.searchParams;
        if (request.method === 'POST' && url.pathname.startsWith('/upload/storage/v1/b/')) {
            const key = query.get('name');
            const precondition = query.get('ifGenerationMatch');
            if (!key || !precondition || request.body === undefined) return this.response(request, 400, {});
            if (this.failJournalSequence !== undefined && key.includes(`/epoch-journal/`) && key.includes(`/${String(this.failJournalSequence).padStart(8, '0')}.json`)) {
                this.failJournalSequence = undefined;
                throw new EpochError('ADAPTER_TIMEOUT');
            }
            const current = this.objects.get(key);
            if (precondition === '0' ? current !== undefined : current?.generation !== precondition) return this.response(request, 412, {});
            const value = JSON.parse(request.body) as unknown;
            const stored = { generation: String(++this.generation), value };
            this.objects.set(key, stored);
            return this.response(request, 200, { name: key, generation: stored.generation }, { 'x-goog-generation': stored.generation });
        }
        const collection = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o$/);
        if (request.method === 'GET' && collection) {
            const prefix = query.get('prefix') ?? '';
            const items = [...this.objects.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([name, value]) => ({ name, generation: value.generation }));
            return this.response(request, 200, { items });
        }
        const objectMatch = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/);
        if (!objectMatch) return this.response(request, 404, {});
        const key = decodeURIComponent(objectMatch[1]!);
        const stored = this.objects.get(key);
        if (!stored) return this.response(request, 404, {});
        if (request.method === 'DELETE') {
            const precondition = query.get('ifGenerationMatch');
            if (!precondition || precondition !== stored.generation) return this.response(request, 412, {});
            this.objects.delete(key);
            return this.response(request, 204, {});
        }
        if (query.get('alt') === 'json') return this.response(request, 200, { name: key, generation: stored.generation });
        if (query.get('alt') === 'media' && query.get('generation') === stored.generation) {
            return this.response(request, 200, stored.value, { 'x-goog-generation': stored.generation });
        }
        return this.response(request, 412, {});
    }

    private response(request: GcsHttpRequest, status: number, value: unknown, headers: Record<string, string> = {}): GcsHttpResponse {
        return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value), url: request.url };
    }
}

type ServiceState = {
    body: Record<string, unknown>;
    runtime: ProtectedRuntimeInput;
    revision: string;
    image: string;
};

type QueueState = {
    input: ProtectedQueueInput;
    state: 'PAUSED' | 'RUNNING';
    callerIdentity: string;
    httpTarget: Record<string, unknown> | null;
};

type SchedulerState = {
    input: ProtectedSchedulerInput;
    state: 'PAUSED' | 'ENABLED';
    identity: string;
};

type PolicyState = { etag: string; bindings: ProtectedIamBinding[] };

type SourceRecord = Readonly<{
    role: Role;
    revision: string;
    sourceSha: string;
    metadataDigest: string;
}>;

type BuildRecord = Readonly<{
    role: Role;
    revision: string;
    image: string;
    buildDigest: string;
}>;

type LedgerEvent = Readonly<{
    observedAtMs: number;
    kind: 'task-created' | 'receiver-work';
}>;

type LedgerRecord = Readonly<{
    source: string;
    coveredStartMs: number;
    coveredEndMs: number;
    events: readonly LedgerEvent[];
}>;

function origin(value: string): string {
    return `${new URL(value).origin}/`;
}

function revisionName(packet: CapacityEpochPacket, role: Role): string {
    const plan = packet.desiredManifest.source[role].revisionPlan;
    const suffix = packet.desiredManifest.source[role].desiredRevisionId ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`;
    return `${plan.prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
}

function runtimeSpec(runtime: ProtectedRuntimeInput, image: string, revision: string): Record<string, unknown> {
    const env = [
        ...Object.entries(runtime.environment).map(([name, value]) => ({ name, value })),
        ...Object.entries(runtime.secretReferences).map(([name, value]) => {
            const [secretName, key] = value.split(':');
            return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
        }),
    ];
    return {
        template: {
            metadata: { name: revision, annotations: { 'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances) } },
            spec: {
                serviceAccountName: runtime.identity.identity,
                containerConcurrency: runtime.settings.concurrency,
                timeoutSeconds: runtime.settings.timeoutSeconds,
                containers: [{ image, env, resources: { limits: { cpu: runtime.settings.cpu, memory: runtime.settings.memory } } }],
            },
        },
    };
}

function reviewedBodies(packet: CapacityEpochPacket): Record<Role, Readonly<Record<string, unknown>>> {
    return Object.fromEntries((['preflight', 'paid'] as const).map(role => {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const revision = revisionName(packet, role);
        const image = `asia-northeast3-docker.pkg.dev/${runtime.project}/workers/${role}@sha256:${'b'.repeat(64)}`;
        const template = runtimeSpec(runtime, image, revision).template as Record<string, unknown>;
        const templateSpec = template.spec as Record<string, unknown>;
        return [role, {
            metadata: { name: runtime.service, generation: 1, resourceVersion: 'rv-1', labels: {}, annotations: {} },
            spec: {
                template: {
                    metadata: {
                        name: revision, labels: {},
                        annotations: {
                            'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances),
                            'capacity.identity-epoch/source-sha': runtime.sourceSha,
                            'capacity.identity-epoch/build-digest': packet.desiredManifest.source[role].desiredBuildDigest,
                            'capacity.identity-epoch/image-digest': canonicalDigest({ image }),
                        },
                    },
                    spec: templateSpec,
                },
                traffic: [{ revisionName: packet.oldManifest.source[role].oldRevision, percent: 100, tag: null }, { revisionName: revision, percent: 0, tag: null }],
            },
        }];
    })) as unknown as Record<Role, Readonly<Record<string, unknown>>>;
}

function reviewedSources(packet: CapacityEpochPacket): LiveZeroWorkSources {
    const project = packet.protectedInputs.desired.runtime.preflight.project;
    const queues = [packet.protectedInputs.desired.queues.preflight.resource, packet.protectedInputs.desired.queues.paid.resource] as const;
    const base = {
        kind: 'supabase' as const, origin: 'https://supabase.example.invalid/', lookbackMs: 60_000,
    };
    const supabase = (selector: Omit<SupabaseLedgerSource, 'lookbackMs' | 'selectorDigest' | 'kind' | 'origin'>): SupabaseLedgerSource => {
        const selected = { ...base, ...selector };
        return { ...selected, selectorDigest: evidenceSelectorDigest({ ...selected, selectorDigest: '0'.repeat(64) } as never) };
    };
    return {
        providerLedger: supabase({ source: 'supabase:public.analysis_provider_cost_ledger', table: 'analysis_provider_cost_ledger', columns: ['run_id', 'request_id', 'operation_key', 'status', 'created_at'], eventTimeColumn: 'created_at' }),
        billingLedger: supabase({ source: 'supabase:public.analysis_revenue_cost_operations', table: 'analysis_revenue_cost_operations', columns: ['request_id', 'owner_kind', 'owner_key_hash', 'operation_kind', 'status', 'created_at'], eventTimeColumn: 'created_at' }),
        taskAudit: { kind: 'cloud-logging' as const, source: 'fixture-task-audit', project, logName: `projects/${project}/logs/fixture-task-audit`, resourceType: 'cloud_tasks_queue' as const, correlation: 'fixture-task-audit', queueResources: queues, sinkName: 'fixture-task-audit-sink', bucketResource: `projects/${project}/locations/global/buckets/fixture-task-audit`, lookbackMs: 60_000, selectorDigest: FIXTURE_ZERO_WORK_SELECTOR_DIGESTS.taskAudit },
        receiverLog: supabase({ source: 'supabase:public.analysis_step_events', table: 'analysis_step_events', columns: ['id', 'request_id', 'step', 'event_type', 'created_at'], eventTimeColumn: 'created_at' }),
    };
}

function serviceWire(runtime: ProtectedRuntimeInput, revision: string, image: string, generation: number, traffic: readonly { revisionName: string; percent: number }[]): Record<string, unknown> {
    const spec = runtimeSpec(runtime, image, revision);
    const wireTraffic = traffic.map(entry => ({ revisionName: entry.revisionName, percent: entry.percent, tag: null }));
    return {
        metadata: { generation, resourceVersion: `rv-${generation}` },
        spec: { ...spec, traffic: wireTraffic },
        status: {
            url: origin(runtime.target.url), observedGeneration: generation, conditions: [{ type: 'Ready', status: 'True' }],
            latestCreatedRevisionName: revision, latestReadyRevisionName: revision, traffic: wireTraffic,
        },
    };
}

function revisionWire(runtime: ProtectedRuntimeInput, revision: string, image: string): Record<string, unknown> {
    const spec = runtimeSpec(runtime, image, revision);
    return {
        metadata: { name: revision, generation: 1, resourceVersion: `${revision}-rv-1`, annotations: { 'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances) } },
        spec: (spec.template as Record<string, unknown>).spec,
        status: { observedGeneration: 1, imageDigest: image, conditions: [{ type: 'Ready', status: 'True' }] },
    };
}

function queueWire(state: QueueState): Record<string, unknown> {
    return {
        name: state.input.resource, state: state.state,
        rateLimits: { maxDispatchesPerSecond: state.input.configuration.maxDispatchesPerSecond, maxConcurrentDispatches: state.input.configuration.maxConcurrentDispatches },
        stackdriverLoggingConfig: { samplingRatio: 1 },
        ...(state.httpTarget === null ? {} : { httpTarget: state.httpTarget }),
    };
}

function schedulerWire(state: SchedulerState): Record<string, unknown> {
    // Keep the fixture's provider clock and scheduler update-time on the
    // same timeline.  Live WorkPlaneClient treats pause provenance as source
    // evidence and must reject an observation whose trusted clock predates
    // the provider update event.
    const updateTime = new Date(state.input.pauseEpochMs).toISOString();
    return {
        name: state.input.resource, state: state.state, lastAttemptTime: null, updateTime, userUpdateTime: updateTime, schedule: state.input.configuration.schedule,
        httpTarget: { uri: state.input.target.uri, httpMethod: state.input.configuration.method, oidcToken: { serviceAccountEmail: state.identity, audience: state.input.target.audience } },
    };
}

function readiness(packet: CapacityEpochPacket, phase: 'old' | 'desired'): Record<string, unknown> {
    const expected = phase === 'old' ? packet.oldManifest.readiness : packet.desiredManifest.readiness;
    return {
        schemaVersion: 'analysis-public-freeze-readiness-v3', ready: true, stage: 'initial', freezeMode: 'drain-and-block', publicFreezeEnabled: true,
        sourceSha: expected.sourceSha, legacyTargetResource: expected.legacyTargetResource,
        preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        preflightProducerConfigFingerprint: expected.preflightFingerprint, preflightProducerConfigReady: true,
        paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        paidProducerConfigFingerprint: expected.paidFingerprint, paidProducerConfigReady: true,
        routes: {
            '/api/analysis/start': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
            '/api/analysis/step': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
            '/api/analysis/run': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
        },
        analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
    };
}

function policyWire(policy: PolicyState): Record<string, unknown> {
    const grouped = new Map<string, { role: string; members: string[]; condition?: unknown }>();
    for (const binding of policy.bindings) {
        const key = `${binding.role}:${canonicalDigest(binding.condition)}`;
        const group = grouped.get(key) ?? { role: binding.role, members: [], ...(binding.condition === null ? {} : { condition: typeof binding.condition === 'string' ? { expression: binding.condition } : binding.condition }) };
        group.members.push(binding.member);
        grouped.set(key, group);
    }
    return { version: 3, etag: policy.etag, bindings: [...grouped.values()].map(group => ({ ...group, members: [...group.members].sort() })) };
}

function flattenPolicy(value: Record<string, unknown>): ProtectedIamBinding[] {
    const result: ProtectedIamBinding[] = [];
    for (const item of (value.bindings ?? []) as unknown[]) {
        const group = item as { role: string; members: string[]; condition?: Record<string, string> };
        const condition = group.condition?.expression ?? null;
        for (const member of group.members) result.push({ role: group.role, member, condition });
    }
    return result;
}

export class FakeProvider implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];
    readonly tasksCreated: string[] = [];
    readonly receiverProbes: ProtectedHttpRequest[] = [];
    /** The fake receiver exposes request-log visibility without treating it as forbidden work evidence. */
    readonly receiverRequestLogs: readonly Readonly<{ method: string; requestUrl: string }>[] = [];
    readonly supabaseRows = new Map<string, readonly Record<string, unknown>[]>();
    readonly services = new Map<string, ServiceState>();
    readonly revisions = new Map<string, Record<string, unknown>>();
    readonly queues = new Map<string, QueueState>();
    readonly schedulers = new Map<string, SchedulerState>();
    readonly policies = new Map<string, PolicyState>();
    readonly sourceRecords = new Map<string, SourceRecord>();
    readonly buildRecords = new Map<string, BuildRecord>();
    readonly ledgers = new Map<string, LedgerRecord>();
    baselineDigest: string | undefined;
    private retainedBaseline: Readonly<{ capturedAtMs: number; sourceDigests: Readonly<Record<string, string>> }> | undefined;
    aliasDeployment = 'dpl-old';
    interruptAfter: 'iam' | 'scheduler' | 'queue' | undefined;
    receiverStatus = 400;
    receiverCode = 'INVALID_REQUEST';
    injectForbiddenStructuredEventOnProbe = false;
    watermarkMs = 1_000_000;
    lastSupabaseDateMs = 0;
    readonly packet: CapacityEpochPacket;

    constructor(packet: CapacityEpochPacket) {
        this.packet = packet;
        for (const role of ['preflight', 'paid'] as const) {
            const oldRuntime = packet.protectedInputs.old.runtime[role];
            const desiredRuntime = packet.protectedInputs.desired.runtime[role];
            const oldRevision = packet.oldManifest.source[role].oldRevision;
            const desiredRevision = revisionName(packet, role);
            const oldImage = `asia-northeast3-docker.pkg.dev/${oldRuntime.project}/workers/${role}@sha256:${'a'.repeat(64)}`;
            const desiredImage = `asia-northeast3-docker.pkg.dev/${desiredRuntime.project}/workers/${role}@sha256:${'b'.repeat(64)}`;
            const resource = this.serviceResource(oldRuntime);
            this.services.set(resource, { body: serviceWire(oldRuntime, oldRevision, oldImage, 1, [{ revisionName: oldRevision, percent: 100 }]), runtime: oldRuntime, revision: oldRevision, image: oldImage });
            this.revisions.set(`${desiredRuntime.project}/${desiredRuntime.location}/${desiredRevision}`, revisionWire(desiredRuntime, desiredRevision, desiredImage));
            this.sourceRecords.set(`${role}:old:${oldRevision}`, { role, revision: oldRevision, sourceSha: packet.protectedObservations.old.source[role].sourceSha, metadataDigest: packet.protectedObservations.old.source[role].metadataDigest });
            this.sourceRecords.set(`${role}:desired:${desiredRevision}`, { role, revision: desiredRevision, sourceSha: packet.protectedObservations.desired.source[role].sourceSha, metadataDigest: canonicalDigest({ role, revision: desiredRevision, sourceSha: packet.protectedObservations.desired.source[role].sourceSha }) });
            this.buildRecords.set(oldImage, { role, revision: oldRevision, image: oldImage, buildDigest: packet.protectedObservations.old.runtime[role].buildDigest });
            this.buildRecords.set(desiredImage, { role, revision: desiredRevision, image: desiredImage, buildDigest: packet.protectedObservations.desired.source[role].desiredBuildDigest });
            this.queues.set(packet.protectedInputs.old.queues[role].resource, { input: packet.protectedInputs.old.queues[role], state: 'PAUSED', callerIdentity: packet.protectedInputs.old.queues[role].target.callerIdentity.identity, httpTarget: null });
            this.schedulers.set(packet.protectedInputs.old.schedulers[role].resource, { input: packet.protectedInputs.old.schedulers[role], state: 'PAUSED', identity: packet.protectedInputs.old.schedulers[role].target.identity.identity });
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const oldInput = packet.protectedInputs.old.iam[role][kind];
                const desiredInput = packet.protectedInputs.desired.iam[role][kind];
                if (!this.policies.has(oldInput.resource)) this.policies.set(oldInput.resource, { etag: oldInput.etag, bindings: [...oldInput.bindings] });
                if (!this.policies.has(desiredInput.resource)) this.policies.set(desiredInput.resource, { etag: desiredInput.etag, bindings: [...oldInput.bindings] });
            }
        }
        for (const phase of ['old', 'desired'] as const) {
            const retention = packet.protectedInputs[phase].retention;
            this.schedulers.set(retention.resource, { input: { ...packet.protectedInputs[phase].schedulers.preflight, resource: retention.resource, project: retention.project, location: retention.location } as ProtectedSchedulerInput, state: 'ENABLED', identity: packet.protectedInputs[phase].schedulers.preflight.target.identity.identity });
        }
        for (const source of Object.values(packet.protectedObservations.desired.zeroWorkSources)) {
            this.ledgers.set(source.source, { source: source.source, coveredStartMs: 999_000, coveredEndMs: 1_000_000, events: [] });
        }
    }

    readSource(role: Role, phase: 'old' | 'desired', revision: string): SourceRecord {
        const record = this.sourceRecords.get(`${role}:${phase}:${revision}`);
        if (!record) throw new EpochError('SOURCE_INVALID');
        return record;
    }

    readBuild(role: Role, revision: string, image: string): string {
        const record = this.buildRecords.get(image);
        if (!record || record.role !== role || record.revision !== revision) throw new EpochError('SOURCE_INVALID');
        return record.buildDigest;
    }

    captureLedgerBaseline(nowMs: number): Readonly<{ capturedAtMs: number; sourceDigests: Readonly<Record<string, string>> }> {
        if (this.retainedBaseline) return this.retainedBaseline;
        const sourceDigests = Object.fromEntries([...this.ledgers].map(([source, record]) => [source, canonicalDigest(record)]));
        const baseline = { capturedAtMs: nowMs - 1_000, sourceDigests };
        this.retainedBaseline = baseline;
        this.baselineDigest = canonicalDigest(baseline);
        return baseline;
    }

    readLedger(source: string, windowStartMs: number, windowEndMs: number, nowMs: number): Readonly<{
        provenance: string;
        digest: string;
        observedAtMs: number;
        coveredStartMs: number;
        coveredEndMs: number;
        coverageLagMs: number;
        freshnessLagMs: number;
        complete: true;
        eventCount: number;
        deltaCount: number;
        }> {
        const record = this.ledgers.get(source);
        if (!record || record.coveredStartMs > windowStartMs
            || record.events.some(event => event.observedAtMs > record.coveredEndMs && event.observedAtMs <= windowEndMs)) throw new EpochError('EVIDENCE_UNAVAILABLE');
        if (record.coveredEndMs < windowEndMs) {
            this.ledgers.set(source, { ...record, coveredEndMs: windowEndMs });
        }
        const eventCount = record.events.filter(event => event.observedAtMs >= windowStartMs && event.observedAtMs <= windowEndMs).length;
        const proof = {
            provenance: source,
            digest: canonicalDigest({ source, windowStartMs, windowEndMs, eventCount }),
            observedAtMs: nowMs,
            coveredStartMs: windowStartMs,
            coveredEndMs: windowEndMs,
            coverageLagMs: nowMs - windowEndMs,
            freshnessLagMs: nowMs - windowEndMs,
            complete: true as const,
            eventCount,
            deltaCount: eventCount,
        };
        return proof;
    }

    private recordMutation(source: string, event: LedgerEvent): void {
        const current = this.ledgers.get(source);
        if (!current) return;
        this.ledgers.set(source, { ...current, coveredEndMs: Math.max(current.coveredEndMs, event.observedAtMs), events: [...current.events, event] });
    }

    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        const url = new URL(request.url);
        if (url.hostname === 'api.vercel.com') return this.vercel(request, url);
        if (url.hostname === 'cloudbuild.googleapis.com') return this.cloudBuild(request, url);
        if (url.hostname === 'logging.googleapis.com') return this.logging(request, url);
        if (url.hostname === 'supabase.example.invalid') return this.supabase(request, url);
        if (url.hostname === 'public.example.invalid' || url.hostname === 'desired-fixture.vercel.app') return this.readinessEndpoint(request, url);
        if (url.hostname === 'preflight.example.com' || url.hostname === 'paid.example.com') return this.receiver(request, url);
        if (url.hostname === 'cloudtasks.googleapis.com') return this.tasks(request, url);
        if (url.hostname === 'cloudscheduler.googleapis.com') return this.scheduler(request, url);
        if (url.hostname === 'iam.googleapis.com' || url.hostname.endsWith('-run.googleapis.com')) return this.google(request, url);
        throw new Error('unexpected fake provider host');
    }

    private receiver(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        this.receiverProbes.push(request);
        (this.receiverRequestLogs as Array<Readonly<{ method: string; requestUrl: string }>>).push({ method: request.method, requestUrl: url.toString() });
        if (this.injectForbiddenStructuredEventOnProbe) {
            this.supabaseRows.set('analysis_step_events', [{ id: 'fixture-event', request_id: 'fixture-request', step: 'started', event_type: 'started', created_at: new Date(this.watermarkMs).toISOString() }]);
        }
        if (!/^\/api\/analysis\/(?:preflight\/worker|v2\/worker)$/.test(url.pathname)) return this.json(request, 404, {});
        if (request.method !== 'POST' || request.body !== '{') return this.json(request, this.receiverStatus, { code: this.receiverCode });
        return this.json(request, this.receiverStatus, { code: this.receiverCode });
    }

    private google(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        const path = url.pathname;
        if (path.includes(':getIamPolicy')) return this.iamRead(request, path);
        if (path.includes(':setIamPolicy')) return this.iamWrite(request, path);
        if (path.startsWith('/apis/serving.knative.dev/v1/namespaces/')) {
            if (path.includes('/revisions/')) {
                const match = path.match(/\/namespaces\/([^/]+)\/revisions\/([^/]+)$/);
                const revision = match?.[2];
                const value = revision ? this.revisions.get(`${match?.[1]}/${url.hostname.split('-run.')[0]}/${revision}`) : undefined;
                if (!value) return this.json(request, 404, {});
                return this.json(request, 200, value);
            }
            const match = path.match(/\/namespaces\/([^/]+)\/services\/([^/]+)$/);
            const resource = match ? `projects/${match[1]}/locations/${url.hostname.replace(/-run\.googleapis\.com$/, '')}/services/${match[2]}` : '';
            const service = this.services.get(resource);
            if (!service) return this.json(request, 404, {});
            if (request.method === 'PUT') {
                const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
                const generation = Number((service.body.metadata as Record<string, unknown>).generation) + 1;
                const spec = body.spec as Record<string, unknown>;
                const traffic = (spec.traffic ?? []) as Array<{ revisionName: string; percent: number; tag?: string | null }>;
                service.body = {
                    metadata: { generation, resourceVersion: `rv-${generation}` }, spec,
                    status: { ...(service.body.status as Record<string, unknown>), observedGeneration: generation, latestCreatedRevisionName: (spec.template as Record<string, unknown>).metadata ? ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>).name : service.revision, latestReadyRevisionName: (spec.template as Record<string, unknown>).metadata ? ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>).name : service.revision, traffic },
                };
                service.runtime = this.runtimeFromSpec(service.runtime, spec);
                service.revision = ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>).name as string;
                service.image = ((((spec.template as Record<string, unknown>).spec as Record<string, unknown>).containers as Array<Record<string, unknown>>)[0]!.image as string);
                const role = service.runtime.role;
                this.sourceRecords.set(`${role}:desired:${service.revision}`, { role, revision: service.revision, sourceSha: this.packet.protectedObservations.desired.source[role].sourceSha, metadataDigest: canonicalDigest({ role, revision: service.revision, sourceSha: this.packet.protectedObservations.desired.source[role].sourceSha }) });
                this.buildRecords.set(service.image, { role, revision: service.revision, image: service.image, buildDigest: this.packet.protectedObservations.desired.source[role].desiredBuildDigest });
                return this.json(request, 200, service.body);
            }
            return this.json(request, 200, service.body);
        }
        throw new Error('unexpected fake google request');
    }

    private tasks(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        const path = url.pathname;
        if (path.includes(':getIamPolicy')) return this.iamRead(request, path);
        if (path.includes(':setIamPolicy')) return this.iamWrite(request, path);
        const queueMatch = path.match(/^\/v2\/(projects\/[^/]+\/locations\/[^/]+\/queues\/[^/:]+)(?::(pause|resume))?$/);
        if (queueMatch) {
            const resource = queueMatch[1]!;
            const queue = this.queues.get(resource);
            if (!queue) return this.json(request, 404, {});
            if (request.method === 'POST' && queueMatch[2]) queue.state = queueMatch[2] === 'pause' ? 'PAUSED' : 'RUNNING';
            if (request.method === 'PATCH') {
                const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
                const target = body.httpTarget as Record<string, unknown>;
                queue.callerIdentity = ((target.oidcToken as Record<string, unknown>).serviceAccountEmail as string);
                queue.httpTarget = target;
                if (this.interruptAfter === 'queue') {
                    this.interruptAfter = undefined;
                    throw new EpochError('ADAPTER_TIMEOUT');
                }
            }
            return this.json(request, 200, queueWire(queue));
        }
        const tasksMatch = path.match(/^\/v2\/(projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+)\/tasks$/);
        if (tasksMatch && request.method === 'POST') {
            this.tasksCreated.push(tasksMatch[1]!);
            this.recordMutation(this.packet.protectedObservations.desired.zeroWorkSources.taskAudit.source, { observedAtMs: 1_000_000, kind: 'task-created' });
            return this.json(request, 200, { name: `${tasksMatch[1]}/tasks/fixture` });
        }
        if (tasksMatch) return this.json(request, 200, { tasks: [] });
        if (request.method === 'POST' && path.includes('/tasks')) this.tasksCreated.push(path);
        throw new Error('unexpected fake tasks request');
    }

    private scheduler(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        const path = url.pathname;
        if (path.includes(':getIamPolicy')) return this.iamRead(request, path);
        if (path.includes(':setIamPolicy')) return this.iamWrite(request, path);
        const match = path.match(/^\/v1\/(projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/:]+)(?::(pause|resume))?$/);
        if (!match) throw new Error('unexpected fake scheduler request');
        const resource = match[1]!;
        const scheduler = this.schedulers.get(resource);
        if (!scheduler) return this.json(request, 404, {});
        if (request.method === 'POST' && match[2]) scheduler.state = match[2] === 'pause' ? 'PAUSED' : 'ENABLED';
        if (request.method === 'PATCH') {
            const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
            const target = body.httpTarget as Record<string, unknown>;
            scheduler.identity = ((target.oidcToken as Record<string, unknown>).serviceAccountEmail as string);
            scheduler.input = { ...scheduler.input, target: { ...scheduler.input.target, uri: target.uri as string, identity: { identity: scheduler.identity, project: scheduler.input.project } } };
            if (this.interruptAfter === 'scheduler') {
                this.interruptAfter = undefined;
                throw new EpochError('ADAPTER_TIMEOUT');
            }
        }
        return this.json(request, 200, schedulerWire(scheduler));
    }

    private iamRead(request: ProtectedHttpRequest, path: string): ProtectedHttpResponse {
        const resource = this.resourceFromIamPath(path);
        const policy = this.policies.get(resource);
        if (!policy) return this.json(request, 404, {});
        return this.json(request, 200, policyWire(policy));
    }

    private iamWrite(request: ProtectedHttpRequest, path: string): ProtectedHttpResponse {
        const resource = this.resourceFromIamPath(path);
        const policy = this.policies.get(resource);
        if (!policy) return this.json(request, 404, {});
        const body = JSON.parse(request.body ?? '{}') as { policy: Record<string, unknown> };
        policy.bindings = flattenPolicy(body.policy);
        policy.etag = `${policy.etag}-n`;
        if (this.interruptAfter === 'iam') {
            this.interruptAfter = undefined;
            throw new EpochError('ADAPTER_TIMEOUT');
        }
        return this.json(request, 200, policyWire(policy));
    }

    private resourceFromIamPath(path: string): string {
        const prefix = path.startsWith('/v1/') ? '/v1/' : '/v2/';
        return path.slice(prefix.length).replace(/:getIamPolicy$|:setIamPolicy$/, '');
    }

    private vercel(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        if (url.pathname.startsWith('/v13/deployments/')) {
            return this.json(request, 200, { id: 'dpl-desired', url: 'desired-fixture.vercel.app', readyState: 'READY', project: { id: this.packet.providerScope.vercelProjectId }, team: { id: this.packet.providerScope.vercelTeamId }, gitSource: { sha: this.packet.desiredManifest.readiness.sourceSha }, target: 'production', alias: [] });
        }
        if (url.pathname === `/v4/aliases/${this.packet.providerScope.vercelProducerAlias}`) {
            return this.json(request, 200, { alias: this.packet.providerScope.vercelProducerAlias, projectId: this.packet.providerScope.vercelProjectId, deploymentId: this.aliasDeployment });
        }
        if (url.pathname === '/v2/deployments/dpl-desired/aliases' && request.method === 'POST') {
            this.aliasDeployment = 'dpl-desired';
            return this.json(request, 200, { alias: this.packet.providerScope.vercelProducerAlias, projectId: this.packet.providerScope.vercelProjectId, deploymentId: this.aliasDeployment });
        }
        if (url.pathname === '/v2/deployments/dpl-desired/aliases') return this.json(request, 200, { aliases: [{ alias: this.packet.providerScope.vercelProducerAlias }] });
        throw new Error('unexpected fake vercel request');
    }

    private readinessEndpoint(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        if (url.pathname !== '/api/analysis/capacity/readiness') return this.json(request, 404, {});
        const phase = url.hostname === 'desired-fixture.vercel.app' || this.aliasDeployment === 'dpl-desired' ? 'desired' : 'old';
        return this.json(request, 200, readiness(this.packet, phase));
    }

    private cloudBuild(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        if (request.method !== 'GET' || !url.pathname.endsWith('/builds')) return this.json(request, 404, {});
        const project = this.packet.protectedInputs.desired.runtime.preflight.project;
        const image = (role: Role) => `asia-northeast3-docker.pkg.dev/${project}/workers/${role}`;
        const build = (phase: 'old' | 'desired') => {
            const input = this.packet.protectedInputs[phase].build;
            const digest = phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64);
            return {
                id: `fixture-${phase}`, status: 'SUCCESS', serviceAccount: input.identity.identity,
                sourceProvenance: { resolvedRepoSource: { repoName: input.sourceContext, commitSha: input.sourceSha } },
                substitutions: { _NODE_ENV: 'production' },
                results: { images: (['preflight', 'paid'] as const).map(role => ({ name: image(role), digest: `sha256:${digest}` })) },
            };
        };
        return this.json(request, 200, { builds: [build('old'), build('desired')] });
    }

    private loggingSources(): Array<Record<string, unknown>> {
        const project = this.packet.protectedInputs.desired.runtime.preflight.project;
        const queues = [this.packet.protectedInputs.desired.queues.preflight.resource, this.packet.protectedInputs.desired.queues.paid.resource];
        return [
            { source: 'fixture-task-audit', project, logName: `projects/${project}/logs/fixture-task-audit`, resourceType: 'cloud_tasks_queue', correlation: 'fixture-task-audit', queueResources: queues, sinkName: 'fixture-task-audit-sink', bucketResource: `projects/${project}/locations/global/buckets/fixture-task-audit` },
        ];
    }

    private loggingFilter(source: Record<string, unknown>): string {
        if (source.resourceType === 'cloud_tasks_queue') {
            const selectors = (source.queueResources as string[]).map(resource => {
                const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(resource)!;
                return `(resource.labels.project_id="${match[1]}" AND resource.labels.location="${match[2]}" AND resource.labels.queue_id="${match[3]}")`;
            });
            return `logName="${source.logName}" AND resource.type="cloud_tasks_queue" AND jsonPayload."@type"="type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog" AND (${selectors.sort().join(' OR ')})`;
        }
        return `logName="${source.logName}" AND resource.type="cloud_run_revision" AND httpRequest.requestUrl=(${(source.receiverRoutes as string[]).map(route => `"${route}"`).join(' OR ')})`;
    }

    private loggingSinkDestination(source: Record<string, unknown>): string {
        return `logging.googleapis.com/${source.bucketResource as string}`;
    }

    private logging(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        const sources = this.loggingSources();
        if (request.method === 'GET' && url.pathname.endsWith('/sinks')) {
            return this.json(request, 200, { sinks: sources.map(source => ({ name: source.sinkName, destination: this.loggingSinkDestination(source), filter: this.loggingFilter(source) })) });
        }
        if (request.method === 'GET' && url.pathname.endsWith('/exclusions')) return this.json(request, 200, { exclusions: [] });
        if (request.method === 'GET' && url.pathname.includes('/buckets/')) return this.json(request, 200, { retentionDays: 30 });
        if (request.method === 'POST' && url.pathname === '/v2/entries:list') {
            const body = JSON.parse(request.body ?? '{}') as { filter?: string };
            const source = sources.find(candidate => body.filter?.includes(`logName="${candidate.logName}"`));
            if (!source) return this.json(request, 200, { entries: [] });
            if (body.filter?.includes('receiveTimestamp >=')) {
                const stamp = new Date(this.watermarkMs).toISOString();
                return this.json(request, 200, { entries: [{ timestamp: stamp, receiveTimestamp: stamp, jsonPayload: { '@type': 'type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog', taskCreationLog: { status: 'OK' } } }] });
            }
            return this.json(request, 200, { entries: [] });
        }
        return this.json(request, 404, {});
    }

    private supabase(request: ProtectedHttpRequest, url: URL): ProtectedHttpResponse {
        if (request.method !== 'GET' || !url.pathname.startsWith('/rest/v1/')) return this.json(request, 404, {});
        if (request.headers.apikey !== 'fixture-supabase-api-key') return this.json(request, 401, {});
        const table = url.pathname.slice('/rest/v1/'.length);
        if (!['analysis_provider_cost_ledger', 'analysis_revenue_cost_operations', 'analysis_step_events'].includes(table)) return this.json(request, 404, {});
        // HTTP Date is second precision. Round upward so the source boundary
        // is never older than the frozen coordinator window while the
        // injected clock advances in deterministic 100ms ticks.
        this.lastSupabaseDateMs = Math.ceil(this.watermarkMs / 1_000) * 1_000;
        const date = new Date(this.lastSupabaseDateMs).toUTCString();
        const bounds = url.searchParams.getAll('created_at');
        const lower = bounds.find(value => value.startsWith('gte.'))?.slice(4);
        const upper = bounds.find(value => value.startsWith('lte.'))?.slice(4);
        const lowerMs = lower === undefined ? Number.NEGATIVE_INFINITY : Date.parse(lower);
        const upperMs = upper === undefined ? Number.POSITIVE_INFINITY : Date.parse(upper);
        const rawRows = this.supabaseRows.get(table) ?? [];
        const rows = rawRows.filter(row => {
            const timestamp = Date.parse(String(row.created_at));
            return Number.isFinite(timestamp) && timestamp >= lowerMs && timestamp <= upperMs;
        });
        const range = rows.length === 0 ? `*/0` : `0-${rows.length - 1}/${rows.length}`;
        return this.json(request, 200, rows, { 'content-range': range, date });
    }

    private json(request: ProtectedHttpRequest, status: number, value: unknown, headers: Record<string, string> = {}): ProtectedHttpResponse {
        return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value), url: request.url };
    }

    private serviceResource(runtime: ProtectedRuntimeInput): string {
        return `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
    }

    private runtimeFromSpec(runtime: ProtectedRuntimeInput, spec: Record<string, unknown>): ProtectedRuntimeInput {
        const template = spec.template as Record<string, unknown>;
        const templateSpec = template.spec as Record<string, unknown>;
        const container = (templateSpec.containers as Array<Record<string, unknown>>)[0]!;
        const environment: Record<string, string> = {};
        const secretReferences: Record<string, string> = {};
        for (const item of (container.env as Array<Record<string, unknown>>)) {
            if (typeof item.value === 'string') environment[item.name as string] = item.value;
            else {
                const ref = (item.valueFrom as Record<string, unknown>).secretKeyRef as Record<string, unknown>;
                secretReferences[item.name as string] = `${ref.name}:${ref.key}`;
            }
        }
        return { ...runtime, identity: { identity: templateSpec.serviceAccountName as string, project: runtime.project }, environment, secretReferences, settings: { ...runtime.settings, cpu: ((container.resources as Record<string, unknown>).limits as Record<string, string>).cpu, memory: ((container.resources as Record<string, unknown>).limits as Record<string, string>).memory, concurrency: templateSpec.containerConcurrency as number, timeoutSeconds: templateSpec.timeoutSeconds as number, maxInstances: Number((template.metadata as Record<string, unknown>).annotations && ((template.metadata as Record<string, unknown>).annotations as Record<string, string>)['autoscaling.knative.dev/maxScale']) } };
    }
}

type HarnessClock = Readonly<{
    now: () => number;
    peek: () => number;
    advance: (milliseconds: number) => void;
}>;

type HarnessOptions = Readonly<{
    packet?: CapacityEpochPacket;
    provider?: FakeProvider;
    gcs?: FakeGcsTransport;
    clock?: HarnessClock;
    failAppendSequence?: number;
    ownerLabel?: string;
    interruptAfter?: 'iam' | 'scheduler' | 'queue';
}>;

function createHarness(options: HarnessOptions = {}) {
    const packet = options.packet ?? createFixturePacket();
    const provider = options.provider ?? new FakeProvider(packet);
    const gcs = options.gcs ?? new FakeGcsTransport();
    if (options.failAppendSequence !== undefined) gcs.failJournalSequence = options.failAppendSequence;
    if (options.interruptAfter !== undefined) provider.interruptAfter = options.interruptAfter;
    let currentNow = 1_000_000;
    const clock: HarnessClock = options.clock ?? {
        now: () => currentNow,
        peek: () => currentNow,
        advance: (milliseconds: number) => { currentNow += milliseconds; },
    };
    const googleTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-google-token', timeoutMs: 2_000 });
    const cloudRun = new CloudRunAdapter({ transport: googleTransport, now: clock.now, pollTimeoutMs: 1_000, pollIntervalMs: 0, sleep: async () => undefined });
    const pauseProvenance = async ({ resource }: { resource: string; project: string; location: string; signal?: AbortSignal }): Promise<PauseProvenance> => {
        const scheduler = provider.schedulers.get(resource);
        if (!scheduler) throw new EpochError('EVIDENCE_UNAVAILABLE');
        const evidence = { resource, operation: 'PAUSE', observedAtMs: clock.peek(), pauseEpochMs: scheduler.input.pauseEpochMs };
        return { resource, pauseEpochMs: scheduler.input.pauseEpochMs, observedAtMs: clock.peek(), source: 'fixture-pause-log', evidence, evidenceDigest: canonicalDigest(evidence), complete: true };
    };
    const workPlanes = new WorkPlaneClient({ transport: googleTransport, pauseProvenance, now: clock.now, pauseProvenanceTimeoutMs: 1_000 });
    const iam = new IamAdapter({ transport: googleTransport });
    const vercelTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-vercel-token', timeoutMs: 2_000 });
    const vercel = new VercelAdapter({
        transport: vercelTransport,
        publicReadinessOrigin: new URL(packet.providerScope.publicReadinessUrl).origin,
        readinessFetcher: async (url: string) => {
            const phase = url.startsWith('https://desired-fixture.vercel.app') || provider.aliasDeployment === 'dpl-desired' ? 'desired' : 'old';
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(readiness(packet, phase)), url };
        },
    });
    const header: EpochHeader = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-08T00:00:00.000Z',
    };
    const storage = new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 });
    const journal = new EpochJournal(storage, { header, now: clock.now, leaseMs: 60_000 });
    const serviceBodies = Object.fromEntries((['preflight', 'paid'] as const).map(role => {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const revision = revisionName(packet, role);
        const oldRevision = packet.oldManifest.source[role].oldRevision;
        const image = `asia-northeast3-docker.pkg.dev/${runtime.project}/workers/${role}@sha256:${'b'.repeat(64)}`;
        return [role, { metadata: { generation: 1 }, spec: { ...runtimeSpec(runtime, image, revision), traffic: [{ revisionName: oldRevision, percent: 100, tag: null }, { revisionName: revision, percent: 0, tag: null }] } }];
    })) as unknown as Record<Role, Readonly<Record<string, unknown>>>;
    const sourceObservation = async ({ role, phase, revision }: { role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }) => {
        const record = provider.readSource(role, phase, revision);
        return { role: record.role, sourceSha: record.sourceSha, revision: record.revision, metadataDigest: record.metadataDigest };
    };
    const buildObservation = async ({ role, revision, image }: { role: Role; phase: 'old' | 'desired'; revision: string; image: string }) => provider.readBuild(role, revision, image);
    const zeroWorkBaseline = async ({ nowMs }: { nowMs: number }) => provider.captureLedgerBaseline(nowMs);
    const zeroWorkObservation = async ({ windowStartMs, windowEndMs, nowMs, baselineDigest }: { windowStartMs: number; windowEndMs: number; nowMs: number; baselineDigest?: string }) => {
        if (baselineDigest === undefined || baselineDigest !== provider.baselineDigest) throw new EpochError('EVIDENCE_UNAVAILABLE');
        const source = packet.protectedObservations.desired.zeroWorkSources;
        return {
            windowStartMs,
            windowEndMs,
            providerLedger: provider.readLedger(source.providerLedger.source, windowStartMs, windowEndMs, nowMs),
            billingLedger: provider.readLedger(source.billingLedger.source, windowStartMs, windowEndMs, nowMs),
            taskAudit: provider.readLedger(source.taskAudit.source, windowStartMs, windowEndMs, nowMs),
            receiverLog: provider.readLedger(source.receiverLog.source, windowStartMs, windowEndMs, nowMs),
        };
    };
    const probe = async ({ role, authority }: { role: Role; runtime: ProtectedRuntimeInput; revision: string; authority: object }) => {
        const target = packet.protectedInputs.desired.runtime[role].target;
        const callerIdentity = packet.protectedInputs.desired.queues[role].target.callerIdentity.identity;
        const receiver = new AuthenticatedReceiverProbe({
            transport: provider,
            authority,
            tokenProvider: async ({ audience, callerIdentity: actualCaller }) => {
                if (audience !== target.audience || actualCaller !== callerIdentity) throw new EpochError('CAPABILITY_BINDING_MISMATCH');
                return 'fixture-receiver-token';
            },
            timeoutMs: 2_000,
        });
        return receiver.malformedBody();
    };
    const ownerDigest = canonicalDigest(options.ownerLabel ?? 'live-vertical-owner');
    const capability = issueCoordinatorCapability(packet, ownerDigest);
    const controlPlane = new LiveEpochControlPlane({
        cloudRun, iam, workPlanes, vercel, publicReadinessUrl: packet.providerScope.publicReadinessUrl,
        projectId: packet.providerScope.vercelProjectId, teamId: packet.providerScope.vercelTeamId,
        deploymentId: packet.providerScope.vercelDeploymentId, expectedOldDeploymentId: packet.providerScope.vercelExpectedOldDeploymentId,
        producerAlias: packet.providerScope.vercelProducerAlias, serviceBodies, journal, capability, ownerDigest,
        renewLease: lease => journal.renew(lease), now: clock.now, sourceObservation, buildObservation,
        zeroWorkBaseline, zeroWorkObservation, probe,
    });
    const coordinator = new EpochCoordinator({ packet, journal, controlPlane, ownerDigest, capability, now: clock.now });
    return { packet, provider, gcs, storage, journal, controlPlane, coordinator, clock };
}

describe('provider-free live adapter vertical', () => {
    it('rejects reviewed Cloud Run body metadata drift before any mutation graph is built', () => {
        const packet = createFixturePacket();
        const bodies = reviewedBodies(packet);
        (bodies.preflight.metadata as Record<string, unknown>).name = 'wrong-service';
        expect(() => validateServiceBodies(packet, bodies)).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects reviewed Cloud Run traffic drift before any mutation graph is built', () => {
        const packet = createFixturePacket();
        const bodies = reviewedBodies(packet);
        const traffic = (bodies.paid.spec as Record<string, unknown>).traffic as Array<Record<string, unknown>>;
        traffic[0] = { ...traffic[0], percent: 99 };
        expect(() => validateServiceBodies(packet, bodies)).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects protected Cloud Run body metadata or revision drift before a PUT', () => {
        const packet = createFixturePacket();
        const metadataDrift = reviewedBodies(packet);
        (metadataDrift.preflight.metadata as Record<string, unknown>).resourceVersion = 'rv-other';
        expect(() => validateServiceBodies(packet, metadataDrift)).toThrow('CAPABILITY_BINDING_MISMATCH');

        const revisionDrift = reviewedBodies(packet);
        const template = (revisionDrift.paid.spec as Record<string, unknown>).template as Record<string, unknown>;
        (template.metadata as Record<string, unknown>).name = 'unreviewed-revision';
        expect(() => validateServiceBodies(packet, revisionDrift)).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('builds the default production graph with concrete collectors and reaches VERIFIED through fake transports', async () => {
        const packet = createFixturePacket();
        const provider = new FakeProvider(packet);
        const gcs = new FakeGcsTransport();
        // The scheduler quiescence contract requires the trusted clock to be
        // at least timeout+grace after the provider's pause update event.
        let nowMs = 200_000;
        const now = () => {
            nowMs += 100;
            nowMs = Math.max(nowMs, provider.lastSupabaseDateMs);
            provider.watermarkMs = nowMs;
            return nowMs;
        };
        const googleTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-google-token', timeoutMs: 2_000 });
        const vercelTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-vercel-token', timeoutMs: 2_000 });
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('default-live-owner'), lockNamespace: packet.lockNamespace,
            ...packet.providerScope, scopeDigest: canonicalDigest(packet.providerScope), vercelToken: 'fixture-vercel-token',
            supabaseServiceRoleBearer: 'fixture-supabase-service-role', supabaseApiKey: 'fixture-supabase-api-key',
            serviceBodies: reviewedBodies(packet), zeroWorkEvidence: reviewedSources(packet),
        } as const;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const request: ProtectedHttpRequest = {
                method: (init?.method ?? 'GET') as ProtectedHttpRequest['method'],
                url: String(input),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                ...(typeof init?.body === 'string' ? { body: init.body } : {}),
            };
            const response = await provider.request(request);
            const fetched = new Response(response.body, { status: response.status, headers: response.headers });
            Object.defineProperty(fetched, 'url', { value: request.url });
            return fetched;
        };
        try {
            const live = await buildLiveBootstrap(packet, descriptor, {
                storage: new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 }),
                now, resolveRetainedHeader: false, googleTransport, vercelTransport,
                vercelPublicTransport: provider, receiverTransport: provider,
                receiverTokenProvider: async () => 'fixture-receiver-token',
                pauseProvenance: async ({ resource }) => {
                    const scheduler = provider.schedulers.get(resource);
                    if (!scheduler) throw new EpochError('EVIDENCE_UNAVAILABLE');
                    const evidence = { resource, operation: 'PAUSE', observedAtMs: now(), pauseEpochMs: scheduler.input.pauseEpochMs };
                    return { resource, pauseEpochMs: scheduler.input.pauseEpochMs, observedAtMs: evidence.observedAtMs, source: 'fixture-pause-log', evidence, evidenceDigest: canonicalDigest(evidence), complete: true };
                },
            });
            expect(live.missingEvidence).toEqual([]);
            const result = await live.coordinator.runThroughVerified();
            expect(result.state).toBe('VERIFIED');
            expect(provider.requests.some(request => new URL(request.url).hostname === 'cloudbuild.googleapis.com')).toBe(true);
            expect(provider.requests.some(request => new URL(request.url).hostname === 'logging.googleapis.com')).toBe(true);
            expect(provider.receiverRequestLogs).toHaveLength(2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('fails protected bootstrap before reservation or provider access when the private Supabase auth path is absent', async () => {
        const packet = createFixturePacket();
        const provider = new FakeProvider(packet);
        const gcs = new FakeGcsTransport();
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('missing-supabase-auth-owner'), lockNamespace: packet.lockNamespace,
            ...packet.providerScope, scopeDigest: canonicalDigest(packet.providerScope), vercelToken: 'fixture-vercel-token',
            serviceBodies: reviewedBodies(packet), zeroWorkEvidence: reviewedSources(packet),
        } as const;
        await expect(buildLiveBootstrap(packet, descriptor, {
            storage: new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 }),
            googleTransport: new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-google-token', timeoutMs: 2_000 }),
        })).rejects.toThrow('EVIDENCE_UNAVAILABLE');
        expect(gcs.requests).toHaveLength(0);
        expect(provider.requests).toHaveLength(0);
    });

    it('preflights authenticated control-plane tokens before a live graph can acquire reservation', async () => {
        const packet = createFixturePacket();
        const gcs = new FakeGcsTransport();
        let tokenCalls = 0;
        const googleTransport = new AuthenticatedProtectedTransport({
            transport: new FakeProvider(packet),
            tokenProvider: async () => { tokenCalls += 1; throw new EpochError('ADAPTER_REQUEST_INVALID'); },
            timeoutMs: 2_000,
        });
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('preflight-auth-owner'), lockNamespace: packet.lockNamespace,
            ...packet.providerScope, scopeDigest: canonicalDigest(packet.providerScope), vercelToken: 'fixture-vercel-token',
            serviceBodies: reviewedBodies(packet), zeroWorkEvidence: null,
        } as const;
        await expect(buildLiveBootstrap(packet, descriptor, {
            storage: new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 }),
            resolveRetainedHeader: false, googleTransport,
        })).rejects.toThrow('ADAPTER_REQUEST_INVALID');
        expect(tokenCalls).toBe(1);
        expect(gcs.writes).toHaveLength(0);
    });

    it('constructs the host-bound Supabase transport from the inherited descriptor credentials', async () => {
        const packet = createFixturePacket();
        const provider = new FakeProvider(packet);
        const gcs = new FakeGcsTransport();
        let nowMs = 200_000;
        const now = () => {
            nowMs += 100;
            nowMs = Math.max(nowMs, provider.lastSupabaseDateMs);
            provider.watermarkMs = nowMs;
            return nowMs;
        };
        const googleTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-google-token', timeoutMs: 2_000 });
        const vercelTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-vercel-token', timeoutMs: 2_000 });
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('descriptor-supabase-auth-owner'), lockNamespace: packet.lockNamespace,
            ...packet.providerScope, scopeDigest: canonicalDigest(packet.providerScope), vercelToken: 'fixture-vercel-token',
            supabaseServiceRoleBearer: 'fixture-supabase-service-role', supabaseApiKey: 'fixture-supabase-api-key',
            serviceBodies: reviewedBodies(packet), zeroWorkEvidence: reviewedSources(packet),
        } as const;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const request: ProtectedHttpRequest = {
                method: (init?.method ?? 'GET') as ProtectedHttpRequest['method'],
                url: String(input),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                ...(typeof init?.body === 'string' ? { body: init.body } : {}),
            };
            const response = await provider.request(request);
            const fetched = new Response(response.body, { status: response.status, headers: response.headers });
            Object.defineProperty(fetched, 'url', { value: request.url });
            return fetched;
        };
        try {
            const live = await buildLiveBootstrap(packet, descriptor, {
                storage: new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 }),
                now, resolveRetainedHeader: false, googleTransport, vercelTransport,
                vercelPublicTransport: provider, receiverTransport: provider, receiverTokenProvider: async () => 'fixture-receiver-token',
                pauseProvenance: async ({ resource }) => {
                    const scheduler = provider.schedulers.get(resource);
                    if (!scheduler) throw new EpochError('EVIDENCE_UNAVAILABLE');
                    const evidence = { resource, operation: 'PAUSE', observedAtMs: now(), pauseEpochMs: scheduler.input.pauseEpochMs };
                    return { resource, pauseEpochMs: scheduler.input.pauseEpochMs, observedAtMs: evidence.observedAtMs, source: 'fixture-pause-log', evidence, evidenceDigest: canonicalDigest(evidence), complete: true };
                },
            });
            const result = await live.coordinator.runThroughVerified();
            expect(result.state).toBe('VERIFIED');
            const supabaseRequests = provider.requests.filter(request => new URL(request.url).hostname === 'supabase.example.invalid');
            expect(supabaseRequests.length).toBeGreaterThan(0);
            expect(supabaseRequests.every(request => request.headers.authorization === 'Bearer fixture-supabase-service-role')) .toBe(true);
            expect(supabaseRequests.every(request => request.headers.apikey === 'fixture-supabase-api-key')).toBe(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects a structured receiver-work event while ignoring the two expected malformed-probe request logs', async () => {
        const packet = createFixturePacket();
        const provider = new FakeProvider(packet);
        provider.injectForbiddenStructuredEventOnProbe = true;
        const gcs = new FakeGcsTransport();
        let nowMs = 200_000;
        const now = () => {
            nowMs += 100;
            nowMs = Math.max(nowMs, provider.lastSupabaseDateMs);
            provider.watermarkMs = nowMs;
            return nowMs;
        };
        const googleTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-google-token', timeoutMs: 2_000 });
        const supabaseTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-supabase-token', timeoutMs: 2_000, additionalAllowedHosts: new Set(['supabase.example.invalid']) });
        const vercelTransport = new AuthenticatedProtectedTransport({ transport: provider, tokenProvider: async () => 'fixture-vercel-token', timeoutMs: 2_000 });
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('structured-event-owner'), lockNamespace: packet.lockNamespace,
            ...packet.providerScope, scopeDigest: canonicalDigest(packet.providerScope), vercelToken: 'fixture-vercel-token',
            serviceBodies: reviewedBodies(packet), zeroWorkEvidence: reviewedSources(packet),
        } as const;
        const live = await buildLiveBootstrap(packet, descriptor, {
            storage: new GcsJournalStorage({ bucket: packet.providerScope.bucket, transport: gcs, tokenProvider: async () => 'fixture-gcs-token', timeoutMs: 2_000 }),
            now, resolveRetainedHeader: false, googleTransport, supabaseTransport, supabaseApiKey: 'fixture-supabase-api-key', vercelTransport,
            vercelPublicTransport: provider, receiverTransport: provider, receiverTokenProvider: async () => 'fixture-receiver-token',
            pauseProvenance: async ({ resource }) => {
                const scheduler = provider.schedulers.get(resource);
                if (!scheduler) throw new EpochError('EVIDENCE_UNAVAILABLE');
                const evidence = { resource, operation: 'PAUSE', observedAtMs: now(), pauseEpochMs: scheduler.input.pauseEpochMs };
                return { resource, pauseEpochMs: scheduler.input.pauseEpochMs, observedAtMs: evidence.observedAtMs, source: 'fixture-pause-log', evidence, evidenceDigest: canonicalDigest(evidence), complete: true };
            },
        });
        await expect(live.coordinator.runThroughVerified()).rejects.toThrow('ZERO_WORK_INCOMPLETE');
        expect(provider.receiverRequestLogs).toHaveLength(2);
    });

    it('runs real adapters through VERIFIED with renewed GCS generations and zero-work evidence', async () => {
        const harness = createHarness();
        const result = await harness.coordinator.runThroughVerified();
        const state = await harness.journal.readValidatedState(result.lease);
        expect(result.state).toBe('VERIFIED');
        expect(state.transitions).toHaveLength(7);
        expect(harness.gcs.requests.length).toBeGreaterThan(0);
        expect(harness.provider.requests.length).toBeGreaterThan(0);
        expect(harness.provider.tasksCreated).toHaveLength(0);
        expect(state.transitions.at(-1)?.toState).toBe('VERIFIED');
    });

    it('rejects denied cold PREPARED admission before any GCS write', async () => {
        const harness = createHarness();
        harness.provider.sourceRecords.set('preflight:old:preflight-old-revision', {
            role: 'preflight', revision: 'preflight-old-revision', sourceSha: 'c'.repeat(40), metadataDigest: harness.packet.protectedObservations.old.source.preflight.metadataDigest,
        });
        await expect(harness.coordinator.runThroughVerified()).rejects.toThrow('SOURCE_INVALID');
        // The common reservation is intentionally acquired before admission,
        // so a rejected cold admission may write reservation objects; it must
        // not initialize the epoch journal/header or capture a baseline.
        expect(harness.gcs.writes.some(request => new URL(request.url).searchParams.get('name')?.includes('/epoch-journal/'))).toBe(false);
        expect(harness.gcs.requests.some(request => request.method === 'POST' && new URL(request.url).searchParams.get('name')?.includes('/epoch-journal/'))).toBe(false);
    });

    it('rejects independent evidence perturbations instead of accepting packet constants', async () => {
        const sourceHarness = createHarness();
        const oldImage = [...sourceHarness.provider.buildRecords.values()].find(record => record.role === 'preflight' && record.revision === 'preflight-old-revision')!.image;
        const oldBuild = sourceHarness.provider.buildRecords.get(oldImage)!;
        sourceHarness.provider.buildRecords.set(oldImage, { ...oldBuild, buildDigest: 'd'.repeat(64) });
        await expect(sourceHarness.coordinator.runThroughVerified()).rejects.toThrow('RUNTIME_MISMATCH');
        expect(sourceHarness.gcs.writes.some(request => new URL(request.url).searchParams.get('name')?.includes('/epoch-journal/'))).toBe(false);

        const evidenceHarness = createHarness();
        const providerLedger = evidenceHarness.packet.protectedObservations.desired.zeroWorkSources.providerLedger.source;
        const ledger = evidenceHarness.provider.ledgers.get(providerLedger)!;
        evidenceHarness.provider.ledgers.set(providerLedger, { ...ledger, events: [{ observedAtMs: 1_000_000, kind: 'receiver-work' }] });
        await expect(evidenceHarness.coordinator.runThroughVerified()).rejects.toThrow('ZERO_WORK_INCOMPLETE');

        const probeHarness = createHarness();
        probeHarness.provider.receiverStatus = 422;
        await expect(probeHarness.coordinator.runThroughVerified()).rejects.toThrow('PROBE_FAILED');
    });

    it('proves the reviewed body image against Cloud Build before the first Cloud Run stage write', async () => {
        const harness = createHarness();
        const desiredImage = [...harness.provider.buildRecords.values()].find(record => record.revision.includes('epoch'))!.image;
        const desiredBuild = harness.provider.buildRecords.get(desiredImage)!;
        harness.provider.buildRecords.set(desiredImage, { ...desiredBuild, buildDigest: 'd'.repeat(64) });
        await expect(harness.coordinator.runThroughVerified()).rejects.toThrow('SOURCE_INVALID');
        expect(harness.provider.requests.some(request => request.method === 'PUT' && new URL(request.url).hostname.endsWith('-run.googleapis.com'))).toBe(false);
    });

    it('recovers a real IAM submutation with a fresh coordinator and owner', async () => {
        const first = createHarness({ interruptAfter: 'iam' });
        await expect(first.coordinator.runThroughVerified()).rejects.toThrow('ADAPTER_TIMEOUT');
        const firstLease = await first.journal.acquire(canonicalDigest('live-vertical-owner'));
        const afterCrash = await first.journal.readValidatedState(firstLease);
        expect(afterCrash.state).toBe('QUEUES_ALIGNED');
        expect([...first.provider.policies.values()].some(policy => policy.bindings.some(binding => binding.member.includes('-desired@')))).toBe(true);
        expect([...first.provider.schedulers.values()].every(item => item.identity.includes('-old@') || item.input.resource.endsWith('/retention'))).toBe(true);

        first.clock.advance(60_001);
        const second = createHarness({ packet: first.packet, provider: first.provider, gcs: first.gcs, clock: first.clock, ownerLabel: 'fresh-live-vertical-owner' });
        const result = await second.coordinator.runThroughVerified();
        expect(result.state).toBe('VERIFIED');
        const final = await second.journal.readValidatedState(result.lease);
        expect(final.transitions.map(transition => transition.toState)).toEqual(['PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED', 'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED']);
        expect([...second.provider.schedulers.values()].some(item => item.identity.includes('-desired@'))).toBe(true);
        expect([...second.provider.queues.values()].every(item => item.httpTarget === null)).toBe(true);
        expect(second.provider.requests.some(request => request.method === 'PATCH' && new URL(request.url).hostname === 'cloudtasks.googleapis.com')).toBe(false);
    });

    it('recovers retained target mutations after the INVOKERS_ROTATED append fails', async () => {
        const harness = createHarness({ failAppendSequence: 5 });
        const run = harness.coordinator.runThroughVerified();
        await expect(run).rejects.toThrow('ADAPTER_TIMEOUT');
        const afterCrash = await harness.journal.readValidatedState(await harness.journal.acquire(canonicalDigest('live-vertical-owner')));
        expect(afterCrash.state).toBe('QUEUES_ALIGNED');
        expect([...harness.provider.schedulers.values()].some(item => item.identity.includes('-desired@'))).toBe(true);
        expect([...harness.provider.queues.values()].every(item => item.httpTarget === null)).toBe(true);

        harness.clock.advance(60_001);
        const fresh = createHarness({ packet: harness.packet, provider: harness.provider, gcs: harness.gcs, clock: harness.clock, ownerLabel: 'fresh-append-owner' });
        const result = await fresh.coordinator.runThroughVerified();
        expect(result.state).toBe('VERIFIED');
        const final = await fresh.journal.readValidatedState(result.lease);
        expect(final.transitions).toHaveLength(7);
        expect(final.transitions.map(transition => transition.toState)).toEqual(['PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED', 'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED']);
    });
});
