import {
    canonicalDigest,
    EpochError,
    epochFail,
    isObject,
    LOCATION_ID_PATTERN,
    PROJECT_ID_PATTERN,
    QUEUE_ID_PATTERN,
    SERVICE_ACCOUNT_ID_PATTERN,
    type EpochErrorCode,
} from './contracts';
import { AuthenticatedProtectedTransport } from './platform';

const CLOUD_TASKS_HOSTS = new Set(['cloudtasks.googleapis.com']);
const TASK_PAGE_SIZE = 1_000;
const MAX_TASK_PAGES = 100;
// Cover the bounded 30-minute apply plus independent verification reads.
// Lease renewal, exact queue conservation and the 31-day retention bound stay independent.
export const MAX_ZERO_WORK_INTERVAL_MS = 45 * 60_000;
const MAX_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_STRING_LENGTH = 8_192;
const TRUSTED_SCOPE = {
    model: 'cooperative-reviewed-workload-conservation',
    projectWideMutationAbsence: 'not-claimed',
    cloudLoggingCompleteness: false,
} as const;

/**
 * The caller supplies only identity names. Credentials, tokens, and key
 * material are intentionally not accepted by this primitive.
 */
export type PausedQueueControlledIdentity =
    string;

export type ReadPausedQueueEvidenceInput = Readonly<{
    project: string;
    queueResources: readonly string[];
    controlledIdentities: readonly PausedQueueControlledIdentity[];
    transport: AuthenticatedProtectedTransport;
    leaseCheck: () => Promise<void>;
    now: () => number;
    intervalStartMs?: number;
}>;

export type PausedQueueEvidence = Readonly<{
    schemaVersion: 'paused-queue-evidence-v1';
    kind: 'paused-queue-conservation';
    project: string;
    queueResources: readonly string[];
    intervalStartMs: number;
    intervalMs: number;
    observedAtMs: number;
    scope: typeof TRUSTED_SCOPE;
    queues: readonly PausedQueueObservation[];
    /**
    * This primitive does not query Cloud Logging and makes no event-stream
     * completeness claim. TaskActivity logs remain a separate supplement.
     */
    cloudLoggingCompleteness: false;
    snapshotDigest: string;
}>;

export type PausedQueueObservation = Readonly<{
    resourceDigest: string;
    state: 'PAUSED';
    configurationDigest: string;
    purgeTime?: string;
    taskInventoryDigest: string;
    taskPageCount: number;
    taskCount: 0;
    complete: true;
}>;

type QueueResource = Readonly<{ resource: string; location: string }>;

type NormalizedReadInput = Readonly<Omit<ReadPausedQueueEvidenceInput, 'intervalStartMs'> & {
    intervalStartMs: number;
}>;

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

function assertBoundedString(value: unknown, max = MAX_STRING_LENGTH): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max
        || /[\u0000-\u001f\u007f]/.test(value)) fail('ADAPTER_RESPONSE_INVALID');
}

function safeProjection(value: unknown, depth = 0): unknown {
    if (depth > 8) fail('ADAPTER_RESPONSE_INVALID');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        assertBoundedString(value);
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('ADAPTER_RESPONSE_INVALID');
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 256) fail('ADAPTER_RESPONSE_INVALID');
        return value.map(item => safeProjection(item, depth + 1));
    }
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    const keys = Object.keys(value);
    if (keys.length > 256) fail('ADAPTER_RESPONSE_INVALID');
    const result: Record<string, unknown> = {};
    for (const key of keys.sort()) {
        if (!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(key)) fail('ADAPTER_RESPONSE_INVALID');
        result[key] = safeProjection(value[key], depth + 1);
    }
    return result;
}

function checkProject(project: string): void {
    if (!PROJECT_ID_PATTERN.test(project)) fail('PROJECT_MISMATCH');
}

function checkInterval(input: NormalizedReadInput, value: number): number {
    if (!Number.isSafeInteger(value) || value < input.intervalStartMs) fail('EVIDENCE_UNAVAILABLE');
    const elapsed = value - input.intervalStartMs;
    if (elapsed > MAX_ZERO_WORK_INTERVAL_MS || elapsed >= MAX_RETENTION_MS) fail('EVIDENCE_UNAVAILABLE');
    return value;
}

async function checkLeaseAndInterval(input: NormalizedReadInput): Promise<number> {
    await input.leaseCheck();
    return checkInterval(input, input.now());
}

async function readJson(
    input: NormalizedReadInput,
    request: Readonly<{
        method: 'GET';
        url: string;
        allowedHosts: ReadonlySet<string>;
        allowedPath: (path: string) => boolean;
        allowedMethods: readonly 'GET'[];
        allowedQueryKeys: readonly string[];
    }>,
): Promise<{ value: unknown }> {
    await checkLeaseAndInterval(input);
    try {
        const result = await input.transport.json(request);
        return { value: result.value };
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('ADAPTER_RESPONSE_INVALID');
    } finally {
        // Every provider read, including a paginated page, is bracketed by the
        // durable reservation check and the bounded local interval.
        await checkLeaseAndInterval(input);
    }
}

function queueResource(project: string, resource: string): QueueResource {
    if (typeof resource !== 'string') fail('RESOURCE_INVALID');
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(resource);
    if (!match || match[1] !== project || !LOCATION_ID_PATTERN.test(match[2]!)
        || !QUEUE_ID_PATTERN.test(match[3]!)) fail('RESOURCE_INVALID');
    return { resource, location: match[2]! };
}

function normalizeControlledIdentities(
    project: string,
    values: readonly PausedQueueControlledIdentity[],
): ReadonlySet<string> {
    if (!Array.isArray(values) || values.length === 0 || values.length > 32) fail('ADAPTER_REQUEST_INVALID');
    const result = new Set<string>();
    for (const value of values) {
        const identity = value;
        if (typeof identity !== 'string' || !SERVICE_ACCOUNT_ID_PATTERN.test(identity)
            || !identity.endsWith('.iam.gserviceaccount.com')
            || identity.split('@')[1] !== `${project}.iam.gserviceaccount.com`
            || result.has(identity)) fail('IDENTITY_INVALID');
        result.add(identity);
    }
    return result;
}

function queueControl(value: Record<string, unknown>, resource: string): {
    purgeTime: string | null;
    digest: string;
} {
    const state = value.state;
    if (value.name !== resource || state !== 'PAUSED') fail('EVIDENCE_UNAVAILABLE');
    let purgeTime: string | null = null;
    if (value.purgeTime !== undefined && value.purgeTime !== null) {
        if (typeof value.purgeTime !== 'string' || value.purgeTime.length > MAX_STRING_LENGTH
            || /[\u0000-\u001f\u007f]/.test(value.purgeTime)
            || !Number.isFinite(Date.parse(value.purgeTime))) {
            fail('ADAPTER_RESPONSE_INVALID');
        }
        purgeTime = value.purgeTime;
    }
    const fields = [
        'name',
        'state',
        'purgeTime',
        'rateLimits',
        'retryConfig',
        'taskTtl',
        'tombstoneTtl',
        'stackdriverLoggingConfig',
        'httpTarget',
        'appEngineHttpTarget',
        'appEngineRoutingOverride',
    ] as const;
    const projection: Record<string, unknown> = { resource };
    for (const field of fields) {
        projection[field] = field === 'purgeTime'
            ? purgeTime
            : value[field] === undefined
                ? null
                : safeProjection(value[field]);
    }
    return { purgeTime, digest: canonicalDigest(projection) };
}

async function readQueue(
    input: NormalizedReadInput,
    queue: QueueResource,
): Promise<{ purgeTime: string | null; controlDigest: string }> {
    const path = '/v2/' + queue.resource;
    const result = await readJson(input, {
        method: 'GET',
        url: 'https://cloudtasks.googleapis.com' + path,
        allowedHosts: CLOUD_TASKS_HOSTS,
        allowedPath: candidate => candidate === path,
        allowedMethods: ['GET'],
        allowedQueryKeys: [],
    });
    if (!isObject(result.value)) fail('ADAPTER_RESPONSE_INVALID');
    const control = queueControl(result.value, queue.resource);
    return { purgeTime: control.purgeTime, controlDigest: control.digest };
}

async function readEmptyTaskPages(
    input: NormalizedReadInput,
    queue: QueueResource,
): Promise<{ pageCount: number; taskInventoryDigest: string }> {
    const path = '/v2/' + queue.resource + '/tasks';
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
        const params = new URLSearchParams({
            pageSize: String(TASK_PAGE_SIZE),
            responseView: 'BASIC',
        });
        if (pageToken !== undefined) params.set('pageToken', pageToken);
        const result = await readJson(input, {
            method: 'GET',
            url: 'https://cloudtasks.googleapis.com' + path + '?' + params.toString(),
            allowedHosts: CLOUD_TASKS_HOSTS,
            allowedPath: candidate => candidate === path,
            allowedMethods: ['GET'],
            allowedQueryKeys: pageToken === undefined
                ? ['pageSize', 'responseView']
                : ['pageSize', 'responseView', 'pageToken'],
        });
        if (!isObject(result.value)) fail('ADAPTER_RESPONSE_INVALID');
        const tasks = result.value.tasks;
        if (tasks !== undefined && !Array.isArray(tasks)) fail('ADAPTER_RESPONSE_INVALID');
        // This primitive intentionally has no nonempty mode. Do not inspect or
        // retain task names, payloads, or request identifiers.
        if (Array.isArray(tasks) && tasks.length > 0) fail('QUEUE_NOT_EMPTY');
        const nextPageToken = result.value.nextPageToken;
        if (nextPageToken === undefined || nextPageToken === null || nextPageToken === '') {
            return {
                pageCount: page + 1,
                taskInventoryDigest: canonicalDigest({ resource: queue.resource, taskCount: 0 }),
            };
        }
        if (typeof nextPageToken !== 'string' || nextPageToken.length > 2_048 || seenTokens.has(nextPageToken)) {
            fail('PAGINATION_INCOMPLETE');
        }
        seenTokens.add(nextPageToken);
        pageToken = nextPageToken;
    }
    fail('PAGINATION_INCOMPLETE');
}

export async function readPausedQueueEvidence(
    input: ReadPausedQueueEvidenceInput,
): Promise<PausedQueueEvidence> {
    if (!isObject(input) || typeof input.project !== 'string' || !Array.isArray(input.queueResources)
        || input.queueResources.length !== 2 || !Array.isArray(input.controlledIdentities)
        || typeof input.leaseCheck !== 'function' || typeof input.now !== 'function'
        || !(input.transport instanceof AuthenticatedProtectedTransport)
        || (input.intervalStartMs !== undefined
            && (!Number.isSafeInteger(input.intervalStartMs) || input.intervalStartMs < 0))) {
        fail('ADAPTER_REQUEST_INVALID');
    }
    checkProject(input.project);
    const initialNow = input.now();
    if (!Number.isSafeInteger(initialNow) || initialNow < 0) fail('EVIDENCE_UNAVAILABLE');
    const normalizedInput: NormalizedReadInput = {
        ...input,
        intervalStartMs: input.intervalStartMs ?? initialNow,
    };
    // Keep the reviewed selector bound to the requested project even though
    // this primitive does not make an IAM claim about any principal.
    normalizeControlledIdentities(normalizedInput.project, normalizedInput.controlledIdentities);
    const queues = normalizedInput.queueResources.map(resource => queueResource(normalizedInput.project, resource));
    if (new Set(queues.map(queue => queue.resource)).size !== 2) fail('RESOURCE_INVALID');
    const orderedQueues = [...queues].sort((left, right) => left.resource.localeCompare(right.resource));
    await checkLeaseAndInterval(normalizedInput);

    const queueObservations: PausedQueueObservation[] = [];
    for (const queue of orderedQueues) {
        const observedQueue = await readQueue(normalizedInput, queue);
        const tasks = await readEmptyTaskPages(normalizedInput, queue);
        queueObservations.push({
            resourceDigest: canonicalDigest(queue.resource),
            state: 'PAUSED',
            configurationDigest: observedQueue.controlDigest,
            ...(observedQueue.purgeTime === null ? {} : { purgeTime: observedQueue.purgeTime }),
            taskInventoryDigest: tasks.taskInventoryDigest,
            taskPageCount: tasks.pageCount,
            taskCount: 0,
            complete: true,
        });
    }

    const observedAtMs = await checkLeaseAndInterval(normalizedInput);
    const intervalMs = observedAtMs - normalizedInput.intervalStartMs;
    const snapshotDigest = canonicalDigest({
        schemaVersion: 'paused-queue-evidence-v1',
        scope: TRUSTED_SCOPE,
        project: normalizedInput.project,
        queueResources: orderedQueues.map(queue => queue.resource),
        queues: queueObservations,
        cloudLoggingCompleteness: false,
    });
    return {
        schemaVersion: 'paused-queue-evidence-v1',
        kind: 'paused-queue-conservation',
        scope: TRUSTED_SCOPE,
        project: normalizedInput.project,
        queueResources: orderedQueues.map(queue => queue.resource),
        intervalStartMs: normalizedInput.intervalStartMs,
        intervalMs,
        observedAtMs,
        queues: queueObservations,
        cloudLoggingCompleteness: false,
        snapshotDigest,
    };
}
