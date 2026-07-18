import {
    profileFetchOutcomeSchema,
    summarizeProfileFetchOutcomes,
    type ProfileFetchFailureCategory,
    type ProfileFetchOutcome,
} from '@/lib/domain/analysis/profile-fetch-outcome';
import type { InstagramProfile } from '@/lib/types/instagram';
import type {
    ProfileAttemptProvider,
    ProfileAttemptResult,
} from './types';

const MAX_OUTCOME_LATENCY_MS = 300_000;
const HTTP_STATUS_PATTERN = /(?:HTTP|status=)\s*(\d{3})/i;
const SELFHOSTED_PROFILE_CIRCUIT_OPEN_MESSAGE =
    'SCRAPING_ERROR: SELFHOSTED PROFILE CIRCUIT IS OPEN.';

export function isSuccessfulProfileAttempt(
    result: ProfileAttemptResult
): result is Extract<ProfileAttemptResult, { profile: InstagramProfile }> {
    return result.outcome.status === 'success';
}

function canonicalUsername(value: string): string {
    return value.trim().toLowerCase();
}

function outcomeBase(
    requestedUsername: string,
    source: ProfileAttemptProvider,
    requestCount: number,
    latencyMs: number,
    capturedAt: string
) {
    return {
        requestedUsername: canonicalUsername(requestedUsername),
        source,
        requestCount: Math.max(0, Math.min(10, Math.trunc(requestCount))),
        latencyMs: Math.max(0, Math.min(MAX_OUTCOME_LATENCY_MS, Math.trunc(latencyMs))),
        capturedAt,
    };
}

export function profileAttemptLatency(startedAt: number, now: number = Date.now()): number {
    return Math.max(0, Math.min(MAX_OUTCOME_LATENCY_MS, Math.trunc(now - startedAt)));
}

export function successfulProfileAttempt(input: {
    requestedUsername: string;
    source: ProfileAttemptProvider;
    profile: InstagramProfile;
    requestCount: number;
    latencyMs: number;
    capturedAt?: string;
}): ProfileAttemptResult {
    const requestedUsername = canonicalUsername(input.requestedUsername);
    if (canonicalUsername(input.profile.username) !== requestedUsername) {
        throw new Error('PROFILE_FETCH_OUTCOME_ERROR: profile username does not match request.');
    }
    const outcome = profileFetchOutcomeSchema.parse({
        ...outcomeBase(
            requestedUsername,
            input.source,
            input.requestCount,
            input.latencyMs,
            input.capturedAt ?? new Date().toISOString()
        ),
        status: 'success',
        failureCategory: null,
        httpStatus: null,
    });
    return { outcome: outcome as Extract<ProfileFetchOutcome, { status: 'success' }>, profile: input.profile };
}

export function unavailableProfileAttempt(input: {
    requestedUsername: string;
    source: ProfileAttemptProvider;
    reason: 'not_found' | 'empty_user';
    httpStatus?: 404 | null;
    requestCount: number;
    latencyMs: number;
    capturedAt?: string;
}): ProfileAttemptResult {
    const outcome = profileFetchOutcomeSchema.parse({
        ...outcomeBase(
            input.requestedUsername,
            input.source,
            input.requestCount,
            input.latencyMs,
            input.capturedAt ?? new Date().toISOString()
        ),
        status: 'unavailable',
        failureCategory: input.reason,
        httpStatus: input.httpStatus ?? null,
    });
    return { outcome: outcome as Extract<ProfileFetchOutcome, { status: 'unavailable' }> };
}

export function profileAttemptFailureDetails(error: unknown): {
    failureCategory: Exclude<
        ProfileFetchFailureCategory,
        'not_found' | 'empty_user'
    >;
    httpStatus: number | null;
} {
    const message = error instanceof Error ? error.message : '';
    const statusMatch = message.match(HTTP_STATUS_PATTERN);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    const httpStatus = status !== null && status >= 400 && status <= 599 ? status : null;
    const upper = message.toUpperCase();

    if (httpStatus === 401 || httpStatus === 403 || upper.includes('AUTH')) {
        return { failureCategory: 'auth', httpStatus };
    }
    if (httpStatus === 429 || upper.includes('RATE_LIMIT') || upper.includes('RATE LIMITED')) {
        return { failureCategory: 'rate_limit', httpStatus };
    }
    if (
        httpStatus === 408
        || httpStatus === 504
        || upper.includes('TIMEOUT')
        || (error instanceof Error && error.name === 'AbortError')
    ) {
        return { failureCategory: 'timeout', httpStatus };
    }
    if (upper.includes('INCOMPLETE')) {
        return { failureCategory: 'incomplete', httpStatus };
    }
    if (upper.includes('SCHEMA')) return { failureCategory: 'schema', httpStatus };
    if (
        upper.includes('TRANSPORT')
        || upper === SELFHOSTED_PROFILE_CIRCUIT_OPEN_MESSAGE
        || upper.includes('NETWORK')
        || upper.includes('ECONN')
        || upper.includes('FETCH FAILED')
    ) {
        return { failureCategory: 'transport', httpStatus };
    }
    if (httpStatus !== null) return { failureCategory: 'http', httpStatus };
    return { failureCategory: 'unknown', httpStatus: null };
}

export function failedProfileAttempt(input: {
    requestedUsername: string;
    source: ProfileAttemptProvider;
    error: unknown;
    requestCount: number;
    latencyMs: number;
    capturedAt?: string;
}): ProfileAttemptResult {
    const failure = profileAttemptFailureDetails(input.error);
    const outcome = profileFetchOutcomeSchema.parse({
        ...outcomeBase(
            input.requestedUsername,
            input.source,
            input.requestCount,
            input.latencyMs,
            input.capturedAt ?? new Date().toISOString()
        ),
        status: 'failed',
        ...failure,
    });
    return { outcome: outcome as Extract<ProfileFetchOutcome, { status: 'failed' }> };
}

export function validateProfileAttemptResults(
    requestedUsernames: readonly string[],
    source: ProfileAttemptProvider,
    results: readonly ProfileAttemptResult[]
): ProfileAttemptResult[] {
    summarizeProfileFetchOutcomes(
        requestedUsernames,
        results.map(result => result.outcome)
    );
    const byUsername = new Map(results.map(result => [result.outcome.requestedUsername, result]));
    return requestedUsernames.map((username) => {
        const key = canonicalUsername(username);
        const result = byUsername.get(key);
        if (!result || result.outcome.source !== source) {
            throw new Error('PROFILE_FETCH_OUTCOME_ERROR: provider source does not match attempt.');
        }
        if (isSuccessfulProfileAttempt(result) && canonicalUsername(result.profile.username) !== key) {
            throw new Error('PROFILE_FETCH_OUTCOME_ERROR: profile username does not match request.');
        }
        return result;
    });
}
