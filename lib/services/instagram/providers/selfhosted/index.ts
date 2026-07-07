import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import type { ScraperProvider } from '../types';
import { mapUserToProfile } from './mappers';
import { pLimit, withRetry } from './rate-limit';
import { fetchWebProfileUser } from './web-client';
import { fetchFollowers, fetchFollowing } from './followers-client';

interface SelfHostedDeps {
    fetchUser?: (username: string) => Promise<Record<string, unknown> | null>;
    concurrency?: number;
    retries?: number;
    fetchFollowersFn?: (username: string, limit: number) => Promise<InstagramFollower[]>;
    fetchFollowingFn?: (username: string, limit: number) => Promise<InstagramFollower[]>;
}

export function makeSelfHostedProvider(deps: SelfHostedDeps = {}): ScraperProvider {
    const fetchUser = deps.fetchUser ?? ((u: string) => fetchWebProfileUser(u));
    const concurrency = deps.concurrency ?? 3;
    const retries = deps.retries ?? 2;
    const followersFn = deps.fetchFollowersFn ?? ((u: string, l: number) => fetchFollowers(u, l));
    const followingFn = deps.fetchFollowingFn ?? ((u: string, l: number) => fetchFollowing(u, l));

    async function getProfile(username: string): Promise<InstagramProfile | null> {
        const user = await withRetry(() => fetchUser(username), { retries });
        return user ? mapUserToProfile(user) : null;
    }

    async function getProfilesBatch(usernames: string[]): Promise<InstagramProfile[]> {
        const limit = pLimit(concurrency);
        const settled = await Promise.allSettled(
            usernames.map((u) =>
                limit(async () => {
                    const user = await withRetry(() => fetchUser(u), { retries });
                    return user ? mapUserToProfile(user) : null;
                })
            )
        );
        const results: InstagramProfile[] = [];
        for (const s of settled) {
            if (s.status === 'fulfilled' && s.value) results.push(s.value);
        }
        return results;
    }

    return {
        name: 'selfhosted',
        getProfile,
        getProfilesBatch,
        getFollowers: (username: string, limit: number) => followersFn(username, limit),
        getFollowing: (username: string, limit: number) => followingFn(username, limit),
    };
}

export const selfHostedProvider: ScraperProvider = makeSelfHostedProvider();
