import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PLAN_IDS, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import { getSelfHostedAdmissionProfileSummary } from '@/lib/services/instagram/providers/selfhosted';
import { getApifyProfile } from '@/lib/services/instagram/providers/apify';
import { selectAnalysisV2ApifyCredentialSlot } from '@/lib/services/instagram/providers/apify-relationship';
import {
    PREFLIGHT_PROVIDER_DEADLINE_MS,
    assertPreflightRuntimePolicy,
} from './preflight-runtime-policy';
import {
    PreflightWorkerRetryError,
    classifyPreflightError,
    fallbackCallContext,
    logPreflightProfileFallbackEntry,
} from './preflight';
import {
    bindPreflightProviderRunCheckpoint,
    createFreshAdmissionProviderRunStore,
    preflightProviderIdentity,
    type FreshAdmissionProviderRunStore,
} from './preflight-provider-run';
import { preflightTargetInputHash } from './preflight-identity';

export const ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES = Object.freeze({
    reserveRpc: 'reserve_analysis_v2_preflight_admission',
    markDispatchedRpc: 'mark_analysis_v2_preflight_admission_dispatched',
    releaseDispatchRpc: 'release_analysis_v2_preflight_admission_dispatch',
    claimRpc: 'claim_analysis_v2_preflight_admission',
    completeRpc: 'complete_analysis_v2_preflight_admission',
    blockRpc: 'block_analysis_v2_preflight_admission',
    releaseRpc: 'release_analysis_v2_preflight_admission',
    failureRpc: 'record_analysis_v2_preflight_admission_failure',
});

export const ANALYSIS_V2_FRESH_ADMISSION_MAX_FAILURES = 3;

export const ANALYSIS_V2_FRESH_ADMISSION_ERROR_CODES = [
    'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
    'ANALYSIS_V2_PREFLIGHT_NOT_READY',
    'ANALYSIS_V2_PREFLIGHT_EXPIRED',
    'ANALYSIS_V2_PLAN_NOT_ALLOWED',
    'ANALYSIS_V2_TARGET_NOT_FOUND',
    'ANALYSIS_V2_TARGET_PRIVATE',
    'ANALYSIS_V2_TARGET_MISMATCH',
    'ANALYSIS_V2_OVER_PLUS_CAPACITY',
    'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
] as const;

export type AnalysisV2FreshAdmissionErrorCode =
    (typeof ANALYSIS_V2_FRESH_ADMISSION_ERROR_CODES)[number];

const terminalAdmissionErrorSchema = z.enum([
    'ANALYSIS_V2_PLAN_NOT_ALLOWED',
    'ANALYSIS_V2_TARGET_NOT_FOUND',
    'ANALYSIS_V2_TARGET_PRIVATE',
    'ANALYSIS_V2_OVER_PLUS_CAPACITY',
    'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
]);

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const usernameSchema = z.string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/);
const timestampSchema = z.string().datetime({ offset: true });
const priceSchema = z.discriminatedUnion('status', [
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
const pricesSchema = z.object({
    basic: priceSchema,
    standard: priceSchema,
    plus: priceSchema,
}).strict();
const admissionCardSchema = z.object({
    launchStatus: z.enum(['production', 'test_only', 'disabled']),
    relationshipCapacity: z.object({
        followers: z.number().int().positive().max(10_000_000),
        following: z.number().int().positive().max(10_000_000),
    }).strict(),
    detailedMutualLimit: z.number().int().positive().max(100_000),
    selectionState: z.enum(['required', 'available_upgrade', 'unavailable']),
    unavailableReason: z.enum([
        'below_required_plan',
        'launch_gate',
        'over_plus_capacity',
    ]).nullable(),
}).strict();
const admissionCardsSchema = z.object({
    basic: admissionCardSchema,
    standard: admissionCardSchema,
    plus: admissionCardSchema,
}).strict();

const reserveInputSchema = z.object({
    preflightId: uuidSchema,
    userId: uuidSchema,
    selectedPlanId: z.enum(PLAN_IDS),
    entitlementJtiHash: sha256Schema,
}).strict();
const reserveRowSchema = z.object({
    admission_status: z.enum(['pending', 'processing', 'ready', 'blocked']),
    should_enqueue: z.boolean(),
    admission_generation: z.number().int().min(1).max(100),
    dispatch_generation: z.number().int().min(1).max(100),
    dispatch_token: uuidSchema.nullable(),
    selected_plan_id: z.enum(PLAN_IDS),
    selected_plan_allowed: z.boolean().nullable(),
    admission_token: uuidSchema.nullable(),
    admission_refreshed_at: timestampSchema.nullable(),
    target_followers_count: z.number().int().nonnegative().max(10_000_000).nullable(),
    target_following_count: z.number().int().nonnegative().max(10_000_000).nullable(),
    capacity_required_plan_id: z.enum(PLAN_IDS).nullable(),
    required_plan_id: z.enum(PLAN_IDS).nullable(),
    plan_cards_snapshot: admissionCardsSchema.nullable(),
    pricing_version: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    pricing_snapshot: pricesSchema,
    admission_error_code: terminalAdmissionErrorSchema.nullable(),
}).strict();
const reserveResultSchema = z.array(reserveRowSchema).length(1);

const claimInputSchema = z.object({
    preflightId: uuidSchema,
    generation: z.number().int().min(1).max(100),
    dispatchGeneration: z.number().int().min(1).max(100),
    dispatchToken: uuidSchema,
}).strict();
const dispatchMutationInputSchema = z.object({
    preflightId: uuidSchema,
    userId: uuidSchema,
    generation: z.number().int().min(1).max(100),
    dispatchGeneration: z.number().int().min(1).max(100),
    dispatchToken: uuidSchema,
}).strict();
const claimResultSchema = z.array(z.object({
    claimed: z.boolean(),
    admission_status: z.enum(['pending', 'processing', 'ready', 'blocked']),
    target_instagram_id: usernameSchema.nullable(),
}).strict()).length(1);
const terminalResultSchema = z.array(z.object({
    admission_status: z.enum(['ready', 'blocked']),
    admission_error_code: terminalAdmissionErrorSchema.nullable(),
}).strict()).length(1);
const failureResultSchema = z.array(z.object({
    admission_status: z.enum(['pending', 'blocked']),
    failure_count: z.number().int().min(1).max(ANALYSIS_V2_FRESH_ADMISSION_MAX_FAILURES),
    admission_error_code: z.literal('ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE').nullable(),
}).strict()).length(1);

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2FreshAdmissionRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

export interface RefreshAnalysisV2FreshAdmissionInput {
    preflightId: string;
    userId: string;
    selectedPlanId: PlanId;
    entitlementJtiHash: string;
}

export interface AnalysisV2FreshAdmissionPlanQuote {
    planId: PlanId;
    launchStatus: 'production' | 'test_only' | 'disabled';
    relationshipCapacity: { followers: number; following: number };
    detailedMutualLimit: number;
    selectionState: 'required' | 'available_upgrade' | 'unavailable';
    unavailableReason: 'below_required_plan' | 'launch_gate' | 'over_plus_capacity' | null;
    pricingVersion: string;
    price: z.infer<typeof priceSchema>;
}

export interface AnalysisV2FreshPlanSnapshot {
    followersCount: number;
    followingCount: number;
    capacityRequiredPlanId: PlanId | null;
    requiredPlanId: PlanId | null;
    selectedPlanId: PlanId;
    plans: AnalysisV2FreshAdmissionPlanQuote[];
    pricingVersion: string;
    refreshedAt: string;
}

export type AnalysisV2FreshAdmissionReservation =
    | Readonly<{
        state: 'pending';
        shouldEnqueue: boolean;
        generation: number;
        dispatchGeneration: number;
        dispatchToken: string | null;
    }>
    | Readonly<{
        state: 'ready';
        generation: number;
        selectedPlanAllowed: boolean;
        admissionToken: string;
        snapshot: AnalysisV2FreshPlanSnapshot;
    }>
    | Readonly<{
        state: 'blocked';
        generation: number;
        errorCode: z.infer<typeof terminalAdmissionErrorSchema>;
        snapshot: AnalysisV2FreshPlanSnapshot | null;
    }>;

interface ClaimedAnalysisV2FreshAdmission {
    preflightId: string;
    generation: number;
    claimToken: string;
    targetInstagramId: string;
}

export type AnalysisV2FreshProfileFetcher = typeof getSelfHostedAdmissionProfileSummary;
export type AnalysisV2FreshFallbackProfileFetcher = typeof getApifyProfile;

export class AnalysisV2FreshAdmissionError extends Error {
    readonly code: AnalysisV2FreshAdmissionErrorCode;

    constructor(code: AnalysisV2FreshAdmissionErrorCode) {
        super(code);
        this.name = 'AnalysisV2FreshAdmissionError';
        this.code = code;
    }
}

export class AnalysisV2FreshAdmissionLeaseBusyError extends Error {
    constructor() {
        super('ANALYSIS_V2_FRESH_ADMISSION_LEASE_BUSY');
        this.name = 'AnalysisV2FreshAdmissionLeaseBusyError';
    }
}

function isBoundedErrorCode(value: unknown): value is AnalysisV2FreshAdmissionErrorCode {
    return typeof value === 'string'
        && ANALYSIS_V2_FRESH_ADMISSION_ERROR_CODES.includes(
            value as AnalysisV2FreshAdmissionErrorCode
        );
}

function safeDatabaseErrorCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (isBoundedErrorCode(error.message)) {
        throw new AnalysisV2FreshAdmissionError(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_FRESH_ADMISSION_ERROR: ${operation} failed `
        + `(${safeDatabaseErrorCode(error)}).`
    );
}

function assertFreshCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
        throw new AnalysisV2FreshAdmissionError(
            'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        );
    }
}

function snapshotFromRow(row: z.infer<typeof reserveRowSchema>): AnalysisV2FreshPlanSnapshot | null {
    if (
        row.target_followers_count === null
        || row.target_following_count === null
        || row.admission_refreshed_at === null
        || row.plan_cards_snapshot === null
    ) return null;

    return Object.freeze({
        followersCount: row.target_followers_count,
        followingCount: row.target_following_count,
        capacityRequiredPlanId: row.capacity_required_plan_id,
        requiredPlanId: row.required_plan_id,
        selectedPlanId: row.selected_plan_id,
        plans: PLAN_IDS.map(planId => Object.freeze({
            planId,
            ...row.plan_cards_snapshot![planId],
            pricingVersion: row.pricing_version,
            price: row.pricing_snapshot[planId],
        })),
        pricingVersion: row.pricing_version,
        refreshedAt: row.admission_refreshed_at,
    });
}

export async function reserveAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    input: RefreshAnalysisV2FreshAdmissionInput,
    dependencies: {
        createAdmissionToken?: () => string;
        createDispatchToken?: () => string;
    } = {}
): Promise<AnalysisV2FreshAdmissionReservation> {
    const parsedInput = reserveInputSchema.safeParse(input);
    if (!parsedInput.success) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid reserve input.');
    }
    const validatedInput = parsedInput.data;
    const proposedToken = uuidSchema.parse(
        dependencies.createAdmissionToken?.() ?? randomUUID()
    );
    const proposedDispatchToken = uuidSchema.parse(
        dependencies.createDispatchToken?.() ?? randomUUID()
    );
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.reserveRpc,
        {
            p_preflight_id: validatedInput.preflightId,
            p_user_id: validatedInput.userId,
            p_selected_plan_id: validatedInput.selectedPlanId,
            p_entitlement_jti_hash: validatedInput.entitlementJtiHash,
            p_admission_token: proposedToken,
            p_dispatch_token: proposedDispatchToken,
        }
    );
    if (error) throwRpcError(error, 'reserve');

    const parsed = reserveResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid reserve result.');
    }
    const row = parsed.data[0];
    if (row.selected_plan_id !== validatedInput.selectedPlanId) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: selected plan mismatch.');
    }
    if (row.admission_status === 'pending' || row.admission_status === 'processing') {
        if (
            row.admission_token !== null
            || row.admission_refreshed_at !== null
            || row.selected_plan_allowed !== null
            || row.admission_error_code !== null
            || (row.should_enqueue && row.dispatch_token === null)
            || (!row.should_enqueue && row.dispatch_token !== null)
        ) {
            throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid pending result.');
        }
        return Object.freeze({
            state: 'pending',
            shouldEnqueue: row.should_enqueue,
            generation: row.admission_generation,
            dispatchGeneration: row.dispatch_generation,
            dispatchToken: row.dispatch_token,
        });
    }

    const snapshot = snapshotFromRow(row);
    if (row.admission_status === 'blocked') {
        if (!row.admission_error_code || row.should_enqueue || row.dispatch_token !== null) {
            throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid blocked result.');
        }
        return Object.freeze({
            state: 'blocked',
            generation: row.admission_generation,
            errorCode: row.admission_error_code,
            snapshot,
        });
    }
    if (
        row.should_enqueue
        || row.dispatch_token !== null
        || row.selected_plan_allowed === null
        || row.admission_token === null
        || snapshot === null
    ) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid ready result.');
    }
    return Object.freeze({
        state: 'ready',
        generation: row.admission_generation,
        selectedPlanAllowed: row.selected_plan_allowed,
        admissionToken: row.admission_token,
        snapshot,
    });
}

export async function markAnalysisV2FreshAdmissionDispatched(
    client: AnalysisV2FreshAdmissionRpcClient,
    input: z.input<typeof dispatchMutationInputSchema>
): Promise<'marked' | 'already_marked'> {
    const validatedInput = dispatchMutationInputSchema.parse(input);
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.markDispatchedRpc,
        {
            p_preflight_id: validatedInput.preflightId,
            p_user_id: validatedInput.userId,
            p_admission_generation: validatedInput.generation,
            p_dispatch_generation: validatedInput.dispatchGeneration,
            p_dispatch_token: validatedInput.dispatchToken,
        }
    );
    if (error) throwRpcError(error, 'dispatch mark');
    if (typeof data !== 'boolean') {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid dispatch mark result.');
    }
    return data ? 'marked' : 'already_marked';
}

export async function releaseAnalysisV2FreshAdmissionDispatch(
    client: AnalysisV2FreshAdmissionRpcClient,
    input: z.input<typeof dispatchMutationInputSchema>
): Promise<'released' | 'already_settled'> {
    const validatedInput = dispatchMutationInputSchema.parse(input);
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseDispatchRpc,
        {
            p_preflight_id: validatedInput.preflightId,
            p_user_id: validatedInput.userId,
            p_admission_generation: validatedInput.generation,
            p_dispatch_generation: validatedInput.dispatchGeneration,
            p_dispatch_token: validatedInput.dispatchToken,
        }
    );
    if (error) throwRpcError(error, 'dispatch release');
    if (typeof data !== 'boolean') {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid dispatch release result.');
    }
    return data ? 'released' : 'already_settled';
}

async function claimAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    input: { preflightId: string; generation: number },
    createClaimToken: () => string
): Promise<ClaimedAnalysisV2FreshAdmission | null> {
    const validatedInput = claimInputSchema.parse(input);
    const claimToken = uuidSchema.parse(createClaimToken());
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc,
        {
            p_preflight_id: validatedInput.preflightId,
            p_admission_generation: validatedInput.generation,
            p_dispatch_generation: validatedInput.dispatchGeneration,
            p_dispatch_token: validatedInput.dispatchToken,
            p_claim_token: claimToken,
            p_lease_seconds: 120,
        }
    );
    if (error) throwRpcError(error, 'claim');
    const parsed = claimResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid claim result.');
    }
    const row = parsed.data[0];
    if (!row.claimed) {
        if (row.admission_status === 'processing') {
            throw new AnalysisV2FreshAdmissionLeaseBusyError();
        }
        return null;
    }
    if (!row.target_instagram_id || row.admission_status !== 'processing') {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid claimed row.');
    }
    return Object.freeze({
        ...validatedInput,
        claimToken,
        targetInstagramId: row.target_instagram_id,
    });
}

async function releaseAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    claim: ClaimedAnalysisV2FreshAdmission
): Promise<void> {
    const { error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc,
        {
            p_preflight_id: claim.preflightId,
            p_admission_generation: claim.generation,
            p_claim_token: claim.claimToken,
        }
    );
    if (error) throwRpcError(error, 'release');
}

async function recordAnalysisV2FreshAdmissionFailure(
    client: AnalysisV2FreshAdmissionRpcClient,
    claim: ClaimedAnalysisV2FreshAdmission
): Promise<Readonly<{ status: 'pending' | 'blocked'; failureCount: number }>> {
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
        {
            p_preflight_id: claim.preflightId,
            p_admission_generation: claim.generation,
            p_claim_token: claim.claimToken,
        }
    );
    if (error) throwRpcError(error, 'failure record');
    const parsed = failureResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid failure result.');
    }
    const row = parsed.data[0];
    if (
        (row.admission_status === 'pending' && row.admission_error_code !== null)
        || (
            row.admission_status === 'blocked'
            && row.failure_count !== ANALYSIS_V2_FRESH_ADMISSION_MAX_FAILURES
        )
        || (
            row.admission_status === 'blocked'
            && row.admission_error_code !== 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        )
    ) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: inconsistent failure result.');
    }
    return Object.freeze({
        status: row.admission_status,
        failureCount: row.failure_count,
    });
}

async function blockAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    claim: ClaimedAnalysisV2FreshAdmission,
    code: 'ANALYSIS_V2_TARGET_NOT_FOUND' | 'ANALYSIS_V2_TARGET_PRIVATE'
): Promise<'blocked'> {
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.blockRpc,
        {
            p_preflight_id: claim.preflightId,
            p_admission_generation: claim.generation,
            p_claim_token: claim.claimToken,
            p_error_code: code,
        }
    );
    if (error) throwRpcError(error, 'block');
    const parsed = terminalResultSchema.safeParse(data);
    if (
        !parsed.success
        || parsed.data[0].admission_status !== 'blocked'
        || parsed.data[0].admission_error_code !== code
    ) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid block result.');
    }
    return 'blocked';
}

async function completeAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    claim: ClaimedAnalysisV2FreshAdmission,
    profile: NonNullable<Awaited<ReturnType<AnalysisV2FreshProfileFetcher>>>
): Promise<'ready' | 'blocked'> {
    const { data, error } = await client.rpc(
        ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc,
        {
            p_preflight_id: claim.preflightId,
            p_admission_generation: claim.generation,
            p_claim_token: claim.claimToken,
            p_target_instagram_id: profile.username.toLowerCase(),
            p_target_followers_count: profile.followersCount,
            p_target_following_count: profile.followingCount,
            p_target_is_private: profile.isPrivate,
        }
    );
    if (error) throwRpcError(error, 'complete');
    const parsed = terminalResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: invalid complete result.');
    }
    return parsed.data[0].admission_status;
}

export async function processAnalysisV2FreshAdmission(
    client: AnalysisV2FreshAdmissionRpcClient,
    input: {
        preflightId: string;
        generation: number;
        dispatchGeneration: number;
        dispatchToken: string;
    },
    dependencies: {
        getProfile?: AnalysisV2FreshProfileFetcher;
        getFallbackProfile?: AnalysisV2FreshFallbackProfileFetcher;
        providerRunStore?: FreshAdmissionProviderRunStore;
        env?: Record<string, string | undefined>;
        createClaimToken?: () => string;
    } = {}
): Promise<'noop' | 'ready' | 'blocked'> {
    const claim = await claimAnalysisV2FreshAdmission(
        client,
        input,
        dependencies.createClaimToken ?? randomUUID
    );
    if (!claim) return 'noop';

    const providerRuns = dependencies.providerRunStore
        ?? createFreshAdmissionProviderRunStore(client, input.generation);
    const workerStartedAt = Date.now();
    let claimSettled = false;
    const retryWithoutFailureBudget = async (error: unknown): Promise<never> => {
        const failure = classifyPreflightError(error);
        await releaseAnalysisV2FreshAdmission(client, claim);
        claimSettled = true;
        throw new PreflightWorkerRetryError({
            category: failure.category,
            retryable: true,
            httpStatus: failure.httpStatus,
        }, null, error);
    };
    const settleFailure = async (error: unknown): Promise<'blocked'> => {
        const failure = classifyPreflightError(error);
        if (
            failure.category === 'run_pending'
            || (failure.category === 'persistence' && failure.retryable)
        ) {
            return await retryWithoutFailureBudget(error);
        }
        const result = await recordAnalysisV2FreshAdmissionFailure(client, claim);
        claimSettled = true;
        if (result.status === 'blocked') return 'blocked';
        throw new PreflightWorkerRetryError({
            category: failure.category,
            retryable: true,
            httpStatus: failure.httpStatus,
        }, result.failureCount, error);
    };
    try {
        let profile: Awaited<ReturnType<AnalysisV2FreshProfileFetcher>>;
        let reusableProfileInputHash: string | null = null;
        try {
            assertPreflightRuntimePolicy(dependencies.env);
            profile = await (
                dependencies.getProfile ?? getSelfHostedAdmissionProfileSummary
            )(claim.targetInstagramId, {
                invocationDeadlineAtMs: workerStartedAt + PREFLIGHT_PROVIDER_DEADLINE_MS,
            });
            if (
                profile
                && profile.username.trim().toLowerCase() !== claim.targetInstagramId
            ) {
                throw new Error('ANALYSIS_V2_FRESH_ADMISSION_ERROR: target identity mismatch.');
            }
            if (profile) {
                assertFreshCount(profile.followersCount);
                assertFreshCount(profile.followingCount);
            }
        } catch (primaryError) {
            const primaryFailure = classifyPreflightError(primaryError);
            if (!primaryFailure.paidFallbackEligible) {
                return await settleFailure(primaryError);
            }
            try {
                const inputHash = preflightTargetInputHash(
                    claim.targetInstagramId,
                    dependencies.env
                );
                const existingRun = await providerRuns.load({
                    preflightId: claim.preflightId,
                    claimToken: claim.claimToken,
                    inputHash,
                });
                logPreflightProfileFallbackEntry({
                    operation: 'fresh_admission',
                    failure: primaryFailure,
                    existingRun: existingRun !== null,
                });
                const identity = preflightProviderIdentity(
                    existingRun?.credentialSlot
                    ?? selectAnalysisV2ApifyCredentialSlot(dependencies.env)
                );
                const bound = await bindPreflightProviderRunCheckpoint({
                    store: providerRuns,
                    claim,
                    inputHash,
                    identity,
                });
                profile = await (
                    dependencies.getFallbackProfile ?? getApifyProfile
                )(
                    claim.targetInstagramId,
                    fallbackCallContext(bound.checkpoint, workerStartedAt)
                );
                if (
                    profile
                    && profile.username.trim().toLowerCase() !== claim.targetInstagramId
                ) {
                    throw new Error(
                        'ANALYSIS_V2_FRESH_ADMISSION_ERROR: target identity mismatch.'
                    );
                }
                if (profile) {
                    assertFreshCount(profile.followersCount);
                    assertFreshCount(profile.followingCount);
                    reusableProfileInputHash = inputHash;
                }
            } catch (fallbackError) {
                return await settleFailure(fallbackError);
            }
        }
        if (!profile) {
            const outcome = await blockAnalysisV2FreshAdmission(
                client,
                claim,
                'ANALYSIS_V2_TARGET_NOT_FOUND'
            );
            claimSettled = true;
            return outcome;
        }
        if (profile.isPrivate) {
            const outcome = await blockAnalysisV2FreshAdmission(
                client,
                claim,
                'ANALYSIS_V2_TARGET_PRIVATE'
            );
            claimSettled = true;
            return outcome;
        }
        if (reusableProfileInputHash !== null) {
            try {
                const reusableRun = await providerRuns.load({
                    preflightId: claim.preflightId,
                    claimToken: claim.claimToken,
                    inputHash: reusableProfileInputHash,
                });
                if (
                    reusableRun?.status !== 'succeeded'
                    || reusableRun.runId === null
                ) {
                    throw new Error(
                        'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: reusable profile run is not succeeded.'
                    );
                }
                await providerRuns.markReusableProfileSchemaV1({
                    preflightId: claim.preflightId,
                    claimToken: claim.claimToken,
                    inputHash: reusableProfileInputHash,
                    runId: reusableRun.runId,
                });
            } catch (attestationError) {
                return await settleFailure(attestationError);
            }
        }
        const outcome = await completeAnalysisV2FreshAdmission(client, claim, profile);
        claimSettled = true;
        return outcome;
    } catch (error) {
        if (!claimSettled) {
            try {
                await releaseAnalysisV2FreshAdmission(client, claim);
            } catch {
                console.error('Analysis V2 fresh admission claim release failed.');
            }
        }
        throw error;
    }
}
