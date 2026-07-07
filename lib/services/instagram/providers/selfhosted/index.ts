import type { InstagramProfile } from '@/lib/types/instagram';
import type { ScraperProvider } from '../types';
import { mapUserToProfile } from './mappers';
import { pLimit, withRetry } from './rate-limit';
import { fetchWebProfileUser } from './web-client';
import { fetchFollowers, fetchFollowing } from './followers-client';

interface SelfHostedDeps {
    fetchUser?: (username: string) => Promise<Record<string, unknown> | null>;
    concurrency?: number;
    retries?: number;
}

export function makeSelfHostedProvider(deps: SelfHostedDeps = {}): ScraperProvider {
    const fetchUser = deps.fetchUser ?? ((u: string) => fetchWebProfileUser(u));
    const concurrency = deps.concurrency ?? 3;
    const retries = deps.retries ?? 2;

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
        getFollowers: (username: string, limit: number) => fetchFollowers(username, limit),
        getFollowing: (username: string, limit: number) => fetchFollowing(username, limit),
    };
}

export const selfHostedProvider: ScraperProvider = makeSelfHostedProvider();
