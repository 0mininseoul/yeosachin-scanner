import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const eventTypeSchema = z.enum([
    'payment.completed',
    'payment.cancel_requested',
    'payment.refunded',
]);

const paymentEventInputSchema = z.object({
    eventId: z.string().trim().min(1).max(256),
    idempotencyKey: z.string().trim().min(1).max(256),
    eventType: eventTypeSchema,
    paymentId: z.string().trim().min(1).max(256),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    amountKrw: z.number().int().positive().nullable(),
}).strict();

const paymentEventResultSchema = z.object({
    status: z.literal('recorded'),
    duplicate: z.boolean(),
}).strict();

export type PaymentEventInput = z.infer<typeof paymentEventInputSchema>;
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
    return parsed.data;
}

function parseRpcResult(data: unknown): PaymentEventResult {
    const parsed = paymentEventResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new CanonicalCommerceError('CANONICAL_COMMERCE_RESULT_INVALID');
    }
    return Object.freeze(parsed.data);
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
                    p_payload_hash: parsed.payloadHash,
                    p_amount_krw: parsed.amountKrw,
                });
            } catch (error) {
                throw new CanonicalCommerceError(
                    'CANONICAL_COMMERCE_RPC_FAILED',
                    error,
                );
            }
            if (result.error) {
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
        .update(`${namespace}\n${value}`, 'utf8')
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
    | { status: 'maintenance_queued' };

/**
 * Payment finalization remains authoritative. A canonical mirror failure is
 * converted into a bounded maintenance marker and never into paid evidence.
 */
export async function recordPaymentEventWithMaintenance(
    store: CanonicalCommerceStore,
    input: PaymentEventInput,
    enqueueMaintenance: CanonicalPaymentMaintenanceEnqueue,
): Promise<PaymentEventWithMaintenanceResult> {
    const parsed = parsePaymentEventInput(input);
    try {
        return await store.recordPaymentEvent(parsed);
    } catch {
        try {
            await enqueueMaintenance({
                kind: 'payment_event',
                targetKeyHash: canonicalEvidenceHash('payment-event', parsed.eventId),
                contentHash: parsed.payloadHash,
            });
        } catch {
            // A second bounded queue outage must not alter the authoritative
            // payment finalization result.
        }
        return { status: 'maintenance_queued' };
    }
}
