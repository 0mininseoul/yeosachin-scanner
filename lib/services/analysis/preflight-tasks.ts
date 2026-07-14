import type { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import {
    getCloudTasksCallerAuthConfig,
    type CloudTasksCallerAuthConfig,
} from '@/lib/services/google/vercel-wif';
import { createCloudTasksClient } from './background-tasks';
import {
    PREFLIGHT_TASK_DISPATCH_DEADLINE_SECONDS,
    assertPreflightRuntimePolicy,
} from './preflight-runtime-policy';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const QUEUE_PATTERN = /^[a-z](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export interface PreflightTasksConfig {
    project: string;
    location: string;
    queue: string;
    targetUrl: string;
    oidcAudience: string;
    serviceAccountEmail: string;
    callerAuth: CloudTasksCallerAuthConfig;
}

export type PreflightDispatchPolicy =
    | Readonly<{ mode: 'queue'; config: PreflightTasksConfig }>
    | Readonly<{ mode: 'local_after' }>
    | Readonly<{ mode: 'unavailable' }>;

interface CloudTasksClientLike {
    queuePath(project: string, location: string, queue: string): string;
    taskPath(project: string, location: string, queue: string, task: string): string;
    createTask(request: Record<string, unknown>): PromiseLike<unknown>;
}

export type PreflightTaskEnqueueFailureDisposition = 'terminal' | 'replayable';

export class PreflightTaskEnqueueError extends Error {
    constructor(readonly disposition: PreflightTaskEnqueueFailureDisposition) {
        super('PREFLIGHT_TASKS_ENQUEUE_ERROR: task creation failed.');
        this.name = 'PreflightTaskEnqueueError';
    }
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

let sharedTasksClient: CloudTasksClient | undefined;
let sharedTokenVerifier: OAuth2Client | undefined;

function strictBoolean(value: string | undefined, key: string): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error(`PREFLIGHT_TASKS_CONFIG_ERROR: ${key} must be boolean.`);
}

function validHttpsUrl(value: string | undefined, key: string): URL {
    let url: URL;
    try {
        url = new URL(value ?? '');
    } catch {
        throw new Error(`PREFLIGHT_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error(`PREFLIGHT_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    return url;
}

export function getPreflightTasksConfig(
    env: Record<string, string | undefined> = process.env
): PreflightTasksConfig | null {
    if (!strictBoolean(env.PREFLIGHT_TASKS_ENABLED, 'PREFLIGHT_TASKS_ENABLED')) return null;

    const project = (env.PREFLIGHT_TASKS_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? '').trim();
    const location = (env.PREFLIGHT_TASKS_LOCATION ?? '').trim();
    const queue = (env.PREFLIGHT_TASKS_QUEUE ?? '').trim();
    const serviceAccountEmail = (env.PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL ?? '').trim();
    if (!PROJECT_PATTERN.test(project)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid project.');
    }
    if (!LOCATION_PATTERN.test(location)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid location.');
    }
    if (!QUEUE_PATTERN.test(queue)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid queue.');
    }
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid service account.');
    }

    const target = validHttpsUrl(
        env.PREFLIGHT_TASKS_TARGET_URL,
        'PREFLIGHT_TASKS_TARGET_URL'
    );
    const audience = validHttpsUrl(
        env.PREFLIGHT_TASKS_OIDC_AUDIENCE,
        'PREFLIGHT_TASKS_OIDC_AUDIENCE'
    );
    if (target.pathname !== '/api/analysis/preflight/worker' || target.search) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: task target must be /api/analysis/preflight/worker.'
        );
    }
    if (audience.pathname !== '/' || audience.search || target.origin !== audience.origin) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: OIDC audience must be the task target origin.'
        );
    }

    const callerAuth = getCloudTasksCallerAuthConfig({
        env,
        projectId: project,
        modeKey: 'PREFLIGHT_TASKS_CALLER_AUTH_MODE',
        enqueuerServiceAccountEmailKey:
            'PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
        errorPrefix: 'PREFLIGHT_TASKS_CONFIG_ERROR',
    });

    return Object.freeze({
        project,
        location,
        queue,
        targetUrl: target.toString(),
        oidcAudience: audience.origin,
        serviceAccountEmail,
        callerAuth,
    });
}

export function resolvePreflightDispatchPolicy(
    env: Record<string, string | undefined> = process.env
): PreflightDispatchPolicy {
    assertPreflightRuntimePolicy(env);
    const config = getPreflightTasksConfig(env);
    if (config) return Object.freeze({ mode: 'queue', config });

    if (!strictBoolean(env.PREFLIGHT_LOCAL_AFTER_ENABLED, 'PREFLIGHT_LOCAL_AFTER_ENABLED')) {
        return Object.freeze({ mode: 'unavailable' });
    }
    if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: local after execution is forbidden in production.'
        );
    }
    return Object.freeze({ mode: 'local_after' });
}

async function getSharedTasksClient(
    config: PreflightTasksConfig
): Promise<CloudTasksClientLike> {
    sharedTasksClient ??= await createCloudTasksClient({
        callerAuth: config.callerAuth,
    });
    return sharedTasksClient;
}

export function preflightTaskId(preflightId: string, generation: number): string {
    if (!UUID_PATTERN.test(preflightId)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid preflight id.');
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 100) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid dispatch generation.');
    }
    return `preflight-${preflightId.toLowerCase()}-g${generation}`;
}

export function freshAdmissionTaskId(
    preflightId: string,
    generation: number,
    dispatchGeneration: number
): string {
    if (!UUID_PATTERN.test(preflightId)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid preflight id.');
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 100) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid admission generation.');
    }
    if (
        !Number.isSafeInteger(dispatchGeneration)
        || dispatchGeneration < 1
        || dispatchGeneration > 100
    ) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid admission dispatch generation.');
    }
    return `preflight-admission-${preflightId.toLowerCase()}-g${generation}-d${dispatchGeneration}`;
}

function isAlreadyExists(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return value.code === 6
        || value.code === 'ALREADY_EXISTS'
        || (typeof value.message === 'string' && value.message.includes('ALREADY_EXISTS'));
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

function taskRequest(
    payload: Record<string, unknown>,
    taskName: string,
    parent: string,
    config: PreflightTasksConfig
): Record<string, unknown> {
    return {
        parent,
        task: {
            name: taskName,
            dispatchDeadline: { seconds: PREFLIGHT_TASK_DISPATCH_DEADLINE_SECONDS },
            httpRequest: {
                httpMethod: 'POST',
                url: config.targetUrl,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                oidcToken: {
                    serviceAccountEmail: config.serviceAccountEmail,
                    audience: config.oidcAudience,
                },
            },
        },
    };
}

export async function enqueuePreflightTask(
    preflightId: string,
    generation: number,
    options: {
        config?: PreflightTasksConfig;
        client?: CloudTasksClientLike;
    } = {}
): Promise<'enqueued' | 'exists'> {
    const config = options.config ?? getPreflightTasksConfig();
    if (!config) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: queue is not configured.');
    }

    const client = options.client ?? await getSharedTasksClient(config);
    const taskId = preflightTaskId(preflightId, generation);
    const parent = client.queuePath(config.project, config.location, config.queue);
    const name = client.taskPath(config.project, config.location, config.queue, taskId);

    const request = taskRequest({ preflightId }, name, parent, config);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await client.createTask(request);
            return 'enqueued';
        } catch (error) {
            if (isAlreadyExists(error)) return 'exists';
            if (attempt === 0 && isTerminalCreateFailure(error)) {
                throw new PreflightTaskEnqueueError('terminal');
            }
            if (attempt === 1) {
                // Do not terminalize retryable or outcome-ambiguous failures.
                throw new PreflightTaskEnqueueError('replayable');
            }
        }
    }
    throw new PreflightTaskEnqueueError('replayable');
}

export async function enqueueFreshAdmissionTask(
    preflightId: string,
    generation: number,
    dispatchGeneration: number,
    dispatchToken: string,
    options: {
        config?: PreflightTasksConfig;
        client?: CloudTasksClientLike;
    } = {}
): Promise<'enqueued' | 'exists'> {
    const config = options.config ?? getPreflightTasksConfig();
    if (!config) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: queue is not configured.');
    }
    if (!UUID_PATTERN.test(dispatchToken)) {
        throw new Error('PREFLIGHT_TASKS_CONFIG_ERROR: invalid admission dispatch token.');
    }

    const client = options.client ?? await getSharedTasksClient(config);
    const taskId = freshAdmissionTaskId(preflightId, generation, dispatchGeneration);
    const parent = client.queuePath(config.project, config.location, config.queue);
    const name = client.taskPath(config.project, config.location, config.queue, taskId);

    try {
        await client.createTask(taskRequest({
            preflightId,
            kind: 'fresh_admission',
            generation,
            dispatchGeneration,
            dispatchToken: dispatchToken.toLowerCase(),
        }, name, parent, config));
        return 'enqueued';
    } catch (error) {
        if (isAlreadyExists(error)) return 'exists';
        throw new Error('PREFLIGHT_TASKS_ENQUEUE_ERROR: admission task creation failed.');
    }
}

export async function verifyPreflightTaskAuthorization(
    authorization: string | null,
    options: {
        config?: PreflightTasksConfig | null;
        verifier?: IdTokenVerifierLike;
    } = {}
): Promise<boolean> {
    const config = options.config === undefined ? getPreflightTasksConfig() : options.config;
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
