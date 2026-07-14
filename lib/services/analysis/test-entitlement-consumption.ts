import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    PLAN_IDS,
    PLAN_LAUNCH_STATUSES,
    assessPlanSelection,
    determinePlanEligibility,
    type PlanId,
    type PlanEligibilityCatalog,
} from '@/lib/domain/analysis/plan-catalog';
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY } from './v2-coordinator';

const ENTITLEMENT_JTI_DOMAIN = 'analysis-test-entitlement-jti-v1';

const uuidSchema = z.string().uuid();
const usernameSchema = z.string()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/);
const launchStatusSnapshotSchema = z.object({
    basic: z.enum(PLAN_LAUNCH_STATUSES),
    standard: z.enum(PLAN_LAUNCH_STATUSES),
    plus: z.enum(PLAN_LAUNCH_STATUSES),
}).strict();
const planCardSchema = z.object({
    launchStatus: z.enum(PLAN_LAUNCH_STATUSES),
    relationshipCapacity: z.object({
        followers: z.number().int().positive(),
        following: z.number().int().positive(),
    }).strict(),
    detailedMutualLimit: z.number().int().positive(),
    selectionState: z.enum(['required', 'available_upgrade', 'unavailable']),
    unavailableReason: z.enum(['below_required_plan', 'launch_gate']).nullable(),
}).strict();
const planCardsSnapshotSchema = z.object({
    basic: planCardSchema,
    standard: planCardSchema,
    plus: planCardSchema,
}).strict();
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
const pricingSnapshotSchema = z.object({
    basic: priceSchema,
    standard: priceSchema,
    plus: priceSchema,
}).strict();

const preflightRowSchema = z.object({
    id: uuidSchema,
    user_id: uuidSchema,
    status: z.string().min(1).max(32),
    expires_at: z.string().datetime({ offset: true }),
    target_instagram_id: usernameSchema,
    target_followers_count: z.number().int().nonnegative(),
    target_following_count: z.number().int().nonnegative(),
    access_mode: z.string().min(1).max(32),
    capacity_required_plan_id: z.string().min(1).max(32),
    required_plan_id: z.string().min(1).max(32),
    launch_status_snapshot: launchStatusSnapshotSchema,
    plan_cards_snapshot: planCardsSnapshotSchema,
    exclusion_decision: z.string().max(32).nullable(),
    excluded_instagram_id: z.string().max(30).nullable(),
    pricing_version: z.string().min(1).max(64),
    pricing_snapshot: pricingSnapshotSchema,
    consumed_request_id: uuidSchema.nullable(),
}).strict();

const rpcResultSchema = z.array(z.object({
    request_id: uuidSchema,
    created: z.boolean(),
    initial_job_key: z.literal(ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
    request_status: z.enum(['pending', 'processing', 'completed', 'failed']),
    background_processing: z.boolean(),
}).strict()).length(1);
const consumptionInputSchema = z.object({
    preflightId: uuidSchema,
    userId: uuidSchema,
    selectedPlanId: z.enum(PLAN_IDS),
    entitlementJtiHash: z.string().regex(/^[a-f0-9]{64}$/),
    admissionToken: uuidSchema.nullable().optional().default(null),
}).strict();

export const ANALYSIS_V2_ENTITLEMENT_ERROR_CODES = [
    'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
    'ANALYSIS_V2_PREFLIGHT_NOT_READY',
    'ANALYSIS_V2_PREFLIGHT_EXPIRED',
    'ANALYSIS_V2_EXCLUSION_REQUIRED',
    'ANALYSIS_V2_PLAN_NOT_ALLOWED',
    'ANALYSIS_V2_ENTITLEMENT_CONFLICT',
    'ANALYSIS_ALREADY_IN_PROGRESS',
] as const;

export type AnalysisV2EntitlementErrorCode =
    (typeof ANALYSIS_V2_ENTITLEMENT_ERROR_CODES)[number];

export interface AnalysisV2PreflightRow {
    id: string;
    user_id: string;
    status: string;
    expires_at: string;
    target_instagram_id: string;
    target_followers_count: number | null;
    target_following_count: number | null;
    access_mode: string;
    capacity_required_plan_id: string | null;
    required_plan_id: string | null;
    launch_status_snapshot: unknown;
    plan_cards_snapshot: unknown;
    exclusion_decision: string | null;
    excluded_instagram_id: string | null;
    pricing_version: string;
    pricing_snapshot: unknown;
    consumed_request_id: string | null;
}

export interface ValidatedTestEntitlementPreflight {
    id: string;
    userId: string;
    selectedPlanId: PlanId;
    state: 'ready' | 'consumed';
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2TestEntitlementRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

export interface ConsumeAnalysisV2TestEntitlementInput {
    preflightId: string;
    userId: string;
    selectedPlanId: PlanId;
    entitlementJtiHash: string;
    admissionToken?: string | null;
}

export interface ConsumedAnalysisV2TestEntitlement {
    requestId: string;
    created: boolean;
    initialJobKey: typeof ANALYSIS_V2_BOOTSTRAP_JOB_KEY;
    requestStatus: 'pending' | 'processing' | 'completed' | 'failed';
    backgroundProcessing: boolean;
}

export type AnalysisV2InitialJobDispatcher = (
    requestId: string,
    jobKey: typeof ANALYSIS_V2_BOOTSTRAP_JOB_KEY
) => Promise<unknown>;

export class AnalysisV2EntitlementConsumptionError extends Error {
    readonly code: AnalysisV2EntitlementErrorCode;

    constructor(code: AnalysisV2EntitlementErrorCode) {
        super(code);
        this.name = 'AnalysisV2EntitlementConsumptionError';
        this.code = code;
    }
}

function isBoundedErrorCode(value: unknown): value is AnalysisV2EntitlementErrorCode {
    return typeof value === 'string'
        && ANALYSIS_V2_ENTITLEMENT_ERROR_CODES.includes(
            value as AnalysisV2EntitlementErrorCode
        );
}

function safeDatabaseErrorCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function invalidPlan(): never {
    throw new AnalysisV2EntitlementConsumptionError('ANALYSIS_V2_PLAN_NOT_ALLOWED');
}

export function validatePreflightForTestEntitlement(
    rawRow: AnalysisV2PreflightRow,
    selectedPlanId: PlanId,
    options: {
        nowMs?: number;
        deferPlanSelectionToFreshAdmission?: boolean;
    } = {}
): ValidatedTestEntitlementPreflight {
    if (rawRow.status !== 'ready' && rawRow.status !== 'consumed') {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
    }
    const parsed = preflightRowSchema.safeParse(rawRow);
    if (!parsed.success) invalidPlan();
    const row = parsed.data;
    if (row.status !== 'ready' && row.status !== 'consumed') {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
    }
    if (row.status === 'ready' && row.consumed_request_id !== null) {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
    }
    if (row.status === 'consumed' && row.consumed_request_id === null) {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
    }
    if (row.status === 'consumed') {
        // The RPC binds this replay to the immutable request, selected plan, and JTI.
        // Do not reinterpret an already-consumed snapshot through a newer catalog.
        return Object.freeze({
            id: row.id,
            userId: row.user_id,
            selectedPlanId,
            state: row.status,
        });
    }
    if (
        Date.parse(row.expires_at) <= (options.nowMs ?? Date.now())
    ) {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_PREFLIGHT_EXPIRED'
        );
    }

    if (
        row.exclusion_decision !== 'exclude'
        && row.exclusion_decision !== 'skip'
    ) {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_EXCLUSION_REQUIRED'
        );
    }
    if (
        (row.exclusion_decision === 'skip' && row.excluded_instagram_id !== null)
        || (
            row.exclusion_decision === 'exclude'
            && (
                row.excluded_instagram_id === null
                || !usernameSchema.safeParse(row.excluded_instagram_id).success
                || row.excluded_instagram_id === row.target_instagram_id
            )
        )
    ) {
        throw new AnalysisV2EntitlementConsumptionError(
            'ANALYSIS_V2_EXCLUSION_REQUIRED'
        );
    }

    if (
        row.access_mode !== 'test_entitlement'
        || !PLAN_IDS.includes(row.capacity_required_plan_id as PlanId)
        || !PLAN_IDS.includes(row.required_plan_id as PlanId)
    ) {
        invalidPlan();
    }

    const catalog = Object.fromEntries(PLAN_IDS.map(planId => {
        const card = row.plan_cards_snapshot[planId];
        if (card.launchStatus !== row.launch_status_snapshot[planId]) invalidPlan();
        return [planId, {
            launchStatus: card.launchStatus,
            relationshipCapacity: card.relationshipCapacity,
            detailedMutualLimit: card.detailedMutualLimit,
        }];
    })) as PlanEligibilityCatalog;
    for (const planId of PLAN_IDS) {
        const card = row.plan_cards_snapshot[planId];
        if (card.selectionState === 'unavailable' && card.unavailableReason === null) invalidPlan();
        if (card.selectionState !== 'unavailable' && card.unavailableReason !== null) invalidPlan();
    }

    if (options.deferPlanSelectionToFreshAdmission) {
        // Counts may move in either direction after preflight. The fresh admission RPC
        // recomputes the selected-plan semantics under the locked server snapshot.
        return Object.freeze({
            id: row.id,
            userId: row.user_id,
            selectedPlanId,
            state: row.status,
        });
    }

    const counts = {
        followers: row.target_followers_count,
        following: row.target_following_count,
    };
    const optionsForPlan = {
        accessMode: 'test_entitlement' as const,
        catalog,
    };
    const eligibility = determinePlanEligibility(counts, optionsForPlan);
    if (
        eligibility.status !== 'eligible'
        || eligibility.capacityRequiredPlanId !== row.capacity_required_plan_id
        || eligibility.requiredPlanId !== row.required_plan_id
        || !assessPlanSelection(selectedPlanId, counts, optionsForPlan).allowed
        || !['required', 'available_upgrade'].includes(
            row.plan_cards_snapshot[selectedPlanId].selectionState
        )
    ) {
        invalidPlan();
    }

    return Object.freeze({
        id: row.id,
        userId: row.user_id,
        selectedPlanId,
        state: row.status,
    });
}

export function hashAnalysisTestEntitlementJti(nonce: string): string {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        throw new Error('ANALYSIS_V2_ENTITLEMENT_JTI_ERROR: invalid nonce.');
    }
    return createHash('sha256')
        .update(`${ENTITLEMENT_JTI_DOMAIN}\n${nonce}`, 'utf8')
        .digest('hex');
}

export async function consumeAnalysisV2TestEntitlement(
    client: AnalysisV2TestEntitlementRpcClient,
    input: ConsumeAnalysisV2TestEntitlementInput
): Promise<ConsumedAnalysisV2TestEntitlement> {
    const parsedInput = consumptionInputSchema.safeParse(input);
    if (!parsedInput.success) {
        throw new Error('ANALYSIS_V2_ENTITLEMENT_CONSUMPTION_ERROR: invalid input.');
    }
    const validatedInput = parsedInput.data;

    const { data, error } = await client.rpc(
        'consume_analysis_v2_test_entitlement',
        {
            p_preflight_id: validatedInput.preflightId,
            p_user_id: validatedInput.userId,
            p_selected_plan_id: validatedInput.selectedPlanId,
            p_entitlement_jti_hash: validatedInput.entitlementJtiHash,
            p_admission_token: validatedInput.admissionToken,
        }
    );

    if (error) {
        if (isBoundedErrorCode(error.message)) {
            throw new AnalysisV2EntitlementConsumptionError(error.message);
        }
        throw new Error(
            'ANALYSIS_V2_ENTITLEMENT_CONSUMPTION_ERROR: '
            + `request creation failed (${safeDatabaseErrorCode(error)}).`
        );
    }

    const parsed = rpcResultSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error(
            'ANALYSIS_V2_ENTITLEMENT_CONSUMPTION_ERROR: RPC result schema is invalid.'
        );
    }
    return {
        requestId: parsed.data[0].request_id,
        created: parsed.data[0].created,
        initialJobKey: parsed.data[0].initial_job_key,
        requestStatus: parsed.data[0].request_status,
        backgroundProcessing: parsed.data[0].background_processing,
    };
}
