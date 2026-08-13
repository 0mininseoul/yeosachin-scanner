import 'server-only';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    PRECHECKOUT_BLITE_SOURCE_MAX_BYTES,
    precheckoutBliteSourceV1Schema,
    type PrecheckoutBliteSourceV1,
} from './blite-source';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const providerReference = z.string().regex(/^[A-Za-z0-9]{8,64}$/);
const providerOperationKey = z.string().regex(
    /^(?:target-profile-fallback|target-profile-fresh-admission:g(?:[1-9]|[1-9][0-9]|100))$/,
);
const boundedNullableText = z.string().max(8_192).nullable();
const boundedNullableCount = z.number().int().nonnegative().max(10_000_000).nullable();

interface RpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

function persistenceError(error?: { code?: string } | null): Error {
    const code = error?.code && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : 'invalid';
    return new Error(`PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR (${code})`);
}

const finalizeInputSchema = z.object({
    preflightId: uuid,
    userId: uuid.nullable(),
    claimToken: uuid,
    targetInputHash: hash,
    providerRunId: uuid,
    providerOperationKey,
    providerRunReference: providerReference,
    targetFullName: boundedNullableText,
    targetBio: boundedNullableText,
    targetProfileImageUrl: boundedNullableText,
    targetFollowersCount: boundedNullableCount,
    targetFollowingCount: boundedNullableCount,
    targetIsPrivate: z.boolean(),
    capacityRequiredPlanId: boundedNullableText,
    requiredPlanId: boundedNullableText,
    planCardsSnapshot: z.record(z.string(), z.unknown()),
    source: precheckoutBliteSourceV1Schema,
    collectedAt: timestamp,
    expiresAt: timestamp,
}).strict();

export type FinalizePrecheckoutBliteSourceInput = z.infer<typeof finalizeInputSchema>;

function sourcePayloadHash(source: PrecheckoutBliteSourceV1): string {
    return createHash('sha256').update(JSON.stringify(source), 'utf8').digest('hex');
}

function validateSourceSize(source: PrecheckoutBliteSourceV1): void {
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > PRECHECKOUT_BLITE_SOURCE_MAX_BYTES) {
        throw persistenceError();
    }
}

export function createPrecheckoutBliteSourceStore(client: RpcClient = supabaseAdmin) {
    return {
        async finalizeReadyWithSource(input: FinalizePrecheckoutBliteSourceInput): Promise<boolean> {
            const parsed = finalizeInputSchema.safeParse(input);
            if (!parsed.success) throw persistenceError();
            validateSourceSize(parsed.data.source);
            const { data, error } = await client.rpc('finalize_preflight_blite_source_v1', {
                p_preflight_id: parsed.data.preflightId,
                p_user_id: parsed.data.userId,
                p_claim_token: parsed.data.claimToken,
                p_target_input_hash: parsed.data.targetInputHash,
                p_provider_run_id: parsed.data.providerRunId,
                p_provider_operation_key: parsed.data.providerOperationKey,
                p_provider_run_reference: parsed.data.providerRunReference,
                p_target_full_name: parsed.data.targetFullName,
                p_target_bio: parsed.data.targetBio,
                p_target_profile_image_url: parsed.data.targetProfileImageUrl,
                p_target_followers_count: parsed.data.targetFollowersCount,
                p_target_following_count: parsed.data.targetFollowingCount,
                p_target_is_private: parsed.data.targetIsPrivate,
                p_capacity_required_plan_id: parsed.data.capacityRequiredPlanId,
                p_required_plan_id: parsed.data.requiredPlanId,
                p_plan_cards_snapshot: parsed.data.planCardsSnapshot,
                p_payload: parsed.data.source,
                p_payload_hash: sourcePayloadHash(parsed.data.source),
                p_collected_at: parsed.data.collectedAt,
                p_expires_at: parsed.data.expiresAt,
            });
            if (error || typeof data !== 'boolean') throw persistenceError(error);
            return data;
        },

        async purgeExpired(input: { limit?: number } = {}): Promise<number> {
            const parsed = z.object({
                limit: z.number().int().min(1).max(1_000).default(100),
            }).strict().safeParse(input);
            if (!parsed.success) throw persistenceError();
            const { data, error } = await client.rpc('purge_expired_precheckout_blite_sources_v1', {
                p_limit: parsed.data.limit,
            });
            if (error || !Number.isSafeInteger(data)) {
                throw persistenceError(error);
            }
            const count = Number(data);
            if (count < 0 || count > parsed.data.limit) throw persistenceError(error);
            return count;
        },
    };
}

export const precheckoutBliteSourceStore = createPrecheckoutBliteSourceStore();

export async function finalizeReadyWithSource(
    input: FinalizePrecheckoutBliteSourceInput,
): Promise<boolean> {
    return precheckoutBliteSourceStore.finalizeReadyWithSource(input);
}

export async function purgeExpired(input: { limit?: number } = {}): Promise<number> {
    return precheckoutBliteSourceStore.purgeExpired(input);
}
