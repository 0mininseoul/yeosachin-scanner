import type { InstagramFollower } from '../lib/types/instagram';
import { isInstagramUsername } from '../lib/services/instagram/username';
import { apifyProvider } from '../lib/services/instagram/providers/apify';
import { coderXProvider } from '../lib/services/instagram/providers/coderx';
import {
    flashApiProvider,
    type FlashRelationshipKind,
} from '../lib/services/instagram/providers/flashapi';
import type {
    ProviderCallContext,
    ProviderName,
    ProviderUsageDelta,
    ScraperProvider,
} from '../lib/services/instagram/providers/types';
import {
    callCanaryRelationshipProvider,
    CanaryRelationshipResultError,
    parseCanaryDeclaredCount,
    parseCanaryRelationship,
    requireCanaryRelationshipRows,
    shouldRunCanaryRelationship,
    type CanaryRelationship,
} from './canary-instagram-provider-options';
import {
    CanaryInputError,
    sanitizeCanaryError,
} from './canary-instagram-provider-errors';
import {
    expectedRelationshipCount,
    minimumCompleteRelationshipCount,
} from '../lib/services/instagram/completeness';

const MAX_CANARY_LIMIT = 100;
const MAX_FULL_CANARY_LIMIT = 1_000;
const CONFIRMATION_FLAG = '--confirm-paid-api-call';
const FULL_CONFIRMATION_FLAG = '--confirm-full-paid-api-call';
type CanaryProvider = Extract<ProviderName, 'flashapi' | 'apify' | 'coderx'>;

interface Usage {
    request_count: number;
    result_count: number;
    raw_result_count: number;
    unique_result_count: number;
    estimated_cost_usd: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

interface Summary extends Usage {
    latency_ms: number;
    status: 'success' | 'error';
}

type ExpectedCounts = Partial<Record<FlashRelationshipKind, number>>;

const summaries: Summary[] = [];

function argument(name: string): string | undefined {
    const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function addUsage(usage: Usage, delta: ProviderUsageDelta): void {
    usage.request_count += delta.request_count ?? 0;
    usage.result_count += delta.result_count ?? 0;
    usage.raw_result_count += delta.raw_result_count ?? 0;
    usage.unique_result_count += delta.unique_result_count ?? 0;
    usage.estimated_cost_usd += delta.estimated_cost_usd ?? 0;
    if (delta.rate_limit_limit !== undefined) {
        usage.rate_limit_limit = Math.max(usage.rate_limit_limit ?? 0, delta.rate_limit_limit);
    }
    if (delta.rate_limit_remaining !== undefined) {
        usage.rate_limit_remaining = Math.min(
            usage.rate_limit_remaining ?? delta.rate_limit_remaining,
            delta.rate_limit_remaining
        );
    }
}

function output(
    step: 'user_id_lookup' | FlashRelationshipKind,
    provider: CanaryProvider,
    usage: Usage,
    latencyMs: number,
    status: 'success' | 'error',
    expectedCount?: number,
    errorCode?: string
): void {
    summaries.push({ ...usage, latency_ms: latencyMs, status });
    process.stdout.write(`${JSON.stringify({
        step,
        provider,
        request_count: usage.request_count,
        result_count: usage.result_count,
        raw_result_count: usage.raw_result_count,
        unique_result_count: usage.unique_result_count,
        unique_ratio: usage.raw_result_count > 0
            ? usage.unique_result_count / usage.raw_result_count
            : 1,
        latency_ms: latencyMs,
        status,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(expectedCount !== undefined
            ? {
                expected_count: expectedCount,
                minimum_complete_count: minimumCompleteRelationshipCount(expectedCount),
                coverage_ratio: expectedCount === 0 ? 1 : usage.result_count / expectedCount,
            }
            : {}),
        estimated_cost_usd: usage.estimated_cost_usd,
        ...(usage.rate_limit_limit !== undefined
            ? { rate_limit_limit: usage.rate_limit_limit }
            : {}),
        ...(usage.rate_limit_remaining !== undefined
            ? { rate_limit_remaining: usage.rate_limit_remaining }
            : {}),
    })}\n`);
}

function outputOverall(
    provider: CanaryProvider,
    latencyMs: number,
    followers: InstagramFollower[],
    following: InstagramFollower[],
    status: 'success' | 'error',
    expectedCounts: ExpectedCounts,
    errorCode?: string
): void {
    const total = summaries.reduce<Usage>((sum, item) => ({
        request_count: sum.request_count + item.request_count,
        result_count: sum.result_count + item.result_count,
        raw_result_count: sum.raw_result_count + item.raw_result_count,
        unique_result_count: sum.unique_result_count + item.unique_result_count,
        estimated_cost_usd: sum.estimated_cost_usd + item.estimated_cost_usd,
        rate_limit_limit: item.rate_limit_limit === undefined
            ? sum.rate_limit_limit
            : Math.max(sum.rate_limit_limit ?? 0, item.rate_limit_limit),
        rate_limit_remaining: item.rate_limit_remaining === undefined
            ? sum.rate_limit_remaining
            : Math.min(
                sum.rate_limit_remaining ?? item.rate_limit_remaining,
                item.rate_limit_remaining
            ),
    }), {
        request_count: 0,
        result_count: 0,
        raw_result_count: 0,
        unique_result_count: 0,
        estimated_cost_usd: 0,
    });
    const followerSet = new Set(followers.map((item) => item.username.toLowerCase()));
    const mutualCount = following.filter((item) =>
        followerSet.has(item.username.toLowerCase())
    ).length;
    process.stdout.write(`${JSON.stringify({
        step: 'overall',
        provider,
        request_count: total.request_count,
        result_count: total.result_count,
        raw_result_count: total.raw_result_count,
        unique_result_count: total.unique_result_count,
        unique_ratio: total.raw_result_count > 0
            ? total.unique_result_count / total.raw_result_count
            : 1,
        latency_ms: latencyMs,
        status,
        ...(errorCode ? { error_code: errorCode } : {}),
        estimated_cost_usd: total.estimated_cost_usd,
        followers_count: followers.length,
        following_count: following.length,
        mutual_count: mutualCount,
        ...(expectedCounts.followers !== undefined
            ? {
                expected_followers_count: expectedCounts.followers,
                followers_coverage_ratio: expectedCounts.followers === 0
                    ? 1
                    : followers.length / expectedCounts.followers,
            }
            : {}),
        ...(expectedCounts.following !== undefined
            ? {
                expected_following_count: expectedCounts.following,
                following_coverage_ratio: expectedCounts.following === 0
                    ? 1
                    : following.length / expectedCounts.following,
            }
            : {}),
        ...(total.rate_limit_limit !== undefined
            ? { rate_limit_limit: total.rate_limit_limit }
            : {}),
        ...(total.rate_limit_remaining !== undefined
            ? { rate_limit_remaining: total.rate_limit_remaining }
            : {}),
    })}\n`);
}

async function measured<T>(
    step: 'user_id_lookup' | FlashRelationshipKind,
    provider: CanaryProvider,
    action: (context: ProviderCallContext) => Promise<T>,
    expectedCount?: number
): Promise<T> {
    const usage: Usage = {
        request_count: 0,
        result_count: 0,
        raw_result_count: 0,
        unique_result_count: 0,
        estimated_cost_usd: 0,
    };
    const startedAt = Date.now();
    try {
        const result = await action({ recordUsage: (delta) => addUsage(usage, delta) });
        if (usage.result_count === 0) {
            usage.result_count = Array.isArray(result) ? result.length : 1;
        }
        if (usage.raw_result_count === 0 && Array.isArray(result)) {
            usage.raw_result_count = result.length;
            usage.unique_result_count = result.length;
        }
        if (step !== 'user_id_lookup' && Array.isArray(result)) {
            try {
                requireCanaryRelationshipRows(result as InstagramFollower[], expectedCount);
            } catch (error) {
                throw new CanaryRelationshipResultError(
                    error,
                    result as InstagramFollower[]
                );
            }
        }
        output(step, provider, usage, Date.now() - startedAt, 'success', expectedCount);
        return result;
    } catch (error) {
        output(
            step,
            provider,
            usage,
            Date.now() - startedAt,
            'error',
            expectedCount,
            sanitizeCanaryError(error).code
        );
        throw error;
    }
}

async function runActorProvider(
    providerName: CanaryProvider,
    provider: ScraperProvider,
    target: string,
    limit: number,
    relationship: CanaryRelationship,
    expectedCounts: ExpectedCounts
) {
    const collect = (
        kind: FlashRelationshipKind,
        context: ProviderCallContext
    ): Promise<InstagramFollower[]> => callCanaryRelationshipProvider(
        provider,
        target,
        kind,
        limit,
        expectedCounts[kind],
        context
    );
    const settled = await Promise.allSettled([
        shouldRunCanaryRelationship(relationship, 'followers')
            ? measured(
                'followers',
                providerName,
                (context) => collect('followers', context),
                expectedCounts.followers
            )
            : Promise.resolve([]),
        shouldRunCanaryRelationship(relationship, 'following')
            ? measured(
                'following',
                providerName,
                (context) => collect('following', context),
                expectedCounts.following
            )
            : Promise.resolve([]),
    ]);
    const failure = settled.find((result) => result.status === 'rejected');
    const rows = (result: PromiseSettledResult<InstagramFollower[]>) =>
        result.status === 'fulfilled'
            ? result.value
            : result.reason instanceof CanaryRelationshipResultError
              ? result.reason.rows
              : [];
    const error = failure?.status === 'rejected' &&
        failure.reason instanceof CanaryRelationshipResultError
        ? failure.reason.originalError
        : failure?.status === 'rejected'
          ? failure.reason as unknown
          : undefined;
    return {
        followers: rows(settled[0]),
        following: rows(settled[1]),
        error,
    };
}

async function main(): Promise<void> {
    const target = argument('username');
    const provider = argument('provider') as CanaryProvider | undefined;
    const limit = Number(argument('limit') ?? 10);
    const relationship = parseCanaryRelationship(argument('relationship'));

    const fullConfirmation = process.argv.includes(FULL_CONFIRMATION_FLAG);
    if (!process.argv.includes(CONFIRMATION_FLAG) && !fullConfirmation) {
        throw new CanaryInputError('confirmation_required', 'explicit paid-call confirmation required');
    }
    if (!target || !isInstagramUsername(target)) {
        throw new CanaryInputError('invalid_arguments', 'valid username required');
    }
    if (!provider || !['flashapi', 'apify', 'coderx'].includes(provider)) {
        throw new CanaryInputError('invalid_arguments', 'valid provider required');
    }
    if (!relationship) {
        throw new CanaryInputError(
            'invalid_arguments',
            'relationship must be followers, following, or both'
        );
    }
    const allowedLimit = fullConfirmation ? MAX_FULL_CANARY_LIMIT : MAX_CANARY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > allowedLimit) {
        throw new CanaryInputError('invalid_arguments', 'bounded canary limit required');
    }
    const declaredFollowers = parseCanaryDeclaredCount(argument('followers-count'));
    const declaredFollowing = parseCanaryDeclaredCount(argument('following-count'));
    if (declaredFollowers === null || declaredFollowing === null) {
        throw new CanaryInputError('invalid_arguments', 'declared relationship counts must be non-negative integers');
    }
    const expectedCounts: ExpectedCounts = {
        ...(declaredFollowers === undefined
            ? {}
            : { followers: expectedRelationshipCount(declaredFollowers, limit) }),
        ...(declaredFollowing === undefined
            ? {}
            : { following: expectedRelationshipCount(declaredFollowing, limit) }),
    };
    if (
        fullConfirmation &&
        ((shouldRunCanaryRelationship(relationship, 'followers') && expectedCounts.followers === undefined) ||
            (shouldRunCanaryRelationship(relationship, 'following') && expectedCounts.following === undefined))
    ) {
        throw new CanaryInputError(
            'invalid_arguments',
            'full canary requires --followers-count and/or --following-count for selected relationships'
        );
    }

    const startedAt = Date.now();
    let result: {
        followers: InstagramFollower[];
        following: InstagramFollower[];
        error?: unknown;
    } = { followers: [], following: [] };
    try {
        result = await runActorProvider(
            provider,
            provider === 'flashapi'
                ? flashApiProvider
                : provider === 'apify'
                  ? apifyProvider
                  : coderXProvider,
            target,
            limit,
            relationship,
            expectedCounts
        );
        if (result.error !== undefined) throw result.error;
        outputOverall(
            provider,
            Date.now() - startedAt,
            result.followers,
            result.following,
            'success',
            expectedCounts
        );
    } catch (error) {
        const sanitized = sanitizeCanaryError(error);
        outputOverall(
            provider,
            Date.now() - startedAt,
            result.followers,
            result.following,
            'error',
            expectedCounts,
            sanitized.code
        );
        throw error;
    }
}

main().catch((error: unknown) => {
    const sanitized = sanitizeCanaryError(error);
    process.stderr.write(`${JSON.stringify({
        status: 'failed',
        error_category: sanitized.category,
        error_code: sanitized.code,
        message: sanitized.message,
    })}\n`);
    process.exitCode = 1;
});
