import type { ApifyInteractionAdapter } from '../apify-interactions';
import type {
    ProviderCallContext,
    ScraperProvider,
    SelfHostedAuthRunReceipt,
} from '../types';
import {
    createSelfHostedAuthWorkerClient,
    type SelfHostedAuthWorkerClient,
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
        const response = await client().getRelationship(side, username, limit);
        const usernames = response.items.map(item => item.username);
        if (new Set(usernames).size !== usernames.length) {
            throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted_auth returned duplicate usernames.');
        }
        await recordSuccessfulRun(context, response);
        return response.items;
    };
    return {
        name: 'selfhosted_auth',
        paid: false,
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
            const response = await client().getPostLikers(postUrls, limitPerPost);
            await recordSuccessfulRun(context, response);
            return response.items;
        },
        async getPostComments(postUrls, limitPerPost, context) {
            const response = await client().getPostComments(postUrls, limitPerPost);
            await recordSuccessfulRun(context, response);
            return response.items;
        },
    };
}

export const selfHostedAuthProvider = makeSelfHostedAuthProvider();
export const selfHostedAuthInteractionAdapter = makeSelfHostedAuthInteractionAdapter();
