import {
    EpochError,
    canonicalQueueConfiguration,
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isObject,
    type ProtectedIdentity,
    type ProtectedQueueInput,
    type ProtectedSchedulerInput,
    type ProtectedRetentionInput,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';
import { requireLeaseCheck, type LeaseCheck } from './lease-capability';

const TASKS_HOSTS = new Set(['cloudtasks.googleapis.com']);
const SCHEDULER_HOSTS = new Set(['cloudscheduler.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const QUEUE_RESOURCE = /^[A-Za-z0-9-]{1,100}$/;
const SCHEDULER_RESOURCE = /^[A-Za-z0-9_-]{1,500}$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_TIMEOUT' | 'PAGINATION_INCOMPLETE' | 'QUEUE_NOT_EMPTY' | 'OBSERVATION_RACE' | 'EVIDENCE_UNAVAILABLE' | 'LOCK_LOST'): never {
    epochFail(code);
}

function parseQueueResource(resource: string, project: string): { location: string; name: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/);
    if (!match || match[1] !== project || !PROJECT.test(project) || !LOCATION.test(match[2]!) || !QUEUE_RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
    return { location: match[2]!, name: match[3]! };
}

function parseSchedulerResource(resource: string, project: string): { location: string; name: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/);
    if (!match || match[1] !== project || !PROJECT.test(project) || !LOCATION.test(match[2]!) || !SCHEDULER_RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
    return { location: match[2]!, name: match[3]! };
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

function assertPageToken(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) fail('ADAPTER_RESPONSE_INVALID');
}

function timestamp(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) fail('ADAPTER_RESPONSE_INVALID');
    return parsed;
}

export type WorkTaskObservation = Readonly<{ name: string; payloadDigest: string; createTime: string }>;

/** Actual Cloud Tasks HTTP target facts; URL is null when there is no URI override. */
export type QueueTargetObservation = Readonly<{
    url: string | null;
    audience: string;
    callerIdentity: ProtectedIdentity;
    uriOverride: Readonly<Record<string, unknown>> | null;
    /** Digest of all non-OIDC Cloud Tasks HTTP-target wire fields. */
    wireConfigurationDigest: string;
}>;

export type QueueObservation = Readonly<{
    resource: string; project: string; location: string; state: 'PAUSED' | 'RUNNING';
    target: QueueTargetObservation | null;
    /** Presence is a provider fact; absence is never replaced with packet input. */
    httpTargetPresent: boolean;
    configuration: Readonly<Record<string, unknown>>; configurationDigest: string;
    tasks: readonly WorkTaskObservation[]; complete: boolean;
}>;

export type SchedulerTargetObservation = Readonly<{ uri: string; audience: string; identity: ProtectedIdentity }>;

export type SchedulerObservation = Readonly<{
    resource: string; project: string; location: string; state: 'PAUSED' | 'ENABLED';
    pauseEpochMs: number; lastAttemptMs: number | null; target: SchedulerTargetObservation;
    configuration: Readonly<Record<string, unknown>>; configurationDigest: string;
}>;

/** Independent, resource-correlated evidence for a completed pause. */
export type PauseProvenance = Readonly<{
    resource: string;
    pauseEpochMs: number;
    observedAtMs: number;
    source: string;
    /** Correlated provider event/object payload retained only in memory. */
    evidence: Readonly<Record<string, unknown>>;
    evidenceDigest: string;
    complete: true;
}>;

export type WorkPlaneClientOptions = Readonly<{
    transport: AuthenticatedProtectedTransport;
    /** Independent correlated evidence of the last PAUSE, never a success bit. */
    pauseProvenance?: (input: Readonly<{ resource: string; project: string; location: string; signal?: AbortSignal }>) => Promise<PauseProvenance>;
    /** Legacy compatibility flag; without an injected collector, provenance fails closed. */
    defaultPauseProvenance?: boolean;
    pauseProvenanceTimeoutMs?: number;
    now?: () => number;
}>;

/** Cloud Tasks and Cloud Scheduler adapters. No synthetic task is ever created. */
export class WorkPlaneClient {
    private readonly transport: AuthenticatedProtectedTransport;
    private readonly pauseProvenance?: (input: Readonly<{ resource: string; project: string; location: string; signal?: AbortSignal }>) => Promise<PauseProvenance>;
    private readonly pauseProvenanceTimeoutMs: number;
    private readonly now: () => number;

    constructor(options: WorkPlaneClientOptions) {
        this.transport = options.transport;
        this.pauseProvenance = options.pauseProvenance
            ?? (options.defaultPauseProvenance ? this.collectPauseProvenance.bind(this) : undefined);
        this.pauseProvenanceTimeoutMs = options.pauseProvenanceTimeoutMs ?? 15_000;
        if (!Number.isSafeInteger(this.pauseProvenanceTimeoutMs) || this.pauseProvenanceTimeoutMs <= 0 || this.pauseProvenanceTimeoutMs > 120_000) fail('ADAPTER_REQUEST_INVALID');
        this.now = options.now ?? (() => Date.now());
    }

    async observeQueue(input: ProtectedQueueInput): Promise<QueueObservation> {
        const { location } = parseQueueResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const config = await this.getQueue(input);
        const tasks = await this.listTasks(input);
        return { resource: input.resource, project: input.project, location: input.location, state: config.state, target: config.target, httpTargetPresent: config.httpTarget !== null, configuration: config.configuration, configurationDigest: canonicalDigest(config.configuration), tasks, complete: true };
    }

    async pauseQueue(input: ProtectedQueueInput, leaseCheck?: LeaseCheck): Promise<QueueObservation> { return this.changeQueueState(input, 'pause', leaseCheck, 'queue.pause'); }
    async resumeQueue(input: ProtectedQueueInput, leaseCheck?: LeaseCheck): Promise<QueueObservation> { return this.changeQueueState(input, 'resume', leaseCheck, 'queue.resume'); }

    async observeScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getScheduler(input);
        return this.schedulerObservation(input, job);
    }

    /**
     * Scheduler GET updateTime is mutable object state, not independent pause
     * provenance.  A live bootstrap must inject a correlated audit collector;
     * this legacy fallback therefore fails closed.
     */
    async collectPauseProvenance(): Promise<PauseProvenance> {
        fail('EVIDENCE_UNAVAILABLE');
    }

    async pauseScheduler(input: ProtectedSchedulerInput, leaseCheck?: LeaseCheck): Promise<SchedulerObservation> { return this.changeSchedulerState(input, 'pause', leaseCheck, 'scheduler.pause'); }
    async resumeScheduler(input: ProtectedSchedulerInput, leaseCheck?: LeaseCheck): Promise<SchedulerObservation> { return this.changeSchedulerState(input, 'resume', leaseCheck, 'scheduler.resume'); }

    /**
     * Align a paused Scheduler OIDC target. Internal packet targets are not
     * sent over the wire: the provider's httpTarget/oidcToken shape is used,
     * and both the expected old and desired target are required.
     */
    async updateSchedulerTarget(options: Readonly<{
        input: ProtectedSchedulerInput;
        expectedOldTarget: SchedulerTargetObservation;
        desiredTarget: SchedulerTargetObservation;
        leaseCheck?: LeaseCheck;
    }>): Promise<SchedulerObservation> {
        const leaseCheck = requireLeaseCheck(options.leaseCheck, { operation: 'scheduler.target', resource: options.input.resource });
        await leaseCheck();
        const before = await this.getScheduler(options.input);
        const beforeObservation = await this.schedulerObservation(options.input, before, leaseCheck);
        if (beforeObservation.state !== 'PAUSED'
            || beforeObservation.configurationDigest !== canonicalDigest(options.input.configuration)) fail('OBSERVATION_RACE');
        if (canonicalDigest(beforeObservation.target) === canonicalDigest(options.desiredTarget)) return beforeObservation;
        if (canonicalDigest(beforeObservation.target) !== canonicalDigest(options.expectedOldTarget)) fail('OBSERVATION_RACE');
        const path = `/v1/${options.input.resource}`;
        const currentHttpTarget = object(before.httpTarget);
        const wireTarget = { ...currentHttpTarget, uri: options.desiredTarget.uri, oidcToken: { serviceAccountEmail: options.desiredTarget.identity.identity, audience: options.desiredTarget.audience } };
        await leaseCheck();
        await this.transport.json({
            method: 'PATCH', url: `https://cloudscheduler.googleapis.com${path}?updateMask=${encodeURIComponent('httpTarget')}`,
            allowedHosts: SCHEDULER_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['PATCH'], allowedQueryKeys: ['updateMask'],
            body: { httpTarget: wireTarget }, acceptedStatuses: [200], beforeDispatch: leaseCheck,
        });
        await leaseCheck();
        const after = await this.schedulerObservation(options.input, await this.getScheduler(options.input), leaseCheck);
        if (after.state !== 'PAUSED' || canonicalDigest(after.target) !== canonicalDigest(options.desiredTarget)) fail('OBSERVATION_RACE');
        return after;
    }

    async updateQueueTarget(options: Readonly<{
        input: ProtectedQueueInput;
        expectedOldTarget: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>;
        desiredTarget: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>;
        leaseCheck?: LeaseCheck;
    }>): Promise<QueueObservation> {
        const leaseCheck = requireLeaseCheck(options.leaseCheck, { operation: 'queue.target', resource: options.input.resource });
        await leaseCheck();
        const beforeRecord = await this.getQueue({ ...options.input, target: options.expectedOldTarget });
        await leaseCheck();
        const before = { resource: options.input.resource, project: options.input.project, location: options.input.location, state: beforeRecord.state, target: beforeRecord.target, httpTargetPresent: beforeRecord.httpTarget !== null, configuration: beforeRecord.configuration, configurationDigest: canonicalDigest(beforeRecord.configuration), tasks: await this.listTasks(options.input, leaseCheck), complete: true as const };
        if (before.state !== 'PAUSED' || !queueConfigurationMatches(before.configuration, options.input.configuration)) fail('OBSERVATION_RACE');
        if (beforeRecord.httpTarget === null) fail('OBSERVATION_RACE');
        if (queueTargetMatches(before.target, options.desiredTarget)) return before;
        if (!queueTargetMatches(before.target, options.expectedOldTarget)) fail('OBSERVATION_RACE');
        const path = `/v2/${options.input.resource}`;
        const wireTarget = { ...beforeRecord.httpTarget, oidcToken: { serviceAccountEmail: options.desiredTarget.callerIdentity.identity, audience: options.desiredTarget.audience } };
        await leaseCheck();
        await this.transport.json({
            method: 'PATCH', url: `https://cloudtasks.googleapis.com${path}?updateMask=${encodeURIComponent('httpTarget')}`,
            allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['PATCH'], allowedQueryKeys: ['updateMask'],
            body: { httpTarget: wireTarget }, acceptedStatuses: [200], beforeDispatch: leaseCheck,
        });
        await leaseCheck();
        const after = await this.observeQueueWithLease(options.input, leaseCheck);
        if (after.state !== 'PAUSED' || !queueTargetMatches(after.target, options.desiredTarget)
            || after.target?.wireConfigurationDigest !== before.target?.wireConfigurationDigest) fail('OBSERVATION_RACE');
        return after;
    }

    async observeRetention(input: ProtectedRetentionInput): Promise<Readonly<{ role: 'retention'; resource: string; project: string; location: string; enabled: boolean; configuration: Readonly<Record<string, unknown>>; configurationDigest: string }>> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getSchedulerRecord(input.resource, input.project);
        const state = job.state;
        if (state !== 'ENABLED' && state !== 'PAUSED') fail('ADAPTER_RESPONSE_INVALID');
        // Retention is a reviewed enablement contract, not a recovery
        // scheduler projection. Keep the provider state and the exact
        // packet-level enabled configuration distinct from scheduler fields.
        const configuration = { enabled: state === 'ENABLED' };
        return { role: 'retention' as const, resource: input.resource, project: input.project, location: input.location, enabled: state === 'ENABLED', configuration, configurationDigest: canonicalDigest(configuration) };
    }

    private async observeQueueWithLease(input: ProtectedQueueInput, leaseCheck?: LeaseCheck): Promise<QueueObservation> {
        const { location } = parseQueueResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        if (leaseCheck) await leaseCheck();
        const config = await this.getQueue(input);
        if (leaseCheck) await leaseCheck();
        const tasks = await this.listTasks(input, leaseCheck);
        return { resource: input.resource, project: input.project, location: input.location, state: config.state, target: config.target, httpTargetPresent: config.httpTarget !== null, configuration: config.configuration, configurationDigest: canonicalDigest(config.configuration), tasks, complete: true };
    }

    private async getQueue(input: ProtectedQueueInput): Promise<{ state: 'PAUSED' | 'RUNNING'; target: QueueTargetObservation | null; configuration: Record<string, unknown>; httpTarget: Record<string, unknown> | null }> {
        const path = `/v2/${input.resource}`;
        const { value } = await this.transport.json({
            method: 'GET', url: `https://cloudtasks.googleapis.com${path}`, allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200],
        });
        const queue = object(value);
        const state = queue.state;
        if (state !== 'PAUSED' && state !== 'RUNNING') fail('ADAPTER_RESPONSE_INVALID');
        const httpTarget = queue.httpTarget === undefined ? null : object(queue.httpTarget);
        return { state, target: this.queueTarget(queue, input), configuration: this.queueConfiguration(queue), httpTarget };
    }

    private async listTasks(input: ProtectedQueueInput, leaseCheck?: LeaseCheck): Promise<readonly WorkTaskObservation[]> {
        const path = `/v2/${input.resource}/tasks`;
        const results: WorkTaskObservation[] = [];
        const seenTokens = new Set<string>();
        const seenTasks = new Set<string>();
        let pageToken: string | undefined;
        for (let page = 0; page < 100; page += 1) {
            if (leaseCheck) await leaseCheck();
            const params = new URLSearchParams({ pageSize: '1000', responseView: 'FULL' });
            if (pageToken) params.set('pageToken', pageToken);
            const { value } = await this.transport.json({
                method: 'GET', url: `https://cloudtasks.googleapis.com${path}?${params.toString()}`, allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path,
                allowedMethods: ['GET'], allowedQueryKeys: pageToken ? ['pageSize', 'pageToken', 'responseView'] : ['pageSize', 'responseView'], acceptedStatuses: [200],
            });
            const body = object(value);
            if (body.tasks !== undefined && !Array.isArray(body.tasks)) fail('ADAPTER_RESPONSE_INVALID');
            for (const item of (body.tasks ?? []) as unknown[]) {
                const task = object(item);
                if (typeof task.name !== 'string' || task.name.length === 0 || task.name.length > 512 || seenTasks.has(task.name)) fail('ADAPTER_RESPONSE_INVALID');
                if (typeof task.createTime !== 'string' || !Number.isFinite(Date.parse(task.createTime))) fail('ADAPTER_RESPONSE_INVALID');
                const request = task.httpRequest === undefined ? {} : object(task.httpRequest);
                const bodyValue = typeof request.body === 'string' ? request.body : '';
                seenTasks.add(task.name);
                results.push({ name: task.name, payloadDigest: canonicalDigest(bodyValue), createTime: task.createTime });
            }
            // Cloud APIs use both an omitted token and an empty token for the
            // terminal page.  Treat either as complete; an actual repeated
            // non-empty token remains a pagination failure.
            if (body.nextPageToken === undefined || body.nextPageToken === '') return results;
            assertPageToken(body.nextPageToken);
            if (seenTokens.has(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            seenTokens.add(body.nextPageToken);
            pageToken = body.nextPageToken;
        }
        fail('PAGINATION_INCOMPLETE');
    }

    private async changeQueueState(input: ProtectedQueueInput, action: 'pause' | 'resume', leaseCheckInput: LeaseCheck | undefined, operation: 'queue.pause' | 'queue.resume'): Promise<QueueObservation> {
        const leaseCheck = requireLeaseCheck(leaseCheckInput, { operation, resource: input.resource });
        const parsed = parseQueueResource(input.resource, input.project);
        if (parsed.location !== input.location) fail('RESOURCE_INVALID');
        const before = await this.observeQueueWithLease(input, leaseCheck);
        const targetMatches = before.target === null
            ? !isObject(input.configuration.httpTarget)
            : queueTargetMatches(before.target, input.target);
        if (!targetMatches || !queueConfigurationMatches(before.configuration, input.configuration)) fail('OBSERVATION_RACE');
        if ((action === 'pause' && before.state === 'PAUSED') || (action === 'resume' && before.state === 'RUNNING')) return before;
        const path = `/v2/${input.resource}:${action}`;
        await leaseCheck();
        await this.transport.json({
            method: 'POST', url: `https://cloudtasks.googleapis.com${path}`, allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body: {}, beforeDispatch: leaseCheck,
        });
        await leaseCheck();
        const after = await this.observeQueueWithLease(input, leaseCheck);
        if ((action === 'pause' && after.state !== 'PAUSED') || (action === 'resume' && after.state !== 'RUNNING')) fail('OBSERVATION_RACE');
        return after;
    }

    private async getScheduler(input: ProtectedSchedulerInput): Promise<Record<string, unknown>> {
        return this.getSchedulerRecord(input.resource, input.project);
    }

    private async getSchedulerRecord(resource: string, project: string): Promise<Record<string, unknown>> {
        parseSchedulerResource(resource, project);
        const path = `/v1/${resource}`;
        const { value } = await this.transport.json({
            method: 'GET', url: `https://cloudscheduler.googleapis.com${path}`, allowedHosts: SCHEDULER_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200],
        });
        return object(value);
    }

    private async changeSchedulerState(input: ProtectedSchedulerInput, action: 'pause' | 'resume', leaseCheckInput: LeaseCheck | undefined, operation: 'scheduler.pause' | 'scheduler.resume'): Promise<SchedulerObservation> {
        const leaseCheck = requireLeaseCheck(leaseCheckInput, { operation, resource: input.resource });
        const parsed = parseSchedulerResource(input.resource, input.project);
        if (parsed.location !== input.location) fail('RESOURCE_INVALID');
        await leaseCheck();
        const before = await this.schedulerObservation(input, await this.getScheduler(input), leaseCheck);
        if (canonicalDigest(before.target) !== canonicalDigest(input.target)
            || canonicalDigest(before.configuration) !== canonicalDigest(input.configuration)) fail('OBSERVATION_RACE');
        if ((action === 'pause' && before.state === 'PAUSED') || (action === 'resume' && before.state === 'ENABLED')) return before;
        const path = `/v1/${input.resource}:${action}`;
        await leaseCheck();
        await this.transport.json({
            method: 'POST', url: `https://cloudscheduler.googleapis.com${path}`, allowedHosts: SCHEDULER_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body: {}, beforeDispatch: leaseCheck,
        });
        await leaseCheck();
        const after = await this.schedulerObservation(input, await this.getScheduler(input), leaseCheck);
        if ((action === 'pause' && after.state !== 'PAUSED') || (action === 'resume' && after.state !== 'ENABLED')) fail('OBSERVATION_RACE');
        return after;
    }

    private async schedulerObservation(input: ProtectedSchedulerInput, job: Record<string, unknown>, leaseCheck?: LeaseCheck): Promise<SchedulerObservation> {
        const state = job.state;
        if (state !== 'PAUSED' && state !== 'ENABLED') fail('ADAPTER_RESPONSE_INVALID');
        const target = this.schedulerTarget(job, input.project);
        const lastAttemptMs = timestamp(job.lastAttemptTime);
        let pauseEpochMs = 0;
        if (state === 'PAUSED') {
            if (!this.pauseProvenance) fail('EVIDENCE_UNAVAILABLE');
            const controller = new AbortController();
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let provenance: PauseProvenance;
            try {
                if (leaseCheck) await leaseCheck();
                provenance = await Promise.race([
                    this.pauseProvenance({ resource: input.resource, project: input.project, location: input.location, signal: controller.signal }),
                    new Promise<PauseProvenance>((_, reject) => {
                        timeoutHandle = setTimeout(() => { controller.abort(); reject(new EpochError('ADAPTER_TIMEOUT')); }, this.pauseProvenanceTimeoutMs);
                    }),
                ]);
            } catch (error) {
                if (error instanceof EpochError) throw error;
                fail('EVIDENCE_UNAVAILABLE');
            } finally {
                if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                controller.abort();
            }
            if (leaseCheck) await leaseCheck();
            if (!isObject(provenance)
                || !hasExactKeys(provenance, ['resource', 'pauseEpochMs', 'observedAtMs', 'source', 'evidence', 'evidenceDigest', 'complete'])
                || provenance.resource !== input.resource
                || provenance.complete !== true
                || typeof provenance.source !== 'string' || provenance.source.length === 0 || provenance.source.length > 2048
                || /[\u0000-\u001f\u007f]/.test(provenance.source)
                || !isObject(provenance.evidence)
                || provenance.evidence.resource !== input.resource
                || provenance.evidence.operation !== 'PAUSE'
                || typeof provenance.evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(provenance.evidenceDigest)
                || canonicalDigest(provenance.evidence) !== provenance.evidenceDigest
                || !Number.isSafeInteger(provenance.pauseEpochMs) || provenance.pauseEpochMs <= 0
                || !Number.isSafeInteger(provenance.observedAtMs) || provenance.observedAtMs < provenance.pauseEpochMs
                || provenance.observedAtMs > this.now()) fail('EVIDENCE_UNAVAILABLE');
            pauseEpochMs = provenance.pauseEpochMs;
        }
        const configuration = this.schedulerConfiguration(job, input);
        return { resource: input.resource, project: input.project, location: input.location, state, pauseEpochMs, lastAttemptMs, target, configuration, configurationDigest: canonicalDigest(configuration) };
    }

    private schedulerTarget(job: Record<string, unknown>, project: string): SchedulerTargetObservation {
        const httpTarget = object(job.httpTarget);
        if (typeof httpTarget.uri !== 'string' || !/^https:\/\/[^\s]+$/.test(httpTarget.uri)) fail('ADAPTER_RESPONSE_INVALID');
        const oidcToken = object(httpTarget.oidcToken);
        if (typeof oidcToken.serviceAccountEmail !== 'string' || !SERVICE_ACCOUNT.test(oidcToken.serviceAccountEmail)
            || SERVICE_ACCOUNT.exec(oidcToken.serviceAccountEmail)?.[1] !== project || typeof oidcToken.audience !== 'string' || !/^https:\/\/[^\s]+$/.test(oidcToken.audience)) fail('ADAPTER_RESPONSE_INVALID');
        return { uri: httpTarget.uri, audience: oidcToken.audience, identity: { identity: oidcToken.serviceAccountEmail, project } };
    }

    private schedulerConfiguration(job: Record<string, unknown>, input: ProtectedSchedulerInput): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
        for (const key of ['schedule', 'timeZone', 'retryConfig', 'attemptDeadline', 'pubsubTarget', 'appEngineHttpTarget']) if (job[key] !== undefined) configuration[key] = job[key];
        const httpTarget = isObject(job.httpTarget) ? job.httpTarget : undefined;
        if (httpTarget && typeof httpTarget.httpMethod === 'string') configuration.method = httpTarget.httpMethod;
        if (httpTarget) {
            const stableTarget = { ...httpTarget };
            delete stableTarget.uri;
            delete stableTarget.oidcToken;
            const expectedWire = input.configuration.httpTarget;
            if (expectedWire !== undefined) {
                if (!isObject(expectedWire) || canonicalDigest(expectedWire) !== canonicalDigest(stableTarget)) fail('RESOURCE_INVALID');
                configuration.httpTarget = stableTarget;
            } else {
                delete stableTarget.httpMethod;
                if (Object.keys(stableTarget).length !== 0) fail('RESOURCE_INVALID');
            }
        }
        return configuration;
    }

    private queueConfiguration(queue: Record<string, unknown>): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
        // Preserve the complete provider configuration in the canonical queue
        // observation.  The evidence collector independently checks
        // samplingRatio=1, while this projection ensures drift cannot be
        // hidden from the packet's queue/configuration digest.
        for (const key of ['rateLimits', 'retryConfig', 'stackdriverLoggingConfig']) if (queue[key] !== undefined) configuration[key] = queue[key];
        return configuration;
    }

    private queueTarget(queue: Record<string, unknown>, input: ProtectedQueueInput): QueueTargetObservation | null {
        if (queue.httpTarget === undefined) {
            if (isObject(input.configuration.httpTarget)) fail('RESOURCE_INVALID');
            return null;
        }
        const httpTarget = object(queue.httpTarget);
        if (httpTarget.uri !== undefined) fail('ADAPTER_RESPONSE_INVALID');
        const oidcToken = object(httpTarget.oidcToken);
        if (typeof oidcToken.serviceAccountEmail !== 'string' || !SERVICE_ACCOUNT.test(oidcToken.serviceAccountEmail)
            || SERVICE_ACCOUNT.exec(oidcToken.serviceAccountEmail)?.[1] !== input.project || typeof oidcToken.audience !== 'string' || !/^https:\/\/[^\s]+$/.test(oidcToken.audience)
        ) fail('ADAPTER_RESPONSE_INVALID');
        const override = httpTarget.uriOverride;
        let overrideObject: Record<string, unknown> | null = null;
        if (override !== undefined) {
            overrideObject = object(override);
            if (Object.keys(overrideObject).some(key => !['scheme', 'host', 'port', 'pathOverride', 'queryOverride', 'uriOverrideEnforceMode'].includes(key))) fail('ADAPTER_RESPONSE_INVALID');
            if (!isObject(input.configuration.httpTarget) || canonicalDigest((input.configuration.httpTarget as Record<string, unknown>).uriOverride ?? null) !== canonicalDigest(overrideObject)) fail('RESOURCE_INVALID');
        } else if (isObject(input.configuration.httpTarget) && (input.configuration.httpTarget as Record<string, unknown>).uriOverride !== undefined) {
            fail('RESOURCE_INVALID');
        }
        // Cloud Tasks has no Scheduler-style httpTarget.uri. Preserve the
        // actual OIDC tuple and override presence; never claim the packet's
        // reviewed URL as an observed provider URL.
        const stableTarget = { ...httpTarget };
        delete stableTarget.oidcToken;
        const expectedWire = input.configuration.httpTarget;
        if (expectedWire !== undefined
            ? (!isObject(expectedWire) || canonicalDigest(expectedWire) !== canonicalDigest(stableTarget))
            : Object.keys(stableTarget).length !== 0) fail('RESOURCE_INVALID');
        return {
            url: null,
            audience: oidcToken.audience,
            callerIdentity: { identity: oidcToken.serviceAccountEmail, project: input.project },
            uriOverride: overrideObject,
            wireConfigurationDigest: canonicalDigest(stableTarget),
        };
    }
}

function queueTargetMatches(actual: QueueTargetObservation | null, expected: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>): boolean {
    return actual !== null
        && actual.audience === expected.audience
        && canonicalDigest(actual.callerIdentity) === canonicalDigest(expected.callerIdentity);
}

/**
 * Protected queue inputs use the reviewed flat rate-limit names while the
 * Cloud Tasks wire response nests them under `rateLimits`.  Normalize only
 * those documented names and compare the complete provider configuration so
 * a pause/resume cannot mutate a resource whose config changed underneath it.
 */
function queueConfigurationMatches(actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): boolean {
    return canonicalDigest(canonicalQueueConfiguration(actual)) === canonicalDigest(canonicalQueueConfiguration(expected));
}

export { EpochError };
