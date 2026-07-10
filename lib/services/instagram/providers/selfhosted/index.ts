import type { InstagramProfile } from '@/lib/types/instagram';
import type { ProviderCallContext, ScraperProvider } from '../types';
import { mapUserToProfile } from './mappers';
import { pLimit, withRetry } from './rate-limit';
import { fetchWebProfileUser } from './web-client';

interface SelfHostedDeps {
    fetchUser?: (username: string) => Promise<Record<string, unknown> | null>;
    concurrency?: number;
    retries?: number;
    env?: Record<string, string | undefined>;
}

export function getSelfHostedProfileConcurrency(
    env: Record<string, string | undefined>
): number {
    const raw = env.SELFHOSTED_PROFILE_CONCURRENCY;
    if (raw === undefined) return 4;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_PROFILE_CONCURRENCY는 1~5 범위의 정수여야 합니다.'
        );
    }
    return value;
}

export function makeSelfHostedProvider(deps: SelfHostedDeps = {}): ScraperProvider {
    const env = deps.env ?? process.env;
    const concurrency = deps.concurrency ?? getSelfHostedProfileConcurrency(env);
    const injectedRetries = deps.retries ?? 0;

    async function fetchUser(
        username: string,
        context?: ProviderCallContext
    ): Promise<Record<string, unknown> | null> {
        if (deps.fetchUser) {
            return withRetry(() => {
                context?.recordUsage({ request_count: 1 });
                return deps.fetchUser!(username);
            }, { retries: injectedRetries });
        }
        return fetchWebProfileUser(username, undefined, {
            onRequest: () => context?.recordUsage({ request_count: 1 }),
        });
    }

    async function getProfile(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        const user = await fetchUser(username, context);
        const result = user ? mapUserToProfile(user) : null;
        if (result && result.username.toLowerCase() !== username.toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted profile username이 요청과 다릅니다.');
        }
        context?.recordUsage({ result_count: result ? 1 : 0 });
        return result;
    }

    async function getProfilesBatch(
        usernames: string[],
        _batchSize?: number,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]> {
        const limit = pLimit(concurrency);
        const requested = new Set(usernames.map((username) => username.toLowerCase()));
        const settled = await Promise.allSettled(
            usernames.map((u) =>
                limit(async () => {
                    const user = await fetchUser(u, context);
                    return user ? { requestedUsername: u, profile: mapUserToProfile(user) } : null;
                })
            )
        );
        const resultMap = new Map<string, InstagramProfile>();
        for (const s of settled) {
            if (s.status !== 'fulfilled' || !s.value) continue;
            const key = s.value.profile.username.toLowerCase();
            if (key !== s.value.requestedUsername.toLowerCase() || !requested.has(key)) {
                throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted 프로필 username이 요청과 다릅니다.');
            }
            resultMap.set(key, s.value.profile);
        }
        const results = [...resultMap.values()];
        context?.recordUsage({ result_count: results.length });
        return results;
    }

    return {
        name: 'selfhosted',
        paid: false,
        getProfile,
        getProfilesBatch,
    };
}

export const selfHostedProvider: ScraperProvider = makeSelfHostedProvider();
