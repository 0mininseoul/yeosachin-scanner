import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import type {
    ProfileFetchOutcome,
    ProfileFetchSource,
} from '@/lib/domain/analysis/profile-fetch-outcome';

export type Capability = 'profile' | 'profilesBatch' | 'followers' | 'following';

export type ProviderName = 'apify' | 'coderx' | 'flashapi' | 'rapidapi' | 'selfhosted';
export type InteractionProviderName = 'apify' | 'disabled';
export const APIFY_CREDENTIAL_SLOTS = [
    'primary',
    'secondary',
    'tertiary',
    'quaternary',
    'quinary',
] as const;
export type ApifyCredentialSlot = typeof APIFY_CREDENTIAL_SLOTS[number];

export function isApifyCredentialSlot(value: unknown): value is ApifyCredentialSlot {
    return typeof value === 'string'
        && APIFY_CREDENTIAL_SLOTS.includes(value as ApifyCredentialSlot);
}
export type ProviderCostTerminalStatus = 'succeeded' | 'failed' | 'aborted' | 'timed_out';

export interface ProviderCostRunStarted {
    logicalProvider: Extract<ProviderName, 'apify' | 'coderx'>;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    runId: string;
    maxChargeUsd: number;
}

export interface ProviderCostRunFinished extends ProviderCostRunStarted {
    status: ProviderCostTerminalStatus;
    usageTotalUsd: number | null;
}

interface ProviderCostRunCallbacks {
    onCostRunStarted?(input: ProviderCostRunStarted): void | Promise<void>;
    onCostRunFinished?(input: ProviderCostRunFinished): void | Promise<void>;
}

export type ScraperTelemetryStatus = 'success' | 'error';
export type ScraperFailureCategory =
    | 'configuration'
    | 'schema'
    | 'incomplete'
    | 'budget'
    | 'timeout'
    | 'provider';

export interface ScraperTelemetryEvent {
    requestId?: string;
    provider: ProviderName;
    capability: Capability;
    request_count: number;
    result_count: number;
    raw_result_count: number;
    unique_result_count: number;
    unique_ratio: number;
    fallback: boolean;
    latency_ms: number;
    status: ScraperTelemetryStatus;
    expected_result_count?: number;
    minimum_complete_count?: number;
    coverage_ratio?: number;
    failure_category?: ScraperFailureCategory;
    estimated_cost_usd: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

export type ScraperTelemetryHook = (
    event: ScraperTelemetryEvent
) => void | Promise<void>;

/** Optional trailing arguments accepted by every public scraper operation. */
export interface ScrapeRequestOptions {
    provider?: ProviderName;
    fallback?: boolean;
    expectedResultCount?: number;
    requestId?: string;
    onTelemetry?: ScraperTelemetryHook;
    /** Internal UX heartbeat emitted only when work for an exact profile starts. */
    onProfileStart?(username: string): void | Promise<void>;
    /** Internal PII-free progress signal emitted after a primary profile is resolved. */
    onProfileResolved?(): void | Promise<void>;
    providerRun?: ProviderRunCheckpoint;
}

/** Durable hand-off for paid provider runs that may outlive one serverless invocation. */
export interface ProviderRunCheckpoint extends ProviderCostRunCallbacks {
    resumeRunId?: string;
    logicalProvider?: Extract<ProviderName, 'apify' | 'coderx'>;
    actorId?: string;
    credentialSlot?: ApifyCredentialSlot;
    maxChargeUsd?: number;
    startReserved?: boolean;
    /** Per-invocation wait budget; it is not part of the durable billing identity. */
    invocationWaitLimitSecs?: number;
    /** Absolute runtime deadline for provider I/O; it is not a durable billing identity. */
    invocationDeadlineAtMs?: number;
    /** Internal request fence checked only before a new paid provider run is reserved. */
    startCancellationSignal?: AbortSignal;
    onBeforeRunStart?(input: {
        logicalProvider: Extract<ProviderName, 'apify' | 'coderx'>;
        actorId: string;
        credentialSlot: ApifyCredentialSlot;
        maxChargeUsd: number;
    }): void | Promise<void>;
    onRunStarted?(runId: string): void | Promise<void>;
}

/** Serializable subset stored with an analysis request. */
export interface ScraperProviderSelection {
    profile?: ProviderName;
    profilesBatch?: ProviderName;
    followers?: ProviderName;
    following?: ProviderName;
    likers?: InteractionProviderName;
    comments?: InteractionProviderName;
    fallback?: boolean;
}

export interface ProviderUsageDelta {
    request_count?: number;
    result_count?: number;
    raw_result_count?: number;
    unique_result_count?: number;
    estimated_cost_usd?: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

export interface ProviderCallContext extends ProviderCostRunCallbacks {
    requestId?: string;
    resumeRunId?: string;
    logicalProvider?: Extract<ProviderName, 'apify' | 'coderx'>;
    actorId?: string;
    credentialSlot?: ApifyCredentialSlot;
    maxChargeUsd?: number;
    startReserved?: boolean;
    invocationWaitLimitSecs?: number;
    invocationDeadlineAtMs?: number;
    /** Internal request fence checked only before a new paid provider run is reserved. */
    startCancellationSignal?: AbortSignal;
    onBeforeRunStart?(input: {
        logicalProvider: Extract<ProviderName, 'apify' | 'coderx'>;
        actorId: string;
        credentialSlot: ApifyCredentialSlot;
        maxChargeUsd: number;
    }): void | Promise<void>;
    onRunStarted?(runId: string): void | Promise<void>;
    onProfileStart?(username: string): void | Promise<void>;
    onProfileResolved?(): void | Promise<void>;
    recordUsage(delta: ProviderUsageDelta): void;
}

export type ProfileAttemptProvider = Extract<ProfileFetchSource, 'selfhosted' | 'apify'>;
export type ProfileAttemptSuccessOutcome = Extract<ProfileFetchOutcome, { status: 'success' }>;
export type ProfileAttemptUnavailableOutcome = Extract<
    ProfileFetchOutcome,
    { status: 'unavailable' }
>;
export type ProfileAttemptFailedOutcome = Extract<ProfileFetchOutcome, { status: 'failed' }>;

/**
 * One terminal result for one requested username in one provider attempt. Profiles are
 * carried only on success; the persistence layer can store telemetry and profile data atomically.
 */
export type ProfileAttemptResult =
    | { outcome: ProfileAttemptSuccessOutcome; profile: InstagramProfile }
    | { outcome: ProfileAttemptUnavailableOutcome }
    | { outcome: ProfileAttemptFailedOutcome };

/**
 * 스크래핑 프로바이더. 각 프로바이더는 지원하는 기능만 구현한다.
 * (예: rapidapi는 getFollowing만, selfhosted는 getProfile/getProfilesBatch만)
 */
export interface ScraperProvider {
    readonly name: ProviderName;
    readonly paid?: boolean;
    /**
     * Lightweight identity/count contract. It deliberately does not parse timeline media, so
     * checkout admission cannot fail because a post or carousel snapshot is incomplete.
     */
    getProfileSummary?(
        username: string,
        context?: ProviderCallContext
    ): Promise<InstagramProfile | null>;
    getProfile?(username: string, context?: ProviderCallContext): Promise<InstagramProfile | null>;
    getFollowers?(
        username: string,
        limit: number,
        context?: ProviderCallContext
    ): Promise<InstagramFollower[]>;
    getFollowing?(
        username: string,
        limit: number,
        context?: ProviderCallContext
    ): Promise<InstagramFollower[]>;
    getProfilesBatch?(
        usernames: string[],
        batchSize?: number,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]>;
    getProfilesBatchOutcomes?(
        usernames: string[],
        batchSize?: number,
        context?: ProviderCallContext
    ): Promise<ProfileAttemptResult[]>;
}
