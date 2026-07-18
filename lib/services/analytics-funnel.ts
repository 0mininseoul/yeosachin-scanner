export type RelationshipBucket =
    | 'unknown'
    | '0_400'
    | '401_800'
    | '801_1200'
    | 'over_1200';

export type AnalyticsErrorCode =
    | 'INTERNAL_ERROR'
    | 'NETWORK_ERROR'
    | 'NOT_FOUND'
    | 'PROVIDER_ERROR'
    | 'RATE_LIMITED'
    | 'TIMEOUT'
    | 'UNAUTHORIZED'
    | 'UNKNOWN'
    | 'VALIDATION_ERROR';

export interface AnalyticsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const MAX_DURATION_MS = 86_400_000;
const CANONICAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTERED_ERROR_CODES = new Set<AnalyticsErrorCode>([
    'INTERNAL_ERROR',
    'NETWORK_ERROR',
    'NOT_FOUND',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'TIMEOUT',
    'UNAUTHORIZED',
    'UNKNOWN',
    'VALIDATION_ERROR',
]);

const DOMAIN_ERROR_CODES: Readonly<Record<string, AnalyticsErrorCode>> = {
    TARGET_NOT_FOUND: 'NOT_FOUND',
    TARGET_PRIVATE: 'VALIDATION_ERROR',
    TARGET_UNSUPPORTED: 'VALIDATION_ERROR',
    OVER_PLUS_CAPACITY: 'VALIDATION_ERROR',
    EXCLUSION_REQUIRED: 'VALIDATION_ERROR',
    INVALID_EXCLUSION: 'VALIDATION_ERROR',
    PLAN_UPGRADE_REQUIRED: 'VALIDATION_ERROR',
    RELATIONSHIP_INCOMPLETE: 'PROVIDER_ERROR',
    PROFILE_EVIDENCE_INCOMPLETE: 'PROVIDER_ERROR',
    QUEUE_UNAVAILABLE: 'PROVIDER_ERROR',
    AI_RATE_LIMITED: 'RATE_LIMITED',
    AI_AMBIGUOUS_RESULT: 'PROVIDER_ERROR',
    ANALYSIS_FAILED: 'INTERNAL_ERROR',
};

const ATTRIBUTION_VALUES = {
    source: new Set(['direct', 'google', 'instagram', 'kakao']),
    medium: new Set(['direct', 'organic', 'paid_social', 'referral']),
    campaign: new Set(['launch_2026']),
    content: new Set(['hero-a']),
    term: new Set(['detector']),
} as const;

export function relationshipBucket(value: number | null | undefined): RelationshipBucket {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
    if (value <= 400) return '0_400';
    if (value <= 800) return '401_800';
    if (value <= 1_200) return '801_1200';
    return 'over_1200';
}

export function readAttribution(search: string): {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
} {
    const params = new URLSearchParams(search);
    const hasAttribution = [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term',
    ].some(key => params.has(key));
    if (!hasAttribution) return { source: 'direct', medium: 'direct' };

    const result: ReturnType<typeof readAttribution> = {};
    for (const [property, queryKey] of [
        ['source', 'utm_source'],
        ['medium', 'utm_medium'],
        ['campaign', 'utm_campaign'],
        ['content', 'utm_content'],
        ['term', 'utm_term'],
    ] as const) {
        const value = params.get(queryKey)?.trim().toLowerCase();
        if (value && ATTRIBUTION_VALUES[property].has(value as never)) {
            result[property] = value;
        }
    }
    return result;
}

export function safeAnalyticsErrorCode(value: unknown): AnalyticsErrorCode {
    if (value instanceof TypeError) return 'NETWORK_ERROR';

    let candidate: unknown = value;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'code' in value) {
        candidate = value.code;
    }
    if (typeof candidate !== 'string') return 'UNKNOWN';
    if (REGISTERED_ERROR_CODES.has(candidate as AnalyticsErrorCode)) {
        return candidate as AnalyticsErrorCode;
    }
    return DOMAIN_ERROR_CODES[candidate] ?? 'UNKNOWN';
}

export function safeAnalyticsHttpErrorCode(
    status: number,
    payload: unknown,
): AnalyticsErrorCode {
    const payloadCode = safeAnalyticsErrorCode(payload);
    if (payloadCode !== 'UNKNOWN') return payloadCode;
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 408 || status === 504) return 'TIMEOUT';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'INTERNAL_ERROR';
    if (status >= 400) return 'VALIDATION_ERROR';
    return 'UNKNOWN';
}

export function boundedDurationMs(startedAt: number, finishedAt: number): number {
    if (!Number.isFinite(startedAt)) return 0;
    if (!Number.isFinite(finishedAt)) return MAX_DURATION_MS;
    return Math.min(MAX_DURATION_MS, Math.max(0, Math.floor(finishedAt - startedAt)));
}

export function availableAnalyticsStorage(): AnalyticsStorage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

export function tryClaimAnalyticsEvent(
    storage: AnalyticsStorage | null | undefined,
    key: string,
): boolean {
    if (!storage) return true;
    try {
        if (storage.getItem(key) === '1') return false;
        storage.setItem(key, '1');
        return true;
    } catch {
        return true;
    }
}

export function landingViewEventKey(): string {
    return 'amplitude:landing_viewed';
}

export function analysisStartedAtKey(requestId: string): string {
    return `amplitude:analysis_started_at:${requestId}`;
}

export function analysisStartedEventKey(requestId: string): string {
    return `amplitude:analysis_started:${requestId}`;
}

export function claimAnalysisStart(
    storage: AnalyticsStorage | null | undefined,
    requestId: string,
    startedAt: number,
): boolean {
    if (!CANONICAL_REQUEST_ID.test(requestId)) return false;
    if (!tryClaimAnalyticsEvent(storage, analysisStartedEventKey(requestId))) return false;
    if (storage) {
        try {
            const safeStartedAt = Number.isFinite(startedAt)
                ? Math.max(0, Math.floor(startedAt))
                : Date.now();
            storage.setItem(analysisStartedAtKey(requestId), String(safeStartedAt));
        } catch {
            // Timing is best-effort and must not affect the product flow.
        }
    }
    return true;
}

export function claimObservedAnalysisStart(
    storage: AnalyticsStorage | null | undefined,
    expectedRequestId: string,
    observation: {
        requestId: string;
        status: 'pending' | 'processing' | 'completed' | 'failed';
    },
    startedAt: number,
): boolean {
    if (
        observation.requestId !== expectedRequestId
        || (observation.status !== 'pending' && observation.status !== 'processing')
    ) return false;
    return claimAnalysisStart(storage, expectedRequestId, startedAt);
}

export function readAnalysisStartedAt(
    storage: AnalyticsStorage | null | undefined,
    requestId: string,
): number | null {
    if (!storage || !CANONICAL_REQUEST_ID.test(requestId)) return null;
    try {
        const startedAt = Number(storage.getItem(analysisStartedAtKey(requestId)));
        return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null;
    } catch {
        return null;
    }
}

export function analysisCompletedEventKey(requestId: string): string {
    return `amplitude:analysis_completed:${requestId}`;
}

export function preflightOutcomeEventKey(
    outcome: 'succeeded' | 'failed',
    preflightId: string,
): string {
    return `amplitude:preflight_${outcome}:${preflightId}`;
}
