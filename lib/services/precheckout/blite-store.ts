import 'server-only';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    precheckoutBliteV1Schema,
    type PrecheckoutBliteV1,
} from './blite-contract';
import {
    precheckoutBliteSourceV1Schema,
    type PrecheckoutBliteSourceV1,
} from './blite-source';

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const legacyClaimSchema = z.discriminatedUnion('disposition', [
    z.object({ disposition: z.literal('claimed'), leaseToken: uuid }).strict(),
    z.object({ disposition: z.literal('pending') }).strict(),
    z.object({ disposition: z.literal('complete'), dto: z.unknown() }).strict(),
]);

interface RpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

function persistenceError(error?: { code?: string } | null): Error {
    const code = error?.code && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : 'invalid';
    return new Error(`PRECHECKOUT_BLITE_PERSISTENCE_ERROR (${code})`);
}

export function createPrecheckoutBliteStore(client: RpcClient = supabaseAdmin) {
    return {
        async claim({ preflightId }: { preflightId: string }) {
            if (!uuid.safeParse(preflightId).success) throw persistenceError();
            const { data, error } = await client.rpc('claim_precheckout_blite_v1', {
                p_preflight_id: preflightId,
            });
            if (error) throw persistenceError(error);
            const parsed = legacyClaimSchema.safeParse(data);
            if (!parsed.success) throw persistenceError();
            return parsed.data;
        },
        async complete(input: { preflightId: string; leaseToken: string; dto: unknown }) {
            if (!uuid.safeParse(input.preflightId).success || !uuid.safeParse(input.leaseToken).success) {
                throw persistenceError();
            }
            const { data, error } = await client.rpc('complete_precheckout_blite_v1', {
                p_preflight_id: input.preflightId,
                p_lease_token: input.leaseToken,
                p_dto: input.dto,
            });
            if (error || data !== true) throw persistenceError(error);
        },
        async release(input: { preflightId: string; leaseToken: string }) {
            if (!uuid.safeParse(input.preflightId).success || !uuid.safeParse(input.leaseToken).success) {
                throw persistenceError();
            }
            const { data, error } = await client.rpc('release_precheckout_blite_v1', {
                p_preflight_id: input.preflightId,
                p_lease_token: input.leaseToken,
            });
            if (error || data !== true) throw persistenceError(error);
        },
    };
}

export const precheckoutBliteStore = createPrecheckoutBliteStore();

export const PRECHECKOUT_BLITE_FAILURE_REASONS = [
    'source_missing',
    'source_expired',
    'source_invalid',
    'source_insufficient',
    'dispatch_failed',
    'inference_timeout',
    'inference_rate_limited',
    'inference_provider_failed',
    'inference_response_invalid',
    'persistence_failed',
    'attempts_exhausted',
] as const;

const failureReasonSchema = z.enum(PRECHECKOUT_BLITE_FAILURE_REASONS);
const v2ClaimSchema = z.discriminatedUnion('disposition', [
    z.object({
        disposition: z.literal('claimed'),
        leaseToken: uuid,
        source: precheckoutBliteSourceV1Schema,
        deadlineAt: timestamp,
    }).strict(),
    z.object({ disposition: z.literal('pending') }).strict(),
    z.object({
        disposition: z.literal('complete'),
        dto: precheckoutBliteV1Schema,
        completedAt: timestamp,
    }).strict(),
    z.object({
        disposition: z.literal('failed'),
        reason: failureReasonSchema,
        failedAt: timestamp,
    }).strict(),
]);

const statusSchema = z.discriminatedUnion('state', [
    z.object({
        state: z.literal('pending'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
    }).strict(),
    z.object({
        state: z.literal('complete'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
        completedAt: timestamp,
        dto: precheckoutBliteV1Schema,
    }).strict(),
    z.object({
        state: z.literal('failed'),
        submittedAt: timestamp,
        deadlineAt: timestamp,
        failedAt: timestamp,
    }).strict(),
]);

const claimInputSchema = z.object({ preflightId: uuid }).strict();
const terminalInputSchema = z.object({
    preflightId: uuid,
    leaseToken: uuid,
}).strict();
const completeInputSchema = terminalInputSchema.extend({ dto: precheckoutBliteV1Schema }).strict();
const failInputSchema = terminalInputSchema.extend({ reason: failureReasonSchema }).strict();

export type PrecheckoutBliteFailureReason = z.infer<typeof failureReasonSchema>;
export type PrecheckoutBliteClaim = z.infer<typeof v2ClaimSchema>;
export type PrecheckoutBliteStatus = z.infer<typeof statusSchema>;
export type { PrecheckoutBliteSourceV1 };

/**
 * Source-backed lifecycle for the single-collection cohort. The legacy v1 store above remains
 * intact while a DB-first migration can coexist with already-deployed callers.
 */
export function createPrecheckoutBliteTerminalStore(client: RpcClient = supabaseAdmin) {
    return {
        async claim(input: { preflightId: string }): Promise<PrecheckoutBliteClaim> {
            const parsedInput = claimInputSchema.safeParse(input);
            if (!parsedInput.success) throw persistenceError();
            const { data, error } = await client.rpc('claim_precheckout_blite_v2', {
                p_preflight_id: parsedInput.data.preflightId,
            });
            if (error) throw persistenceError(error);
            const parsed = v2ClaimSchema.safeParse(data);
            if (!parsed.success) throw persistenceError();
            return parsed.data;
        },

        async complete(input: {
            preflightId: string;
            leaseToken: string;
            dto: PrecheckoutBliteV1;
        }): Promise<boolean> {
            const parsedInput = completeInputSchema.safeParse(input);
            if (!parsedInput.success) throw persistenceError();
            const { data, error } = await client.rpc('complete_precheckout_blite_v2', {
                p_preflight_id: parsedInput.data.preflightId,
                p_lease_token: parsedInput.data.leaseToken,
                p_dto: parsedInput.data.dto,
            });
            if (error || typeof data !== 'boolean') throw persistenceError(error);
            return data;
        },

        async fail(input: {
            preflightId: string;
            leaseToken: string;
            reason: PrecheckoutBliteFailureReason;
        }): Promise<boolean> {
            const parsedInput = failInputSchema.safeParse(input);
            if (!parsedInput.success) throw persistenceError();
            const { data, error } = await client.rpc('fail_precheckout_blite_v2', {
                p_preflight_id: parsedInput.data.preflightId,
                p_lease_token: parsedInput.data.leaseToken,
                p_reason: parsedInput.data.reason,
            });
            if (error || typeof data !== 'boolean') throw persistenceError(error);
            return data;
        },

        async readStatus(input: { preflightId: string }): Promise<PrecheckoutBliteStatus | null> {
            const parsedInput = claimInputSchema.safeParse(input);
            if (!parsedInput.success) throw persistenceError();
            const { data, error } = await client.rpc('read_precheckout_blite_status_v1', {
                p_preflight_id: parsedInput.data.preflightId,
            });
            if (error) throw persistenceError(error);
            if (data === null) return null;
            const parsed = statusSchema.safeParse(data);
            if (!parsed.success) throw persistenceError();
            return parsed.data;
        },
    };
}

export const precheckoutBliteTerminalStore = createPrecheckoutBliteTerminalStore();

export async function claim(input: { preflightId: string }): Promise<PrecheckoutBliteClaim> {
    return precheckoutBliteTerminalStore.claim(input);
}

export async function complete(input: {
    preflightId: string;
    leaseToken: string;
    dto: PrecheckoutBliteV1;
}): Promise<boolean> {
    return precheckoutBliteTerminalStore.complete(input);
}

export async function fail(input: {
    preflightId: string;
    leaseToken: string;
    reason: PrecheckoutBliteFailureReason;
}): Promise<boolean> {
    return precheckoutBliteTerminalStore.fail(input);
}

export async function readStatus(input: {
    preflightId: string;
}): Promise<PrecheckoutBliteStatus | null> {
    return precheckoutBliteTerminalStore.readStatus(input);
}
