import { ApifyApiError, ApifyClient } from 'apify-client';
import type { InstagramFollower } from '@/lib/types/instagram';
import type {
    ApifyCredentialSlot,
    ProviderCallContext,
    ProviderCostRunStarted,
    ProviderCostTerminalStatus,
} from './types';
import { isApifyCredentialSlot } from './types';
import { isInstagramUsername } from '../username';

export type ApifyClientLike = Pick<ApifyClient, 'actor' | 'dataset' | 'run'>;
export type ApifyRelationshipKind = 'followers' | 'following';

const APIFY_RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const MAX_INVOCATION_WAIT_SECS = 240;
export const APIFY_PROVIDER_QUOTA_ERROR_CODE = 'SCRAPING_PROVIDER_QUOTA_ERROR';
export const APIFY_PROVIDER_START_REJECTED_ERROR_CODE =
    'SCRAPING_PROVIDER_START_REJECTED_ERROR';
export const APIFY_QUEUED_START_CANCELLED_ERROR_CODE = 'SCRAPING_QUEUED_START_CANCELLED';
const PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR =
    'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR';
const PROVIDER_RUN_COST_START_PERSISTENCE_ERROR =
    'ANALYSIS_V2_PROVIDER_RUN_COST_START_PERSISTENCE_ERROR';
const PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR =
    'ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR';
const PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR =
    'ANALYSIS_V2_PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR';
const PROVIDER_RUN_PERSISTENCE_ERROR = 'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR';
const SCRAPING_RUN_CHECKPOINT_ERROR =
    'SCRAPING_RUN_CHECKPOINT_ERROR: Apify run id could not be persisted.';
const RESUMABLE_APIFY_RUN_STATUSES = new Set([
    'READY',
    'RUNNING',
    'TIMING-OUT',
    'ABORTING',
]);
export const APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES = Object.freeze([
    'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH',
    'ANALYSIS_V2_PROVIDER_RUN_ALREADY_RESERVED',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
    'ANALYSIS_V2_PROVIDER_RUN_COST_IDENTITY_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
    'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT',
    PROVIDER_RUN_PERSISTENCE_ERROR,
    'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY',
    PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR,
    PROVIDER_RUN_COST_START_PERSISTENCE_ERROR,
    PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR,
    PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR,
    'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_STATE_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_TERMINAL_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_VALIDATION_ERROR',
] as const);
const DURABLE_PROVIDER_CALLBACK_ERROR_CODE_SET = new Set<string>(
    APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES
);

function durableProviderCallbackCode(error: unknown): string | undefined {
    const code = error instanceof Error
        ? error.message.match(/^([A-Z][A-Z0-9_]{2,63})(?::|\s|\(|$)/)?.[1]
        : undefined;
    return code && DURABLE_PROVIDER_CALLBACK_ERROR_CODE_SET.has(code) ? code : undefined;
}

export function isApifyProviderLifecycleError(error: unknown): boolean {
    return durableProviderCallbackCode(error) !== undefined;
}

export function isApifyQueuedStartCancellation(error: unknown): boolean {
    return error instanceof Error
        && error.message === APIFY_QUEUED_START_CANCELLED_ERROR_CODE;
}

export function throwIfApifyQueuedStartCancelled(context?: ProviderCallContext): void {
    if (
        context?.startCancellationSignal?.aborted
        && !context.resumeRunId?.trim()
        && !context.startReserved
    ) {
        throw new Error(APIFY_QUEUED_START_CANCELLED_ERROR_CODE);
    }
}

function sanitizedProviderCallbackError(error: unknown, fallbackMessage: string): Error {
    const code = durableProviderCallbackCode(error);
    return new Error(
        code && code !== PROVIDER_RUN_PERSISTENCE_ERROR
            ? code
            : fallbackMessage
    );
}

function sanitizedRunCheckpointError(error: unknown): Error {
    const code = durableProviderCallbackCode(error);
    return new Error(
        code && code !== PROVIDER_RUN_PERSISTENCE_ERROR
            ? code
            : SCRAPING_RUN_CHECKPOINT_ERROR
    );
}

function hasExplicitFreeTierQuotaSignal(statusMessage: unknown): boolean {
    if (typeof statusMessage !== 'string') return false;
    return /\bfree\s+(?:api(?:\s*\/\s*mcp)?|mcp)\b/i.test(statusMessage)
        && /\bdaily\s+(?:api\s+|mcp\s+)?limit\s+(?:has\s+been\s+)?reached\b/i
            .test(statusMessage)
        && /\bupgrade\s+to\s+(?:a\s+)?paid(?:\s+apify)?\s+plan\b/i
            .test(statusMessage);
}

export interface ApifyActorRunOptions {
    logicalProvider: 'apify' | 'coderx';
    credentialSlot: ApifyCredentialSlot;
    actorBuild?: string;
    requireExplicitRestrictedAccess?: boolean;
    timeoutSecs: number;
    maxItems: number;
    maxTotalChargeUsd: number;
    invocationWaitLimitSecs?: number;
}

export interface ApifyRelationshipActorDefinition {
    logicalProvider: 'apify' | 'coderx';
    credentialSlot: ApifyCredentialSlot;
    actorId: string;
    actorBuild?: string;
    actorConcurrency: number;
    minimumLimit: number;
    maximumLimit: number;
    maximumMetadataItems: number;
    maximumEstimatedCostUsd: number;
    datasetReadRetries: number;
    datasetRetryBaseDelayMs: number;
    estimatedCostPerResultUsd: number;
    minimumUniqueRatio: number;
    timeoutSecs: number;
    buildInput(username: string, kind: ApifyRelationshipKind, actorLimit: number): unknown;
    parseDataset(
        items: Array<Record<string, unknown>>,
        username: string,
        kind: ApifyRelationshipKind,
        actorLimit: number
    ): InstagramFollower[];
}

interface ActorWaiter {
    limit: number;
    resolve(): void;
}

class SharedActorSemaphore {
    private active = 0;
    private readonly queue: ActorWaiter[] = [];

    async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
        await this.acquire(limit);
        try {
            return await task();
        } finally {
            this.active--;
            this.drain();
        }
    }

    private acquire(limit: number): Promise<void> {
        if (this.queue.length === 0 && this.active < limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push({ limit, resolve });
        });
    }

    private drain(): void {
        while (this.queue.length > 0 && this.active < this.queue[0].limit) {
            const waiter = this.queue.shift();
            if (!waiter) return;
            this.active++;
            waiter.resolve();
        }
    }
}

const sharedActorSemaphore = new SharedActorSemaphore();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withinInvocationDeadline<T>(
    pending: Promise<T>,
    deadlineAtMs: number | undefined
): Promise<T> {
    if (deadlineAtMs === undefined) return pending;
    const remainingMs = deadlineAtMs - Date.now();
    if (!Number.isFinite(deadlineAtMs) || remainingMs <= 0) {
        throw new Error('SCRAPING_INVOCATION_DEADLINE_ERROR');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('SCRAPING_INVOCATION_DEADLINE_ERROR')),
                    remainingMs
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function restrictApifyRunResources(
    client: ApifyClientLike,
    runId: string,
    deadlineAtMs: number | undefined
): Promise<void> {
    const run = client.run(runId);
    let resources: readonly { generalAccess?: unknown }[];
    try {
        resources = await Promise.all([
            withinInvocationDeadline(
                run.update({ generalAccess: 'RESTRICTED' }),
                deadlineAtMs
            ),
            withinInvocationDeadline(
                run.keyValueStore().update({ generalAccess: 'RESTRICTED' }),
                deadlineAtMs
            ),
            withinInvocationDeadline(
                run.dataset().update({ generalAccess: 'RESTRICTED' }),
                deadlineAtMs
            ),
            withinInvocationDeadline(
                run.requestQueue().update({ generalAccess: 'RESTRICTED' }),
                deadlineAtMs
            ),
        ]);
    } catch {
        throw new Error('SCRAPING_ACCESS_ERROR: Apify run resources could not be restricted.');
    }
    if (resources.some(resource => resource.generalAccess !== 'RESTRICTED')) {
        throw new Error('SCRAPING_ACCESS_ERROR: Apify run resources are not restricted.');
    }
}

export function runWithApifyActorSlot<T>(
    concurrency: number,
    task: () => Promise<T>
): Promise<T> {
    return sharedActorSemaphore.run(concurrency, task);
}

function assertLimit(limit: number, maximum: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > maximum) {
        throw new Error(`SCRAPING_CONFIG_ERROR: limit은 0~${maximum} 범위의 정수여야 합니다.`);
    }
}

export function selectApifyCredentialSlot(
    env: Record<string, string | undefined> = process.env
): Extract<ApifyCredentialSlot, 'primary' | 'secondary'> {
    const slot = env.APIFY_API_TOKEN_SLOT?.trim().toLowerCase() || 'primary';
    if (slot !== 'primary' && slot !== 'secondary') {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: APIFY_API_TOKEN_SLOT은 primary 또는 secondary여야 합니다.'
        );
    }
    return slot;
}

/** Explicit V2 canary selection. A request never rotates or fails over between token slots. */
export function selectAnalysisV2ApifyCredentialSlot(
    env: Record<string, string | undefined> = process.env
): ApifyCredentialSlot {
    const configured = env.ANALYSIS_V2_APIFY_API_TOKEN_SLOT?.trim().toLowerCase();
    if (!configured) return selectApifyCredentialSlot(env);
    if (!isApifyCredentialSlot(configured)) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: ANALYSIS_V2_APIFY_API_TOKEN_SLOT이 올바르지 않습니다.'
        );
    }
    return configured;
}

export function selectApifyApiToken(
    env: Record<string, string | undefined> = process.env,
    requestedSlot?: ApifyCredentialSlot
): string {
    const slot = requestedSlot ?? selectApifyCredentialSlot(env);
    if (!isApifyCredentialSlot(slot)) {
        throw new Error('SCRAPING_CONFIG_ERROR: invalid Apify credential slot.');
    }
    const key = {
        primary: 'APIFY_PRIMARY_API_TOKEN',
        secondary: 'APIFY_SECONDARY_API_TOKEN',
        tertiary: 'APIFY_TERTIARY_API_TOKEN',
        quaternary: 'APIFY_QUATERNARY_API_TOKEN',
        quinary: 'APIFY_QUINARY_API_TOKEN',
    }[slot];
    const token = slot === 'primary'
        ? env[key]?.trim() || env.APIFY_API_TOKEN?.trim()
        : env[key]?.trim();
    if (!token) throw new Error(`SCRAPING_CONFIG_ERROR: ${key}이 설정되지 않았습니다.`);
    return token;
}

export function getApifyClient(
    env: Record<string, string | undefined> = process.env,
    credentialSlot?: ApifyCredentialSlot
): ApifyClient {
    // Starting an Actor is not idempotent. The client must not retry the POST after an
    // ambiguous transport failure because that can create and charge a second run.
    return new ApifyClient({ token: selectApifyApiToken(env, credentialSlot), maxRetries: 0 });
}

export async function startOrResumeApifyActor(
    client: ApifyClientLike,
    actorId: string,
    input: unknown,
    options: ApifyActorRunOptions,
    context?: ProviderCallContext
) {
    const resumeRunId = context?.resumeRunId?.trim();
    if (resumeRunId && !APIFY_RUN_ID_PATTERN.test(resumeRunId)) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: invalid Apify run id.');
    }
    if (
        context?.logicalProvider
        && context.logicalProvider !== options.logicalProvider
    ) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: logical provider does not match.');
    }
    if (context?.actorId && context.actorId !== actorId) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: Actor id does not match.');
    }
    if (
        (resumeRunId || context?.startReserved)
        && (context?.credentialSlot === undefined || context?.maxChargeUsd === undefined)
    ) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: stored Actor billing identity is missing.');
    }
    if (!isApifyCredentialSlot(options.credentialSlot)) {
        throw new Error('SCRAPING_CONFIG_ERROR: invalid Apify credential slot.');
    }
    if (
        !Number.isFinite(options.maxTotalChargeUsd)
        || options.maxTotalChargeUsd < 0
        || options.maxTotalChargeUsd > 100_000
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: invalid Apify maximum charge.');
    }
    const credentialSlot = context?.credentialSlot ?? options.credentialSlot;
    const maxTotalChargeUsd = context?.maxChargeUsd ?? options.maxTotalChargeUsd;
    if (!isApifyCredentialSlot(credentialSlot)) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: stored credential slot is invalid.');
    }
    if (
        !Number.isFinite(maxTotalChargeUsd)
        || maxTotalChargeUsd < 0
        || maxTotalChargeUsd > 100_000
    ) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: stored maximum charge is invalid.');
    }
    const invocationWaitLimitSecs = options.invocationWaitLimitSecs
        ?? MAX_INVOCATION_WAIT_SECS;
    if (
        !Number.isInteger(invocationWaitLimitSecs)
        || invocationWaitLimitSecs < 1
        || invocationWaitLimitSecs > MAX_INVOCATION_WAIT_SECS
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: invalid Apify invocation wait limit.');
    }

    let runId = resumeRunId;
    let durablyCheckpointed = Boolean(resumeRunId);
    if (!runId) {
        if (context?.startReserved) {
            throw new Error(
                'SCRAPING_AMBIGUOUS_START_ERROR: a reserved Actor start has no confirmed run id.'
            );
        }
        try {
            await context?.onBeforeRunStart?.({
                logicalProvider: options.logicalProvider,
                actorId,
                credentialSlot,
                maxChargeUsd: maxTotalChargeUsd,
            });
        } catch (error) {
            throw sanitizedProviderCallbackError(
                error,
                PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR
            );
        }
        let startedRun;
        try {
            startedRun = await withinInvocationDeadline(
                client.actor(actorId).start(input, {
                    ...(options.actorBuild ? { build: options.actorBuild } : {}),
                    timeout: options.timeoutSecs,
                    maxItems: options.maxItems,
                    maxTotalChargeUsd,
                    restartOnError: false,
                }),
                context?.invocationDeadlineAtMs
            );
        } catch (error) {
            if (error instanceof ApifyApiError) {
                const statusCode = Number.isInteger(error.statusCode)
                    && error.statusCode >= 400
                    && error.statusCode <= 599
                    ? error.statusCode
                    : 500;
                const errorType = typeof error.type === 'string'
                    && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(error.type)
                    ? error.type.toLowerCase()
                    : null;
                try {
                    await context?.onRunStartRejected?.({
                        logicalProvider: options.logicalProvider,
                        actorId,
                        credentialSlot,
                        maxChargeUsd: maxTotalChargeUsd,
                        statusCode,
                        errorType,
                    });
                } catch (callbackError) {
                    throw sanitizedProviderCallbackError(
                        callbackError,
                        PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR
                    );
                }
                throw new Error(APIFY_PROVIDER_START_REJECTED_ERROR_CODE);
            }
            // Apify does not expose an idempotency key for Actor starts. Retrying an
            // ambiguous POST can double-charge, so this error is intentionally terminal.
            throw new Error(
                'SCRAPING_AMBIGUOUS_START_ERROR: Apify Actor start response was not confirmed.'
            );
        }
        if (!APIFY_RUN_ID_PATTERN.test(startedRun.id)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify run id is invalid.');
        }
        runId = startedRun.id;
        try {
            await context?.onRunStarted?.(runId);
            durablyCheckpointed = typeof context?.onRunStarted === 'function';
        } catch (error) {
            try {
                await client.run(runId).abort();
            } catch {
                // The run checkpoint failure remains terminal even if best-effort abort fails.
            }
            throw sanitizedRunCheckpointError(error);
        }
    }

    const costRun: ProviderCostRunStarted = {
        logicalProvider: options.logicalProvider,
        actorId,
        credentialSlot,
        runId,
        maxChargeUsd: maxTotalChargeUsd,
    };
    try {
        await context?.onCostRunStarted?.(costRun);
    } catch (error) {
        throw sanitizedProviderCallbackError(
            error,
            PROVIDER_RUN_COST_START_PERSISTENCE_ERROR
        );
    }

    let explicitlyRestricted = false;
    if (options.requireExplicitRestrictedAccess) {
        await restrictApifyRunResources(
            client,
            runId,
            context?.invocationDeadlineAtMs
        );
        explicitlyRestricted = true;
    }

    let run;
    try {
        run = await withinInvocationDeadline(
            client.run(runId).waitForFinish({
                waitSecs: Math.min(options.timeoutSecs, invocationWaitLimitSecs),
            }),
            context?.invocationDeadlineAtMs
        );
    } catch {
        if (durablyCheckpointed) {
            throw new Error(
                'SCRAPING_RUN_PENDING_ERROR: Apify run status is temporarily unavailable; retry the checkpointed run.'
            );
        }
        throw new Error('SCRAPING_ERROR: Apify run status request failed.');
    }

    const terminalStatus: ProviderCostTerminalStatus | undefined = (() => {
        switch (run.status) {
            case 'SUCCEEDED':
                return 'succeeded';
            case 'FAILED':
                return 'failed';
            case 'ABORTED':
                return 'aborted';
            case 'TIMED-OUT':
                return 'timed_out';
            default:
                return undefined;
        }
    })();
    if (terminalStatus) {
        try {
            await context?.onCostRunFinished?.({
                ...costRun,
                status: terminalStatus,
                // Apify documents the first terminal cost as preliminary. A later
                // authenticated reconciliation finalizes usage without delaying users.
                usageTotalUsd: null,
            });
        } catch (error) {
            throw sanitizedProviderCallbackError(
                error,
                PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR
            );
        }
    }
    if (terminalStatus && hasExplicitFreeTierQuotaSignal(run.statusMessage)) {
        throw new Error(APIFY_PROVIDER_QUOTA_ERROR_CODE);
    }
    if (!terminalStatus && RESUMABLE_APIFY_RUN_STATUSES.has(run.status) && durablyCheckpointed) {
        throw new Error(
            `SCRAPING_RUN_PENDING_ERROR: Apify run status=${run.status}; retry the checkpointed run.`
        );
    }
    return explicitlyRestricted
        ? { ...run, generalAccess: 'RESTRICTED' }
        : run;
}

function hasDurableRunCheckpoint(context?: ProviderCallContext): boolean {
    return Boolean(context?.resumeRunId || context?.onRunStarted);
}

function resumableDatasetError(
    context: ProviderCallContext | undefined,
    detail: string
): Error {
    if (hasDurableRunCheckpoint(context)) {
        return new Error(`SCRAPING_DATASET_TRANSIENT_ERROR: ${detail}`);
    }
    return new Error(`SCRAPING_ERROR: ${detail}`);
}

function actorRequestError(error: unknown): Error {
    if (error && typeof error === 'object') {
        const statusCode = (error as { statusCode?: unknown }).statusCode;
        if (
            typeof statusCode === 'number' &&
            Number.isInteger(statusCode) &&
            statusCode >= 400 &&
            statusCode <= 599
        ) {
            return new Error(
                `SCRAPING_ERROR: Apify actor transport request failed (HTTP ${statusCode}).`
            );
        }
    }
    return new Error('SCRAPING_ERROR: Apify actor transport request failed.');
}

export function numberSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 ${min}~${max} 범위의 숫자여야 합니다.`);
    }
    return value;
}

export function integerSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const value = numberSetting(env, key, fallback, min, max);
    if (!Number.isInteger(value)) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 정수여야 합니다.`);
    }
    return value;
}

export async function runApifyRelationshipActor(
    client: ApifyClientLike,
    definition: ApifyRelationshipActorDefinition,
    username: string,
    kind: ApifyRelationshipKind,
    limit: number,
    context?: ProviderCallContext
): Promise<InstagramFollower[]> {
    assertLimit(limit, definition.maximumLimit);
    if (limit === 0) return [];

    const account = username.trim().replace(/^@/, '').toLowerCase();
    if (!isInstagramUsername(account)) {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
    }

    const actorLimit = Math.max(definition.minimumLimit, limit);
    const datasetLimit = actorLimit + definition.maximumMetadataItems;
    const estimatedOperationCostUsd = datasetLimit * definition.estimatedCostPerResultUsd;
    if (
        context?.maxChargeUsd === undefined
        &&
        estimatedOperationCostUsd >
        definition.maximumEstimatedCostUsd + Number.EPSILON
    ) {
        throw new Error(
            'SCRAPING_BUDGET_ERROR: Apify actor estimated-cost ceiling would be exceeded.'
        );
    }
    return runWithApifyActorSlot(definition.actorConcurrency, async () => {
        throwIfApifyQueuedStartCancelled(context);
        context?.recordUsage({ request_count: 1 });
        let run;
        try {
            run = await startOrResumeApifyActor(
                client,
                definition.actorId,
                definition.buildInput(account, kind, actorLimit),
                {
                    logicalProvider: definition.logicalProvider,
                    credentialSlot: definition.credentialSlot,
                    timeoutSecs: definition.timeoutSecs,
                    maxItems: datasetLimit,
                    maxTotalChargeUsd: context?.maxChargeUsd
                        ?? Number(estimatedOperationCostUsd.toFixed(12)),
                    actorBuild: definition.actorBuild,
                },
                context
            );
        } catch (error) {
            if (
                error instanceof Error
                && (
                    error.message.startsWith('SCRAPING_AMBIGUOUS_START_ERROR:')
                    || error.message === APIFY_PROVIDER_START_REJECTED_ERROR_CODE
                    || error.message.startsWith('SCRAPING_RUN_CHECKPOINT_ERROR:')
                    || error.message.startsWith('SCRAPING_RUN_PENDING_ERROR:')
                    || error.message === APIFY_PROVIDER_QUOTA_ERROR_CODE
                    || error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
                    || isApifyProviderLifecycleError(error)
                )
            ) {
                throw error;
            }
            throw actorRequestError(error);
        }

        if (run.status !== 'SUCCEEDED') {
            throw new Error(`SCRAPING_ERROR: Apify actor 실행 실패 (status=${run.status}).`);
        }
        if (!run.defaultDatasetId) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify run에 defaultDatasetId가 없습니다.');
        }

        const items: Array<Record<string, unknown>> = [];
        const dataset = client.dataset(run.defaultDatasetId);
        const chargedItemsByOffset = new Map<number, number>();
        let offset = 0;
        let expectedTotal: number | undefined;
        while (offset <= datasetLimit) {
            const pageLimit = Math.min(1_000, datasetLimit + 1 - offset);
            let page;
            let invariantError: Error | undefined;
            for (let attempt = 0; attempt <= definition.datasetReadRetries; attempt++) {
                try {
                    page = await dataset.listItems({ offset, limit: pageLimit });
                } catch {
                    page = undefined;
                    invariantError = resumableDatasetError(
                        context,
                        'APIFY_DATASET_TRANSPORT_EXHAUSTED Apify dataset transport request failed.'
                    );
                }
                if (page && !Array.isArray(page.items)) {
                    throw new Error('SCRAPING_SCHEMA_ERROR: Apify dataset items가 배열이 아닙니다.');
                }
                if (!page) {
                    if (attempt < definition.datasetReadRetries) {
                        await sleep(definition.datasetRetryBaseDelayMs * 2 ** attempt);
                    }
                    continue;
                }
                const alreadyCharged = chargedItemsByOffset.get(offset) ?? 0;
                if (page.items.length > alreadyCharged) {
                    context?.recordUsage({
                        estimated_cost_usd:
                            (page.items.length - alreadyCharged) *
                            definition.estimatedCostPerResultUsd,
                    });
                    chargedItemsByOffset.set(offset, page.items.length);
                }

                invariantError = undefined;
                if (!Number.isInteger(page.total) || page.total < 0) {
                    invariantError = new Error(
                        'SCRAPING_SCHEMA_ERROR: APIFY_DATASET_TOTAL_INVALID Apify dataset total이 유효한 정수가 아닙니다.'
                    );
                } else if (!Number.isInteger(page.offset) || page.offset !== offset) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_OFFSET_MISMATCH Apify dataset offset이 요청과 다릅니다.'
                    );
                } else if (!Number.isInteger(page.count) || page.count !== page.items.length) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_COUNT_MISMATCH Apify dataset count가 items 길이와 다릅니다.'
                    );
                } else if (expectedTotal !== undefined && expectedTotal !== page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_TOTAL_CHANGED Apify dataset total이 페이지 사이에 변경되었습니다.'
                    );
                } else if (offset + page.items.length > page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_TOTAL_LAGGING Apify dataset 페이지가 total을 초과했습니다.'
                    );
                } else if (page.items.length === 0 && offset < page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_PAGE_EMPTY Apify dataset 페이지가 중간에서 비었습니다.'
                    );
                } else if (
                    offset === 0 &&
                    page.total === 0 &&
                    page.items.length === 0 &&
                    attempt < definition.datasetReadRetries
                ) {
                    invariantError = hasDurableRunCheckpoint(context)
                        ? new Error(
                            'SCRAPING_DATASET_TRANSIENT_ERROR: APIFY_DATASET_EMPTY_UNSETTLED Apify dataset이 아직 비어 있습니다.'
                        )
                        : new Error(
                            'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_EMPTY_UNSETTLED Apify dataset이 아직 비어 있습니다.'
                        );
                }
                if (!invariantError) break;
                if (attempt < definition.datasetReadRetries) {
                    await sleep(definition.datasetRetryBaseDelayMs * 2 ** attempt);
                }
            }
            if (invariantError) throw invariantError;
            if (!page) {
                throw new Error('SCRAPING_ERROR: Apify dataset response missing.');
            }

            expectedTotal = page.total;
            items.push(...page.items);
            offset += page.items.length;
            if (offset >= page.total) break;
        }
        if ((expectedTotal ?? 0) > datasetLimit || items.length > datasetLimit) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_LIMIT_EXCEEDED Apify dataset이 요청한 결과 한도를 초과했습니다.'
            );
        }
        if (expectedTotal !== undefined && items.length !== expectedTotal) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_READ_INCOMPLETE Apify dataset을 끝까지 읽지 못했습니다.'
            );
        }
        const mapped = definition.parseDataset(items, account, kind, actorLimit);
        if (mapped.length > actorLimit) {
            throw new Error(
                'SCRAPING_SCHEMA_ERROR: APIFY_RESULT_LIMIT_EXCEEDED Apify actor가 resultsLimit보다 많은 결과를 반환했습니다.'
            );
        }

        const unique = new Map<string, InstagramFollower>();
        for (const user of mapped) {
            const key = user.username.toLowerCase();
            if (!unique.has(key)) unique.set(key, user);
        }
        const uniqueRatio = mapped.length > 0 ? unique.size / mapped.length : 1;
        if (uniqueRatio < definition.minimumUniqueRatio) {
            context?.recordUsage({
                raw_result_count: mapped.length,
                unique_result_count: unique.size,
            });
            throw new Error('SCRAPING_INCOMPLETE_ERROR: Apify 결과의 중복 비율이 허용 범위를 초과했습니다.');
        }
        const result = [...unique.values()].slice(0, limit);
        context?.recordUsage({
            result_count: result.length,
            raw_result_count: mapped.length,
            unique_result_count: unique.size,
        });
        return result;
    });
}
