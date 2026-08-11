import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { assembleFirstPaymentConciergeSource } from './first-payment-concierge-source';

function profile(username: string) {
    return {
        username,
        fullName: `${username} name`,
        biography: '',
        followersCount: 1,
        followsCount: 1,
        postsCount: 0,
        private: false,
        verified: false,
        latestPosts: [],
    };
}

function relationship(
    username: string,
    side: 'followers' | 'following',
    isPrivate = false,
) {
    return {
        username_scrape: 'target',
        type: side === 'followers' ? 'Followers' : 'Following',
        id: '1',
        username,
        full_name: `${username} name`,
        is_private: isPrivate,
        is_verified: false,
        profile_pic_url: 'https://example.com/profile.jpg',
    };
}

function run(
    operation: string,
    sourceLabel: 'original' | 'transient' | 'last',
    items: readonly unknown[],
) {
    return {
        sourceLabel,
        actorId: 'test-actor',
        credentialSlot: 'primary',
        runId: `${sourceLabel}-${operation}`,
        ledgerStatus: 'SUCCEEDED',
        operationKey: `${operation}:test`,
        items,
    };
}

describe('first payment concierge source selection', () => {
    it('uses the exact retained relationship snapshot instead of a newer oversized run', () => {
        const mutuals = Array.from({ length: 182 }, (_, index) => `u${index}`);
        const retainedFollowers = [
            ...mutuals,
            ...Array.from({ length: 208 }, (_, index) => `f${index}`),
        ];
        const oversizedFollowers = [...retainedFollowers, 'new_follower'];
        const following = Array.from({ length: 256 }, (_, index) => `u${index}`);
        const publicProfiles = Array.from({ length: 129 }, (_, index) => profile(`u${index}`));

        const source = assembleFirstPaymentConciergeSource({
            descriptor: {
                schemaVersion: 2,
                descriptorHash: 'a'.repeat(64),
                preflightRuns: [],
                providerRuns: [],
                schedulerOperations: [],
            } as never,
            runs: [
                run('target-profile-fallback', 'last', [{
                    ...profile('target'),
                    followersCount: 391,
                    followsCount: 256,
                }]),
                run(
                    'relationship-followers',
                    'original',
                    retainedFollowers.map(username => relationship(
                        username,
                        'followers',
                        /^u(?:13[4-9]|1[4-7][0-9]|18[01])$/.test(username),
                    )),
                ),
                run(
                    'relationship-followers',
                    'transient',
                    oversizedFollowers.map(username => relationship(username, 'followers')),
                ),
                run(
                    'relationship-following',
                    'original',
                    following.map(username => relationship(
                        username,
                        'following',
                        /^u(?:13[4-9]|1[4-7][0-9]|18[01])$/.test(username),
                    )),
                ),
                run('profile-fallback', 'last', publicProfiles),
                run('target-likers', 'last', []),
                run('target-comments', 'last', []),
            ],
        });

        expect(source.followersCollected).toBe(390);
        expect(source.followingCollected).toBe(256);
        expect(source.mutualRows).toHaveLength(182);
        expect(source.publicProfiles).toHaveLength(129);
        expect(source.publicUnavailableRows).toHaveLength(5);
        expect(source.privateRows).toHaveLength(48);
    });
});
