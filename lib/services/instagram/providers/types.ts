import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

export type Capability = 'profile' | 'profilesBatch' | 'followers' | 'following';

export type ProviderName = 'apify' | 'coderx' | 'flashapi' | 'rapidapi' | 'selfhosted';
export type InteractionProviderName = 'apify' | 'disabled';
export type ApifyCredentialSlot = 'primary' | 'secondary';
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
    onBeforeRunStart?(input: {
        logicalProvider: Extract<ProviderName, 'apify' | 'coderx'>;
        actorId: string;
        credentialSlot: ApifyCredentialSlot;
        maxChargeUsd: number;
    }): void | Promise<void>;
    onRunStarted?(runId: string): void | Promise<void>;
    recordUsage(delta: ProviderUsageDelta): void;
}

/**
 * 스크래핑 프로바이더. 각 프로바이더는 지원하는 기능만 구현한다.
 * (예: rapidapi는 getFollowing만, selfhosted는 getProfile/getProfilesBatch만)
 */
export interface ScraperProvider {
    readonly name: ProviderName;
    readonly paid?: boolean;
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
}
