import type { ApifyInteractionAdapter } from '../apify-interactions';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
    ScraperProvider,
    SelfHostedAuthRunReceipt,
} from '../types';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    failedProfileAttempt,
    isSuccessfulProfileAttempt,
    profileAttemptLatency,
    successfulProfileAttempt,
    unavailableProfileAttempt,
} from '../profile-attempt';
import { isInstagramUsername } from '../../username';
import {
    createSelfHostedAuthWorkerClient,
    type SelfHostedAuthWorkerClient,
    type SelfHostedAuthWorkerRequestOptions,
} from './client';

interface SelfHostedAuthDependencies {
    client?: SelfHostedAuthWorkerClient;
    env?: Record<string, string | undefined>;
}

function clientResolver(dependencies: SelfHostedAuthDependencies) {
    let resolved = dependencies.client;
    return (): SelfHostedAuthWorkerClient => {
        resolved ??= createSelfHostedAuthWorkerClient({ env: dependencies.env });
        return resolved;
    };
}

function workerRequestOptions(
    context: ProviderCallContext | undefined
): SelfHostedAuthWorkerRequestOptions {
    const identity = context?.selfHostedAuthIdentity;
    if (!identity) {
        throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_IDENTITY_MISSING');
    }
    return {
        operationKey: identity.operationKey,
        inputHash: identity.inputHash,
        signal: context?.startCancellationSignal,
    };
}

async function recordSuccessfulRun(
    context: ProviderCallContext | undefined,
    response: { runId: string; accountSlot: 'primary'; items: readonly unknown[] }
): Promise<void> {
    context?.recordUsage({
        request_count: 1,
        result_count: response.items.length,
        raw_result_count: response.items.length,
        unique_result_count: response.items.length,
        estimated_cost_usd: 0,
    });
    const receipt: SelfHostedAuthRunReceipt = {
        provider: 'selfhosted_auth',
        runId: response.runId,
        accountSlot: response.accountSlot,
    };
    await context?.onSelfHostedAuthRunFinished?.(receipt);
}

function canonicalProfileUsernames(usernames: readonly string[]): string[] {
    const normalized = usernames.map(username => username.trim().toLowerCase());
    if (
        normalized.length < 1
        || normalized.length > 30
        || normalized.some(username => !isInstagramUsername(username))
        || new Set(normalized).size !== normalized.length
    ) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: selfhosted_auth outcome usernames are invalid or duplicated.'
        );
    }
    return normalized;
}

async function reportProfileStart(
    context: ProviderCallContext | undefined,
    username: string,
): Promise<void> {
    await context?.onProfileStart?.(username);
}

async function reportProfileResolved(
    context: ProviderCallContext | undefined,
    profile: InstagramProfile,
): Promise<void> {
    await context?.onProfileResolved?.(profile);
}

export function makeSelfHostedAuthProvider(
    dependencies: SelfHostedAuthDependencies = {}
): ScraperProvider {
    const client = clientResolver(dependencies);
    const relationship = async (
        side: 'followers' | 'following',
        username: string,
        limit: number,
        context?: ProviderCallContext
    ) => {
        const response = await client().getRelationship(
            side,
            username,
            limit,
            workerRequestOptions(context)
        );
        const usernames = response.items.map(item => item.username);
        if (new Set(usernames).size !== usernames.length) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth returned duplicate usernames.');
        }
        await recordSuccessfulRun(context, response);
        return response.items;
    };
    const getProfileSummary = async (
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> => {
        const response = await client().getProfile(
            username,
            0,
            workerRequestOptions(context)
        );
        const profile = response.items[0] ?? null;
        if (profile && profile.username.toLowerCase() !== username.trim().toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth summary username mismatch.');
        }
        await recordSuccessfulRun(context, response);
        return profile;
    };
    const getProfile = async (
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null> => {
        const response = await client().getProfile(
            username,
            10,
            workerRequestOptions(context)
        );
        const profile = response.items[0] ?? null;
        if (profile && profile.username.toLowerCase() !== username.trim().toLowerCase()) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth profile username mismatch.');
        }
        await recordSuccessfulRun(context, response);
        return profile;
    };
    const getProfilesBatchOutcomes = async (
        usernames: string[],
        _batchSize?: number,
        context?: ProviderCallContext
    ): Promise<ProfileAttemptResult[]> => {
        const requested = canonicalProfileUsernames(usernames);
        const startedAt = Date.now();
        for (const username of requested) await reportProfileStart(context, username);
        const response = await client().getProfilesBatch(
            requested,
            10,
            workerRequestOptions(context)
        );
        const byUsername = new Map(response.items.map(item => [item.username, item]));
        if (
            byUsername.size !== response.items.length
            || response.items.some(item => !requested.includes(item.username))
        ) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth profile batch response mismatch.');
        }
        const results: ProfileAttemptResult[] = [];
        for (const username of requested) {
            const item = byUsername.get(username);
            const latencyMs = profileAttemptLatency(startedAt);
            if (!item) {
                throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth profile batch omitted username.');
            }
            if (item.status === 'not_found') {
                results.push(unavailableProfileAttempt({
                    requestedUsername: username,
                    // Profile checkpoint source intentionally retains the existing enum.
                    source: 'selfhosted',
                    reason: 'not_found',
                    httpStatus: 404,
                    requestCount: 1,
                    latencyMs,
                }));
                continue;
            }
            if (item.status === 'failed') {
                results.push(failedProfileAttempt({
                    requestedUsername: username,
                    source: 'selfhosted',
                    // Preserve the bounded failure category without exposing any
                    // provider exception detail to the durable profile outcome.
                    error: new Error('SCRAPING_SCHEMA_ERROR: profile batch item'),
                    requestCount: 1,
                    latencyMs,
                }));
                continue;
            }
            if (item.profile.username.toLowerCase() !== username) {
                throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth profile username mismatch.');
            }
            await reportProfileResolved(context, item.profile);
            results.push(successfulProfileAttempt({
                requestedUsername: username,
                source: 'selfhosted',
                profile: item.profile,
                requestCount: 1,
                latencyMs,
            }));
        }
        await recordSuccessfulRun(context, response);
        return results;
    };
    const getProfilesBatch = async (
        usernames: string[],
        batchSize?: number,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]> => {
        const results = await getProfilesBatchOutcomes(usernames, batchSize, context);
        return results.flatMap(result => isSuccessfulProfileAttempt(result)
            ? [result.profile]
            : []);
    };
    return {
        name: 'selfhosted_auth',
        paid: false,
        getProfileSummary,
        getProfile,
        getProfilesBatch,
        getProfilesBatchOutcomes,
        getFollowers(username, limit, context) {
            return relationship('followers', username, limit, context);
        },
        getFollowing(username, limit, context) {
            return relationship('following', username, limit, context);
        },
    };
}

export function makeSelfHostedAuthInteractionAdapter(
    dependencies: SelfHostedAuthDependencies = {}
): ApifyInteractionAdapter {
    const client = clientResolver(dependencies);
    return {
        async getPostLikers(postUrls, limitPerPost, context) {
            const response = await client().getPostLikers(
                postUrls,
                limitPerPost,
                workerRequestOptions(context)
            );
            await recordSuccessfulRun(context, response);
            return response.items;
        },
        async getPostComments(postUrls, limitPerPost, context) {
            const response = await client().getPostComments(
                postUrls,
                limitPerPost,
                workerRequestOptions(context)
            );
            await recordSuccessfulRun(context, response);
            return response.items;
        },
    };
}

export const selfHostedAuthProvider = makeSelfHostedAuthProvider();
export const selfHostedAuthInteractionAdapter = makeSelfHostedAuthInteractionAdapter();
