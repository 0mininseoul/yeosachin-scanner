import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    canonicalEvidenceHash,
    canonicalJson,
    parseCanonicalJsonObject,
    type CanonicalJsonObject,
} from '@/lib/services/commerce/canonical-commerce-store';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const lifecycleEventSchema = z.enum([
    'classification',
    'paid_evidence',
    'deletion_requested',
    'objects_purged',
    'database_purged',
    'retired',
    'e2e',
]);
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

function parseJsonObject(value: unknown): CanonicalJsonObject {
    try {
        return parseCanonicalJsonObject(value);
    } catch (error) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_INPUT_INVALID', error);
    }
}

const lifecycleInputSchema = z.object({
    accountId: uuidSchema,
    eventKind: lifecycleEventSchema,
    state: z.string().trim().min(1).max(128),
    payload: z.unknown().optional().default({}),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload),
}));

const maintenanceInputSchema = z.object({
    kind: maintenanceKindSchema,
    targetKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z.unknown().optional().default({}),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    requeue: z.boolean().optional().default(false),
}).strict().transform(input => ({
    ...input,
    payload: parseJsonObject(input.payload),
}));

const operationResultSchema = z.object({
    status: z.string().min(1),
    duplicate: z.boolean().optional(),
}).passthrough();

export type AccountLifecycleInput = z.input<typeof lifecycleInputSchema>;
export type MaintenanceJobInput = z.input<typeof maintenanceInputSchema>;

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

/** Payment, identity, and maintenance flags are retained contracts. */
export type CanonicalFamily = 'payment' | 'account' | 'maintenance';

const canonicalReadFlags: Record<CanonicalFamily, string> = {
    payment: 'COMMERCE_CANONICAL_PAYMENT_READ',
    account: 'COMMERCE_CANONICAL_ACCOUNT_READ',
    maintenance: 'COMMERCE_CANONICAL_MAINTENANCE_READ',
};
const canonicalWriteFlags: Record<CanonicalFamily, string> = {
    payment: 'COMMERCE_CANONICAL_PAYMENT_WRITE',
    account: 'COMMERCE_CANONICAL_ACCOUNT_WRITE',
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

/**
 * Canonical mirrors are deliberately fail-open for retained legacy producers,
 * but they must never wait indefinitely on a control-plane write.
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
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RPC_FAILED', error);
    }
    if (result.error) {
        throw new CanonicalOperationsError('CANONICAL_OPERATIONS_RPC_FAILED', result.error);
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

export interface CanonicalOperationsStore {
    appendAccountLifecycle(input: AccountLifecycleInput): Promise<unknown>;
    enqueueMaintenanceJob(input: MaintenanceJobInput): Promise<unknown>;
}

export function createCanonicalOperationsStore(
    dependencies: { rpc: CanonicalOperationsRpcClient['rpc'] } = {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
    },
): CanonicalOperationsStore {
    return Object.freeze({
        async appendAccountLifecycle(input: AccountLifecycleInput) {
            const parsed = parseInput(lifecycleInputSchema, input);
            const data = await callRpc(dependencies.rpc, 'append_account_lifecycle_v1', {
                p_account_id: parsed.accountId,
                p_event_kind: parsed.eventKind,
                p_state: parsed.state,
                p_payload: parsed.payload,
                p_content_hash: parsed.contentHash,
            });
            return parseOperationResult(data);
        },

        async enqueueMaintenanceJob(input: MaintenanceJobInput) {
            const parsed = parseInput(maintenanceInputSchema, input);
            const data = await callRpc(dependencies.rpc, 'enqueue_maintenance_job_v1', {
                p_kind: parsed.kind,
                p_target_key_hash: parsed.targetKeyHash,
                p_payload: parsed.payload,
                p_content_hash: parsed.contentHash,
                ...(parsed.requeue ? { p_requeue: true } : {}),
            });
            return parseOperationResult(data);
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

/** Preserve the shared canonical hash implementation for retained callers. */
export { canonicalJson };
