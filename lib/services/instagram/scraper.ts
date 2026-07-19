import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import {
    summarizeProfileFetchOutcomes,
    type ProfileFetchFailureCategory,
} from '@/lib/domain/analysis/profile-fetch-outcome';
import {
    MAX_BATCH_EXCEPTION_EVENTS,
    operationalLogger,
} from '@/lib/observability/server';
import type {
    Capability,
    ProfileAttemptProvider,
    ProfileAttemptResult,
    ProviderCallContext,
    ProviderName,
    ProviderUsageDelta,
    ScraperFailureCategory,
    ScrapeRequestOptions,
    ScraperProvider,
    ScraperTelemetryEvent,
    ScraperTelemetryHook,
} from './providers/types';
import {
    failedProfileAttempt,
    isSuccessfulProfileAttempt,
    profileAttemptLatency,
    successfulProfileAttempt,
    validateProfileAttemptResults,
} from './providers/profile-attempt';
import {
    AUTOMATIC_FALLBACK,
    getScraperConfig,
    isProviderAllowed,
    type ScraperConfig,
} from './config';
import { apifyProvider } from './providers/apify';
import { APIFY_PROVIDER_QUOTA_ERROR_CODE } from './providers/apify-relationship';
import { coderXProvider } from './providers/coderx';
import { flashApiProvider } from './providers/flashapi';
import { rapidApiProvider } from './providers/rapidapi';
import { selfHostedProvider } from './providers/selfhosted';
import { isInstagramUsername } from './username';
import {
    minimumCompleteRelationshipCount,
    validateRelationshipCompleteness,
} from './completeness';
import { emitScraperOperationalTelemetry } from './supabase-telemetry';

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
export const MAX_V2_PROFILE_BATCH_SIZE = 30;

export interface ProfilesBatchV2AttemptSnapshot {
    attempt: 'primary' | 'fallback';
    source: ProfileAttemptProvider;
    requestedUsernames: readonly string[];
    results: readonly ProfileAttemptResult[];
}

export interface ProfilesBatchV2Resume {
    primaryResults: readonly ProfileAttemptResult[];
    frozenUnresolvedUsernames: readonly string[];
}

export interface ProfilesBatchV2Options {
    requestId?: string;
    onTelemetry?: ScrapeRequestOptions['onTelemetry'];
    providerRun?: ScrapeRequestOptions['providerRun'];
    onProfileStart?: ScrapeRequestOptions['onProfileStart'];
    onProfileResolved?: ScrapeRequestOptions['onProfileResolved'];
    resume?: ProfilesBatchV2Resume;
    persistAttemptOutcomes(snapshot: ProfilesBatchV2AttemptSnapshot): Promise<void>;
}

export interface ProfilesBatchV2Result {
    results: readonly ProfileAttemptResult[];
    profiles: readonly InstagramProfile[];
    primaryResults: readonly ProfileAttemptResult[];
    fallbackResults: readonly ProfileAttemptResult[];
    frozenUnresolvedUsernames: readonly string[];
}

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

function validateProfileBatchAttempt(
    result: InstagramProfile[],
    usernames: string[],
    provider: ScraperProvider,
    options?: ScrapeRequestOptions
): InstagramProfile[] {
    // A completed paid Actor can legitimately omit accounts that became unavailable.
    // Only durable operations may preserve that schema-valid subset; ordinary calls
    // retain the completeness requirement so provider regressions still fail closed.
    if (options?.providerRun && provider.paid === true) {
        validateProfileBatchSubset(result, usernames);
        if (usernames.length - result.length > 1) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: durable profiles batch omitted multiple accounts.'
            );
        }
        return result;
    }
    return validateProfileBatchCompleteness(result, usernames);
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

function candidateFailureCode(
    category: ProfileFetchFailureCategory
): 'NOT_FOUND' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'TIMEOUT' | 'VALIDATION_ERROR' | 'PROVIDER_ERROR' {
    if (category === 'not_found' || category === 'empty_user') return 'NOT_FOUND';
    if (category === 'auth') return 'UNAUTHORIZED';
    if (category === 'rate_limit') return 'RATE_LIMITED';
    if (category === 'timeout') return 'TIMEOUT';
    if (category === 'incomplete' || category === 'schema') return 'VALIDATION_ERROR';
    return 'PROVIDER_ERROR';
}

function emitV2CandidateFailures(
    results: readonly ProfileAttemptResult[],
    limit: number,
): number {
    let emitted = 0;
    for (const result of results) {
        if (result.outcome.status === 'success') continue;
        if (emitted === limit) break;
        emitted += 1;
        try {
            operationalLogger.emit({
                event: 'scraper.candidate_failed',
                severity: result.outcome.status === 'failed' ? 'error' : 'warn',
                fields: {
                    candidate_instagram_id: result.outcome.requestedUsername,
                    provider: result.outcome.source,
                    operation: 'profilesBatch',
                    disposition: result.outcome.status === 'unavailable'
                        ? 'unavailable'
                        : 'failure',
                    error_code: candidateFailureCode(result.outcome.failureCategory),
                    attempt: result.outcome.requestCount,
                    duration_ms: result.outcome.latencyMs,
                },
            });
        } catch {
            // Candidate processing is independent from observability delivery.
        }
    }
    return emitted;
}

function v2TelemetryHook(options: ProfilesBatchV2Options): ScraperTelemetryHook {
    return async event => {
        emitScraperOperationalTelemetry(event);
        if (options.onTelemetry) await options.onTelemetry(event);
    };
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
    options?: ScrapeRequestOptions,
    valueResultCount: (value: T) => number = inferResultCount
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
        invocationWaitLimitSecs: options?.providerRun?.invocationWaitLimitSecs,
        invocationDeadlineAtMs: options?.providerRun?.invocationDeadlineAtMs,
        startCancellationSignal: options?.providerRun?.startCancellationSignal,
        onBeforeRunStart: options?.providerRun?.onBeforeRunStart,
        onRunStarted: options?.providerRun?.onRunStarted,
        onProfileStart: options?.onProfileStart,
        onProfileResolved: options?.onProfileResolved,
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
        if (usage.result_count === 0) usage.result_count = valueResultCount(value);
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

function canonicalV2ProfileUsernames(usernames: readonly string[]): string[] {
    if (usernames.length < 1 || usernames.length > MAX_V2_PROFILE_BATCH_SIZE) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: V2 profile batch must contain 1~${MAX_V2_PROFILE_BATCH_SIZE} usernames.`
        );
    }
    const normalized = usernames.map(username => username.trim().toLowerCase());
    if (
        normalized.some(username => !isInstagramUsername(username))
        || new Set(normalized).size !== normalized.length
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: V2 profile usernames are invalid or duplicated.');
    }
    return normalized;
}

function canonicalFrozenSubset(
    frozenUsernames: readonly string[],
    requestedUsernames: readonly string[]
): string[] {
    const normalized = frozenUsernames.map(username => username.trim().toLowerCase());
    const requested = new Set(requestedUsernames);
    if (
        normalized.some(username => !isInstagramUsername(username) || !requested.has(username))
        || new Set(normalized).size !== normalized.length
    ) {
        throw new Error('SCRAPING_CONFIG_ERROR: frozen unresolved usernames are invalid.');
    }
    return normalized;
}

function immutableAttemptResults(
    results: readonly ProfileAttemptResult[]
): readonly ProfileAttemptResult[] {
    return Object.freeze(results.map((result) => {
        const outcome = Object.freeze({ ...result.outcome });
        return Object.freeze(isSuccessfulProfileAttempt(result)
            ? { outcome, profile: result.profile }
            : { outcome }) as ProfileAttemptResult;
    }));
}

function profilesToAttemptResults(
    requestedUsernames: readonly string[],
    profiles: readonly InstagramProfile[],
    source: ProfileAttemptProvider,
    startedAt: number
): ProfileAttemptResult[] {
    const requested = new Set(requestedUsernames);
    const returned = new Map<string, InstagramProfile>();
    for (const profile of profiles) {
        const username = typeof profile?.username === 'string'
            ? profile.username.trim().toLowerCase()
            : '';
        if (!isInstagramUsername(username) || !requested.has(username) || returned.has(username)) {
            throw new Error(
                'SCRAPING_SCHEMA_ERROR: V2 profile attempt returned an unexpected or duplicate username.'
            );
        }
        returned.set(username, profile);
    }

    const latencyMs = profileAttemptLatency(startedAt);
    return requestedUsernames.map((requestedUsername) => {
        const profile = returned.get(requestedUsername);
        if (profile) {
            return successfulProfileAttempt({
                requestedUsername,
                source,
                profile,
                requestCount: 1,
                latencyMs,
            });
        }
        return failedProfileAttempt({
            requestedUsername,
            source,
            error: new Error(
                'SCRAPING_INCOMPLETE_ERROR: provider omitted a terminal result without explicit not-found evidence.'
            ),
            requestCount: 1,
            latencyMs,
        });
    });
}

function allFailedProfileAttempts(
    requestedUsernames: readonly string[],
    source: ProfileAttemptProvider,
    error: unknown,
    startedAt: number
): ProfileAttemptResult[] {
    const latencyMs = profileAttemptLatency(startedAt);
    return requestedUsernames.map(requestedUsername => failedProfileAttempt({
        requestedUsername,
        source,
        error,
        requestCount: 1,
        latencyMs,
    }));
}

async function runProfileOutcomeAttempt(
    provider: ScraperProvider,
    source: ProfileAttemptProvider,
    requestedUsernames: readonly string[],
    fallback: boolean,
    options: ScrapeRequestOptions
): Promise<{
    results: readonly ProfileAttemptResult[];
    paidRunBarrierError?: Error;
}> {
    const startedAt = Date.now();
    try {
        const results = await runAttempt(
            'profilesBatch',
            provider,
            (candidate, context) => {
                const exact = candidate.getProfilesBatchOutcomes?.(
                    [...requestedUsernames],
                    requestedUsernames.length,
                    context
                );
                if (exact) return exact;
                return candidate.getProfilesBatch?.(
                    [...requestedUsernames],
                    requestedUsernames.length,
                    context
                ).then(profiles => profilesToAttemptResults(
                    requestedUsernames,
                    profiles,
                    source,
                    startedAt
                ));
            },
            fallback,
            options,
            value => value.filter(result => result.outcome.status === 'success').length
        );
        return {
            results: immutableAttemptResults(
                validateProfileAttemptResults(requestedUsernames, source, results)
            ),
        };
    } catch (error) {
        if (
            error instanceof Error
            && error.message.startsWith('SCRAPING_CONFIG_ERROR:')
        ) {
            throw error;
        }
        const paidRunBarrierError = error instanceof Error && (
            error.message === APIFY_PROVIDER_QUOTA_ERROR_CODE
            || [
                'SCRAPING_AMBIGUOUS_START_ERROR:',
                'SCRAPING_RUN_CHECKPOINT_ERROR:',
                'SCRAPING_RUN_PENDING_ERROR:',
                'ANALYSIS_PERSISTENCE_ERROR:',
                'ANALYSIS_V2_PROGRESS_',
            ].some(prefix => error.message.startsWith(prefix))
        )
            ? error
            : undefined;
        return {
            results: immutableAttemptResults(
                allFailedProfileAttempts(requestedUsernames, source, error, startedAt)
            ),
            ...(paidRunBarrierError ? { paidRunBarrierError } : {}),
        };
    }
}

async function persistProfileAttempt(
    options: ProfilesBatchV2Options,
    snapshot: ProfilesBatchV2AttemptSnapshot
): Promise<void> {
    try {
        await options.persistAttemptOutcomes(snapshot);
    } catch {
        throw new Error(
            `PROFILE_FETCH_PERSISTENCE_ERROR: ${snapshot.attempt} outcomes were not persisted.`
        );
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
                    .then(result => validateProfileBatchAttempt(
                        result,
                        usernames,
                        p,
                        options
                    )),
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
            ).then(result => validateProfileBatchAttempt(
                result,
                fallbackUsernames,
                p,
                options
            )),
            true,
            options
        );
        if (options?.providerRun && fallback.paid === true) {
            return validateProfileBatchSubset(supplement, fallbackUsernames);
        }
        return validateProfileBatchCompleteness(
            [...primaryResult, ...supplement],
            usernames
        );
    }

    return route(
        'profilesBatch',
        selected,
        (p, context) => p.getProfilesBatch?.(usernames, batchSize, context)
            .then(result => validateProfileBatchAttempt(result, usernames, p, options)),
        options?.fallback ?? c.fallback,
        options
    );
}

/**
 * V2 profile path. Free-provider outcomes are durably acknowledged before the paid
 * input is frozen, and a retry must supply that frozen snapshot instead of rerunning free work.
 */
export async function getProfilesBatchV2(
    usernames: readonly string[],
    options: ProfilesBatchV2Options
): Promise<ProfilesBatchV2Result> {
    if (!options || typeof options.persistAttemptOutcomes !== 'function') {
        throw new Error('SCRAPING_CONFIG_ERROR: V2 profile persistence callback is required.');
    }
    const requestedUsernames = Object.freeze(canonicalV2ProfileUsernames(usernames));
    const onTelemetry = v2TelemetryHook(options);
    let candidateFailureEvents = 0;
    const primary = providers.selfhosted;
    const fallback = providers.apify;
    if (
        !primary
        || primary.name !== 'selfhosted'
        || primary.paid !== false
        || !fallback
        || fallback.name !== 'apify'
        || fallback.paid !== true
    ) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: V2 profiles require free selfhosted primary and paid Apify fallback.'
        );
    }
    if (options.providerRun?.logicalProvider && options.providerRun.logicalProvider !== 'apify') {
        throw new Error('SCRAPING_CONFIG_ERROR: V2 profile fallback can only resume Apify.');
    }
    if (
        (options.providerRun?.resumeRunId || options.providerRun?.startReserved)
        && !options.resume
    ) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: a resumed paid profile run requires the frozen primary snapshot.'
        );
    }

    let primaryResults: readonly ProfileAttemptResult[];
    let frozenUnresolvedUsernames: readonly string[];
    if (options.resume) {
        primaryResults = immutableAttemptResults(validateProfileAttemptResults(
            requestedUsernames,
            'selfhosted',
            options.resume.primaryResults
        ));
        const derived = summarizeProfileFetchOutcomes(
            requestedUsernames,
            primaryResults.map(result => result.outcome)
        ).unresolvedUsernames;
        const supplied = canonicalFrozenSubset(
            options.resume.frozenUnresolvedUsernames,
            requestedUsernames
        );
        if (
            supplied.length !== derived.length
            || supplied.some((username, index) => username !== derived[index])
        ) {
            throw new Error(
                'PROFILE_FETCH_OUTCOME_ERROR: frozen unresolved usernames differ from primary outcomes.'
            );
        }
        frozenUnresolvedUsernames = Object.freeze(supplied);
    } else {
        const primaryAttempt = await runProfileOutcomeAttempt(
            primary,
            'selfhosted',
            requestedUsernames,
            false,
            {
                requestId: options.requestId,
                onTelemetry,
                onProfileStart: options.onProfileStart,
                onProfileResolved: options.onProfileResolved,
            }
        );
        if (primaryAttempt.paidRunBarrierError) throw primaryAttempt.paidRunBarrierError;
        primaryResults = primaryAttempt.results;
        await persistProfileAttempt(options, Object.freeze({
            attempt: 'primary',
            source: 'selfhosted',
            requestedUsernames,
            results: primaryResults,
        }));
        candidateFailureEvents += emitV2CandidateFailures(
            primaryResults,
            MAX_BATCH_EXCEPTION_EVENTS - candidateFailureEvents,
        );
        frozenUnresolvedUsernames = Object.freeze(
            summarizeProfileFetchOutcomes(
                requestedUsernames,
                primaryResults.map(result => result.outcome)
            ).unresolvedUsernames
        );
    }

    let fallbackResults: readonly ProfileAttemptResult[] = Object.freeze([]);
    if (frozenUnresolvedUsernames.length > 0) {
        if (
            !options.providerRun
            || (
                !options.providerRun.resumeRunId
                && !options.providerRun.startReserved
                && (
                    typeof options.providerRun.onBeforeRunStart !== 'function'
                    || typeof options.providerRun.onRunStarted !== 'function'
                )
            )
        ) {
            throw new Error(
                'SCRAPING_CONFIG_ERROR: V2 paid fallback requires a durable provider-run checkpoint.'
            );
        }
        const fallbackAttempt = await runProfileOutcomeAttempt(
            fallback,
            'apify',
            frozenUnresolvedUsernames,
            true,
            {
                requestId: options.requestId,
                onTelemetry,
                onProfileStart: options.onProfileStart,
                providerRun: options.providerRun,
            }
        );
        fallbackResults = fallbackAttempt.results;
        // A run/checkpoint barrier is not a terminal per-username provider outcome. Persisting
        // synthetic failures here would seal the frozen fallback set and make a same-run retry
        // conflict when the Actor later succeeds.
        if (fallbackAttempt.paidRunBarrierError) throw fallbackAttempt.paidRunBarrierError;
        await persistProfileAttempt(options, Object.freeze({
            attempt: 'fallback',
            source: 'apify',
            requestedUsernames: frozenUnresolvedUsernames,
            results: fallbackResults,
        }));
        emitV2CandidateFailures(
            fallbackResults,
            MAX_BATCH_EXCEPTION_EVENTS - candidateFailureEvents,
        );
    }

    const fallbackByUsername = new Map(
        fallbackResults.map(result => [result.outcome.requestedUsername, result])
    );
    const finalResults = immutableAttemptResults(primaryResults.map((primaryResult) => {
        if (primaryResult.outcome.status === 'success') return primaryResult;
        const fallbackResult = fallbackByUsername.get(primaryResult.outcome.requestedUsername);
        if (!fallbackResult) {
            throw new Error(
                'PROFILE_FETCH_OUTCOME_ERROR: unresolved username has no fallback result.'
            );
        }
        return fallbackResult;
    }));
    summarizeProfileFetchOutcomes(
        requestedUsernames,
        finalResults.map(result => result.outcome)
    );

    return {
        results: finalResults,
        profiles: Object.freeze(finalResults.flatMap(result =>
            isSuccessfulProfileAttempt(result) ? [result.profile] : []
        )),
        primaryResults,
        fallbackResults,
        frozenUnresolvedUsernames,
    };
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
