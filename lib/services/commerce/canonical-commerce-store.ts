import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const eventTypeSchema = z.enum([
    'payment.completed',
    'payment.cancel_requested',
    'payment.refunded',
]);
const paymentDispositionSchema = z.enum([
    'accepted',
    'duplicate',
    'no_sale',
    'rejected',
    'payment_pending',
]);

/**
 * Canonical evidence is deliberately a small JSON value. This keeps hashes
 * deterministic and prevents accidental persistence of raw request bodies,
 * credentials, or buyer contact data.
 */
export type CanonicalJsonValue =
    | null
    | boolean
    | number
    | string
    | CanonicalJsonValue[]
    | { [key: string]: CanonicalJsonValue };
export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue };

const sensitiveKeyPattern = /(?:token|secret|password|cookie|authorization|raw[_-]?body|buyer[_-]?(?:email|phone)|email|phone)/i;

/**
 * Hashes in the commerce/operations boundary use one deliberately boring
 * wire format: UTF-8 bytes of `${namespace}\n${canonicalJson(value)}`. Keep
 * the separator and encoding named so the SQL implementation can mirror this
 * contract without relying on a database's JSONB display representation.
 */
export const CANONICAL_JSON_HASH_SEPARATOR = '\n';
export const CANONICAL_JSON_HASH_ENCODING = 'utf8';
export const CANONICAL_HASH_NAMESPACES = Object.freeze({
    systemConfiguration: 'system-configuration',
    paymentNotificationContent: 'payment-discord-content',
    kakaoNotificationKey: 'kakao-signup-key',
    kakaoNotificationContent: 'kakao-signup-content',
    sentryNotificationKey: 'sentry-dedupe-key',
    sentryNotificationContent: 'sentry-notification-content',
});

function compareCanonicalKeys(left: string, right: string): number {
    // Sort by UTF-8 bytes. PostgreSQL reproduces this ordering by sorting the
    // lowercase hex form of convert_to(key, 'UTF8'), independent of collation.
    return Buffer.compare(
        Buffer.from(left, CANONICAL_JSON_HASH_ENCODING),
        Buffer.from(right, CANONICAL_JSON_HASH_ENCODING),
    );
}

function normalizeCanonicalJson(value: unknown, depth = 0, key = 'root'): CanonicalJsonValue {
    if (depth > 8) {
        throw new Error('CANONICAL_JSON_DEPTH_LIMIT');
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        if (typeof value === 'string' && value.length > 8192) {
            throw new Error('CANONICAL_JSON_STRING_LIMIT');
        }
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('CANONICAL_JSON_NUMBER_INVALID');
        }
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 100) {
            throw new Error('CANONICAL_JSON_ARRAY_LIMIT');
        }
        return value.map((item, index) => normalizeCanonicalJson(item, depth + 1, `${key}[${index}]`));
    }
    if (typeof value !== 'object' || value === undefined) {
        throw new Error('CANONICAL_JSON_VALUE_INVALID');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('CANONICAL_JSON_OBJECT_INVALID');
    }

    const output: CanonicalJsonObject = {};
    const entries = Object.entries(value);
    if (entries.length > 100) {
        throw new Error('CANONICAL_JSON_OBJECT_LIMIT');
    }
    for (const [childKey, childValue] of entries) {
        if (!childKey || childKey.length > 128 || sensitiveKeyPattern.test(childKey)) {
            throw new Error('CANONICAL_JSON_KEY_INVALID');
        }
        if (childValue === undefined) {
            throw new Error('CANONICAL_JSON_UNDEFINED');
        }
        output[childKey] = normalizeCanonicalJson(childValue, depth + 1, `${key}.${childKey}`);
    }
    return Object.fromEntries(
        Object.entries(output).sort(([left], [right]) => compareCanonicalKeys(left, right)),
    );
}

export function parseCanonicalJsonObject(value: unknown): CanonicalJsonObject {
    const normalized = normalizeCanonicalJson(value);
    if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
        throw new Error('CANONICAL_JSON_OBJECT_REQUIRED');
    }
    return normalized;
}

function serializeCanonicalJson(value: CanonicalJsonValue): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') {
            throw new Error('CANONICAL_JSON_VALUE_INVALID');
        }
        return serialized;
    }
    if (Array.isArray(value)) {
        return `[${value.map(serializeCanonicalJson).join(',')}]`;
    }
    // JSON.stringify gives integer-like object keys special enumeration
    // ordering. Serialize entries explicitly so PostgreSQL's UTF-8 ordering
    // remains the source of truth for every valid object key.
    return `{${Object.entries(value)
        .sort(([left], [right]) => compareCanonicalKeys(left, right))
        .map(([key, child]) => `${JSON.stringify(key)}:${serializeCanonicalJson(child)}`)
        .join(',')}}`;
}

export function canonicalJson(value: unknown): string {
    return serializeCanonicalJson(normalizeCanonicalJson(value));
}

export function canonicalJsonHashInput(namespace: string, value: unknown): string {
    if (!namespace || namespace.includes(CANONICAL_JSON_HASH_SEPARATOR)) {
        throw new Error('CANONICAL_JSON_NAMESPACE_INVALID');
    }
    return `${namespace}${CANONICAL_JSON_HASH_SEPARATOR}${canonicalJson(value)}`;
}

export function canonicalJsonHash(namespace: string, value: unknown): string {
    return createHash('sha256')
        .update(canonicalJsonHashInput(namespace, value), CANONICAL_JSON_HASH_ENCODING)
        .digest('hex');
}

const paymentEventInputSchema = z.object({
    eventId: z.string().trim().min(1).max(256),
    idempotencyKey: z.string().trim().min(1).max(256),
    eventType: eventTypeSchema,
    paymentId: z.string().trim().min(1).max(256),
    orderId: z.string().uuid().nullable(),
    provider: z.literal('groble'),
    disposition: paymentDispositionSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z.unknown(),
    occurredAt: z.string().datetime({ offset: true }),
    amountKrw: z.number().int().nonnegative().nullable(),
}).strict();

const paymentEventResultSchema = z.object({
    status: z.literal('recorded'),
    duplicate: z.boolean(),
}).strict();

export type PaymentEventInput = z.infer<typeof paymentEventInputSchema> & {
    payload: CanonicalJsonObject;
};
export type PaymentEventResult = z.infer<typeof paymentEventResultSchema>;

export interface CanonicalCommerceRpcClient {
    rpc(
        name: string,
        params: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: unknown }>;
}

export class CanonicalCommerceError extends Error {
    readonly code:
        | 'CANONICAL_COMMERCE_INPUT_INVALID'
        | 'CANONICAL_COMMERCE_RPC_FAILED'
        | 'CANONICAL_COMMERCE_IDEMPOTENCY_CONFLICT'
        | 'CANONICAL_COMMERCE_RESULT_INVALID';

    constructor(
        code: CanonicalCommerceError['code'],
        cause?: unknown,
    ) {
        super(code);
        this.name = 'CanonicalCommerceError';
        this.code = code;
        Object.defineProperty(this, 'cause', {
            configurable: true,
            enumerable: false,
            value: cause,
            writable: true,
        });
    }
}

function parsePaymentEventInput(input: PaymentEventInput): PaymentEventInput {
    const parsed = paymentEventInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new CanonicalCommerceError('CANONICAL_COMMERCE_INPUT_INVALID');
    }
    try {
        return {
            ...parsed.data,
            payload: parseCanonicalJsonObject(parsed.data.payload),
        };
    } catch (error) {
        throw new CanonicalCommerceError('CANONICAL_COMMERCE_INPUT_INVALID', error);
    }
}

function parseRpcResult(data: unknown): PaymentEventResult {
    const parsed = paymentEventResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new CanonicalCommerceError('CANONICAL_COMMERCE_RESULT_INVALID');
    }
    return Object.freeze(parsed.data);
}

function rpcErrorContains(error: unknown, marker: string): boolean {
    if (typeof error === 'string') return error.includes(marker);
    if (error && typeof error === 'object') {
        const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
        return [candidate.message, candidate.details, candidate.hint]
            .filter((value): value is string => typeof value === 'string')
            .some(value => value.includes(marker));
    }
    return false;
}

export interface CanonicalCommerceStore {
    recordPaymentEvent(input: PaymentEventInput): Promise<PaymentEventResult>;
}

export function createCanonicalCommerceStore(
    dependencies: { rpc: CanonicalCommerceRpcClient['rpc'] } = {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
    },
): CanonicalCommerceStore {
    return Object.freeze({
        async recordPaymentEvent(input: PaymentEventInput): Promise<PaymentEventResult> {
            const parsed = parsePaymentEventInput(input);
            let result: { data: unknown; error: unknown };
            try {
                result = await dependencies.rpc('record_payment_event_v1', {
                    p_event_id: parsed.eventId,
                    p_idempotency_key: parsed.idempotencyKey,
                    p_event_type: parsed.eventType,
                    p_payment_id: parsed.paymentId,
                    p_order_id: parsed.orderId,
                    p_provider: parsed.provider,
                    p_disposition: parsed.disposition,
                    p_payload_hash: parsed.payloadHash,
                    p_payload: parsed.payload,
                    p_occurred_at: parsed.occurredAt,
                    p_amount_krw: parsed.amountKrw,
                });
            } catch (error) {
                if (
                    rpcErrorContains(error, 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT')
                    || rpcErrorContains(error, 'PAYMENT_EVENT_IDEMPOTENCY_KEY_CONFLICT')
                ) {
                    throw new CanonicalCommerceError(
                        'CANONICAL_COMMERCE_IDEMPOTENCY_CONFLICT',
                        error,
                    );
                }
                throw new CanonicalCommerceError(
                    'CANONICAL_COMMERCE_RPC_FAILED',
                    error,
                );
            }
            if (result.error) {
                if (
                    rpcErrorContains(result.error, 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT')
                    || rpcErrorContains(result.error, 'PAYMENT_EVENT_IDEMPOTENCY_KEY_CONFLICT')
                ) {
                    throw new CanonicalCommerceError(
                        'CANONICAL_COMMERCE_IDEMPOTENCY_CONFLICT',
                        result.error,
                    );
                }
                throw new CanonicalCommerceError(
                    'CANONICAL_COMMERCE_RPC_FAILED',
                    result.error,
                );
            }
            return parseRpcResult(result.data);
        },
    });
}

export const canonicalCommerceStore = createCanonicalCommerceStore();

export function canonicalEvidenceHash(namespace: string, value: string): string {
    return createHash('sha256')
        .update(`${namespace}${CANONICAL_JSON_HASH_SEPARATOR}${value}`, CANONICAL_JSON_HASH_ENCODING)
        .digest('hex');
}

export type CanonicalPaymentMaintenanceMarker = Readonly<{
    kind: 'payment_event';
    targetKeyHash: string;
    contentHash: string;
}>;

export type CanonicalPaymentMaintenanceEnqueue = (
    marker: CanonicalPaymentMaintenanceMarker,
) => Promise<void>;

export type PaymentEventWithMaintenanceResult =
    | PaymentEventResult
    | { status: 'maintenance_queued' }
    | { status: 'unavailable'; code: 'CANONICAL_MAINTENANCE_UNAVAILABLE' };

/**
 * Payment finalization remains authoritative. A canonical mirror failure is
 * converted into a bounded maintenance marker, but a queue outage is exposed
 * to the caller instead of being reported as queued.
 */
export async function recordPaymentEventWithMaintenance(
    store: CanonicalCommerceStore,
    input: PaymentEventInput,
    enqueueMaintenance: CanonicalPaymentMaintenanceEnqueue,
): Promise<PaymentEventWithMaintenanceResult> {
    const parsed = parsePaymentEventInput(input);
    try {
        return await store.recordPaymentEvent(parsed);
    } catch (error) {
        if (
            error instanceof CanonicalCommerceError
            && error.code !== 'CANONICAL_COMMERCE_RPC_FAILED'
        ) {
            throw error;
        }
        try {
            await enqueueMaintenance({
                kind: 'payment_event',
                targetKeyHash: canonicalEvidenceHash('payment-event', parsed.eventId),
                contentHash: parsed.payloadHash,
            });
        } catch {
            return {
                status: 'unavailable',
                code: 'CANONICAL_MAINTENANCE_UNAVAILABLE',
            };
        }
        return { status: 'maintenance_queued' };
    }
}
