import { describe, expect, it, vi } from 'vitest';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    createAnonymousProfileCache,
} from './anonymous-profile-cache';

const inputHash = 'a'.repeat(64);
const profile: InstagramProfile = {
    username: 'target_user',
    fullName: 'Target',
    bio: 'bio',
    profilePicUrl: 'https://example.com/profile.jpg',
    followersCount: 100,
    followingCount: 80,
    postsCount: 12,
    isPrivate: false,
    isVerified: false,
    latestPosts: [{
        id: 'post',
        shortCode: 'post',
        type: 'image',
        likesCount: 1,
        commentsCount: 0,
        timestamp: '2026-08-05T00:00:00.000Z',
        taggedUsers: [],
        mentionedUsers: [],
    }],
};

describe('anonymous profile cache', () => {
    it('stores only the profile summary and reuses a valid snapshot', async () => {
        const store = {
            from: vi.fn(() => ({
                upsert: vi.fn().mockResolvedValue({ error: null }),
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({
                            data: {
                                profile_summary: {
                                    username: 'target_user',
                                    fullName: 'Target',
                                    bio: 'bio',
                                    externalUrl: null,
                                    profilePicUrl: 'https://example.com/profile.jpg',
                                    followersCount: 100,
                                    followingCount: 80,
                                    postsCount: 12,
                                    isPrivate: false,
                                    isVerified: false,
                                },
                                expires_at: '2999-01-01T00:00:00.000Z',
                            },
                            error: null,
                        }),
                    })),
                })),
            })),
        };
        const cache = createAnonymousProfileCache(store);

        await expect(cache.store(inputHash, profile)).resolves.toBe(true);
        const upsert = store.from.mock.results[0]?.value.upsert;
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            target_input_hash: inputHash,
            profile_summary: expect.not.objectContaining({ latestPosts: expect.anything() }),
        }), { onConflict: 'target_input_hash' });
        await expect(cache.load(inputHash)).resolves.toMatchObject({
            username: 'target_user',
            followersCount: 100,
        });
    });

    it('uses the opaque target hash to single-flight concurrent misses', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        const store = {
            rpc,
            from: vi.fn(() => ({
                upsert: vi.fn().mockResolvedValue({ error: null }),
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                    })),
                })),
            })),
        };
        const cache = createAnonymousProfileCache(store);

        const lease = await cache.reserve?.(inputHash);
        expect(lease).toMatch(/^[0-9a-f-]{36}$/i);
        expect(rpc).toHaveBeenCalledWith('claim_anonymous_profile_cache_lock', expect.objectContaining({
            p_target_input_hash: inputHash,
            p_lease_token: lease,
        }));
        await cache.release?.(inputHash, lease!);
        expect(rpc).toHaveBeenLastCalledWith('release_anonymous_profile_cache_lock', {
            p_target_input_hash: inputHash,
            p_lease_token: lease,
        });
    });
});
