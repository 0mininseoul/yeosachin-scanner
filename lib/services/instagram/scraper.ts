import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import type {
    Capability,
    ProviderCallContext,
    ProviderName,
    ProviderUsageDelta,
    ScraperFailureCategory,
    ScrapeRequestOptions,
    ScraperProvider,
    ScraperTelemetryEvent,
} from './providers/types';
import {
    AUTOMATIC_FALLBACK,
    getScraperConfig,
    isProviderAllowed,
    type ScraperConfig,
} from './config';
import { apifyProvider } from './providers/apify';
import { coderXProvider } from './providers/coderx';
import { flashApiProvider } from './providers/flashapi';
import { rapidApiProvider } from './providers/rapidapi';
import { selfHostedProvider } from './providers/selfhosted';
import { isInstagramUsername } from './username';
import {
    minimumCompleteRelationshipCount,
    validateRelationshipCompleteness,
} from './completeness';

// ── 프로바이더 레지스트리 (테스트에서 주입 가능) ──
let providers: Record<ProviderName, ScraperProvider> = {
    apify: apifyProvider,
    coderx: coderXProvider,
    flashapi: flashApiProvider,
    rapidapi: rapidApiProvider,
    selfhosted: selfHostedProvider,
};
let configOverride: Record<string, string | undefined> | null = null;

function config(): ScraperConfig {
    return getScraperConfig(configOverride ?? process.env);
}

const MAX_PAID_FALLBACKS = 1;

interface UsageAccumulator {
    request_count: number;
    result_count: number;
    raw_result_count: number;
    unique_result_count: number;
    estimated_cost_usd: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

function addUsage(target: UsageAccumulator, delta: ProviderUsageDelta): void {
    for (const key of [
        'request_count',
        'result_count',
        'raw_result_count',
        'unique_result_count',
        'estimated_cost_usd',
    ] as const) {
        const value = delta[key];
        if (value === undefined) continue;
        const mustBeInteger = key !== 'estimated_cost_usd';
        if (!Number.isFinite(value) || value < 0 || (mustBeInteger && !Number.isInteger(value))) {
            throw new Error(`SCRAPING_TELEMETRY_ERROR: ${key}는 0 이상의 유한한 숫자여야 합니다.`);
        }
        target[key] += value;
    }
    for (const key of ['rate_limit_limit', 'rate_limit_remaining'] as const) {
        const value = delta[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`SCRAPING_TELEMETRY_ERROR: ${key}는 0 이상의 안전한 정수여야 합니다.`);
        }
        const current = target[key];
        target[key] = current === undefined
            ? value
            : key === 'rate_limit_limit'
              ? Math.max(current, value)
              : Math.min(current, value);
    }
}

function inferResultCount(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    return value === null || value === undefined ? 0 : 1;
}

function validateRelationshipRequest(
    username: string,
    limit: number,
    expectedResultCount: number | undefined
): void {
    const normalized = username.trim().replace(/^@/, '');
    if (!isInstagramUsername(normalized)) {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram username/id 형식이 올바르지 않습니다.');
    }
    if (!Number.isInteger(limit) || limit < 0 || limit > 500_000) {
        throw new Error('SCRAPING_CONFIG_ERROR: limit은 0~500000 범위의 정수여야 합니다.');
    }
    if (
        expectedResultCount !== undefined &&
        (!Number.isInteger(expectedResultCount) ||
            expectedResultCount < 0 ||
            expectedResultCount > limit)
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: expectedResultCount는 0~limit 범위의 정수여야 합니다.');
    }
}

function validateProfileBatchSubset(
    result: InstagramProfile[],
    usernames: string[]
): InstagramProfile[] {
    const requested = new Set<string>();
    for (const username of usernames) {
        const key = username.trim().toLowerCase();
        if (!isInstagramUsername(key) || requested.has(key)) {
            throw new Error('SCRAPING_CONFIG_ERROR: profiles batch usernames are invalid or duplicated.');
        }
        requested.add(key);
    }

    const returned = new Set<string>();
    for (const profile of result) {
        const key = typeof profile?.username === 'string'
            ? profile.username.trim().toLowerCase()
            : '';
        if (!isInstagramUsername(key) || !requested.has(key)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: profiles batch returned an unexpected username.');
        }
        if (returned.has(key)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: profiles batch returned a duplicate username.');
        }
        returned.add(key);
    }

    return result;
}

function validateProfileBatchCompleteness(
    result: InstagramProfile[],
    usernames: string[]
): InstagramProfile[] {
    validateProfileBatchSubset(result, usernames);
    if (result.length !== usernames.length) {
        throw new Error('SCRAPING_INCOMPLETE_ERROR: profiles batch omitted requested accounts.');
    }
    return result;
}

function missingProfileUsernames(
    result: InstagramProfile[],
    usernames: string[]
): string[] {
    const returned = new Set(result.map((profile) => profile.username.trim().toLowerCase()));
    return usernames.filter((username) => !returned.has(username.trim().toLowerCase()));
}

async function emitTelemetry(
    options: ScrapeRequestOptions | undefined,
    event: ScraperTelemetryEvent
): Promise<void> {
    if (!options?.onTelemetry) return;
    try {
        await options.onTelemetry(event);
    } catch {
        console.warn('[scraper] telemetry hook failed');
    }
}

function safeFailureCategory(error: unknown): ScraperFailureCategory {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('CONFIG')) return 'configuration';
    if (message.includes('SCHEMA')) return 'schema';
    if (message.includes('INCOMPLETE')) return 'incomplete';
    if (message.includes('BUDGET')) return 'budget';
    if (message.includes('TIMEOUT')) return 'timeout';
    return 'provider';
}

async function runAttempt<T>(
    capability: Capability,
    provider: ScraperProvider,
    call: (p: ScraperProvider, context: ProviderCallContext) => Promise<T> | undefined,
    fallback: boolean,
    options?: ScrapeRequestOptions
): Promise<T> {
    const startedAt = Date.now();
    const usage: UsageAccumulator = {
        request_count: 0,
        result_count: 0,
        raw_result_count: 0,
        unique_result_count: 0,
        estimated_cost_usd: 0,
    };
    const context: ProviderCallContext = {
        requestId: options?.requestId,
        resumeRunId: options?.providerRun?.resumeRunId,
        logicalProvider: options?.providerRun?.logicalProvider,
        actorId: options?.providerRun?.actorId,
        credentialSlot: options?.providerRun?.credentialSlot,
        maxChargeUsd: options?.providerRun?.maxChargeUsd,
        startReserved: options?.providerRun?.startReserved,
        onBeforeRunStart: options?.providerRun?.onBeforeRunStart,
        onRunStarted: options?.providerRun?.onRunStarted,
        onCostRunStarted: options?.providerRun?.onCostRunStarted,
        onCostRunFinished: options?.providerRun?.onCostRunFinished,
        recordUsage: (delta) => addUsage(usage, delta),
    };

    let status: ScraperTelemetryEvent['status'] = 'success';
    let failureCategory: ScraperFailureCategory | undefined;
    try {
        const pending = call(provider, context);
        if (pending === undefined) {
            throw new Error(
                `SCRAPING_ERROR: 프로바이더 '${provider.name}'가 '${capability}'를 지원하지 않습니다.`
            );
        }
        const value = await pending;
        if (usage.result_count === 0) usage.result_count = inferResultCount(value);
        if (usage.raw_result_count === 0) usage.raw_result_count = usage.result_count;
        if (usage.unique_result_count === 0) usage.unique_result_count = usage.result_count;
        return value;
    } catch (error) {
        status = 'error';
        failureCategory = safeFailureCategory(error);
        throw error;
    } finally {
        if (usage.raw_result_count === 0) usage.raw_result_count = usage.result_count;
        if (usage.unique_result_count === 0) usage.unique_result_count = usage.result_count;
        await emitTelemetry(options, {
            requestId: options?.requestId,
            provider: provider.name,
            capability,
            request_count: usage.request_count,
            result_count: usage.result_count,
            raw_result_count: usage.raw_result_count,
            unique_result_count: usage.unique_result_count,
            unique_ratio: usage.raw_result_count > 0
                ? usage.unique_result_count / usage.raw_result_count
                : 1,
            fallback,
            latency_ms: Math.max(0, Date.now() - startedAt),
            status,
            ...(options?.expectedResultCount !== undefined
                ? {
                    expected_result_count: options.expectedResultCount,
                    minimum_complete_count: minimumCompleteRelationshipCount(
                        options.expectedResultCount
                    ),
                    coverage_ratio: options.expectedResultCount === 0
                        ? 1
                        : usage.result_count / options.expectedResultCount,
                }
                : {}),
            ...(failureCategory ? { failure_category: failureCategory } : {}),
            estimated_cost_usd: usage.estimated_cost_usd,
            ...(usage.rate_limit_limit !== undefined
                ? { rate_limit_limit: usage.rate_limit_limit }
                : {}),
            ...(usage.rate_limit_remaining !== undefined
                ? { rate_limit_remaining: usage.rate_limit_remaining }
                : {}),
        });
    }
}

/** Execute one primary and, when configured, at most one paid fallback. */
async function route<T>(
    capability: Capability,
    selected: ProviderName,
    call: (p: ScraperProvider, context: ProviderCallContext) => Promise<T> | undefined,
    fallbackEnabled: boolean,
    options?: ScrapeRequestOptions
): Promise<T> {
    const primary = providers[selected];
    if (!primary) throw new Error(`SCRAPING_CONFIG_ERROR: 알 수 없는 프로바이더 '${selected}'입니다.`);

    try {
        return await runAttempt(capability, primary, call, false, options);
    } catch (error) {
        const fallbackName = AUTOMATIC_FALLBACK[capability]?.[selected];
        const fallbackProvider = fallbackName ? providers[fallbackName] : undefined;
        let paidFallbacks = 0;
        if (
            fallbackEnabled &&
            fallbackName &&
            fallbackProvider &&
            fallbackName !== selected &&
            paidFallbacks < MAX_PAID_FALLBACKS
        ) {
            if (fallbackProvider.paid !== false) paidFallbacks++;
            console.warn(
                `[scraper] ${selected} ${capability} 실패 → ${fallbackName}로 폴백 (${safeFailureCategory(error)})`
            );
            return runAttempt(capability, fallbackProvider, call, true, options);
        }
        throw error;
    }
}

function selectedProvider(
    capability: Capability,
    configured: ProviderName,
    options?: ScrapeRequestOptions
): ProviderName {
    // Durable run IDs in analysis_provider_runs are explicitly Apify-owned. A retry
    // must wait/read that Actor even if the original operation reached Apify only as
    // a fallback from the self-hosted provider.
    const resumeProvider = options?.providerRun?.logicalProvider;
    if (resumeProvider) {
        if (!isProviderAllowed(capability, resumeProvider)) {
            throw new Error(
                `SCRAPING_CONFIG_ERROR: '${resumeProvider}' cannot resume capability '${capability}'.`
            );
        }
        return resumeProvider;
    }
    if (options?.provider === undefined) return configured;
    if (!isProviderAllowed(capability, options.provider)) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: '${options.provider}'는 '${capability}'에 사용할 수 없습니다.`
        );
    }
    return options.provider;
}

export async function getInstagramProfile(
    username: string,
    options?: ScrapeRequestOptions
): Promise<InstagramProfile | null> {
    const c = config();
    return route(
        'profile',
        selectedProvider('profile', c.profile, options),
        (p, context) => p.getProfile?.(username, context),
        options?.fallback ?? c.fallback,
        options
    );
}

export async function getFollowers(
    username: string,
    limit: number = 500,
    options?: ScrapeRequestOptions
): Promise<InstagramFollower[]> {
    validateRelationshipRequest(username, limit, options?.expectedResultCount);
    const providerLimit = options?.expectedResultCount ?? limit;
    const c = config();
    return route(
        'followers',
        selectedProvider('followers', c.followers, options),
        (p, context) => {
            const pending = p.getFollowers?.(username, providerLimit, context);
            return pending?.then((result) => options?.expectedResultCount === undefined
                ? result
                : validateRelationshipCompleteness(result, options.expectedResultCount));
        },
        options?.fallback ?? c.fallback,
        options
    );
}

export async function getFollowing(
    username: string,
    limit: number = 500,
    options?: ScrapeRequestOptions
): Promise<InstagramFollower[]> {
    validateRelationshipRequest(username, limit, options?.expectedResultCount);
    const providerLimit = options?.expectedResultCount ?? limit;
    const c = config();
    return route(
        'following',
        selectedProvider('following', c.following, options),
        (p, context) => {
            const pending = p.getFollowing?.(username, providerLimit, context);
            return pending?.then((result) => options?.expectedResultCount === undefined
                ? result
                : validateRelationshipCompleteness(result, options.expectedResultCount));
        },
        options?.fallback ?? c.fallback,
        options
    );
}

export async function getProfilesBatch(
    usernames: string[],
    batchSize?: number,
    options?: ScrapeRequestOptions
): Promise<InstagramProfile[]> {
    const c = config();
    const selected = selectedProvider('profilesBatch', c.profilesBatch, options);
    const fallbackEnabled = options?.fallback ?? c.fallback;
    const fallbackName = AUTOMATIC_FALLBACK.profilesBatch?.[selected];

    if (fallbackEnabled && fallbackName && fallbackName !== selected) {
        const primary = providers[selected];
        const fallback = providers[fallbackName];
        if (!primary || !fallback) {
            throw new Error('SCRAPING_CONFIG_ERROR: profile batch provider routing is incomplete.');
        }

        let primaryResult: InstagramProfile[];
        try {
            primaryResult = await runAttempt(
                'profilesBatch',
                primary,
                (p, context) => p.getProfilesBatch?.(usernames, batchSize, context)
                    .then(result => validateProfileBatchSubset(result, usernames)),
                false,
                options
            );
        } catch (error) {
            console.warn(
                `[scraper] ${selected} profilesBatch 실패 → ${fallbackName}로 폴백 (${safeFailureCategory(error)})`
            );
            return runAttempt(
                'profilesBatch',
                fallback,
                (p, context) => p.getProfilesBatch?.(usernames, usernames.length, context)
                    .then(result => validateProfileBatchCompleteness(result, usernames)),
                true,
                options
            );
        }

        const missing = missingProfileUsernames(primaryResult, usernames);
        if (missing.length === 0) return primaryResult;

        // The analysis route freezes `usernames` before a paid Actor starts. If that
        // Actor outlives the invocation, a retry can only reconstruct the full frozen
        // input; free-provider partial rows have not been committed independently.
        // Therefore the durable path sends the full bounded batch to the fallback.
        const fallbackUsernames = options?.providerRun ? usernames : missing;
        console.warn(
            `[scraper] ${selected} profilesBatch 누락 ${missing.length}건 → ${fallbackName}로 보충`
        );
        const supplement = await runAttempt(
            'profilesBatch',
            fallback,
            (p, context) => p.getProfilesBatch?.(
                fallbackUsernames,
                fallbackUsernames.length,
                context
            ).then(result => validateProfileBatchCompleteness(result, fallbackUsernames)),
            true,
            options
        );
        if (options?.providerRun) return supplement;
        return validateProfileBatchCompleteness(
            [...primaryResult, ...supplement],
            usernames
        );
    }

    return route(
        'profilesBatch',
        selected,
        (p, context) => p.getProfilesBatch?.(usernames, batchSize, context)
            .then(result => validateProfileBatchCompleteness(result, usernames)),
        options?.fallback ?? c.fallback,
        options
    );
}

// ── 프로바이더 무관 순수 헬퍼 ──
export function extractMutualFollows(
    followers: InstagramFollower[],
    following: InstagramFollower[]
): InstagramFollower[] {
    const followerSet = new Set(followers.map((f) => f.username.toLowerCase()));
    return following.filter((f) => followerSet.has(f.username.toLowerCase()));
}

export function classifyByPrivacy(accounts: InstagramFollower[]): {
    publicAccounts: InstagramFollower[];
    privateAccounts: InstagramFollower[];
} {
    return {
        publicAccounts: accounts.filter((a) => !a.isPrivate),
        privateAccounts: accounts.filter((a) => a.isPrivate),
    };
}

// ── 테스트 전용 훅 ──
export function __setProvidersForTest(
    env: Record<string, string | undefined>,
    overrides: Partial<Record<ProviderName, ScraperProvider>>
): void {
    configOverride = env;
    providers = { ...providers, ...overrides } as Record<ProviderName, ScraperProvider>;
}

export function __resetProvidersForTest(): void {
    configOverride = null;
    providers = {
        apify: apifyProvider,
        coderx: coderXProvider,
        flashapi: flashApiProvider,
        rapidapi: rapidApiProvider,
        selfhosted: selfHostedProvider,
    };
}
