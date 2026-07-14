import { createHash } from 'node:crypto';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { GoogleAuth, type ClientOptions } from 'google-gax';
import { OAuth2Client } from 'google-auth-library';
import { prepareGoogleApplicationCredentials } from '@/lib/services/google/credentials';
import {
    GOOGLE_CLOUD_PLATFORM_SCOPE,
    createVercelWifGoogleAuth,
    type CloudTasksCallerAuthConfig,
} from '@/lib/services/google/vercel-wif';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const QUEUE_PATTERN = /^[a-z](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export interface AnalysisTasksConfig {
    project: string;
    location: string;
    queue: string;
    targetUrl: string;
    oidcAudience: string;
    serviceAccountEmail: string;
}

export interface AnalysisTaskState {
    currentStep: string;
    progress: number;
    stepData?: {
        profileBatchIndex?: number;
        analyzeBatchIndex?: number;
        interactionStage?: string;
        interactionCandidateBatchIndex?: number;
        deepAnalysisStage?: string;
    } | null;
}

type AnalysisTaskEnqueueOptions = {
    config?: AnalysisTasksConfig | null;
    client?: CloudTasksClientLike;
    delaySeconds?: number;
};

interface CloudTasksClientLike {
    queuePath(project: string, location: string, queue: string): string;
    taskPath(project: string, location: string, queue: string, task: string): string;
    createTask(request: Record<string, unknown>): PromiseLike<unknown>;
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

type CloudTasksClientConstructorOptions = Pick<ClientOptions, 'auth' | 'projectId'>;

type CreateCloudTasksClientOptions = {
    callerAuth?: CloudTasksCallerAuthConfig;
    prepareLegacyCredentials?: () => unknown;
    createClient?: (
        options?: CloudTasksClientConstructorOptions
    ) => Promise<CloudTasksClient>;
    createAdcGoogleAuth?: (projectId: string) => GoogleAuth;
    createWifGoogleAuth?: typeof createVercelWifGoogleAuth;
};

let sharedTasksClient: CloudTasksClient | undefined;
let sharedTokenVerifier: OAuth2Client | undefined;

async function getSharedTasksClient(): Promise<CloudTasksClientLike> {
    if (!sharedTasksClient) {
        sharedTasksClient = await createCloudTasksClient();
    }
    return sharedTasksClient;
}

export async function createCloudTasksClient(
    options: CreateCloudTasksClientOptions = {}
): Promise<CloudTasksClient> {
    const prepareLegacyCredentials = options.prepareLegacyCredentials
        ?? prepareGoogleApplicationCredentials;
    const createClient = options.createClient ?? (async (
        clientOptions?: CloudTasksClientConstructorOptions
    ) => {
        const { CloudTasksClient: TasksClient } = await import('@google-cloud/tasks');
        return new TasksClient(clientOptions);
    });

    if (!options.callerAuth) {
        prepareLegacyCredentials();
        return createClient();
    }

    const auth = options.callerAuth.mode === 'vercel-wif'
        ? (options.createWifGoogleAuth ?? createVercelWifGoogleAuth)(
            options.callerAuth
        )
        : (options.createAdcGoogleAuth ?? ((projectId: string) => new GoogleAuth({
            projectId,
            scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
        })))(options.callerAuth.projectId);

    return createClient({
        auth,
        projectId: options.callerAuth.projectId,
    });
}

function booleanSetting(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: ANALYSIS_TASKS_ENABLED must be boolean.');
}

function httpsUrl(value: string | undefined, key: string): URL {
    let url: URL;
    try {
        url = new URL(value ?? '');
    } catch {
        throw new Error(`ANALYSIS_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error(`ANALYSIS_TASKS_CONFIG_ERROR: ${key} must be a valid HTTPS URL.`);
    }
    return url;
}

export function getAnalysisTasksConfig(
    env: Record<string, string | undefined> = process.env
): AnalysisTasksConfig | null {
    if (!booleanSetting(env.ANALYSIS_TASKS_ENABLED)) return null;

    const project = (env.ANALYSIS_TASKS_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? '').trim();
    const location = (env.ANALYSIS_TASKS_LOCATION ?? '').trim();
    const queue = (env.ANALYSIS_TASKS_QUEUE ?? '').trim();
    const serviceAccountEmail = (env.ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL ?? '').trim();
    if (!PROJECT_PATTERN.test(project)) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid project.');
    }
    if (!LOCATION_PATTERN.test(location)) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid location.');
    }
    if (!QUEUE_PATTERN.test(queue)) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid queue.');
    }
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid service account.');
    }

    const target = httpsUrl(env.ANALYSIS_TASKS_TARGET_URL, 'ANALYSIS_TASKS_TARGET_URL');
    const audience = httpsUrl(
        env.ANALYSIS_TASKS_OIDC_AUDIENCE,
        'ANALYSIS_TASKS_OIDC_AUDIENCE'
    );
    if (target.pathname !== '/api/analysis/step' || target.search) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: task target must be /api/analysis/step.');
    }
    if (target.origin !== audience.origin) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: OIDC audience must match task target origin.');
    }

    return {
        project,
        location,
        queue,
        targetUrl: target.toString(),
        oidcAudience: audience.origin,
        serviceAccountEmail,
    };
}

function boundedIndex(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedStage(value: unknown): string | undefined {
    return typeof value === 'string' && /^[a-z_]{1,50}$/.test(value)
        ? value
        : undefined;
}

/** Converts the persisted request row into the small state used for task idempotency. */
export function analysisTaskStateFromRow(row: unknown): AnalysisTaskState {
    if (!isRecord(row)) {
        throw new Error('ANALYSIS_TASKS_STATE_ERROR: invalid analysis request state.');
    }

    const currentStep = row.current_step === null || row.current_step === undefined
        ? 'pending'
        : boundedStage(row.current_step);
    const progress = row.progress;
    if (
        !currentStep ||
        typeof progress !== 'number' ||
        !Number.isSafeInteger(progress) ||
        progress < 0 ||
        progress > 100
    ) {
        throw new Error('ANALYSIS_TASKS_STATE_ERROR: invalid analysis request state.');
    }

    const persistedStepData = row.step_data;
    if (
        persistedStepData !== null &&
        persistedStepData !== undefined &&
        !isRecord(persistedStepData)
    ) {
        throw new Error('ANALYSIS_TASKS_STATE_ERROR: invalid analysis request state.');
    }
    const stepData = isRecord(persistedStepData) ? persistedStepData : {};

    return {
        currentStep,
        progress,
        stepData: {
            profileBatchIndex: boundedIndex(stepData.profileBatchIndex),
            analyzeBatchIndex: boundedIndex(stepData.analyzeBatchIndex),
            interactionStage: boundedStage(stepData.interactionStage),
            interactionCandidateBatchIndex: boundedIndex(
                stepData.interactionCandidateBatchIndex
            ),
            deepAnalysisStage: boundedStage(stepData.deepAnalysisStage),
        },
    };
}

export function analysisTaskStateKey(requestId: string, state: AnalysisTaskState): string {
    if (!UUID_PATTERN.test(requestId)) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid analysis request id.');
    }
    const normalized = {
        currentStep: state.currentStep,
        progress: boundedIndex(state.progress),
        profileBatchIndex: boundedIndex(state.stepData?.profileBatchIndex),
        analyzeBatchIndex: boundedIndex(state.stepData?.analyzeBatchIndex),
        interactionStage: state.stepData?.interactionStage ?? '',
        interactionCandidateBatchIndex: boundedIndex(
            state.stepData?.interactionCandidateBatchIndex
        ),
        deepAnalysisStage: state.stepData?.deepAnalysisStage ?? '',
    };
    const digest = createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
        .slice(0, 20);
    return `analysis-${requestId.toLowerCase()}-${digest}`;
}

function isAlreadyExists(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return value.code === 6
        || value.code === 'ALREADY_EXISTS'
        || (typeof value.message === 'string' && value.message.includes('ALREADY_EXISTS'));
}

export async function enqueueAnalysisTask(
    requestId: string,
    state: AnalysisTaskState,
    options: AnalysisTaskEnqueueOptions = {}
): Promise<'disabled' | 'enqueued' | 'exists'> {
    const config = options.config === undefined ? getAnalysisTasksConfig() : options.config;
    if (!config) return 'disabled';
    const delaySeconds = options.delaySeconds ?? 0;
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 300) {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: invalid task delay.');
    }

    const client = options.client ?? await getSharedTasksClient();
    const taskId = analysisTaskStateKey(requestId, state);
    const parent = client.queuePath(config.project, config.location, config.queue);
    const task: Record<string, unknown> = {
        name: client.taskPath(config.project, config.location, config.queue, taskId),
        // Match the Vercel function ceiling so a terminated invocation enters the
        // queue's bounded retry path immediately instead of waiting another five minutes.
        dispatchDeadline: { seconds: 300 },
        httpRequest: {
            httpMethod: 'POST',
            url: config.targetUrl,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ requestId })).toString('base64'),
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
        return 'enqueued';
    } catch (error) {
        if (isAlreadyExists(error)) return 'exists';
        throw new Error('ANALYSIS_TASKS_ENQUEUE_ERROR: continuation task creation failed.');
    }
}

/**
 * Enqueues the first task before exposing background mode to clients. A disabled queue keeps
 * the legacy browser-driven pipeline active, and enqueue failures never invoke the marker.
 */
export async function startAnalysisInBackground(
    requestId: string,
    state: AnalysisTaskState,
    markBackgroundProcessing: () => void | PromiseLike<void>,
    options: AnalysisTaskEnqueueOptions = {}
): Promise<boolean> {
    const outcome = await enqueueAnalysisTask(requestId, state, {
        ...options,
        delaySeconds: options.delaySeconds ?? 2,
    });
    if (outcome === 'disabled') return false;

    await markBackgroundProcessing();
    return true;
}

export async function verifyAnalysisTaskAuthorization(
    authorization: string | null,
    options: {
        config?: AnalysisTasksConfig | null;
        verifier?: IdTokenVerifierLike;
    } = {}
): Promise<boolean> {
    const config = options.config === undefined ? getAnalysisTasksConfig() : options.config;
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
