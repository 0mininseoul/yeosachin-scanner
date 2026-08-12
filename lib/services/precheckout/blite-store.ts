import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const uuid = z.string().uuid();
const claimSchema = z.discriminatedUnion('disposition', [
    z.object({ disposition: z.literal('claimed'), leaseToken: uuid }).strict(),
    z.object({ disposition: z.literal('pending') }).strict(),
    z.object({ disposition: z.literal('complete'), dto: z.unknown() }).strict(),
]);

interface RpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string };
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
            const parsed = claimSchema.safeParse(data);
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
