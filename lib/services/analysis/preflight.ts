import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    analysisV2ErrorCodeSchema,
    planAccessModeSchema,
    planIdSchema,
    planQuoteV1Schema,
    preflightAcceptedV1Schema,
    preflightStatusV1Schema,
    type AnalysisV2ErrorCode,
    type PlanQuoteV1,
    type PreflightAcceptedV1,
    type PreflightExclusionDecisionV1,
    type PreflightStatusV1,
} from '@/lib/contracts/analysis-v2';
import {
    ANALYSIS_PLAN_CATALOG,
    PLAN_IDS,
    PLAN_LAUNCH_STATUSES,
    PLAN_PRICING_VERSION,
    buildPlanSelectionCards,
    determinePlanEligibility,
    type PlanAccessMode,
    type PlanEligibilityCatalog,
    type PlanId,
} from '@/lib/domain/analysis/plan-catalog';
import {
    isPaidEarlybirdPlanId,
    type PaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import { CURRENT_ANALYSIS_PIPELINE_VERSION } from '@/lib/domain/analysis/pipeline-version';
import { RISK_POLICY_VERSION } from '@/lib/domain/analysis/risk-policy';
import { selectAiStagePolicyVersion } from '@/lib/services/ai/stage-policy';
import {
    selectAiSchedulerPolicyVersion,
    type AiSchedulerPolicyVersion,
} from '@/lib/services/ai/scheduler-policy';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
} from './test-entitlement';
import { getSelfHostedProfileSummary } from '@/lib/services/instagram/providers/selfhosted';
import { getApifyProfileSummary } from '@/lib/services/instagram/providers/apify';
import { selectAnalysisV2ApifyCredentialSlot } from '@/lib/services/instagram/providers/apify-relationship';
import {
    classifyWebProfileFailure,
    type WebProfileFailureKind,
} from '@/lib/services/instagram/providers/selfhosted/web-client';
import { isInstagramUsername } from '@/lib/services/instagram/username';
import {
    canonicalizeImageProxyUrl,
    createImageProxyPath,
} from '@/lib/services/media/image-proxy-token';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ProviderRunCheckpoint } from '@/lib/services/instagram/providers/types';
import {
    PREFLIGHT_PROVIDER_DEADLINE_MS,
    PREFLIGHT_WORKER_LEASE_SECONDS,
    assertPreflightRuntimePolicy,
} from './preflight-runtime-policy';
import {
    bindPreflightProviderRunCheckpoint,
    preflightProviderIdentity,
    preflightProviderRunStore,
    type PreflightProviderRunStore,
} from './preflight-provider-run';
import { preflightTargetInputHash } from './preflight-identity';
import {
    BETA_APIFY_POOL_CAPACITY_ERROR,
    type BetaApifyPreflightCoordinator,
} from './beta-apify-preflight-coordinator';
import { shouldAbortPipelineBeforeExecution } from './pipeline-retry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const PREFLIGHT_DATABASE_NAMES = Object.freeze({
    table: 'analysis_preflights',
    createOrReplayRpc: 'create_or_replay_analysis_v2_preflight',
    createOrReplayBetaRpc: 'create_or_replay_analysis_v2_betatest_preflight',
    markBetaPrepareDispatchedRpc: 'mark_analysis_beta_preflight_prepare_dispatched',
    markBetaPrepareRetryExhaustedRpc:
        'mark_analysis_beta_preflight_prepare_retry_exhausted',
    claimBetaPrepareRpc: 'claim_analysis_beta_preflight_prepare',
    releaseBetaPrepareClaimRpc: 'release_analysis_beta_preflight_prepare_claim',
    blockBetaPrepareCapacityRpc: 'block_analysis_beta_preflight_capacity',
    claimRpc: 'claim_analysis_v2_preflight',
    reserveDispatchRpc: 'reserve_analysis_v2_preflight_dispatch',
    markDispatchedRpc: 'mark_analysis_v2_preflight_dispatched',
    releaseClaimRpc: 'release_analysis_preflight_claim',
    completeRpc: 'complete_analysis_v2_preflight',
    blockRpc: 'block_analysis_v2_preflight',
    exclusionRpc: 'set_analysis_v2_preflight_exclusion',
});

export type PreflightPolicyVersionsSnapshot = Readonly<{
    pipeline: typeof CURRENT_ANALYSIS_PIPELINE_VERSION;
    risk: typeof RISK_POLICY_VERSION;
    aiStage: ReturnType<typeof selectAiStagePolicyVersion>;
    scheduler?: AiSchedulerPolicyVersion;
}>;

export function preflightPolicyVersions(accessMode: PlanAccessMode): PreflightPolicyVersionsSnapshot {
    const legacySnapshot = Object.freeze({
        pipeline: CURRENT_ANALYSIS_PIPELINE_VERSION,
        risk: RISK_POLICY_VERSION,
        aiStage: selectAiStagePolicyVersion({
            rolloutMode: process.env.ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT,
            narrativeV28RolloutMode: process.env.ANALYSIS_V2_NARRATIVE_V28_ROLLOUT,
            microbatchV29RolloutMode: process.env.ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT,
            genderSummaryQualityV211RolloutMode:
                process.env.ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT,
            accessMode,
        }),
    });
    const scheduler = selectAiSchedulerPolicyVersion({
        rolloutMode: process.env.ANALYSIS_V2_AI_SCHEDULER_ROLLOUT,
        accessMode,
    });
    return scheduler
        ? Object.freeze({ ...legacySnapshot, scheduler })
        : legacySnapshot;
}

export type PreflightAuthProvider = 'google' | 'kakao';
export type ExclusionDecision = 'exclude' | 'skip';

export interface CreatePreflightInput {
    userId: string;
    email: string;
    authProvider: PreflightAuthProvider;
    targetInstagramId: string;
    idempotencyKey: string;
    accessMode: PlanAccessMode;
}

export interface CreatedPreflight {
    preflightId: string;
    expiresAt: string;
    created: boolean;
    status: 'pending' | 'processing' | 'ready' | 'blocked' | 'expired' | 'consumed';
}

export interface CreatedBetaPreflight extends CreatedPreflight {
    prepareGeneration: number;
    prepareToken: string;
    deliveryRetryCount?: number | null;
    shouldEnqueue: boolean;
}

export type BetaPrepareState =
    | 'reserved'
    | 'preparing'
    | 'prepared'
    | 'capacity_blocked'
    | 'retry_exhausted'
    | 'expired'
    | 'missing';

export interface BetaPrepareClaim {
    claimed: boolean;
    state: BetaPrepareState;
    claimToken: string | null;
    disposition: 'claimed' | 'stale' | 'busy' | 'terminal' | 'missing' | 'exhausted';
}

export interface ClaimedPreflight {
    preflightId: string;
    claimToken: string;
    userId: string;
    targetInstagramId: string;
    accessMode: PlanAccessMode;
    /** Set only by the database claim contract; public creation remains standard-only. */
    analysisEntryChannel?: 'standard' | 'betatest';
    workerAttemptCount: number;
    catalogSnapshot: PreflightCatalogSnapshot;
}

export interface PreflightWorkerFailureClassification {
    category: WebProfileFailureKind
        | 'configuration'
        | 'persistence'
        | 'provider'
        | 'run_pending'
        | 'unknown';
    retryable: boolean;
    httpStatus: number | null;
    workerAttemptCount: number | null;
}

interface PreflightProcessObservationBase {
    preflightId: string;
    userId: string;
    targetInstagramId: string;
    followersCount?: number;
    followingCount?: number;
}

type PreflightBusinessBlockedCode = Exclude<AnalysisV2ErrorCode, 'ANALYSIS_FAILED'>;

export type PreflightProcessObservation =
    | (PreflightProcessObservationBase & {
        type: 'profile_collected';
    })
    | (PreflightProcessObservationBase & {
        type: 'completed';
        outcome: 'ready';
        requiredPlan: PlanId;
        errorCode?: never;
        failureCategory?: never;
    })
    | (PreflightProcessObservationBase & {
        type: 'completed';
        outcome: 'blocked';
        requiredPlan?: never;
        errorCode: PreflightBusinessBlockedCode;
        failureCategory?: never;
    })
    | (PreflightProcessObservationBase & {
        type: 'completed';
        outcome: 'blocked';
        requiredPlan?: never;
        errorCode: 'ANALYSIS_FAILED';
        failureCategory: PreflightWorkerFailureClassification['category'];
    })
    | (PreflightProcessObservationBase & {
        type: 'failed';
        category: PreflightWorkerFailureClassification['category'];
        retryable: boolean;
        httpStatus: number | null;
        workerAttemptCount: number;
    });

export type PreflightProcessObserver = (observation: PreflightProcessObservation) => void;

export class PreflightWorkerRetryError extends Error {
    readonly classification: PreflightWorkerFailureClassification;

    constructor(
        classification: Omit<PreflightWorkerFailureClassification, 'workerAttemptCount'>,
        workerAttemptCount: number | null,
        cause?: unknown
    ) {
        super('PREFLIGHT_WORKER_RETRY', { cause });
        this.name = 'PreflightWorkerRetryError';
        this.classification = Object.freeze({ ...classification, workerAttemptCount });
    }
}

export function classifyPreflightWorkerFailure(
    error: unknown
): PreflightWorkerFailureClassification {
    if (error instanceof PreflightWorkerRetryError) return error.classification;
    return Object.freeze({
        category: 'unknown',
        retryable: true,
        httpStatus: null,
        workerAttemptCount: null,
    });
}

function notifyPreflightObserver(
    observer: PreflightProcessObserver | undefined,
    observation: PreflightProcessObservation,
): void {
    try {
        observer?.(Object.freeze({ ...observation }));
    } catch {
        // Operational observation must never change preflight behavior.
    }
}

export interface PreflightCatalogSnapshot {
    plans: PlanEligibilityCatalog;
    pricingVersion: string;
    prices: Record<PlanId, PlanQuoteV1['price']>;
}

export interface ReadyPreflightSnapshot {
    target: {
        username: string;
        fullName: string | null;
        bio: string | null;
        profileImageUrl: string | null;
        followersCount: number;
        followingCount: number;
        isPrivate: false;
    };
    accessMode: PlanAccessMode;
    capacityRequiredPlan: PlanId;
    requiredPlan: PlanId;
    plans: Array<{
        planId: PlanId;
        launchStatus: 'production' | 'test_only' | 'disabled';
        relationshipCapacity: { followers: number; following: number };
        detailedMutualLimit: number;
        selectionState: 'required' | 'available_upgrade' | 'unavailable';
        unavailableReason: 'below_required_plan' | 'launch_gate' | null;
        pricingVersion: string;
        price: PlanQuoteV1['price'];
    }>;
    pricingVersion: string;
}

const readyPreflightSnapshotSchema = z.object({
    target: z.object({
        username: z.string().min(1).max(30).regex(/^[A-Za-z0-9._]+$/),
        fullName: z.string().max(200).nullable(),
        bio: z.string().max(2_200).nullable(),
        profileImageUrl: z.string().url().max(8_192).nullable(),
        followersCount: z.number().int().nonnegative(),
        followingCount: z.number().int().nonnegative(),
        isPrivate: z.literal(false),
    }).strict(),
    accessMode: planAccessModeSchema,
    capacityRequiredPlan: planIdSchema,
    requiredPlan: planIdSchema,
    plans: z.array(planQuoteV1Schema).length(PLAN_IDS.length),
    pricingVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

const planDefinitionSchema = z.object({
    launchStatus: z.enum(PLAN_LAUNCH_STATUSES),
    relationshipCapacity: z.object({
        followers: z.number().int().positive(),
        following: z.number().int().positive(),
    }).strict(),
    detailedMutualLimit: z.number().int().positive(),
}).strict();

const planCatalogSnapshotSchema = z.object({
    basic: planDefinitionSchema,
    standard: planDefinitionSchema,
    plus: planDefinitionSchema,
}).strict();

const boundedPriceSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('deferred'),
        currency: z.literal('KRW'),
        amountKrw: z.null(),
    }).strict(),
    z.object({
        status: z.literal('quoted'),
        currency: z.literal('KRW'),
        amountKrw: z.number().int().positive().max(1_000_000_000),
    }).strict(),
]);

const pricingSnapshotSchema = z.object({
    basic: boundedPriceSchema,
    standard: boundedPriceSchema,
    plus: boundedPriceSchema,
}).strict();

export interface StoredPreflight {
    preflightId: string;
    status: 'pending' | 'processing' | 'ready' | 'blocked' | 'expired' | 'consumed';
    expiresAt: string;
    blockedCode: AnalysisV2ErrorCode | null;
    readySnapshot: ReadyPreflightSnapshot | null;
    exclusionDecision: PreflightExclusionDecisionV1;
}

export interface PreflightStore {
    createOrReplay(input: CreatePreflightInput): Promise<CreatedPreflight>;
    findForOwner(preflightId: string, userId: string): Promise<StoredPreflight | null>;
    claim(preflightId: string): Promise<ClaimedPreflight | null>;
    reserveDispatch(preflightId: string, userId: string): Promise<{
        shouldEnqueue: boolean;
        generation: number;
        reservationToken: string | null;
        status: CreatedPreflight['status'];
    }>;
    markDispatched(input: {
        preflightId: string;
        userId: string;
        generation: number;
        reservationToken: string;
    }): Promise<void>;
    releaseClaim(claim: ClaimedPreflight): Promise<void>;
    finalizeReady(claim: ClaimedPreflight, snapshot: ReadyPreflightSnapshot): Promise<void>;
    finalizeBlocked(claim: ClaimedPreflight, code: AnalysisV2ErrorCode): Promise<void>;
    blockQueueUnavailable(preflightId: string, userId: string): Promise<void>;
    setExclusion(input: {
        preflightId: string;
        userId: string;
        decision: ExclusionDecision;
        excludedInstagramId: string | null;
    }): Promise<void>;
}

export interface BetaPreflightEntryStore {
    createOrReplayBeta(
        input: Omit<CreatePreflightInput, 'accessMode'>
    ): Promise<CreatedBetaPreflight>;
    markBetaPrepareDispatched(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
    }): Promise<void>;
    hasBetaEntryProvenance(preflightId: string, userId: string): Promise<boolean>;
}

export interface BetaPreflightPrepareStore {
    claimBetaPrepare(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
    }): Promise<BetaPrepareClaim>;
    markBetaPrepareRetryExhausted(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
    }): Promise<boolean>;
    releaseBetaPrepareClaim(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
        claimToken: string;
    }): Promise<boolean>;
    blockBetaPrepareCapacity(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
        claimToken: string | null;
    }): Promise<'blocked' | 'prepared' | 'retry_exhausted' | 'expired'>;
    reserveDispatch: PreflightStore['reserveDispatch'];
    markDispatched: PreflightStore['markDispatched'];
}

export type SupabasePreflightStore = PreflightStore
    & BetaPreflightEntryStore
    & BetaPreflightPrepareStore;

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

interface OwnerQuery {
    select(columns: string): OwnerQuery;
    eq(column: string, value: string): OwnerQuery;
    maybeSingle(): PromiseLike<RpcResult>;
}

interface PreflightSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
    from(table: string): OwnerQuery;
}

export class PreflightIdempotencyConflictError extends Error {
    constructor() {
        super('PREFLIGHT_IDEMPOTENCY_CONFLICT');
        this.name = 'PreflightIdempotencyConflictError';
    }
}

export class PreflightRateLimitedError extends Error {
    constructor() {
        super('PREFLIGHT_RATE_LIMITED');
        this.name = 'PreflightRateLimitedError';
    }
}

export class BetaPreflightAccessUnavailableError extends Error {
    constructor() {
        super('BETA_PREFLIGHT_ACCESS_UNAVAILABLE');
        this.name = 'BetaPreflightAccessUnavailableError';
    }
}

export class PreflightNotFoundError extends Error {
    constructor() {
        super('PREFLIGHT_NOT_FOUND');
        this.name = 'PreflightNotFoundError';
    }
}

export class PreflightImmutableError extends Error {
    constructor(message = 'PREFLIGHT_IMMUTABLE') {
        super(message);
        this.name = 'PreflightImmutableError';
    }
}

export class PreflightExpiredError extends Error {
    constructor() {
        super('PREFLIGHT_EXPIRED');
        this.name = 'PreflightExpiredError';
    }
}

export class PreflightConsumedError extends Error {
    constructor() {
        super('PREFLIGHT_CONSUMED');
        this.name = 'PreflightConsumedError';
    }
}

export class PreflightLeaseBusyError extends Error {
    constructor() {
        super('PREFLIGHT_LEASE_BUSY');
        this.name = 'PreflightLeaseBusyError';
    }
}

export class InvalidPreflightExclusionError extends Error {
    constructor() {
        super('PREFLIGHT_INVALID_EXCLUSION');
        this.name = 'InvalidPreflightExclusionError';
    }
}

function rpcRow(data: unknown, label: string): Record<string, unknown> | null {
    if (Array.isArray(data)) {
        if (data.length === 0) return null;
        if (data.length !== 1 || !data[0] || typeof data[0] !== 'object') {
            throw new Error(`PREFLIGHT_PERSISTENCE_ERROR: invalid ${label} result.`);
        }
        return data[0] as Record<string, unknown>;
    }
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    if (data === null) return null;
    throw new Error(`PREFLIGHT_PERSISTENCE_ERROR: invalid ${label} result.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function launchStatusSnapshot(): Record<PlanId, 'production' | 'test_only' | 'disabled'> {
    return Object.fromEntries(PLAN_IDS.map(planId => [
        planId,
        ANALYSIS_PLAN_CATALOG[planId].launchStatus,
    ])) as Record<PlanId, 'production' | 'test_only' | 'disabled'>;
}

function pricingSnapshot(): Record<PlanId, ReadyPreflightSnapshot['plans'][number]['price']> {
    return Object.fromEntries(PLAN_IDS.map(planId => [
        planId,
        { ...ANALYSIS_PLAN_CATALOG[planId].price },
    ])) as Record<PlanId, ReadyPreflightSnapshot['plans'][number]['price']>;
}

function planCatalogSnapshot(): PlanEligibilityCatalog {
    return Object.fromEntries(PLAN_IDS.map(planId => {
        const plan = ANALYSIS_PLAN_CATALOG[planId];
        return [planId, {
            launchStatus: plan.launchStatus,
            relationshipCapacity: { ...plan.relationshipCapacity },
            detailedMutualLimit: plan.detailedMutualLimit,
        }];
    })) as PlanEligibilityCatalog;
}

function currentPreflightCatalogSnapshot(): PreflightCatalogSnapshot {
    return {
        plans: planCatalogSnapshot(),
        pricingVersion: PLAN_PRICING_VERSION,
        prices: pricingSnapshot(),
    };
}

function planCardsSnapshot(
    snapshot: ReadyPreflightSnapshot
): Record<PlanId, Omit<
    ReadyPreflightSnapshot['plans'][number],
    'planId' | 'pricingVersion' | 'price'
>> {
    return Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
        launchStatus: plan.launchStatus,
        relationshipCapacity: plan.relationshipCapacity,
        detailedMutualLimit: plan.detailedMutualLimit,
        selectionState: plan.selectionState,
        unavailableReason: plan.unavailableReason,
    }])) as Record<PlanId, Omit<
        ReadyPreflightSnapshot['plans'][number],
        'planId' | 'pricingVersion' | 'price'
    >>;
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (
        error.message === 'ANALYSIS_BETA_ACCESS_UNAVAILABLE'
        || error.message?.startsWith('ANALYSIS_BETA_ACCESS_UNAVAILABLE ') === true
        || error.message?.startsWith('ANALYSIS_BETA_ACCESS_UNAVAILABLE\n') === true
    ) {
        throw new BetaPreflightAccessUnavailableError();
    }
    if (
        error.message === 'PREFLIGHT_IDEMPOTENCY_CONFLICT'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT'
    ) {
        throw new PreflightIdempotencyConflictError();
    }
    if (error.message === 'ANALYSIS_V2_PREFLIGHT_RATE_LIMITED') {
        throw new PreflightRateLimitedError();
    }
    if (
        error.message === 'PREFLIGHT_NOT_FOUND'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND'
    ) throw new PreflightNotFoundError();
    if (
        error.message === 'PREFLIGHT_INVALID_EXCLUSION'
        || error.message === 'ANALYSIS_V2_INVALID_EXCLUSION'
    ) {
        throw new InvalidPreflightExclusionError();
    }
    if (
        error.message === 'PREFLIGHT_EXPIRED'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_EXPIRED'
        || error.message === 'PREFLIGHT_CONSUMED'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_CONSUMED'
        || error.message === 'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        || error.message === 'PREFLIGHT_IMMUTABLE'
    ) {
        throw new PreflightImmutableError(error.message);
    }
    throw new Error(
        `PREFLIGHT_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

function requiredUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new Error(`PREFLIGHT_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value.toLowerCase();
}

function requiredTimestamp(value: unknown): string {
    if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid expiry.');
    }
    return value;
}

function requiredAccessMode(value: unknown): PlanAccessMode {
    if (value !== 'production' && value !== 'test_entitlement') {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid access mode.');
    }
    return value;
}

function requiredUsername(value: unknown): string {
    if (typeof value !== 'string' || !isInstagramUsername(value.toLowerCase())) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid target username.');
    }
    return value.toLowerCase();
}

function requiredWorkerAttemptCount(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 7) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid worker attempt count.');
    }
    return value as number;
}

function nullableBoundedString(value: unknown, maximum: number, field: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.length > maximum) {
        throw new Error(`PREFLIGHT_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value;
}

function readySnapshotFromColumns(row: Record<string, unknown>): ReadyPreflightSnapshot {
    if (
        !isRecord(row.launch_status_snapshot)
        || !isRecord(row.plan_cards_snapshot)
        || !isRecord(row.pricing_snapshot)
    ) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid catalog snapshots.');
    }
    const launchStatuses = row.launch_status_snapshot;
    const cards = row.plan_cards_snapshot;
    const prices = row.pricing_snapshot;
    const pricingVersion = row.pricing_version;
    if (typeof pricingVersion !== 'string') {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid pricing version.');
    }

    const plans = PLAN_IDS.map(planId => {
        const card = cards[planId];
        const price = prices[planId];
        if (!isRecord(card) || !isRecord(price) || launchStatuses[planId] !== card.launchStatus) {
            throw new Error('PREFLIGHT_PERSISTENCE_ERROR: inconsistent plan snapshots.');
        }
        return {
            planId,
            ...card,
            pricingVersion,
            price,
        };
    });

    return readyPreflightSnapshotSchema.parse({
        target: {
            username: requiredUsername(row.target_instagram_id),
            fullName: nullableBoundedString(row.target_full_name, 200, 'target full name'),
            bio: nullableBoundedString(row.target_bio, 2_200, 'target bio'),
            profileImageUrl: nullableBoundedString(
                row.target_profile_image_url,
                8_192,
                'target profile image'
            ),
            followersCount: row.target_followers_count,
            followingCount: row.target_following_count,
            isPrivate: row.target_is_private,
        },
        accessMode: row.access_mode,
        capacityRequiredPlan: row.capacity_required_plan_id,
        requiredPlan: row.required_plan_id,
        plans,
        pricingVersion,
    }) as ReadyPreflightSnapshot;
}

function storedPreflightFromRow(row: Record<string, unknown>): StoredPreflight {
    const status = row.status;
    if (![
        'pending',
        'processing',
        'ready',
        'blocked',
        'expired',
        'consumed',
    ].includes(String(status))) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid preflight status.');
    }
    const blockedCode = row.error_code === null || row.error_code === undefined
        ? null
        : analysisV2ErrorCodeSchema.parse(row.error_code);
    const readySnapshot = status === 'ready' || status === 'consumed'
        ? readySnapshotFromColumns(row)
        : null;
    const exclusionDecision = row.exclusion_decision;
    if (
        exclusionDecision !== 'pending'
        && exclusionDecision !== 'exclude'
        && exclusionDecision !== 'skip'
    ) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid exclusion decision.');
    }
    return {
        preflightId: requiredUuid(row.id, 'preflight id'),
        status: status as StoredPreflight['status'],
        expiresAt: requiredTimestamp(row.expires_at),
        blockedCode,
        readySnapshot,
        exclusionDecision,
    };
}

export function createSupabasePreflightStore(
    client: PreflightSupabaseClient
): SupabasePreflightStore {
    return {
        async createOrReplay(input) {
            const { data, error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.createOrReplayRpc, {
                p_user_id: input.userId,
                p_email: input.email,
                p_auth_provider: input.authProvider,
                p_target_instagram_id: input.targetInstagramId,
                p_idempotency_key: input.idempotencyKey,
                p_access_mode: input.accessMode,
                p_launch_status_snapshot: launchStatusSnapshot(),
                p_plan_catalog_snapshot: planCatalogSnapshot(),
                p_pricing_version: PLAN_PRICING_VERSION,
                p_pricing_snapshot: pricingSnapshot(),
                p_policy_versions_snapshot: preflightPolicyVersions(input.accessMode),
            });
            if (error) throwRpcError(error, 'create');
            const row = rpcRow(data, 'create');
            if (!row || typeof row.created !== 'boolean') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid create result.');
            }
            const status = row.preflight_status;
            if (![
                'pending',
                'processing',
                'ready',
                'blocked',
                'expired',
                'consumed',
            ].includes(String(status))) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid create status.');
            }
            return {
                preflightId: requiredUuid(row.preflight_id, 'preflight id'),
                expiresAt: requiredTimestamp(row.expires_at),
                created: row.created,
                status: status as CreatedPreflight['status'],
            };
        },

        async createOrReplayBeta(input) {
            const proposedPrepareToken = randomUUID();
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.createOrReplayBetaRpc,
                {
                    p_user_id: input.userId,
                    p_email: input.email,
                    p_auth_provider: input.authProvider,
                    p_target_instagram_id: input.targetInstagramId,
                    p_idempotency_key: input.idempotencyKey,
                    p_launch_status_snapshot: launchStatusSnapshot(),
                    p_plan_catalog_snapshot: planCatalogSnapshot(),
                    p_pricing_version: PLAN_PRICING_VERSION,
                    p_pricing_snapshot: pricingSnapshot(),
                    p_policy_versions_snapshot: preflightPolicyVersions('production'),
                    p_beta_prepare_token: proposedPrepareToken,
                }
            );
            if (error) throwRpcError(error, 'beta create');
            const row = rpcRow(data, 'beta create');
            const status = row?.preflight_status;
            if (
                !row
                || typeof row.created !== 'boolean'
                || typeof row.should_enqueue !== 'boolean'
                || !Number.isSafeInteger(row.prepare_generation)
                || (row.prepare_generation as number) < 1
                || (row.prepare_generation as number) > 100
                || ![
                    'pending', 'processing', 'ready', 'blocked', 'expired', 'consumed',
                ].includes(String(status))
            ) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid beta create result.');
            }
            return {
                preflightId: requiredUuid(row.preflight_id, 'preflight id'),
                expiresAt: requiredTimestamp(row.expires_at),
                created: row.created,
                status: status as CreatedPreflight['status'],
                prepareGeneration: row.prepare_generation as number,
                prepareToken: requiredUuid(row.prepare_token, 'beta prepare token'),
                shouldEnqueue: row.should_enqueue,
            };
        },

        async markBetaPrepareDispatched(input) {
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.markBetaPrepareDispatchedRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_prepare_generation: input.prepareGeneration,
                    p_prepare_token: input.prepareToken,
                }
            );
            if (error) throwRpcError(error, 'beta prepare dispatch mark');
            if (typeof data !== 'boolean') {
                throw new Error(
                    'PREFLIGHT_PERSISTENCE_ERROR: invalid beta prepare dispatch mark.'
                );
            }
        },

        async markBetaPrepareRetryExhausted(input) {
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.markBetaPrepareRetryExhaustedRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_prepare_generation: input.prepareGeneration,
                    p_prepare_token: input.prepareToken,
                }
            );
            if (error) throwRpcError(error, 'beta prepare retry exhaustion');
            if (typeof data !== 'boolean') {
                throw new Error(
                    'PREFLIGHT_PERSISTENCE_ERROR: invalid beta retry exhaustion result.'
                );
            }
            return data;
        },

        async claimBetaPrepare(input) {
            const claimToken = randomUUID();
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.claimBetaPrepareRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_prepare_generation: input.prepareGeneration,
                    p_prepare_token: input.prepareToken,
                    p_claim_token: claimToken,
                    p_lease_seconds: PREFLIGHT_WORKER_LEASE_SECONDS,
                }
            );
            if (error) throwRpcError(error, 'beta prepare claim');
            const row = rpcRow(data, 'beta prepare claim');
            const state = z.enum([
                'reserved', 'preparing', 'prepared', 'capacity_blocked',
                'retry_exhausted', 'expired', 'missing',
            ]).safeParse(row?.prepare_state);
            const disposition = z.enum([
                'claimed', 'stale', 'busy', 'terminal', 'missing', 'exhausted',
            ]).safeParse(row?.claim_disposition);
            if (
                !row
                || typeof row.claimed !== 'boolean'
                || !state.success
                || !disposition.success
            ) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid beta prepare claim.');
            }
            if (
                row.claimed
                && (state.data !== 'preparing' || disposition.data !== 'claimed')
            ) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid beta prepare claim.');
            }
            return {
                claimed: row.claimed,
                state: state.data,
                claimToken: row.claimed ? claimToken : null,
                disposition: disposition.data,
            };
        },

        async releaseBetaPrepareClaim(input) {
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.releaseBetaPrepareClaimRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_prepare_generation: input.prepareGeneration,
                    p_prepare_token: input.prepareToken,
                    p_claim_token: input.claimToken,
                }
            );
            if (error) throwRpcError(error, 'beta prepare claim release');
            if (typeof data !== 'boolean') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid beta claim release.');
            }
            return data;
        },

        async blockBetaPrepareCapacity(input) {
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.blockBetaPrepareCapacityRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_prepare_generation: input.prepareGeneration,
                    p_prepare_token: input.prepareToken,
                    p_claim_token: input.claimToken,
                }
            );
            if (error) throwRpcError(error, 'beta prepare capacity block');
            if (
                data !== 'blocked'
                && data !== 'prepared'
                && data !== 'retry_exhausted'
                && data !== 'expired'
            ) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid beta capacity block.');
            }
            return data;
        },

        async findForOwner(preflightId, userId) {
            const query = client.from(PREFLIGHT_DATABASE_NAMES.table);
            const { data, error } = await query
                .select(`
                    id,
                    status,
                    expires_at,
                    error_code,
                    target_instagram_id,
                    target_full_name,
                    target_bio,
                    target_profile_image_url,
                    target_followers_count,
                    target_following_count,
                    target_is_private,
                    access_mode,
                    launch_status_snapshot,
                    capacity_required_plan_id,
                    required_plan_id,
                    plan_cards_snapshot,
                    pricing_version,
                    pricing_snapshot,
                    exclusion_decision
                `)
                .eq('id', preflightId)
                .eq('user_id', userId)
                .maybeSingle();
            if (error) throwRpcError(error, 'read');
            const row = rpcRow(data, 'read');
            return row ? storedPreflightFromRow(row) : null;
        },

        async hasBetaEntryProvenance(preflightId, userId) {
            const query = client.from(PREFLIGHT_DATABASE_NAMES.table);
            const { data, error } = await query
                .select('beta_entry_provenance')
                .eq('id', preflightId)
                .eq('user_id', userId)
                .maybeSingle();
            if (error) throwRpcError(error, 'beta provenance read');
            const row = rpcRow(data, 'beta provenance read');
            if (!row) return false;
            return row.beta_entry_provenance === 'betatest_service_v1'
                || row.beta_entry_provenance === 'legacy_betatest_v1';
        },

        async reserveDispatch(preflightId, userId) {
            const proposedToken = randomUUID();
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.reserveDispatchRpc,
                {
                    p_preflight_id: preflightId,
                    p_user_id: userId,
                    p_dispatch_token: proposedToken,
                }
            );
            if (error) throwRpcError(error, 'dispatch reserve');
            const row = rpcRow(data, 'dispatch reserve');
            if (
                !row
                || typeof row.should_enqueue !== 'boolean'
                || !Number.isSafeInteger(row.dispatch_generation)
                || (row.dispatch_generation as number) < 0
                || (row.dispatch_generation as number) > 100
                || !['pending', 'processing', 'ready', 'blocked', 'expired', 'consumed']
                    .includes(String(row.preflight_status))
            ) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid dispatch reservation.');
            }
            const reservationToken = row.reservation_token === null
                ? null
                : requiredUuid(row.reservation_token, 'dispatch reservation token');
            if (row.should_enqueue && reservationToken === null) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: dispatch token is missing.');
            }
            return {
                shouldEnqueue: row.should_enqueue,
                generation: row.dispatch_generation as number,
                reservationToken,
                status: row.preflight_status as CreatedPreflight['status'],
            };
        },

        async markDispatched(input) {
            const { data, error } = await client.rpc(
                PREFLIGHT_DATABASE_NAMES.markDispatchedRpc,
                {
                    p_preflight_id: input.preflightId,
                    p_user_id: input.userId,
                    p_dispatch_generation: input.generation,
                    p_dispatch_token: input.reservationToken,
                }
            );
            if (error) throwRpcError(error, 'dispatch mark');
            if (typeof data !== 'boolean') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid dispatch mark result.');
            }
        },

        async claim(preflightId) {
            const claimToken = randomUUID();
            const { data, error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.claimRpc, {
                p_preflight_id: preflightId,
                p_claim_token: claimToken,
                p_lease_seconds: PREFLIGHT_WORKER_LEASE_SECONDS,
            });
            if (error) throwRpcError(error, 'claim');
            const row = rpcRow(data, 'claim');
            if (!row) return null;
            if (typeof row.claimed !== 'boolean') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid claim result.');
            }
            if (!row.claimed) {
                if (row.preflight_status === 'processing') {
                    throw new PreflightLeaseBusyError();
                }
                if (!['ready', 'blocked', 'expired', 'consumed'].includes(
                    String(row.preflight_status)
                )) {
                    throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid claim status.');
                }
                return null;
            }
            return {
                preflightId: requiredUuid(preflightId, 'preflight id'),
                claimToken,
                userId: requiredUuid(row.user_id, 'user id'),
                targetInstagramId: requiredUsername(row.target_instagram_id),
                accessMode: requiredAccessMode(row.access_mode),
                analysisEntryChannel: row.analysis_entry_channel === undefined
                    ? 'standard'
                    : z.enum(['standard', 'betatest']).parse(row.analysis_entry_channel),
                workerAttemptCount: requiredWorkerAttemptCount(row.worker_attempt_count),
                catalogSnapshot: {
                    plans: planCatalogSnapshotSchema.parse(row.plan_catalog_snapshot),
                    pricingVersion: z.string()
                        .min(1)
                        .max(64)
                        .regex(/^[A-Za-z0-9._:-]+$/)
                        .parse(row.pricing_version),
                    prices: pricingSnapshotSchema.parse(row.pricing_snapshot),
                },
            };
        },

        async releaseClaim(claim) {
            const { error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.releaseClaimRpc, {
                p_preflight_id: claim.preflightId,
                p_claim_token: claim.claimToken,
            });
            if (error) throwRpcError(error, 'claim release');
        },

        async finalizeReady(claim, snapshot) {
            const { error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.completeRpc, {
                p_preflight_id: claim.preflightId,
                p_user_id: claim.userId,
                p_claim_token: claim.claimToken,
                p_target_full_name: snapshot.target.fullName,
                p_target_bio: snapshot.target.bio,
                p_target_profile_image_url: snapshot.target.profileImageUrl,
                p_target_followers_count: snapshot.target.followersCount,
                p_target_following_count: snapshot.target.followingCount,
                p_target_is_private: snapshot.target.isPrivate,
                p_capacity_required_plan_id: snapshot.capacityRequiredPlan,
                p_required_plan_id: snapshot.requiredPlan,
                p_plan_cards_snapshot: planCardsSnapshot(snapshot),
            });
            if (error) throwRpcError(error, 'ready finalize');
        },

        async finalizeBlocked(claim, code) {
            const { error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.blockRpc, {
                p_preflight_id: claim.preflightId,
                p_user_id: claim.userId,
                p_claim_token: claim.claimToken,
                p_error_code: code,
            });
            if (error) throwRpcError(error, 'blocked finalize');
        },

        async blockQueueUnavailable(preflightId, userId) {
            const { error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.blockRpc, {
                p_preflight_id: preflightId,
                p_user_id: userId,
                p_claim_token: null,
                p_error_code: 'QUEUE_UNAVAILABLE',
            });
            if (error) throwRpcError(error, 'queue unavailable block');
        },

        async setExclusion(input) {
            const { data, error } = await client.rpc(PREFLIGHT_DATABASE_NAMES.exclusionRpc, {
                p_preflight_id: input.preflightId,
                p_user_id: input.userId,
                p_decision: input.decision,
                p_excluded_instagram_id: input.excludedInstagramId,
            });
            if (error) throwRpcError(error, 'exclusion');
            if (typeof data !== 'boolean') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid exclusion result.');
            }
        },
    };
}

export const preflightStore = createSupabasePreflightStore(
    supabaseAdmin as unknown as PreflightSupabaseClient
);

function boundedText(value: string | undefined, maximum: number): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, maximum) : null;
}

function safeProfileImageUrl(value: string | undefined): string | null {
    if (!value || value.length > 8_192) return null;
    try {
        return canonicalizeImageProxyUrl(value);
    } catch {
        return null;
    }
}

function assertProfileCounts(profile: InstagramProfile): void {
    for (const [field, value] of [
        ['followersCount', profile.followersCount],
        ['followingCount', profile.followingCount],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`PREFLIGHT_PROFILE_ERROR: invalid ${field}.`);
        }
    }
}

export function buildReadyPreflightSnapshot(
    profile: InstagramProfile,
    accessMode: PlanAccessMode,
    catalogSnapshot: PreflightCatalogSnapshot = currentPreflightCatalogSnapshot()
): ReadyPreflightSnapshot | PreflightBusinessBlockedCode {
    assertProfileCounts(profile);
    const username = profile.username.toLowerCase();
    if (!isInstagramUsername(username)) return 'TARGET_UNSUPPORTED';
    if (profile.isPrivate) return 'TARGET_PRIVATE';

    const counts = {
        followers: profile.followersCount,
        following: profile.followingCount,
    };
    const eligibility = determinePlanEligibility(counts, {
        accessMode,
        catalog: catalogSnapshot.plans,
    });
    if (eligibility.status === 'blocked') {
        return eligibility.reason === 'over_plus_capacity'
            ? 'OVER_PLUS_CAPACITY'
            : 'TARGET_UNSUPPORTED';
    }

    const cards = buildPlanSelectionCards(counts, {
        accessMode,
        catalog: catalogSnapshot.plans,
    });
    return readyPreflightSnapshotSchema.parse({
        target: {
            username,
            fullName: boundedText(profile.fullName, 200),
            bio: boundedText(profile.bio, 2_200),
            profileImageUrl: safeProfileImageUrl(profile.profilePicUrl),
            followersCount: profile.followersCount,
            followingCount: profile.followingCount,
            isPrivate: false,
        },
        accessMode,
        capacityRequiredPlan: eligibility.capacityRequiredPlanId,
        requiredPlan: eligibility.requiredPlanId,
        plans: PLAN_IDS.map((planId, index) => {
            const plan = catalogSnapshot.plans[planId];
            const card = cards[index];
            return {
                planId,
                launchStatus: card.launchStatus,
                relationshipCapacity: { ...plan.relationshipCapacity },
                detailedMutualLimit: plan.detailedMutualLimit,
                selectionState: card.selectionState,
                unavailableReason: card.unavailableReason,
                pricingVersion: catalogSnapshot.pricingVersion,
                price: { ...catalogSnapshot.prices[planId] },
            };
        }),
        pricingVersion: catalogSnapshot.pricingVersion,
    }) as ReadyPreflightSnapshot;
}

export interface ClassifiedPreflightError {
    category: PreflightWorkerFailureClassification['category'];
    retryable: boolean;
    httpStatus: number | null;
    paidFallbackEligible: boolean;
}

const PREFLIGHT_FALLBACK_MAX_WAIT_SECONDS = 75;

export function classifyPreflightError(error: unknown): ClassifiedPreflightError {
    const webFailure = classifyWebProfileFailure(error);
    if (webFailure) return {
        category: webFailure.kind,
        retryable: webFailure.retryable,
        httpStatus: webFailure.httpStatus,
        paidFallbackEligible: true,
    };
    const message = error instanceof Error ? error.message : '';
    if (message === 'SCRAPING_PROVIDER_START_REJECTED_ERROR') {
        return {
            category: 'provider',
            retryable: false,
            httpStatus: null,
            paidFallbackEligible: false,
        };
    }
    if (message.startsWith('SCRAPING_RUN_PENDING_ERROR:')) {
        return {
            category: 'run_pending',
            retryable: true,
            httpStatus: null,
            paidFallbackEligible: false,
        };
    }
    if (
        message.startsWith('SCRAPING_CONFIG_ERROR:')
        || message.startsWith('PREFLIGHT_TASKS_CONFIG_ERROR:')
        || message.startsWith('SCRAPING_BUDGET_ERROR:')
    ) {
        return {
            category: 'configuration',
            retryable: false,
            httpStatus: null,
            paidFallbackEligible: false,
        };
    }
    if (
        message.startsWith('PREFLIGHT_PROVIDER_RUN_VALIDATION_ERROR')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_NOT_RESERVED')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_ALREADY_RESERVED')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid')
        || message.startsWith('PREFLIGHT_PERSISTENCE_ERROR: invalid')
    ) {
        return {
            category: 'persistence',
            retryable: false,
            httpStatus: null,
            paidFallbackEligible: false,
        };
    }
    if (
        message.startsWith('PREFLIGHT_PERSISTENCE_ERROR:')
        || message.startsWith('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR:')
        || message.startsWith('ANALYSIS_PERSISTENCE_ERROR:')
        || message === 'ANALYSIS_V2_PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR'
    ) {
        return {
            category: 'persistence',
            retryable: true,
            httpStatus: null,
            paidFallbackEligible: false,
        };
    }
    if (message.startsWith('SCRAPING_SCHEMA_ERROR:')) {
        return {
            category: 'schema',
            retryable: false,
            httpStatus: null,
            paidFallbackEligible: true,
        };
    }
    return {
        category: 'unknown',
        retryable: false,
        httpStatus: null,
        paidFallbackEligible: false,
    };
}

export function logPreflightProfileFallbackEntry(input: {
    operation: 'profile' | 'fresh_admission';
    failure: ClassifiedPreflightError;
    existingRun: boolean;
}): void {
    console.info(JSON.stringify({
        event: 'preflight_profile_fallback_entered',
        operation: input.operation,
        category: input.failure.category,
        httpStatus: input.failure.httpStatus,
        existingRun: input.existingRun,
    }));
}

function assertMatchingProfile(profile: InstagramProfile, username: string): void {
    if (profile.username.toLowerCase() !== username) {
        throw new Error('SCRAPING_SCHEMA_ERROR: provider summary username mismatch.');
    }
}

export function fallbackCallContext(
    checkpoint: ProviderRunCheckpoint,
    startedAt: number
) {
    const deadlineAtMs = startedAt + PREFLIGHT_PROVIDER_DEADLINE_MS;
    const remainingMs = Math.max(
        1_000,
        deadlineAtMs - Date.now()
    );
    return {
        ...checkpoint,
        invocationDeadlineAtMs: deadlineAtMs,
        invocationWaitLimitSecs: Math.min(
            PREFLIGHT_FALLBACK_MAX_WAIT_SECONDS,
            Math.max(1, Math.floor(remainingMs / 1_000))
        ),
        recordUsage: () => undefined,
    };
}

/**
 * Dedicated beta worker boundary. A preflight begins as standard; only the
 * coordinator's atomic hold may flip its persisted entry channel. Ordinary
 * dispatch is strictly later, so replay/crash cannot start a provider without
 * the durable hold.
 */
export async function prepareBetaPreflightDispatch(input: {
    preflightId: string;
    userId: string;
    prepareGeneration: number;
    prepareToken: string;
    deliveryRetryCount?: number | null;
    coordinator: BetaApifyPreflightCoordinator;
    store?: BetaPreflightPrepareStore;
    enqueue: (preflightId: string, generation: number) => Promise<'enqueued' | 'exists'>;
}): Promise<'prepared' | 'blocked' | 'noop'> {
    const store = input.store ?? preflightStore;
    if (shouldAbortPipelineBeforeExecution(input.deliveryRetryCount ?? null)) {
        const exhausted = await store.markBetaPrepareRetryExhausted({
            preflightId: input.preflightId,
            userId: input.userId,
            prepareGeneration: input.prepareGeneration,
            prepareToken: input.prepareToken,
        });
        if (exhausted) return 'noop';
    }
    const claim = await store.claimBetaPrepare({
        preflightId: input.preflightId,
        userId: input.userId,
        prepareGeneration: input.prepareGeneration,
        prepareToken: input.prepareToken,
    });
    if (!claim.claimed) {
        if (claim.state === 'capacity_blocked') return 'blocked';
        if (claim.state === 'retry_exhausted' || claim.state === 'expired') {
            return 'noop';
        }
        if (claim.disposition === 'busy') {
            throw new PreflightWorkerRetryError({
                category: 'persistence', retryable: true, httpStatus: null,
            }, null);
        }
        if (claim.state !== 'prepared') return 'noop';
    }
    try {
        if (claim.claimed) {
            if (!claim.claimToken) {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: beta claim token is missing.');
            }
            await input.coordinator.prepare({
                preflightId: input.preflightId,
                userId: input.userId,
                prepareGeneration: input.prepareGeneration,
                prepareToken: input.prepareToken,
                claimToken: claim.claimToken,
            });
        }
    } catch (error) {
        if (error instanceof Error && error.message === BETA_APIFY_POOL_CAPACITY_ERROR) {
            const resolution = await store.blockBetaPrepareCapacity({
                preflightId: input.preflightId,
                userId: input.userId,
                prepareGeneration: input.prepareGeneration,
                prepareToken: input.prepareToken,
                claimToken: claim.claimToken,
            });
            if (resolution === 'blocked') return 'blocked';
            if (resolution === 'retry_exhausted' || resolution === 'expired') {
                return 'noop';
            }
        } else {
            if (claim.claimToken) {
                try {
                    await store.releaseBetaPrepareClaim({
                        preflightId: input.preflightId,
                        userId: input.userId,
                        prepareGeneration: input.prepareGeneration,
                        prepareToken: input.prepareToken,
                        claimToken: claim.claimToken,
                    });
                } catch {
                    // The bounded DB lease remains the recovery fence.
                }
            }
            throw error;
        }
    }
    const reservation = await store.reserveDispatch(input.preflightId, input.userId);
    if (!reservation.shouldEnqueue) return 'prepared';
    if (!reservation.reservationToken) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: beta dispatch token is missing.');
    }
    await input.enqueue(input.preflightId, reservation.generation);
    await store.markDispatched({
        preflightId: input.preflightId,
        userId: input.userId,
        generation: reservation.generation,
        reservationToken: reservation.reservationToken,
    });
    return 'prepared';
}

export async function processPreflight(
    preflightId: string,
    dependencies: {
        store?: PreflightStore;
        getProfile?: typeof getSelfHostedProfileSummary;
        getFallbackProfile?: typeof getApifyProfileSummary;
        providerRunStore?: PreflightProviderRunStore;
        betaCreditCoordinator?: BetaApifyPreflightCoordinator;
        env?: Record<string, string | undefined>;
        observer?: PreflightProcessObserver;
        /** Post-terminal only; true means a beta allocation was processed. */
        settleBetaCredit?: (preflightId: string) => Promise<boolean>;
        refreshBetaCredit?: () => Promise<void>;
    } = {}
): Promise<'noop' | 'ready' | 'blocked'> {
    const store = dependencies.store ?? preflightStore;
    const providerRuns = dependencies.providerRunStore ?? preflightProviderRunStore;
    const settleTerminalBetaCredit = async (knownBeta: boolean): Promise<void> => {
        let processed = false;
        let settlementFailed = false;
        try {
            processed = await dependencies.settleBetaCredit?.(preflightId) ?? false;
        } catch {
            settlementFailed = true;
        }
        if (processed || (knownBeta && settlementFailed)) {
            try {
                await dependencies.refreshBetaCredit?.();
            } catch {
                // Refresh is advisory after a durable terminal transition.
            }
        }
    };
    const claim = await store.claim(preflightId);
    if (!claim) {
        // The claim RPC itself may have expired or exhausted the row. The
        // targeted RPC proves whether beta credit actually needs releasing.
        await settleTerminalBetaCredit(false);
        return 'noop';
    }
    const workerStartedAt = Date.now();
    let terminalized = false;
    const baseObservation = {
        preflightId: claim.preflightId,
        userId: claim.userId,
        targetInstagramId: claim.targetInstagramId,
    } as const;
    let profileObservation: Pick<
        PreflightProcessObservationBase,
        'followersCount' | 'followingCount'
    > = {};
    try {
        const isBetatest = claim.analysisEntryChannel === 'betatest';
        const betaHold = isBetatest
            ? await dependencies.betaCreditCoordinator?.reuse(claim.preflightId)
            : undefined;
        if (isBetatest && !betaHold) {
            throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
        }
        const inputHash = preflightTargetInputHash(
            claim.targetInstagramId,
            dependencies.env ?? process.env
        );
        const existingRun = await providerRuns.load({
            preflightId: claim.preflightId,
            claimToken: claim.claimToken,
            inputHash,
        });

        let profile: InstagramProfile | null;
        if (existingRun) {
            if (
                betaHold
                && existingRun.credentialSlot !== betaHold.credentialSlot
            ) {
                throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
            }
            if (
                ['starting', 'rejected', 'failed', 'aborted', 'timed_out']
                    .includes(existingRun.status)
            ) {
                await store.finalizeBlocked(claim, 'ANALYSIS_FAILED');
                terminalized = true;
                notifyPreflightObserver(dependencies.observer, {
                    type: 'completed',
                    outcome: 'blocked',
                    ...baseObservation,
                    errorCode: 'ANALYSIS_FAILED',
                    failureCategory: existingRun.status === 'timed_out'
                        ? 'timeout'
                        : 'provider',
                });
                return 'blocked';
            }
            const bound = await bindPreflightProviderRunCheckpoint({
                store: providerRuns,
                claim,
                inputHash,
                identity: preflightProviderIdentity(
                    betaHold?.credentialSlot ?? existingRun.credentialSlot
                ),
            });
            profile = await (dependencies.getFallbackProfile ?? getApifyProfileSummary)(
                claim.targetInstagramId,
                fallbackCallContext(bound.checkpoint, workerStartedAt)
            );
        } else {
            assertPreflightRuntimePolicy(dependencies.env);
            try {
                profile = await (dependencies.getProfile ?? getSelfHostedProfileSummary)(
                    claim.targetInstagramId,
                    {
                        invocationDeadlineAtMs:
                            workerStartedAt + PREFLIGHT_PROVIDER_DEADLINE_MS,
                    }
                );
                if (profile) assertMatchingProfile(profile, claim.targetInstagramId);
            } catch (error) {
                const failure = classifyPreflightError(error);
                if (!failure.paidFallbackEligible) throw error;
                logPreflightProfileFallbackEntry({
                    operation: 'profile',
                    failure,
                    existingRun: false,
                });
                const identity = preflightProviderIdentity(
                    betaHold?.credentialSlot
                    ?? selectAnalysisV2ApifyCredentialSlot(dependencies.env)
                );
                const bound = await bindPreflightProviderRunCheckpoint({
                    store: providerRuns,
                    claim,
                    inputHash,
                    identity,
                });
                profile = await (dependencies.getFallbackProfile ?? getApifyProfileSummary)(
                    claim.targetInstagramId,
                    fallbackCallContext(bound.checkpoint, workerStartedAt)
                );
            }
        }
        if (!profile) {
            await store.finalizeBlocked(claim, 'TARGET_NOT_FOUND');
            terminalized = true;
            notifyPreflightObserver(dependencies.observer, {
                type: 'completed',
                outcome: 'blocked',
                ...baseObservation,
                errorCode: 'TARGET_NOT_FOUND',
            });
            return 'blocked';
        }
        assertMatchingProfile(profile, claim.targetInstagramId);
        assertProfileCounts(profile);
        profileObservation = {
            followersCount: profile.followersCount,
            followingCount: profile.followingCount,
        };
        notifyPreflightObserver(dependencies.observer, {
            type: 'profile_collected',
            ...baseObservation,
            ...profileObservation,
        });

        const snapshot = buildReadyPreflightSnapshot(
            profile,
            claim.accessMode,
            claim.catalogSnapshot
        );
        if (typeof snapshot === 'string') {
            await store.finalizeBlocked(claim, snapshot);
            terminalized = true;
            notifyPreflightObserver(dependencies.observer, {
                type: 'completed',
                outcome: 'blocked',
                ...baseObservation,
                ...profileObservation,
                errorCode: snapshot,
            });
            return 'blocked';
        }
        await store.finalizeReady(claim, snapshot);
        terminalized = true;
        notifyPreflightObserver(dependencies.observer, {
            type: 'completed',
            outcome: 'ready',
            ...baseObservation,
            ...profileObservation,
            requiredPlan: snapshot.requiredPlan,
        });
        return 'ready';
    } catch (error) {
        if (
            !terminalized
            && claim.analysisEntryChannel === 'betatest'
            && error instanceof Error
            && error.message === BETA_APIFY_POOL_CAPACITY_ERROR
        ) {
            await store.finalizeBlocked(claim, 'BETA_CAPACITY_UNAVAILABLE');
            terminalized = true;
            notifyPreflightObserver(dependencies.observer, {
                type: 'completed', outcome: 'blocked', ...baseObservation,
                ...profileObservation, errorCode: 'BETA_CAPACITY_UNAVAILABLE',
            });
            return 'blocked';
        }
        const failure = classifyPreflightError(error);
        if (!terminalized && !failure.retryable) {
            try {
                await store.finalizeBlocked(claim, 'ANALYSIS_FAILED');
                terminalized = true;
                notifyPreflightObserver(dependencies.observer, {
                    type: 'completed',
                    outcome: 'blocked',
                    ...baseObservation,
                    ...profileObservation,
                    errorCode: 'ANALYSIS_FAILED',
                    failureCategory: failure.category,
                });
                return 'blocked';
            } catch (blockError) {
                error = blockError;
            }
        }
        if (!terminalized) {
            try {
                await store.releaseClaim(claim);
            } catch {
                console.error('Preflight claim release failed after a transient worker error.');
            }
        }
        const retryFailure = classifyPreflightError(error);
        notifyPreflightObserver(dependencies.observer, {
            type: 'failed',
            ...baseObservation,
            ...profileObservation,
            category: retryFailure.category,
            retryable: true,
            httpStatus: retryFailure.httpStatus,
            workerAttemptCount: claim.workerAttemptCount,
        });
        throw new PreflightWorkerRetryError({
            category: retryFailure.category,
            retryable: true,
            httpStatus: retryFailure.httpStatus,
        }, claim.workerAttemptCount, error);
    } finally {
        if (terminalized) {
            await settleTerminalBetaCredit(
                claim.analysisEntryChannel === 'betatest'
            );
        }
    }
}

export function acceptedPreflightDto(created: CreatedPreflight): PreflightAcceptedV1 {
    return preflightAcceptedV1Schema.parse({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        preflightId: created.preflightId,
        expiresAt: created.expiresAt,
        status: 'pending',
        exclusionDecision: 'pending',
    });
}

export function publicPreflightStatusDto(
    stored: StoredPreflight,
    remainingSlotsByPlan: Partial<Record<PaidEarlybirdPlanId, number>> = {},
    imageProxyPath: typeof createImageProxyPath = createImageProxyPath,
    nowMs = Date.now()
): PreflightStatusV1 {
    if (stored.status === 'expired' || Date.parse(stored.expiresAt) <= nowMs) {
        throw new PreflightExpiredError();
    }
    if (stored.status === 'consumed') throw new PreflightConsumedError();
    if (stored.status === 'pending' || stored.status === 'processing') {
        return preflightStatusV1Schema.parse({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            preflightId: stored.preflightId,
            expiresAt: stored.expiresAt,
            status: 'pending',
            exclusionDecision: stored.exclusionDecision,
        });
    }
    if (stored.status === 'blocked') {
        return preflightStatusV1Schema.parse({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            preflightId: stored.preflightId,
            expiresAt: stored.expiresAt,
            status: 'blocked',
            exclusionDecision: stored.exclusionDecision,
            code: stored.blockedCode ?? 'ANALYSIS_FAILED',
        });
    }
    if (!stored.readySnapshot) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: ready snapshot is missing.');
    }
    const snapshot = stored.readySnapshot;
    const { profileImageUrl, ...publicTarget } = snapshot.target;
    return preflightStatusV1Schema.parse({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        preflightId: stored.preflightId,
        expiresAt: stored.expiresAt,
        status: 'ready',
        exclusionDecision: stored.exclusionDecision,
        target: {
            ...publicTarget,
            profileImage: imageProxyPath(profileImageUrl) ?? null,
        },
        accessMode: snapshot.accessMode,
        capacityRequiredPlan: snapshot.capacityRequiredPlan,
        requiredPlan: snapshot.requiredPlan,
        plans: snapshot.plans.map(plan => {
            if (!isPaidEarlybirdPlanId(plan.planId)) return plan;
            const remainingSlots = remainingSlotsByPlan[plan.planId];
            return remainingSlots !== undefined
                ? { ...plan, remainingSlots }
                : plan;
        }),
        pricingVersion: snapshot.pricingVersion,
    });
}

export function trustedPreflightAccessMode(
    env: Record<string, string | undefined> = process.env
): PlanAccessMode {
    const value = env.PREFLIGHT_ACCESS_MODE?.trim() || 'production';
    if (value === 'production') return value;
    if (value === 'test_entitlement') {
        if (!analysisTestEntitlementsEnabled(env)) {
            throw new Error('PREFLIGHT_CONFIG_ERROR: test entitlement mode is disabled.');
        }
        assertAnalysisTestEntitlementConfiguration(env);
        return value;
    }
    throw new Error('PREFLIGHT_CONFIG_ERROR: invalid or unsafe access mode.');
}
