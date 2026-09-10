import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    canonicalEvidenceHash,
    CANONICAL_HASH_NAMESPACES,
    canonicalJson,
    canonicalJsonHash,
    parseCanonicalJsonObject,
    type CanonicalJsonObject,
} from '@/lib/services/commerce/canonical-commerce-store';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const fulfillmentStateSchema = z.enum([
    'awaiting_operator',
    'admission_pending',
    'analysis_in_progress',
    'completed',
    'retryable_failure',
    'manual_review',
]);
const notificationChannelSchema = z.enum(['discord', 'kakao', 'sentry']);
const lifecycleEventSchema = z.enum([
    'classification',
    'paid_evidence',
    'deletion_requested',
    'objects_purged',
    'database_purged',
    'retired',
    'e2e',
]);
const leaseKindSchema = z.enum(['provider', 'capacity', 'maintenance', 'notification']);
const maintenanceKindSchema = z.enum([
    'recovery',
    'replay',
    'rearm',
    'cleanup',
    'terminalize',
    'purge',
    'audit_assembly',
]);
const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable();

function parseJsonObject(value: unknown, invalidCode: 'CANONICAL_OPERATIONS_INPUT_INVALID'): CanonicalJsonObject {
    try {
        return parseCanonicalJsonObject(value);
    } catch {
        throw new CanonicalOperationsError(invalidCode);
    }
}

const fulfillmentInputSchema = z.object({
    orderId: uuidSchema,
    requestId: uuidSchema.nullable(),
    state: fulfillmentStateSchema,
    attemptCount: z.number().int().min(0).max(10),
    leaseGeneration: z.number().int().nonnegative(),
    leaseToken: uuidSchema.nullable().optional().default(null),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    nextAttemptAt: z.string().datetime({ offset: true }),
    lastErrorCode: errorCodeSchema,
    operatorAdmittedAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
    lastErrorAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
    completedAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
    manualReviewAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
    payload: z.unknown().optional().default({}),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload, 'CANONICAL_OPERATIONS_INPUT_INVALID'),
}));
const notificationInputSchema = z.object({
    channel: notificationChannelSchema,
    eventKind: z.string().trim().min(1).max(128),
    dedupeKey: z.string().trim().min(1).max(512),
    payload: z.unknown().optional().default({}),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    requeue: z.boolean().optional().default(false),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload, 'CANONICAL_OPERATIONS_INPUT_INVALID'),
}));
const lifecycleInputSchema = z.object({
    accountId: uuidSchema,
    eventKind: lifecycleEventSchema,
    state: z.string().trim().min(1).max(128),
    payload: z.unknown().optional().default({}),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload, 'CANONICAL_OPERATIONS_INPUT_INVALID'),
}));
const configurationInputSchema = z.object({
    configKey: z.string().trim().min(1).max(256),
    version: z.number().int().positive(),
    state: z.enum(['draft', 'effective', 'retired']),
    config: z.unknown(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectiveAt: z.string().datetime({ offset: true }).nullable(),
}).strict().transform(input => ({
    ...input,
    config: parseJsonObject(input.config, 'CANONICAL_OPERATIONS_INPUT_INVALID'),
}));
const leaseInputSchema = z.object({
    leaseKey: z.string().trim().min(1).max(256),
    kind: leaseKindSchema,
    holderHash: z.string().regex(/^[a-f0-9]{64}$/),
    leaseSeconds: z.number().int().min(1).max(3600),
}).strict();
const maintenanceInputSchema = z.object({
    kind: maintenanceKindSchema,
    targetKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z.unknown().optional().default({}),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    requeue: z.boolean().optional().default(false),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload, 'CANONICAL_OPERATIONS_INPUT_INVALID'),
}));
const notificationFinishInputSchema = z.object({
    outboxId: uuidSchema,
    leaseToken: uuidSchema,
    leaseGeneration: z.number().int().nonnegative(),
    outcome: z.enum(['sent', 'retryable', 'dead']),
    errorCode: errorCodeSchema,
    retryAfterSeconds: z.number().int().min(0).max(3600),
}).strict();
const maintenanceFinishInputSchema = z.object({
    jobId: uuidSchema,
    leaseToken: uuidSchema,
    leaseGeneration: z.number().int().nonnegative(),
    outcome: z.enum(['succeeded', 'retryable', 'blocked']),
    errorCode: errorCodeSchema,
    retryAfterSeconds: z.number().int().min(0).max(3600),
}).strict();
const claimInputSchema = z.object({
    limit: z.number().int().min(1).max(100),
    holderHash: z.string().regex(/^[a-f0-9]{64}$/),
    leaseSeconds: z.number().int().min(60).max(600),
}).strict();

const operationResultSchema = z.object({
    status: z.string().min(1),
    duplicate: z.boolean().optional(),
}).passthrough();
const leaseResultSchema = z.object({
    acquired: z.boolean(),
    generation: z.number().int().nonnegative(),
    fence_token: z.number().int().nonnegative(),
    lease_expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type FulfillmentJobInput = z.input<typeof fulfillmentInputSchema>;
export type NotificationInput = z.input<typeof notificationInputSchema>;
export type AccountLifecycleInput = z.input<typeof lifecycleInputSchema>;
export type SystemConfigurationInput = z.input<typeof configurationInputSchema>;
export type SystemLeaseInput = z.infer<typeof leaseInputSchema>;
export type MaintenanceJobInput = z.input<typeof maintenanceInputSchema>;
export type NotificationFinishInput = z.infer<typeof notificationFinishInputSchema>;
export type MaintenanceFinishInput = z.infer<typeof maintenanceFinishInputSchema>;
export type CanonicalClaimInput = z.infer<typeof claimInputSchema>;
export type SystemLeaseResult = Readonly<{
    acquired: boolean;
    generation: number;
    fenceToken: number;
    leaseExpiresAt: string | null;
}>;

export const CANONICAL_SYSTEM_CONFIGURATION_HASH_NAMESPACE =
    CANONICAL_HASH_NAMESPACES.systemConfiguration;

export function canonicalSystemConfigurationHash(config: CanonicalJsonObject): string {
    return canonicalJsonHash(CANONICAL_SYSTEM_CONFIGURATION_HASH_NAMESPACE, config);
}

/**
 * Canonical mirrors are deliberately fail-open for legacy producers, but they
 * must never wait indefinitely on a control-plane write. The operation is
 * started lazily so the timeout covers both invocation and completion.
 */
export const CANONICAL_MIRROR_TIMEOUT_MS = 1_000;

export async function withCanonicalMirrorTimeout<T>(
    operation: () => PromiseLike<T>,
    timeoutMs = CANONICAL_MIRROR_TIMEOUT_MS,
): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('CANONICAL_MIRROR_TIMEOUT');
                    Object.defineProperty(error, 'code', {
                        configurable: true,
                        enumerable: true,
                        value: 'CANONICAL_MIRROR_TIMEOUT',
                    });
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export interface CanonicalOperationsRpcClient {
    rpc(
        name: string,
        params?: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }>;
}

export class CanonicalOperationsError extends Error {
    readonly code:
        | 'CANONICAL_OPERATIONS_INPUT_INVALID'
        | 'CANONICAL_OPERATIONS_RPC_FAILED'
        | 'CANONICAL_OPERATIONS_RESULT_INVALID'
        | 'CANONICAL_MAINTENANCE_UNAVAILABLE';

    constructor(
        code: CanonicalOperationsError['code'],
        cause?: unknown,
    ) {
        super(code);
        this.name = 'CanonicalOperationsError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            configurable: true,
            enumerable: false,
            value: cause,
            writable: true,
        });
    }
}

export type CanonicalFamily =
    | 'payment'
    | 'fulfillment'
    | 'notification'
    | 'account'
    | 'config'
    | 'lease'
    | 'maintenance';

const canonicalReadFlags: Record<CanonicalFamily, string> = {
    payment: 'COMMERCE_CANONICAL_PAYMENT_READ',
    fulfillment: 'COMMERCE_CANONICAL_FULFILLMENT_READ',
    notification: 'COMMERCE_CANONICAL_NOTIFICATION_READ',
    account: 'COMMERCE_CANONICAL_ACCOUNT_READ',
    config: 'COMMERCE_CANONICAL_CONFIG_READ',
    lease: 'COMMERCE_CANONICAL_LEASE_READ',
    maintenance: 'COMMERCE_CANONICAL_MAINTENANCE_READ',
};
const canonicalWriteFlags: Record<CanonicalFamily, string> = {
    payment: 'COMMERCE_CANONICAL_PAYMENT_WRITE',
    fulfillment: 'COMMERCE_CANONICAL_FULFILLMENT_WRITE',
    notification: 'COMMERCE_CANONICAL_NOTIFICATION_WRITE',
    account: 'COMMERCE_CANONICAL_ACCOUNT_WRITE',
    config: 'COMMERCE_CANONICAL_CONFIG_WRITE',
    lease: 'COMMERCE_CANONICAL_LEASE_WRITE',
    maintenance: 'COMMERCE_CANONICAL_MAINTENANCE_WRITE',
};

export function rollbackCanonicalFlags(
    environment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
    return Object.fromEntries([
        ...Object.entries(environment),
        ...Object.values(canonicalReadFlags).map(flag => [flag, 'false']),
        ...Object.values(canonicalWriteFlags).map(flag => [flag, 'false']),
    ]);
}

export function rollbackCanonicalReadFlags(
    environment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
    return rollbackCanonicalFlags(environment);
}

export function isCanonicalFamilyReadEnabled(
    family: CanonicalFamily,
    environment: Record<string, string | undefined> = process.env,
): boolean {
    return environment[canonicalReadFlags[family]] === 'true';
}

export function isCanonicalFamilyWriteEnabled(
    family: CanonicalFamily,
    environment: Record<string, string | undefined> = process.env,
): boolean {
    return environment[canonicalWriteFlags[family]] === 'true';
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
    }
    return parsed.data;
}

async function callRpc(
    rpc: CanonicalOperationsRpcClient['rpc'],
    name: string,
    params: Record<string, unknown> = {},
): Promise<unknown> {
    let result: { data: unknown; error: unknown };
    try {
        result = await rpc(name, params);
    } catch (error) {
        throw new CanonicalOperationsError(
            'CANONICAL_OPERATIONS_RPC_FAILED',
            error,
        );
    }
    if (result.error) {
        throw new CanonicalOperationsError(
            'CANONICAL_OPERATIONS_RPC_FAILED',
            result.error,
        );
    }
    return result.data;
}

function parseOperationResult(data: unknown): Readonly<Record<string, unknown>> {
    const result = operationResultSchema.safeParse(data);
    if (!result.success) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
    }
    return Object.freeze(result.data);
}

function parseRows(data: unknown): ReadonlyArray<Record<string, unknown>> {
    if (
        !Array.isArray(data)
        || data.length > 100
        || data.some(row => !row || typeof row !== 'object' || Array.isArray(row))
    ) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
    }
    return Object.freeze(data as Record<string, unknown>[]);
}

export interface CanonicalOperationsStore {
    upsertFulfillmentJob(input: FulfillmentJobInput): Promise<unknown>;
    enqueueNotification(input: NotificationInput): Promise<unknown>;
    appendAccountLifecycle(input: AccountLifecycleInput): Promise<unknown>;
    recordSystemConfiguration(input: SystemConfigurationInput): Promise<unknown>;
    acquireSystemLease(input: SystemLeaseInput): Promise<SystemLeaseResult>;
    enqueueMaintenanceJob(input: MaintenanceJobInput): Promise<unknown>;
    claimNotificationOutbox(input: CanonicalClaimInput): Promise<ReadonlyArray<Record<string, unknown>>>;
    finishNotificationOutbox(input: NotificationFinishInput): Promise<unknown>;
    reconcileStaleNotificationOutboxClaims(limit?: number): Promise<unknown>;
    claimMaintenanceJobs(input: CanonicalClaimInput): Promise<ReadonlyArray<Record<string, unknown>>>;
    finishMaintenanceJob(input: MaintenanceFinishInput): Promise<unknown>;
    reconcileStaleMaintenanceJobs(limit?: number): Promise<unknown>;
}

export function createCanonicalOperationsStore(
    dependencies: { rpc: CanonicalOperationsRpcClient['rpc'] } = {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
    },
): CanonicalOperationsStore {
    return Object.freeze({
        async upsertFulfillmentJob(input: FulfillmentJobInput) {
            const parsed = parseInput(fulfillmentInputSchema, input);
            const data = await callRpc(
                dependencies.rpc,
                'upsert_fulfillment_job_v1',
                {
                    p_order_id: parsed.orderId,
                    p_request_id: parsed.requestId,
                    p_state: parsed.state,
                    p_attempt_count: parsed.attemptCount,
                    p_lease_generation: parsed.leaseGeneration,
                    p_lease_token: parsed.leaseToken,
                    p_lease_expires_at: parsed.leaseExpiresAt,
                    p_next_attempt_at: parsed.nextAttemptAt,
                    p_last_error_code: parsed.lastErrorCode,
                    p_operator_admitted_at: parsed.operatorAdmittedAt,
                    p_last_error_at: parsed.lastErrorAt,
                    p_completed_at: parsed.completedAt,
                    p_manual_review_at: parsed.manualReviewAt,
                    p_payload: parsed.payload,
                },
            );
            return parseOperationResult(data);
        },

        async enqueueNotification(input: NotificationInput) {
            const parsed = parseInput(notificationInputSchema, input);
            const data = await callRpc(
                dependencies.rpc,
                'enqueue_notification_v1',
                {
                    p_channel: parsed.channel,
                    p_event_kind: parsed.eventKind,
                    p_dedupe_key: parsed.dedupeKey,
                    p_payload: parsed.payload,
                    p_content_hash: parsed.contentHash,
                    ...(parsed.requeue ? { p_requeue: true } : {}),
                },
            );
            return parseOperationResult(data);
        },

        async appendAccountLifecycle(input: AccountLifecycleInput) {
            const parsed = parseInput(lifecycleInputSchema, input);
            const data = await callRpc(
                dependencies.rpc,
                'append_account_lifecycle_v1',
                {
                    p_account_id: parsed.accountId,
                    p_event_kind: parsed.eventKind,
                    p_state: parsed.state,
                    p_payload: parsed.payload,
                    p_content_hash: parsed.contentHash,
                },
            );
            return parseOperationResult(data);
        },

        async recordSystemConfiguration(input: SystemConfigurationInput) {
            const parsed = parseInput(configurationInputSchema, input);
            if (
                Object.keys(parsed.config).length === 0
                || parsed.contentHash !== canonicalSystemConfigurationHash(parsed.config)
            ) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
            }
            const data = await callRpc(
                dependencies.rpc,
                'record_system_configuration_v1',
                {
                    p_config_key: parsed.configKey,
                    p_version: parsed.version,
                    p_state: parsed.state,
                    p_config: parsed.config,
                    p_content_hash: parsed.contentHash,
                    p_effective_at: parsed.effectiveAt,
                },
            );
            return parseOperationResult(data);
        },

        async acquireSystemLease(input: SystemLeaseInput) {
            const parsed = parseInput(leaseInputSchema, input);
            const data = await callRpc(
                dependencies.rpc,
                'acquire_system_lease_v1',
                {
                    p_lease_key: parsed.leaseKey,
                    p_kind: parsed.kind,
                    p_holder_hash: parsed.holderHash,
                    p_lease_seconds: parsed.leaseSeconds,
                },
            );
            const result = leaseResultSchema.safeParse(data);
            if (!result.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze({
                acquired: result.data.acquired,
                generation: result.data.generation,
                fenceToken: result.data.fence_token,
                leaseExpiresAt: result.data.lease_expires_at,
            });
        },

        async enqueueMaintenanceJob(input: MaintenanceJobInput) {
            const parsed = parseInput(maintenanceInputSchema, input);
            const data = await callRpc(
                dependencies.rpc,
                'enqueue_maintenance_job_v1',
                {
                    p_kind: parsed.kind,
                    p_target_key_hash: parsed.targetKeyHash,
                    p_payload: parsed.payload,
                    p_content_hash: parsed.contentHash,
                    ...(parsed.requeue ? { p_requeue: true } : {}),
                },
            );
            return parseOperationResult(data);
        },

        async claimNotificationOutbox(input: CanonicalClaimInput) {
            const parsed = parseInput(claimInputSchema, input);
            const data = await callRpc(dependencies.rpc, 'claim_notification_outbox_v1', {
                p_limit: parsed.limit,
                p_holder_hash: parsed.holderHash,
                p_lease_seconds: parsed.leaseSeconds,
            });
            return parseRows(data);
        },

        async finishNotificationOutbox(input: NotificationFinishInput) {
            const parsed = parseInput(notificationFinishInputSchema, input);
            return parseOperationResult(await callRpc(dependencies.rpc, 'finish_notification_outbox_v1', {
                p_outbox_id: parsed.outboxId,
                p_lease_token: parsed.leaseToken,
                p_lease_generation: parsed.leaseGeneration,
                p_outcome: parsed.outcome,
                p_error_code: parsed.errorCode,
                p_retry_after_seconds: parsed.retryAfterSeconds,
            }));
        },

        async reconcileStaleNotificationOutboxClaims(limit = 100) {
            const parsedLimit = claimInputSchema.shape.limit.safeParse(limit);
            if (!parsedLimit.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
            }
            return parseOperationResult(await callRpc(
                dependencies.rpc,
                'reconcile_stale_notification_outbox_v1',
                { p_limit: parsedLimit.data },
            ));
        },

        async claimMaintenanceJobs(input: CanonicalClaimInput) {
            const parsed = parseInput(claimInputSchema, input);
            const data = await callRpc(dependencies.rpc, 'claim_maintenance_jobs_v1', {
                p_limit: parsed.limit,
                p_holder_hash: parsed.holderHash,
                p_lease_seconds: parsed.leaseSeconds,
            });
            return parseRows(data);
        },

        async finishMaintenanceJob(input: MaintenanceFinishInput) {
            const parsed = parseInput(maintenanceFinishInputSchema, input);
            return parseOperationResult(await callRpc(dependencies.rpc, 'finish_maintenance_job_v1', {
                p_job_id: parsed.jobId,
                p_lease_token: parsed.leaseToken,
                p_lease_generation: parsed.leaseGeneration,
                p_outcome: parsed.outcome,
                p_error_code: parsed.errorCode,
                p_retry_after_seconds: parsed.retryAfterSeconds,
            }));
        },

        async reconcileStaleMaintenanceJobs(limit = 100) {
            const parsedLimit = claimInputSchema.shape.limit.safeParse(limit);
            if (!parsedLimit.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID');
            }
            return parseOperationResult(await callRpc(
                dependencies.rpc,
                'reconcile_stale_maintenance_jobs_v1',
                { p_limit: parsedLimit.data },
            ));
        },
    });
}

export const canonicalOperationsStore = createCanonicalOperationsStore();

export function queueCanonicalMaintenanceJob(input: MaintenanceJobInput): Promise<unknown> {
    if (!isCanonicalFamilyWriteEnabled('maintenance')) {
        return Promise.reject(new CanonicalOperationsError('CANONICAL_MAINTENANCE_UNAVAILABLE'));
    }
    return canonicalOperationsStore.enqueueMaintenanceJob(input);
}

export type ShadowRow = Readonly<{
    key: string;
    fields: Record<string, unknown>;
}>;
export type ShadowComparisonResult =
    | { status: 'disabled'; compared: 0 }
    | { status: 'blocked'; compared: 0 }
    | { status: 'unavailable'; compared: 0 }
    | { status: 'match'; compared: number; mismatchedFields: string[]; truncated: boolean }
    | { status: 'mismatch'; compared: number; mismatchedFields: string[]; truncated: boolean };

/**
 * Bounded, opt-in parity comparison. Only keys, counts, and field names are
 * returned so shadow diagnostics cannot become a second data export path.
 */
export async function shadowCompareCanonicalFamily(
    family: CanonicalFamily,
    readLegacy: () => Promise<ReadonlyArray<ShadowRow>>,
    readCanonical: () => Promise<ReadonlyArray<ShadowRow>>,
    limit = 100,
    environment: Record<string, string | undefined> = process.env,
): Promise<ShadowComparisonResult> {
    if (!isCanonicalFamilyReadEnabled(family, environment)) {
        return { status: 'disabled', compared: 0 };
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return { status: 'blocked', compared: 0 };
    }
    try {
        const [legacy, canonical] = await Promise.all([readLegacy(), readCanonical()]);
        if (!Array.isArray(legacy) || !Array.isArray(canonical)) {
            return { status: 'unavailable', compared: 0 };
        }
        const truncated = legacy.length > limit || canonical.length > limit;
        const boundedLegacy = legacy.slice(0, limit);
        const boundedCanonical = canonical.slice(0, limit);
        const canonicalByKey = new Map(boundedCanonical.map(row => [row.key, row]));
        const legacyByKey = new Map(boundedLegacy.map(row => [row.key, row]));
        const mismatchedFields = new Set<string>();
        if (legacyByKey.size !== boundedLegacy.length || canonicalByKey.size !== boundedCanonical.length) {
            mismatchedFields.add('duplicate_key');
        }
        let compared = 0;
        for (const legacyRow of boundedLegacy) {
            const canonicalRow = canonicalByKey.get(legacyRow.key);
            if (!canonicalRow) {
                mismatchedFields.add('missing_record');
                continue;
            }
            compared += 1;
            const keys = new Set([
                ...Object.keys(legacyRow.fields),
                ...Object.keys(canonicalRow.fields),
            ]);
            for (const field of keys) {
                let equal = false;
                try {
                    equal = canonicalJson(legacyRow.fields[field]) === canonicalJson(canonicalRow.fields[field]);
                } catch {
                    equal = false;
                }
                if (!equal) mismatchedFields.add(field);
            }
        }
        // Compare the canonical tail back against legacy as well. Equal row
        // counts are not parity when a row exists only on the canonical side.
        for (const canonicalRow of boundedCanonical) {
            if (!legacyByKey.has(canonicalRow.key)) {
                mismatchedFields.add('missing_record');
            }
        }
        if (boundedLegacy.length !== boundedCanonical.length) mismatchedFields.add('record_count');
        if (truncated) mismatchedFields.add('truncated');
        const result = {
            status: mismatchedFields.size > 0 ? 'mismatch' as const : 'match' as const,
            compared,
            mismatchedFields: [...mismatchedFields].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
            truncated,
        };
        return result;
    } catch {
        return { status: 'unavailable', compared: 0 };
    }
}

export async function shadowReadCanonicalNotificationOutbox(
    limit = 10,
    rpc: CanonicalOperationsRpcClient['rpc'] = (name, params) =>
        supabaseAdmin.rpc(name, params),
): Promise<{
    status: 'ok' | 'blocked';
    rowCount: number;
    comparison?: ShadowComparisonResult;
}> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return { status: 'blocked', rowCount: 0 };
    }
    // Ask for one sentinel row so a full page cannot be mistaken for parity.
    // The SQL reader is capped at 100, therefore a requested limit of 100 is
    // compared at 99 with a 100-row probe and fails closed on a full probe.
    const comparisonLimit = Math.min(limit, 99);
    const readLimit = comparisonLimit + 1;
    try {
        const [legacyResult, canonicalResult] = await Promise.all([
            withCanonicalMirrorTimeout(() => rpc('list_notification_legacy_outbox_v1', {
                p_limit: readLimit,
            })),
            withCanonicalMirrorTimeout(() => rpc('list_notification_outbox_v1', {
                p_limit: readLimit,
            })),
        ]);
        if (legacyResult.error || canonicalResult.error
            || !Array.isArray(legacyResult.data)
            || !Array.isArray(canonicalResult.data)) {
            return { status: 'blocked', rowCount: 0 };
        }
        const normalize = (data: unknown): ReadonlyArray<ShadowRow> => {
            if (!Array.isArray(data)) throw new Error('SHADOW_ROWS_INVALID');
            return data.map(row => {
                if (!row || typeof row !== 'object' || Array.isArray(row)) {
                    throw new Error('SHADOW_ROW_INVALID');
                }
                const value = row as Record<string, unknown>;
                if (typeof value.dedupe_key !== 'string'
                    || typeof value.channel !== 'string'
                    || typeof value.event_kind !== 'string'
                    || typeof value.content_hash !== 'string') {
                    throw new Error('SHADOW_ROW_INVALID');
                }
                const fields: Record<string, unknown> = {
                    channel: value.channel,
                    event_kind: value.event_kind,
                    payload: value.payload,
                    content_hash: value.content_hash,
                };
                return {
                    key: value.dedupe_key,
                    fields,
                };
            });
        };
        const legacyRows = normalize(legacyResult.data);
        const canonicalRows = normalize(canonicalResult.data);
        // This helper is reached only after the route's explicit read flag
        // gate. Keep the comparison itself independent of process.env so a
        // diagnostic call cannot silently skip its parity check.
        const comparison = await shadowCompareCanonicalFamily(
            'notification',
            async () => legacyRows,
            async () => canonicalRows,
            comparisonLimit,
            { COMMERCE_CANONICAL_NOTIFICATION_READ: 'true' },
        );
        return {
            status: comparison.status === 'match' ? 'ok' : 'blocked',
            rowCount: canonicalRows.length,
            comparison,
        };
    } catch {
        return { status: 'blocked', rowCount: 0 };
    }
}

export function maintenanceMarker(
    kind: MaintenanceJobInput['kind'],
    target: string,
    content: string,
): MaintenanceJobInput {
    return {
        kind,
        targetKeyHash: canonicalEvidenceHash(`maintenance:${kind}`, target),
        contentHash: canonicalEvidenceHash(`maintenance:${kind}:content`, content),
        payload: {},
    };
}
