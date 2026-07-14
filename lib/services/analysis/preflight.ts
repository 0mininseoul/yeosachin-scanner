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
import { CURRENT_ANALYSIS_PIPELINE_VERSION } from '@/lib/domain/analysis/pipeline-version';
import { RISK_POLICY_VERSION } from '@/lib/domain/analysis/risk-policy';
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
} from './test-entitlement';
import { getSelfHostedProfileSummary } from '@/lib/services/instagram/providers/selfhosted';
import { isInstagramUsername } from '@/lib/services/instagram/username';
import {
    canonicalizeImageProxyUrl,
    createImageProxyPath,
} from '@/lib/services/media/image-proxy-token';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    PREFLIGHT_WORKER_LEASE_SECONDS,
    assertPreflightRuntimePolicy,
} from './preflight-runtime-policy';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const PREFLIGHT_DATABASE_NAMES = Object.freeze({
    table: 'analysis_preflights',
    createOrReplayRpc: 'create_or_replay_analysis_v2_preflight',
    claimRpc: 'claim_analysis_v2_preflight',
    reserveDispatchRpc: 'reserve_analysis_v2_preflight_dispatch',
    markDispatchedRpc: 'mark_analysis_v2_preflight_dispatched',
    releaseClaimRpc: 'release_analysis_preflight_claim',
    completeRpc: 'complete_analysis_v2_preflight',
    blockRpc: 'block_analysis_v2_preflight',
    exclusionRpc: 'set_analysis_v2_preflight_exclusion',
});

const PREFLIGHT_POLICY_VERSIONS = Object.freeze({
    pipeline: CURRENT_ANALYSIS_PIPELINE_VERSION,
    risk: RISK_POLICY_VERSION,
    aiStage: AI_STAGE_POLICY_VERSION,
});

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

export interface ClaimedPreflight {
    preflightId: string;
    claimToken: string;
    userId: string;
    targetInstagramId: string;
    accessMode: PlanAccessMode;
    catalogSnapshot: PreflightCatalogSnapshot;
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
): PreflightStore {
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
                p_policy_versions_snapshot: PREFLIGHT_POLICY_VERSIONS,
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
): ReadyPreflightSnapshot | AnalysisV2ErrorCode {
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

export async function processPreflight(
    preflightId: string,
    dependencies: {
        store?: PreflightStore;
        getProfile?: typeof getSelfHostedProfileSummary;
    } = {}
): Promise<'noop' | 'ready' | 'blocked'> {
    const store = dependencies.store ?? preflightStore;
    const claim = await store.claim(preflightId);
    if (!claim) return 'noop';
    let terminalized = false;
    try {
        assertPreflightRuntimePolicy();
        const profile = await (dependencies.getProfile ?? getSelfHostedProfileSummary)(
            claim.targetInstagramId
        );
        if (!profile) {
            await store.finalizeBlocked(claim, 'TARGET_NOT_FOUND');
            terminalized = true;
            return 'blocked';
        }
        if (profile.username.toLowerCase() !== claim.targetInstagramId) {
            throw new Error('PREFLIGHT_PROFILE_ERROR: returned username does not match target.');
        }

        const snapshot = buildReadyPreflightSnapshot(
            profile,
            claim.accessMode,
            claim.catalogSnapshot
        );
        if (typeof snapshot === 'string') {
            await store.finalizeBlocked(claim, snapshot);
            terminalized = true;
            return 'blocked';
        }
        await store.finalizeReady(claim, snapshot);
        terminalized = true;
        return 'ready';
    } catch (error) {
        if (!terminalized) {
            try {
                await store.releaseClaim(claim);
            } catch {
                console.error('Preflight claim release failed after a transient worker error.');
            }
        }
        throw error;
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
        plans: snapshot.plans,
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
