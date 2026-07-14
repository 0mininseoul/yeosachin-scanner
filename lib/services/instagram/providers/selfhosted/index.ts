import type { InstagramProfile } from '@/lib/types/instagram';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
    ProviderUsageDelta,
    ScraperProvider,
} from '../types';
import {
    failedProfileAttempt,
    profileAttemptLatency,
    successfulProfileAttempt,
    unavailableProfileAttempt,
} from '../profile-attempt';
import {
    mapUserToAdmissionProfileSummary,
    mapUserToProfile,
    mapUserToProfileSummary,
    type SelfHostedAdmissionProfileSummary,
} from './mappers';
import { pLimit, withRetry } from './rate-limit';
import { fetchWebProfileAdmissionUser, fetchWebProfileUser } from './web-client';
import { isInstagramUsername } from '../../username';

interface SelfHostedDeps {
    fetchUser?: (username: string) => Promise<Record<string, unknown> | null>;
    concurrency?: number;
    retries?: number;
    env?: Record<string, string | undefined>;
}

function isConfigurationError(error: unknown): error is Error {
    return error instanceof Error && error.message.startsWith('SCRAPING_CONFIG_ERROR:');
}

function isProgressPersistenceError(error: unknown): error is Error {
    return error instanceof Error && (
        error.message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
        || error.message.startsWith('ANALYSIS_V2_PROGRESS_')
    );
}

async function reportProfileStart(
    context: ProviderCallContext | undefined,
    username: string
): Promise<void> {
    try {
        await context?.onProfileStart?.(username);
    } catch (error) {
        if (isProgressPersistenceError(error)) throw error;
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: active profile heartbeat failed.');
    }
}

async function reportProfileResolved(context: ProviderCallContext | undefined): Promise<void> {
    try {
        await context?.onProfileResolved?.();
    } catch (error) {
        if (isProgressPersistenceError(error)) throw error;
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: profile work progress failed.');
    }
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

    async function getProfileSummary(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> {
        if (!isInstagramUsername(username)) {
            throw new Error('SCRAPING_CONFIG_ERROR: selfhosted summary username is invalid.');
        }
        const user = await fetchUser(username, context);
        const result = user ? mapUserToProfileSummary(user) : null;
        if (result && result.username.toLowerCase() !== username.toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted summary username mismatch.');
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
            if (s.status === 'rejected' && isConfigurationError(s.reason)) throw s.reason;
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

    async function getProfilesBatchOutcomes(
        usernames: string[],
        _batchSize?: number,
        context?: ProviderCallContext
    ): Promise<ProfileAttemptResult[]> {
        const normalized = usernames.map(username => username.trim().toLowerCase());
        if (
            normalized.some(username => !isInstagramUsername(username))
            || new Set(normalized).size !== normalized.length
        ) {
            throw new Error(
                'SCRAPING_CONFIG_ERROR: selfhosted outcome usernames are invalid or duplicated.'
            );
        }

        const limit = pLimit(concurrency);
        const results = await Promise.all(
            normalized.map(username => limit(async () => {
                const startedAt = Date.now();
                await reportProfileStart(context, username);
                let requestCount = 0;
                const itemContext: ProviderCallContext = {
                    ...context,
                    recordUsage(delta: ProviderUsageDelta): void {
                        requestCount += delta.request_count ?? 0;
                        context?.recordUsage(delta);
                    },
                };

                try {
                    const rawUser = await fetchUser(username, itemContext);
                    const latencyMs = profileAttemptLatency(startedAt);
                    if (rawUser === null) {
                        return unavailableProfileAttempt({
                            requestedUsername: username,
                            source: 'selfhosted',
                            reason: 'empty_user',
                            requestCount,
                            latencyMs,
                        });
                    }
                    const profile = mapUserToProfile(rawUser);
                    await reportProfileResolved(itemContext);
                    return successfulProfileAttempt({
                        requestedUsername: username,
                        source: 'selfhosted',
                        profile,
                        requestCount,
                        latencyMs,
                    });
                } catch (error) {
                    if (isConfigurationError(error) || isProgressPersistenceError(error)) {
                        throw error;
                    }
                    return failedProfileAttempt({
                        requestedUsername: username,
                        source: 'selfhosted',
                        error,
                        requestCount,
                        latencyMs: profileAttemptLatency(startedAt),
                    });
                }
            }))
        );
        context?.recordUsage({
            result_count: results.filter(result => result.outcome.status === 'success').length,
        });
        return results;
    }

    return {
        name: 'selfhosted',
        paid: false,
        getProfileSummary,
        getProfile,
        getProfilesBatch,
        getProfilesBatchOutcomes,
    };
}

export const selfHostedProvider: ScraperProvider = makeSelfHostedProvider();

export async function getSelfHostedProfileSummary(
    username: string
): Promise<InstagramProfile | null> {
    if (!selfHostedProvider.getProfileSummary) {
        throw new Error('SCRAPING_CONFIG_ERROR: selfhosted summary capability is unavailable.');
    }
    return selfHostedProvider.getProfileSummary(username);
}


export async function getSelfHostedAdmissionProfileSummary(
    username: string
): Promise<SelfHostedAdmissionProfileSummary | null> {
    if (!isInstagramUsername(username)) {
        throw new Error('SCRAPING_CONFIG_ERROR: selfhosted admission username is invalid.');
    }
    const user = await fetchWebProfileAdmissionUser(username);
    const result = user ? mapUserToAdmissionProfileSummary(user) : null;
    if (result && result.username.toLowerCase() !== username.toLowerCase()) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted admission username mismatch.');
    }
    return result;
}
