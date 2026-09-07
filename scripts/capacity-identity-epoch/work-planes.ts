import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
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

function fail(code: 'RESOURCE_INVALID' | 'PROJECT_MISMATCH' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'PAGINATION_INCOMPLETE' | 'QUEUE_NOT_EMPTY' | 'OBSERVATION_RACE'): never {
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
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
        fail('ADAPTER_RESPONSE_INVALID');
    }
}

function optionalTimestamp(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) fail('ADAPTER_RESPONSE_INVALID');
    return parsed;
}

export type WorkTaskObservation = Readonly<{
    name: string;
    payloadDigest: string;
    createTime: string;
}>;

export type QueueObservation = Readonly<{
    resource: string;
    project: string;
    location: string;
    state: 'PAUSED' | 'RUNNING';
    configuration: Readonly<Record<string, unknown>>;
    configurationDigest: string;
    tasks: readonly WorkTaskObservation[];
    complete: boolean;
}>;

export type SchedulerObservation = Readonly<{
    resource: string;
    project: string;
    location: string;
    state: 'PAUSED' | 'ENABLED';
    pauseEpochMs: number;
    lastAttemptMs: number | null;
    configuration: Readonly<Record<string, unknown>>;
    configurationDigest: string;
}>;

export type WorkPlaneClientOptions = Readonly<{ transport: AuthenticatedProtectedTransport }>;

/** Cloud Tasks and Cloud Scheduler adapters. No synthetic task is ever created. */
export class WorkPlaneClient {
    private readonly transport: AuthenticatedProtectedTransport;

    constructor(options: WorkPlaneClientOptions) {
        this.transport = options.transport;
    }

    async observeQueue(input: ProtectedQueueInput): Promise<QueueObservation> {
        const { location } = parseQueueResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const config = await this.getQueue(input);
        const tasks = await this.listTasks(input);
        const state = config.state;
        return {
            resource: input.resource,
            project: input.project,
            location: input.location,
            state,
            configuration: config.configuration,
            configurationDigest: canonicalDigest(config.configuration),
            tasks,
            complete: true,
        };
    }

    async pauseQueue(input: ProtectedQueueInput): Promise<QueueObservation> {
        return this.changeQueueState(input, 'pause');
    }

    async resumeQueue(input: ProtectedQueueInput): Promise<QueueObservation> {
        return this.changeQueueState(input, 'resume');
    }

    async observeScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getScheduler(input);
        const state = job.state;
        if (state !== 'PAUSED' && state !== 'ENABLED') fail('ADAPTER_RESPONSE_INVALID');
        const pauseEpochMs = state === 'PAUSED'
            ? optionalTimestamp(job.updateTime) ?? 0
            : 0;
        if (state === 'PAUSED' && pauseEpochMs <= 0) fail('ADAPTER_RESPONSE_INVALID');
        const lastAttemptMs = optionalTimestamp(job.status && object(job.status).lastAttemptTime);
        return {
            resource: input.resource,
            project: input.project,
            location: input.location,
            state,
            pauseEpochMs,
            lastAttemptMs,
            configuration: this.schedulerConfiguration(job),
            configurationDigest: canonicalDigest(this.schedulerConfiguration(job)),
        };
    }

    async pauseScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        return this.changeSchedulerState(input, 'pause');
    }

    async resumeScheduler(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        return this.changeSchedulerState(input, 'resume');
    }

    async updateSchedulerTarget(input: ProtectedSchedulerInput): Promise<SchedulerObservation> {
        const before = await this.getScheduler(input);
        const target = object(before.httpTarget ?? before.appEngineHttpTarget ?? before.pubsubTarget ?? {});
        if (canonicalDigest(target) !== canonicalDigest(input.target)) fail('OBSERVATION_RACE');
        const path = `/v1/${input.resource}`;
        const { value } = await this.transport.json({
            method: 'PATCH',
            url: `https://cloudscheduler.googleapis.com${path}?updateMask=${encodeURIComponent('httpTarget')}`,
            allowedHosts: SCHEDULER_HOSTS,
            allowedPath: candidate => candidate === path,
            allowedQueryKeys: ['updateMask'],
            body: { httpTarget: input.target },
            acceptedStatuses: [200],
        });
        const after = this.schedulerObservation(input, object(value));
        if (after.configurationDigest === canonicalDigest(this.schedulerConfiguration(before))) fail('OBSERVATION_RACE');
        return after;
    }

    async observeRetention(input: ProtectedRetentionInput): Promise<Readonly<{ resource: string; enabled: boolean; configurationDigest: string }>> {
        const { location } = parseSchedulerResource(input.resource, input.project);
        if (location !== input.location) fail('RESOURCE_INVALID');
        const job = await this.getSchedulerRecord(input.resource, input.project);
        const state = job.state;
        if (state !== 'ENABLED' && state !== 'PAUSED') fail('ADAPTER_RESPONSE_INVALID');
        const configuration = this.schedulerConfiguration(job);
        return { resource: input.resource, enabled: state === 'ENABLED', configurationDigest: canonicalDigest(configuration) };
    }

    private async getQueue(input: ProtectedQueueInput): Promise<{ state: 'PAUSED' | 'RUNNING'; configuration: Record<string, unknown> }> {
        const path = `/v2/${input.resource}`;
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://cloudtasks.googleapis.com${path}`,
            allowedHosts: TASKS_HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
        });
        const queue = object(value);
        const state = queue.state;
        if (state !== 'PAUSED' && state !== 'RUNNING') fail('ADAPTER_RESPONSE_INVALID');
        const configuration = this.queueConfiguration(queue);
        return { state, configuration };
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
                method: 'GET',
                url: `https://cloudtasks.googleapis.com${path}?${params.toString()}`,
                allowedHosts: TASKS_HOSTS,
                allowedPath: candidate => candidate === path,
                allowedQueryKeys: pageToken ? ['pageSize', 'pageToken', 'responseView'] : ['pageSize', 'responseView'],
                acceptedStatuses: [200],
            });
            const body = object(value);
            if (body.tasks !== undefined && !Array.isArray(body.tasks)) fail('ADAPTER_RESPONSE_INVALID');
            for (const item of (body.tasks ?? []) as unknown[]) {
                const task = object(item);
                if (typeof task.name !== 'string' || task.name.length === 0 || task.name.length > 512 || seenTasks.has(task.name)) fail('ADAPTER_RESPONSE_INVALID');
                const createTime = task.createTime;
                if (typeof createTime !== 'string' || !Number.isFinite(Date.parse(createTime))) fail('ADAPTER_RESPONSE_INVALID');
                const httpRequest = task.httpRequest === undefined ? {} : object(task.httpRequest);
                const bodyValue = typeof httpRequest.body === 'string' ? httpRequest.body : '';
                seenTasks.add(task.name);
                results.push({ name: task.name, payloadDigest: canonicalDigest(bodyValue), createTime });
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
            method: 'POST',
            url: `https://cloudtasks.googleapis.com${path}`,
            allowedHosts: TASKS_HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
            body: {},
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
            method: 'GET',
            url: `https://cloudscheduler.googleapis.com${path}`,
            allowedHosts: SCHEDULER_HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
        });
        return object(value);
    }

    private async changeSchedulerState(input: ProtectedSchedulerInput, action: 'pause' | 'resume'): Promise<SchedulerObservation> {
        const path = `/v1/${input.resource}:${action}`;
        await this.transport.json({
            method: 'POST',
            url: `https://cloudscheduler.googleapis.com${path}`,
            allowedHosts: SCHEDULER_HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200],
            body: {},
        });
        const after = await this.observeScheduler(input);
        if ((action === 'pause' && after.state !== 'PAUSED') || (action === 'resume' && after.state !== 'ENABLED')) fail('OBSERVATION_RACE');
        return after;
    }

    private schedulerObservation(input: ProtectedSchedulerInput, job: Record<string, unknown>): SchedulerObservation {
        const state = job.state;
        if (state !== 'PAUSED' && state !== 'ENABLED') fail('ADAPTER_RESPONSE_INVALID');
        const configuration = this.schedulerConfiguration(job);
        const pauseEpochMs = state === 'PAUSED' ? optionalTimestamp(job.updateTime) ?? 0 : 0;
        if (state === 'PAUSED' && pauseEpochMs <= 0) fail('ADAPTER_RESPONSE_INVALID');
        const status = job.status === undefined ? null : object(job.status);
        return {
            resource: input.resource,
            project: input.project,
            location: input.location,
            state,
            pauseEpochMs,
            lastAttemptMs: status ? optionalTimestamp(status.lastAttemptTime) : null,
            configuration,
            configurationDigest: canonicalDigest(configuration),
        };
    }

    private schedulerConfiguration(job: Record<string, unknown>): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
        for (const key of ['schedule', 'timeZone', 'httpTarget', 'retryConfig', 'attemptDeadline', 'pubsubTarget', 'appEngineHttpTarget']) {
            if (job[key] !== undefined) configuration[key] = job[key];
        }
        return configuration;
    }

    private queueConfiguration(queue: Record<string, unknown>): Record<string, unknown> {
        const configuration: Record<string, unknown> = {};
        for (const key of ['rateLimits', 'retryConfig', 'stackdriverLoggingConfig']) {
            if (queue[key] !== undefined) configuration[key] = queue[key];
        }
        return configuration;
    }
}

export { EpochError };
