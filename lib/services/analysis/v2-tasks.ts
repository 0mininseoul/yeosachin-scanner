import { createHash } from 'node:crypto';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
    getCloudTasksCallerAuthConfig,
    type CloudTasksCallerAuthConfig,
} from '@/lib/services/google/vercel-wif';
import { createCloudTasksClient } from './background-tasks';
import { getAnalysisWorkloadRole } from './workload-role';
import {
    analysisV2JobStore,
    assertAnalysisV2JobIdentity,
    type AnalysisV2JobDispatchReservation,
    type AnalysisV2JobStore,
    type AnalysisV2TaskDelivery,
} from './v2-job-store';
import {
    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT,
    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION,
    ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER,
} from './v2-worker-task-contract';

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const QUEUE_PATTERN = /^[a-z](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;

// Match the Cloud Run request window. The route retains a 60-second completion margin.
export const ANALYSIS_V2_TASK_DISPATCH_DEADLINE_SECONDS =
    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT.dispatchDeadlineSeconds;
export const ANALYSIS_V2_TASK_MAX_DELAY_SECONDS = 300;

export interface AnalysisV2TasksConfig {
    workloadRole?: 'paid';
    project: string;
    location: string;
    queue: string;
    targetUrl: string;
    oidcAudience: string;
    serviceAccountEmail: string;
    callerAuth: CloudTasksCallerAuthConfig;
}

export type AnalysisV2TaskPayload = AnalysisV2TaskDelivery;

/**
 * Fresh paid admission is a paid workload even though the legacy task used the
 * preflight queue. Keeping a distinct payload lets the paid route execute the
 * same admission engine without pretending it is an ordinary V2 job.
 */
export interface AnalysisV2FreshAdmissionTaskPayload {
    preflightId: string;
    kind: 'fresh_admission';
    workloadRole?: 'preflight' | 'paid';
    generation: number;
    dispatchGeneration: number;
    dispatchToken: string;
}

export type AnalysisV2WorkerTaskPayload =
    | AnalysisV2TaskPayload
    | AnalysisV2FreshAdmissionTaskPayload;

const analysisV2TaskPayloadSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN).transform(value => value.toLowerCase()),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    workloadRole: z.enum(['preflight', 'paid']).optional(),
    generation: z.number().int().min(1).max(1_000),
    reservationToken: z.string().regex(UUID_PATTERN).transform(value => value.toLowerCase()),
}).strict();

const analysisV2FreshAdmissionTaskPayloadSchema = z.object({
    preflightId: z.string().regex(UUID_PATTERN).transform(value => value.toLowerCase()),
    kind: z.literal('fresh_admission'),
    workloadRole: z.enum(['preflight', 'paid']).optional(),
    generation: z.number().int().min(1).max(100),
    dispatchGeneration: z.number().int().min(1).max(100),
    dispatchToken: z.string().regex(UUID_PATTERN).transform(value => value.toLowerCase()),
}).strict();

export type AnalysisV2TaskLookupOutcome = 'exists' | 'not_found';
export type AnalysisV2TaskEnqueueOutcome = 'enqueued' | 'exists';
export type AnalysisV2JobDispatchOutcome =
    | AnalysisV2TaskEnqueueOutcome
    | 'already_dispatched';

export type AnalysisV2TaskEnqueueFailureDisposition = 'terminal' | 'replayable';

/**
 * Deliberately discards provider error text while retaining whether a create refusal was
 * definitive.  A replayable error leaves the durable dispatch reservation untouched because
 * Cloud Tasks may have accepted the deterministic task before the response was lost.
 */
export class AnalysisV2TaskEnqueueError extends Error {
    constructor(readonly disposition: AnalysisV2TaskEnqueueFailureDisposition) {
        super('ANALYSIS_V2_TASKS_ENQUEUE_ERROR: task creation failed.');
        this.name = 'AnalysisV2TaskEnqueueError';
    }
}

interface CloudTasksClientLike {
    queuePath(project: string, location: string, queue: string): string;
    taskPath(project: string, location: string, queue: string, task: string): string;
    createTask(request: Record<string, unknown>): PromiseLike<unknown>;
}

interface CloudTasksLookupClientLike {
    getTask(request: { name: string; responseView: 'BASIC' }): PromiseLike<unknown>;
}

interface IdTokenTicketLike {
    getPayload(): {
        email?: string;
        email_verified?: boolean;
    } | undefined;
}

interface IdTokenVerifierLike {
    verifyIdToken(options: { idToken: string; audience: string }): PromiseLike<IdTokenTicketLike>;
}

type EnqueueOptions = {
    config?: AnalysisV2TasksConfig | null;
    client?: CloudTasksClientLike;
    delaySeconds?: number;
};

type DispatchOptions = EnqueueOptions & {
    store?: AnalysisV2JobStore;
};

let sharedTasksClient: CloudTasksClient | undefined;
let sharedTokenVerifier: OAuth2Client | undefined;

async function getSharedTasksClient(
    config: AnalysisV2TasksConfig
): Promise<CloudTasksClient> {
    sharedTasksClient ??= await createCloudTasksClient({
        callerAuth: config.callerAuth,
    });
    return sharedTasksClient;
}

function strictBoolean(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error(
        'ANALYSIS_V2_TASKS_CONFIG_ERROR: ANALYSIS_V2_TASKS_ENABLED must be boolean.'
    );
}

function validHttpsUrl(value: string | undefined, key: string): URL {
    let url: URL;
    try {
        url = new URL(value ?? '');
    } catch {
        throw new Error(`ANALYSIS_V2_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error(`ANALYSIS_V2_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    return url;
}

export function getAnalysisV2TasksConfig(
    env: Record<string, string | undefined> = process.env
): AnalysisV2TasksConfig | null {
    if (!strictBoolean(env.ANALYSIS_V2_TASKS_ENABLED)) return null;

    const project = (
        env.ANALYSIS_V2_TASKS_PROJECT
        ?? env.GOOGLE_CLOUD_PROJECT
        ?? ''
    ).trim();
    const location = (env.ANALYSIS_V2_TASKS_LOCATION ?? '').trim();
    const queue = (env.ANALYSIS_V2_TASKS_QUEUE ?? '').trim();
    const serviceAccountEmail = (
        env.ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL
        ?? ''
    ).trim();
    if (!PROJECT_PATTERN.test(project)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid project.');
    }
    if (!LOCATION_PATTERN.test(location)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid location.');
    }
    if (!QUEUE_PATTERN.test(queue)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid queue.');
    }
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid service account.');
    }

    const target = validHttpsUrl(
        env.ANALYSIS_V2_TASKS_TARGET_URL,
        'ANALYSIS_V2_TASKS_TARGET_URL'
    );
    const audience = validHttpsUrl(
        env.ANALYSIS_V2_TASKS_OIDC_AUDIENCE,
        'ANALYSIS_V2_TASKS_OIDC_AUDIENCE'
    );
    if (target.pathname !== '/api/analysis/v2/worker' || target.search) {
        throw new Error(
            'ANALYSIS_V2_TASKS_CONFIG_ERROR: task target must be '
            + '/api/analysis/v2/worker.'
        );
    }
    if (audience.pathname !== '/' || audience.search || target.origin !== audience.origin) {
        throw new Error(
            'ANALYSIS_V2_TASKS_CONFIG_ERROR: OIDC audience must be the task target origin.'
        );
    }

    const callerAuth = getCloudTasksCallerAuthConfig({
        env,
        projectId: project,
        modeKey: 'ANALYSIS_V2_TASKS_CALLER_AUTH_MODE',
        enqueuerServiceAccountEmailKey:
            'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
        errorPrefix: 'ANALYSIS_V2_TASKS_CONFIG_ERROR',
    });

    const configuredRole = env.ANALYSIS_WORKLOAD_ROLE?.trim();
    if (configuredRole !== undefined) {
        if (getAnalysisWorkloadRole(env) !== 'paid') {
            throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: workload role must be paid.');
        }
    }

    return Object.freeze({
        workloadRole: 'paid' as const,
        project,
        location,
        queue,
        targetUrl: target.toString(),
        oidcAudience: audience.origin,
        serviceAccountEmail,
        callerAuth,
    });
}

export function parseAnalysisV2TaskPayload(input: unknown): AnalysisV2TaskPayload {
    return analysisV2TaskPayloadSchema.parse(input);
}

/** Parses both current paid job deliveries and the explicit fresh-admission paid payload. */
export function parseAnalysisV2WorkerTaskPayload(input: unknown): AnalysisV2WorkerTaskPayload {
    return z.union([
        analysisV2TaskPayloadSchema,
        analysisV2FreshAdmissionTaskPayloadSchema,
    ]).parse(input);
}

export function analysisV2TaskId(
    requestId: string,
    jobKey: string,
    generation: number
): string {
    const identity = assertAnalysisV2JobIdentity({ requestId, jobKey });
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 1_000) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid dispatch generation.');
    }
    const jobDigest = createHash('sha256').update(identity.jobKey).digest('hex').slice(0, 24);
    return `analysis-v2-${identity.requestId}-${jobDigest}-g${generation}`;
}

export function analysisV2FreshAdmissionTaskId(
    preflightId: string,
    generation: number,
    dispatchGeneration: number,
): string {
    if (!UUID_PATTERN.test(preflightId)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid preflight id.');
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 100) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid admission generation.');
    }
    if (
        !Number.isSafeInteger(dispatchGeneration)
        || dispatchGeneration < 1
        || dispatchGeneration > 100
    ) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid admission dispatch generation.');
    }
    return `analysis-v2-fresh-${preflightId.toLowerCase()}-g${generation}-d${dispatchGeneration}`;
}

function isAlreadyExists(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return value.code === 6
        || value.code === 'ALREADY_EXISTS';
}

function isNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return value.code === 5
        || value.code === 'NOT_FOUND';
}

const TERMINAL_CREATE_ERROR_CODES = new Set<unknown>([
    3,
    5,
    7,
    9,
    11,
    12,
    16,
    'INVALID_ARGUMENT',
    'NOT_FOUND',
    'PERMISSION_DENIED',
    'FAILED_PRECONDITION',
    'OUT_OF_RANGE',
    'UNIMPLEMENTED',
    'UNAUTHENTICATED',
]);

function isTerminalCreateFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return TERMINAL_CREATE_ERROR_CODES.has((error as { code?: unknown }).code);
}

function configuredTaskName(
    config: AnalysisV2TasksConfig,
    client: Pick<CloudTasksClientLike, 'taskPath'>,
    requestId: string,
    jobKey: string,
    generation: number
): string {
    const taskId = analysisV2TaskId(requestId, jobKey, generation);
    return client.taskPath(config.project, config.location, config.queue, taskId);
}

function requireConfig(config: AnalysisV2TasksConfig | null): AnalysisV2TasksConfig {
    if (!config) {
        throw new Error('ANALYSIS_V2_TASKS_UNAVAILABLE: queue is not configured.');
    }
    return config;
}

/** Validates queue configuration without constructing a client or consuming an entitlement. */
export function assertAnalysisV2TasksConfigured(
    env: Record<string, string | undefined> = process.env
): AnalysisV2TasksConfig {
    return requireConfig(getAnalysisV2TasksConfig(env));
}

export async function enqueueAnalysisV2Task(
    delivery: AnalysisV2TaskDelivery,
    options: EnqueueOptions = {}
): Promise<{ outcome: AnalysisV2TaskEnqueueOutcome; taskName: string }> {
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const payload = parseAnalysisV2TaskPayload({
        ...delivery,
        workloadRole: delivery.workloadRole ?? config.workloadRole ?? 'paid',
    });
    const delaySeconds = options.delaySeconds ?? 0;
    if (
        !Number.isSafeInteger(delaySeconds)
        || delaySeconds < 0
        || delaySeconds > ANALYSIS_V2_TASK_MAX_DELAY_SECONDS
    ) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid task delay.');
    }

    const client = options.client ?? await getSharedTasksClient(config);
    const parent = client.queuePath(config.project, config.location, config.queue);
    const taskName = configuredTaskName(
        config,
        client,
        payload.requestId,
        payload.jobKey,
        payload.generation
    );
    const task: Record<string, unknown> = {
        name: taskName,
        dispatchDeadline: { seconds: ANALYSIS_V2_TASK_DISPATCH_DEADLINE_SECONDS },
        httpRequest: {
            httpMethod: 'POST',
            url: config.targetUrl,
            // A header preserves old worker strict-body compatibility during a rolling deploy.
            headers: {
                'Content-Type': 'application/json',
                [ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER]: String(
                    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION,
                ),
            },
            body: Buffer.from(JSON.stringify(payload)).toString('base64'),
            oidcToken: {
                serviceAccountEmail: config.serviceAccountEmail,
                audience: config.oidcAudience,
            },
        },
        ...(delaySeconds > 0
            ? { scheduleTime: { seconds: Math.floor(Date.now() / 1_000) + delaySeconds } }
            : {}),
    };

    try {
        await client.createTask({ parent, task });
        return { outcome: 'enqueued', taskName };
    } catch (error) {
        if (isAlreadyExists(error)) return { outcome: 'exists', taskName };
        throw new AnalysisV2TaskEnqueueError(
            isTerminalCreateFailure(error) ? 'terminal' : 'replayable',
        );
    }
}

/**
 * Enqueues a fresh paid admission on the paid V2 queue/service. Legacy
 * roleless fresh payloads are drain-only data accepted by the preflight route;
 * no new producer can create them on the preflight queue.
 */
export async function enqueueAnalysisV2FreshAdmissionTask(
    delivery: Omit<AnalysisV2FreshAdmissionTaskPayload, 'kind'> & {
        kind?: 'fresh_admission';
    },
    options: EnqueueOptions = {},
): Promise<{ outcome: AnalysisV2TaskEnqueueOutcome; taskName: string }> {
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const payload = analysisV2FreshAdmissionTaskPayloadSchema.parse({
        ...delivery,
        kind: 'fresh_admission',
        workloadRole: delivery.workloadRole ?? config.workloadRole ?? 'paid',
    });
    if (payload.workloadRole !== 'paid') {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: fresh admission role must be paid.');
    }
    const delaySeconds = options.delaySeconds ?? 0;
    if (
        !Number.isSafeInteger(delaySeconds)
        || delaySeconds < 0
        || delaySeconds > ANALYSIS_V2_TASK_MAX_DELAY_SECONDS
    ) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid task delay.');
    }

    const client = options.client ?? await getSharedTasksClient(config);
    const parent = client.queuePath(config.project, config.location, config.queue);
    const taskName = client.taskPath(
        config.project,
        config.location,
        config.queue,
        analysisV2FreshAdmissionTaskId(
            payload.preflightId,
            payload.generation,
            payload.dispatchGeneration,
        ),
    );
    const task: Record<string, unknown> = {
        name: taskName,
        dispatchDeadline: { seconds: ANALYSIS_V2_TASK_DISPATCH_DEADLINE_SECONDS },
        httpRequest: {
            httpMethod: 'POST',
            url: config.targetUrl,
            headers: {
                'Content-Type': 'application/json',
                [ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER]: String(
                    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION,
                ),
            },
            body: Buffer.from(JSON.stringify(payload)).toString('base64'),
            oidcToken: {
                serviceAccountEmail: config.serviceAccountEmail,
                audience: config.oidcAudience,
            },
        },
        ...(delaySeconds > 0
            ? { scheduleTime: { seconds: Math.floor(Date.now() / 1_000) + delaySeconds } }
            : {}),
    };
    try {
        await client.createTask({ parent, task });
        return { outcome: 'enqueued', taskName };
    } catch (error) {
        if (isAlreadyExists(error)) return { outcome: 'exists', taskName };
        throw new AnalysisV2TaskEnqueueError(
            isTerminalCreateFailure(error) ? 'terminal' : 'replayable',
        );
    }
}

/** Looks up a generation-qualified fresh-admission task by its deterministic name. */
export async function lookupAnalysisV2FreshAdmissionTask(
    input: { preflightId: string; generation: number; dispatchGeneration: number },
    options: {
        config?: AnalysisV2TasksConfig | null;
        client?: CloudTasksLookupClientLike & Pick<CloudTasksClientLike, 'taskPath'>;
    } = {},
): Promise<AnalysisV2TaskLookupOutcome> {
    const preflightId = input.preflightId.toLowerCase();
    if (!UUID_PATTERN.test(preflightId)) {
        throw new Error('ANALYSIS_V2_TASKS_CONFIG_ERROR: invalid preflight id.');
    }
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const client = options.client ?? await getSharedTasksClient(config);
    const name = client.taskPath(
        config.project,
        config.location,
        config.queue,
        analysisV2FreshAdmissionTaskId(
            preflightId,
            input.generation,
            input.dispatchGeneration,
        ),
    );
    try {
        await client.getTask({ name, responseView: 'BASIC' });
        return 'exists';
    } catch (error) {
        if (isNotFound(error)) return 'not_found';
        throw new Error('ANALYSIS_V2_TASKS_LOOKUP_ERROR: fresh task lookup failed.');
    }
}

export async function lookupAnalysisV2Task(
    input: { requestId: string; jobKey: string; generation: number },
    options: {
        config?: AnalysisV2TasksConfig | null;
        client?: CloudTasksLookupClientLike & Pick<CloudTasksClientLike, 'taskPath'>;
    } = {}
): Promise<AnalysisV2TaskLookupOutcome> {
    const identity = assertAnalysisV2JobIdentity(input);
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const client = options.client ?? await getSharedTasksClient(config);
    const name = configuredTaskName(
        config,
        client,
        identity.requestId,
        identity.jobKey,
        input.generation
    );
    try {
        await client.getTask({ name, responseView: 'BASIC' });
        return 'exists';
    } catch (error) {
        if (isNotFound(error)) return 'not_found';
        throw new Error('ANALYSIS_V2_TASKS_LOOKUP_ERROR: task lookup failed.');
    }
}

/**
 * Durable dispatch choreography. A caller may safely replay this function: the database reuses
 * an existing reservation and Cloud Tasks accepts an identical deterministic task as success.
 */
export async function dispatchAnalysisV2Job(
    requestId: string,
    jobKey: string,
    options: DispatchOptions = {}
): Promise<AnalysisV2JobDispatchOutcome> {
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const store = options.store ?? analysisV2JobStore;
    const reservation = await store.reserveDispatch({ requestId, jobKey });
    if (!reservation.reserved) return 'already_dispatched';
    return dispatchReservedAnalysisV2Job(reservation, { ...options, config, store });
}

/**
 * Completes a dispatch reservation created atomically with scheduler continuation. Replaying this
 * function is safe because both the task id and the database dispatch fence are deterministic.
 */
export async function dispatchReservedAnalysisV2Job(
    reservation: AnalysisV2JobDispatchReservation,
    options: DispatchOptions = {}
): Promise<AnalysisV2TaskEnqueueOutcome> {
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const store = options.store ?? analysisV2JobStore;
    if (
        !reservation.reserved
        || reservation.status !== 'pending'
        || reservation.dispatchState !== 'reserved'
    ) {
        throw new Error('ANALYSIS_V2_TASKS_DISPATCH_ERROR: invalid reservation state.');
    }
    if (!reservation.reservationToken) {
        throw new Error('ANALYSIS_V2_TASKS_DISPATCH_ERROR: reservation token is missing.');
    }

    const enqueued = await enqueueAnalysisV2Task({
        requestId: reservation.requestId,
        jobKey: reservation.jobKey,
        generation: reservation.generation,
        reservationToken: reservation.reservationToken,
    }, { ...options, config });
    try {
        await store.markDispatched({
            ...reservation,
            reservationToken: reservation.reservationToken,
            taskName: enqueued.taskName,
        });
    } catch {
        throw new Error('ANALYSIS_V2_TASKS_DISPATCH_ERROR: dispatch mark failed.');
    }
    return enqueued.outcome;
}

/**
 * Capacity waits are durable job deferrals, not transport retries. Rotate the exact dispatch
 * generation before creating a successor task so Cloud Tasks' finite delivery budget cannot
 * strand a pending job after repeated provider-capacity responses.
 */
export async function rearmAnalysisV2JobAfterCapacity(
    delivery: AnalysisV2TaskDelivery,
    options: DispatchOptions & { store: AnalysisV2JobStore },
): Promise<AnalysisV2TaskEnqueueOutcome> {
    const config = requireConfig(
        options.config === undefined ? getAnalysisV2TasksConfig() : options.config
    );
    const reservation = await options.store.rearmDispatch({
        requestId: delivery.requestId,
        jobKey: delivery.jobKey,
        expectedGeneration: delivery.generation,
        expectedReservationToken: delivery.reservationToken,
    });
    return dispatchReservedAnalysisV2Job(reservation, { ...options, config });
}

export async function verifyAnalysisV2TaskAuthorization(
    authorization: string | null,
    options: {
        config?: AnalysisV2TasksConfig | null;
        verifier?: IdTokenVerifierLike;
    } = {}
): Promise<boolean> {
    const config = options.config === undefined
        ? getAnalysisV2TasksConfig()
        : options.config;
    if (!config || !authorization?.startsWith('Bearer ')) return false;
    const idToken = authorization.slice('Bearer '.length).trim();
    if (!idToken) return false;

    const verifier = options.verifier ?? (sharedTokenVerifier ??= new OAuth2Client());
    try {
        const ticket = await verifier.verifyIdToken({
            idToken,
            audience: config.oidcAudience,
        });
        const payload = ticket.getPayload();
        return payload?.email_verified === true
            && payload.email?.toLowerCase() === config.serviceAccountEmail.toLowerCase();
    } catch {
        return false;
    }
}
