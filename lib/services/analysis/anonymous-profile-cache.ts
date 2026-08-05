import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { InstagramProfile } from '@/lib/types/instagram';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

const profileSummarySchema = z.object({
    username: z.string().min(1).max(30).regex(/^[A-Za-z0-9._]+$/),
    fullName: z.string().max(200).nullable(),
    bio: z.string().max(2_200).nullable(),
    externalUrl: z.string().max(2_048).nullable(),
    profilePicUrl: z.string().max(8_192).nullable(),
    followersCount: z.number().int().nonnegative().max(10_000_000),
    followingCount: z.number().int().nonnegative().max(10_000_000),
    postsCount: z.number().int().nonnegative().max(10_000_000),
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
}).strict();

type ProfileSummary = z.infer<typeof profileSummarySchema>;

interface CacheQuery {
    maybeSingle(): PromiseLike<{
        data: unknown;
        error: unknown | null;
    }>;
}

interface CacheSelectQuery {
    eq(column: string, value: string): CacheQuery;
}

interface CacheTable {
    from(table: string): {
        upsert(values: Record<string, unknown>, options: { onConflict: string }): PromiseLike<{
            error: unknown | null;
        }>;
        select(columns: string): CacheSelectQuery;
    };
    rpc?: (
        functionName: string,
        args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface AnonymousProfileCache {
    load(inputHash: string): Promise<InstagramProfile | null>;
    store(inputHash: string, profile: InstagramProfile): Promise<boolean>;
    /** Cross-instance single-flight lease; absent on test-only cache doubles. */
    reserve?(inputHash: string): Promise<string | null>;
    release?(inputHash: string, leaseToken: string): Promise<void>;
    waitFor?(inputHash: string, timeoutMs?: number): Promise<InstagramProfile | null>;
}

function summaryFromProfile(profile: InstagramProfile): ProfileSummary {
    return profileSummarySchema.parse({
        username: profile.username,
        fullName: profile.fullName ?? null,
        bio: profile.bio ?? null,
        externalUrl: profile.externalUrl ?? null,
        profilePicUrl: profile.profilePicUrl ?? null,
        followersCount: profile.followersCount,
        followingCount: profile.followingCount,
        postsCount: profile.postsCount,
        isPrivate: profile.isPrivate,
        isVerified: profile.isVerified,
    });
}

function profileFromSummary(value: unknown): InstagramProfile | null {
    const parsed = profileSummarySchema.safeParse(value);
    if (!parsed.success) return null;
    return {
        username: parsed.data.username,
        ...(parsed.data.fullName === null ? {} : { fullName: parsed.data.fullName }),
        ...(parsed.data.bio === null ? {} : { bio: parsed.data.bio }),
        ...(parsed.data.externalUrl === null ? {} : { externalUrl: parsed.data.externalUrl }),
        ...(parsed.data.profilePicUrl === null ? {} : { profilePicUrl: parsed.data.profilePicUrl }),
        followersCount: parsed.data.followersCount,
        followingCount: parsed.data.followingCount,
        postsCount: parsed.data.postsCount,
        isPrivate: parsed.data.isPrivate,
        isVerified: parsed.data.isVerified,
    };
}

export function createAnonymousProfileCache(
    client: CacheTable = supabaseAdmin as unknown as CacheTable,
): AnonymousProfileCache {
    const load = async (inputHash: string): Promise<InstagramProfile | null> => {
        if (!HASH_PATTERN.test(inputHash)) return null;
        try {
            const result = await client
                .from('analysis_anonymous_profile_cache')
                .select('profile_summary, expires_at')
                .eq('target_input_hash', inputHash)
                .maybeSingle();
            if (result.error || !result.data || typeof result.data !== 'object') return null;
            const row = result.data as Record<string, unknown>;
            if (
                typeof row.expires_at !== 'string'
                || Date.parse(row.expires_at) <= Date.now()
            ) return null;
            return profileFromSummary(row.profile_summary);
        } catch {
            return null;
        }
    };

    return {
        load,

        async store(inputHash, profile) {
            if (!HASH_PATTERN.test(inputHash)) return false;
            try {
                const result = await client
                    .from('analysis_anonymous_profile_cache')
                    .upsert({
                        target_input_hash: inputHash,
                        profile_summary: summaryFromProfile(profile),
                        expires_at: new Date(Date.now() + PROFILE_SUMMARY_TTL_MS).toISOString(),
                    }, { onConflict: 'target_input_hash' });
                return !result.error;
            } catch {
                return false;
            }
        },

        async reserve(inputHash) {
            if (!HASH_PATTERN.test(inputHash) || !client.rpc) return null;
            const leaseToken = randomUUID();
            try {
                const result = await client.rpc('claim_anonymous_profile_cache_lock', {
                    p_target_input_hash: inputHash,
                    p_lease_token: leaseToken,
                    p_lease_seconds: 60,
                });
                if (result.error) throw new Error('ANONYMOUS_PROFILE_CACHE_LOCK_UNAVAILABLE');
                return result.data !== true ? null : leaseToken;
            } catch {
                // The cache is an optimization. If its lock RPC is unavailable, let the
                // caller fail open to the explicit provider path instead of waiting for a
                // second cache request to time out.
                throw new Error('ANONYMOUS_PROFILE_CACHE_LOCK_UNAVAILABLE');
            }
        },

        async release(inputHash, leaseToken) {
            if (!HASH_PATTERN.test(inputHash) || !client.rpc) return;
            try {
                await client.rpc('release_anonymous_profile_cache_lock', {
                    p_target_input_hash: inputHash,
                    p_lease_token: leaseToken,
                });
            } catch {
                // A lease expiry is the recovery path if the worker disappears.
            }
        },

        async waitFor(inputHash, timeoutMs = 30_000) {
            if (!HASH_PATTERN.test(inputHash)) return null;
            const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 60_000));
            while (Date.now() < deadline) {
                const profile = await load(inputHash);
                if (profile) return profile;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return load(inputHash);
        },
    };
}

export const anonymousProfileCache = createAnonymousProfileCache();
