import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type ProtectedIdentity,
    type ProtectedQueueInput,
    type ProtectedSchedulerInput,
    type ProtectedRetentionInput,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';

const TASKS_HOSTS = new Set(['cloudtasks.googleapis.com']);
const SCHEDULER_HOSTS = new Set(['cloudscheduler.googleapis.com']);
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const RESOURCE = /^[a-z][a-z0-9-]{0,62}$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'PAGINATION_INCOMPLETE' | 'QUEUE_NOT_EMPTY' | 'OBSERVATION_RACE' | 'EVIDENCE_UNAVAILABLE'): never {
    epochFail(code);
}

function parseQueueResource(resource: string, project: string): { location: string; name: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/);
    if (!match || match[1] !== project || !PROJECT.test(project) || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
    return { location: match[2]!, name: match[3]! };
}

function parseSchedulerResource(resource: string, project: string): { location: string; name: string } {
    const match = resource.match(/^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/);
    if (!match || match[1] !== project || !PROJECT.test(project) || !LOCATION.test(match[2]!) || !RESOURCE.test(match[3]!)) fail('RESOURCE_INVALID');
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

export type WorkPlaneClientOptions = Readonly<{
    transport: AuthenticatedProtectedTransport;
    /** Independent audit-log/control-plane evidence of the last PAUSE. */
    pauseProvenance?: (resource: string) => Promise<number>;
    now?: () => number;
}>;

/** Cloud Tasks and Cloud Scheduler adapters. No synthetic task is ever created. */
export class WorkPlaneClient {
    private readonly transport: AuthenticatedProtectedTransport;
    private readonly pauseProvenance?: (resource: string) => Promise<number>;
    private readonly now: () => number;

    constructor(options: WorkPlaneClientOptions) {
        this.transport = options.transport;
        this.pauseProvenance = options.pauseProvenance;
        this.now = options.now ?? (() => Date.now());
    }

    async observeQueue(input: ProtectedQueueInput): Promise<QueueObservation> {
        const { location } = parseQueueResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const config = await this.getQueue(input);
        const tasks = await this.listTasks(input);
        return { resource: input.resource, project: input.project, location: input.location, state: config.state, target: config.target, httpTargetPresent: config.httpTarget !== null, configuration: config.configuration, configurationDigest: canonicalDigest(config.configuration), tasks, complete: true };
    }

    async pauseQueue(input: ProtectedQueueInput): Promise<QueueObservation> { return this.changeQueueState(input, 'pause'); }
    async resumeQueue(input: ProtectedQueueInput): Promise<QueueObservation> { return this.changeQueueState(input, 'resume'); }

    async observeScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getScheduler(input);
        return this.schedulerObservation(input, job);
    }

    async pauseScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> { return this.changeSchedulerState(input, 'pause'); }
    async resumeScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> { return this.changeSchedulerState(input, 'resume'); }

    /**
     * Align a paused Scheduler OIDC target. Internal packet targets are not
     * sent over the wire: the provider's httpTarget/oidcToken shape is used,
     * and both the expected old and desired target are required.
     */
    async updateSchedulerTarget(options: Readonly<{
        input: ProtectedSchedulerInput;
        expectedOldTarget: SchedulerTargetObservation;
        desiredTarget: SchedulerTargetObservation;
    }>): Promise<SchedulerObservation> {
        const before = await this.getScheduler(options.input);
        const beforeObservation = await this.schedulerObservation(options.input, before);
        if (beforeObservation.state !== 'PAUSED' || canonicalDigest(beforeObservation.target) !== canonicalDigest(options.expectedOldTarget)) fail('OBSERVATION_RACE');
        const path = `/v1/${options.input.resource}`;
        const currentHttpTarget = object(before.httpTarget);
        const wireTarget = { ...currentHttpTarget, uri: options.desiredTarget.uri, oidcToken: { serviceAccountEmail: options.desiredTarget.identity.identity, audience: options.desiredTarget.audience } };
        await this.transport.json({
            method: 'PATCH', url: `https://cloudscheduler.googleapis.com${path}?updateMask=${encodeURIComponent('httpTarget')}`,
            allowedHosts: SCHEDULER_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['PATCH'], allowedQueryKeys: ['updateMask'],
            body: { httpTarget: wireTarget }, acceptedStatuses: [200],
        });
        const after = await this.schedulerObservation(options.input, await this.getScheduler(options.input));
        if (after.state !== 'PAUSED' || canonicalDigest(after.target) !== canonicalDigest(options.desiredTarget)) fail('OBSERVATION_RACE');
        return after;
    }

    async updateQueueTarget(options: Readonly<{
        input: ProtectedQueueInput;
        expectedOldTarget: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>;
        desiredTarget: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>;
    }>): Promise<QueueObservation> {
        const beforeRecord = await this.getQueue({ ...options.input, target: options.expectedOldTarget });
        const before = { resource: options.input.resource, project: options.input.project, location: options.input.location, state: beforeRecord.state, target: beforeRecord.target, httpTargetPresent: beforeRecord.httpTarget !== null, configuration: beforeRecord.configuration, configurationDigest: canonicalDigest(beforeRecord.configuration), tasks: await this.listTasks(options.input), complete: true as const };
        if (before.state !== 'PAUSED' || !queueTargetMatches(before.target, options.expectedOldTarget)) fail('OBSERVATION_RACE');
        if (beforeRecord.httpTarget === null) fail('OBSERVATION_RACE');
        const path = `/v2/${options.input.resource}`;
        const wireTarget = { ...beforeRecord.httpTarget, oidcToken: { serviceAccountEmail: options.desiredTarget.callerIdentity.identity, audience: options.desiredTarget.audience } };
        await this.transport.json({
            method: 'PATCH', url: `https://cloudtasks.googleapis.com${path}?updateMask=${encodeURIComponent('httpTarget')}`,
            allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['PATCH'], allowedQueryKeys: ['updateMask'],
            body: { httpTarget: wireTarget }, acceptedStatuses: [200],
        });
        const after = await this.observeQueue(options.input);
        if (after.state !== 'PAUSED' || !queueTargetMatches(after.target, options.desiredTarget)) fail('OBSERVATION_RACE');
        return after;
    }

    async observeRetention(input: ProtectedRetentionInput): Promise<Readonly<{ role: 'retention'; resource: string; project: string; location: string; enabled: boolean; configuration: Readonly<Record<string, unknown>>; configurationDigest: string }>> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getSchedulerRecord(input.resource, input.project);
        const state = job.state;
        if (state !== 'ENABLED' && state !== 'PAUSED') fail('ADAPTER_RESPONSE_INVALID');
        const configuration = this.schedulerConfiguration(job);
        return { role: 'retention' as const, resource: input.resource, project: input.project, location: input.location, enabled: state === 'ENABLED', configuration, configurationDigest: canonicalDigest(configuration) };
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

    private async listTasks(input: ProtectedQueueInput): Promise<readonly WorkTaskObservation[]> {
        const path = `/v2/${input.resource}/tasks`;
        const results: WorkTaskObservation[] = [];
        const seenTokens = new Set<string>();
        const seenTasks = new Set<string>();
        let pageToken: string | undefined;
        for (let page = 0; page < 100; page += 1) {
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
            if (body.nextPageToken === undefined) return results;
            assertPageToken(body.nextPageToken);
            if (seenTokens.has(body.nextPageToken)) fail('ADAPTER_RESPONSE_INVALID');
            seenTokens.add(body.nextPageToken);
            pageToken = body.nextPageToken;
        }
        fail('PAGINATION_INCOMPLETE');
    }

    private async changeQueueState(input: ProtectedQueueInput, action: 'pause' | 'resume'): Promise<QueueObservation> {
        const path = `/v2/${input.resource}:${action}`;
        await this.transport.json({
            method: 'POST', url: `https://cloudtasks.googleapis.com${path}`, allowedHosts: TASKS_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body: {},
        });
        const after = await this.observeQueue(input);
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

    private async changeSchedulerState(input: ProtectedSchedulerInput, action: 'pause' | 'resume'): Promise<SchedulerObservation> {
        const path = `/v1/${input.resource}:${action}`;
        await this.transport.json({
            method: 'POST', url: `https://cloudscheduler.googleapis.com${path}`, allowedHosts: SCHEDULER_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body: {},
        });
        const after = await this.observeScheduler(input);
        if ((action === 'pause' && after.state !== 'PAUSED') || (action === 'resume' && after.state !== 'ENABLED')) fail('OBSERVATION_RACE');
        return after;
    }

    private async schedulerObservation(input: ProtectedSchedulerInput, job: Record<string, unknown>): Promise<SchedulerObservation> {
        const state = job.state;
        if (state !== 'PAUSED' && state !== 'ENABLED') fail('ADAPTER_RESPONSE_INVALID');
        const target = this.schedulerTarget(job, input.project);
        const lastAttemptMs = timestamp(job.lastAttemptTime);
        let pauseEpochMs = 0;
        if (state === 'PAUSED') {
            if (!this.pauseProvenance) fail('EVIDENCE_UNAVAILABLE');
            pauseEpochMs = await this.pauseProvenance(input.resource);
            if (!Number.isSafeInteger(pauseEpochMs) || pauseEpochMs < 0 || pauseEpochMs > this.now()) fail('EVIDENCE_UNAVAILABLE');
        }
        const configuration = this.schedulerConfiguration(job);
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

    private schedulerConfiguration(job: Record<string, unknown>): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
        for (const key of ['schedule', 'timeZone', 'retryConfig', 'attemptDeadline', 'pubsubTarget', 'appEngineHttpTarget']) if (job[key] !== undefined) configuration[key] = job[key];
        const httpTarget = isObject(job.httpTarget) ? job.httpTarget : undefined;
        if (httpTarget && typeof httpTarget.httpMethod === 'string') configuration.method = httpTarget.httpMethod;
        return configuration;
    }

    private queueConfiguration(queue: Record<string, unknown>): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
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
        return { url: null, audience: oidcToken.audience, callerIdentity: { identity: oidcToken.serviceAccountEmail, project: input.project }, uriOverride: overrideObject };
    }
}

function queueTargetMatches(actual: QueueTargetObservation | null, expected: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>): boolean {
    return actual !== null
        && actual.audience === expected.audience
        && canonicalDigest(actual.callerIdentity) === canonicalDigest(expected.callerIdentity);
}

export { EpochError };
