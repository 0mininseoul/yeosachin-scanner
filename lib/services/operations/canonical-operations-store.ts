import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { canonicalEvidenceHash } from '@/lib/services/commerce/canonical-commerce-store';

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

const fulfillmentInputSchema = z.object({
    orderId: uuidSchema,
    requestId: uuidSchema.nullable(),
    state: fulfillmentStateSchema,
    attemptCount: z.number().int().min(0).max(10),
    leaseGeneration: z.number().int().nonnegative(),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    nextAttemptAt: z.string().datetime({ offset: true }),
    lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
}).strict();
const notificationInputSchema = z.object({
    channel: notificationChannelSchema,
    eventKind: z.string().trim().min(1).max(128),
    dedupeKey: z.string().trim().min(1).max(512),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const lifecycleInputSchema = z.object({
    accountId: uuidSchema,
    eventKind: lifecycleEventSchema,
    state: z.string().trim().min(1).max(128),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const leaseInputSchema = z.object({
    leaseKey: z.string().trim().min(1).max(256),
    kind: leaseKindSchema,
    holderHash: z.string().regex(/^[a-f0-9]{64}$/),
    leaseSeconds: z.number().int().min(1).max(3600),
}).strict();
const maintenanceInputSchema = z.object({
    kind: maintenanceKindSchema,
    targetKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
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

export type FulfillmentJobInput = z.infer<typeof fulfillmentInputSchema>;
export type NotificationInput = z.infer<typeof notificationInputSchema>;
export type AccountLifecycleInput = z.infer<typeof lifecycleInputSchema>;
export type SystemLeaseInput = z.infer<typeof leaseInputSchema>;
export type MaintenanceJobInput = z.infer<typeof maintenanceInputSchema>;
export type SystemLeaseResult = Readonly<{
    acquired: boolean;
    generation: number;
    fenceToken: number;
    leaseExpiresAt: string | null;
}>;

export interface CanonicalOperationsRpcClient {
    rpc(
        name: string,
        params: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }>;
}

export class CanonicalOperationsError extends Error {
    readonly code:
        | 'CANONICAL_OPERATIONS_INPUT_INVALID'
        | 'CANONICAL_OPERATIONS_RPC_FAILED'
        | 'CANONICAL_OPERATIONS_RESULT_INVALID';

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

export function isCanonicalFamilyReadEnabled(
    family: CanonicalFamily,
    environment: Record<string, string | undefined> = process.env,
): boolean {
    return environment[canonicalReadFlags[family]] === 'true';
}

export function isCanonicalDualWriteEnabled(
    environment: Record<string, string | undefined> = process.env,
): boolean {
    return environment.COMMERCE_CANONICAL_DUAL_WRITE === 'true';
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
    params: Record<string, unknown>,
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

export interface CanonicalOperationsStore {
    upsertFulfillmentJob(input: FulfillmentJobInput): Promise<unknown>;
    enqueueNotification(input: NotificationInput): Promise<unknown>;
    appendAccountLifecycle(input: AccountLifecycleInput): Promise<unknown>;
    acquireSystemLease(input: SystemLeaseInput): Promise<SystemLeaseResult>;
    enqueueMaintenanceJob(input: MaintenanceJobInput): Promise<unknown>;
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
                    p_lease_expires_at: parsed.leaseExpiresAt,
                    p_next_attempt_at: parsed.nextAttemptAt,
                    p_last_error_code: parsed.lastErrorCode,
                },
            );
            const result = operationResultSchema.safeParse(data);
            if (!result.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(result.data);
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
                    p_content_hash: parsed.contentHash,
                },
            );
            const result = operationResultSchema.safeParse(data);
            if (!result.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(result.data);
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
                    p_content_hash: parsed.contentHash,
                },
            );
            const result = operationResultSchema.safeParse(data);
            if (!result.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(result.data);
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
                    p_content_hash: parsed.contentHash,
                },
            );
            const result = operationResultSchema.safeParse(data);
            if (!result.success) {
                throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RESULT_INVALID');
            }
            return Object.freeze(result.data);
        },
    });
}

export const canonicalOperationsStore = createCanonicalOperationsStore();

export function queueCanonicalMaintenanceJob(input: MaintenanceJobInput): Promise<unknown> {
    return canonicalOperationsStore.enqueueMaintenanceJob(input);
}

export async function shadowReadCanonicalNotificationOutbox(
    limit = 10,
): Promise<{ status: 'ok' | 'blocked'; rowCount: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return { status: 'blocked', rowCount: 0 };
    }
    try {
        const result = await supabaseAdmin.rpc('list_notification_outbox_v1', {
            p_limit: limit,
        });
        if (result.error || !Array.isArray(result.data)) {
            return { status: 'blocked', rowCount: 0 };
        }
        return { status: 'ok', rowCount: result.data.length };
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
    };
}
