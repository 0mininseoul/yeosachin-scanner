import { z } from 'zod';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    BETA_APIFY_POOL_CAPACITY_ERROR,
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    BETA_APIFY_OPERATION_FAMILIES,
    getBetaApifyCreditPoolRuntimeConfig,
    planBetaApifyCreditAllocation,
    type BetaApifyOperationBudgetMap,
    type BetaApifyOperationSlotMap,
    type BetaApifyPoolSnapshot,
} from './beta-apify-credit-runtime';
import type { BetaApifyFreeCredentialSlot } from './beta-apify-credit-pool';

/** Public boundary for a checkout-free beta start. Never forwards provider details. */
export const BETA_APIFY_PLAN_ADMISSION_ERROR = BETA_APIFY_POOL_CAPACITY_ERROR;

const UUID = z.string().uuid();
const planId = z.enum(['basic', 'standard', 'plus']);
const slot = z.enum(['primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary']);
const operationSlots = z.object(Object.fromEntries(
    BETA_APIFY_OPERATION_FAMILIES.map(operation => [operation, slot])
) as Record<(typeof BETA_APIFY_OPERATION_FAMILIES)[number], typeof slot>).strict();
const usd = z.number().finite().positive().max(1_000);
const operationBudgets = z.object(Object.fromEntries(
    BETA_APIFY_OPERATION_FAMILIES.map(operation => [operation, usd])
) as Record<(typeof BETA_APIFY_OPERATION_FAMILIES)[number], typeof usd>).strict();
const resultSchema = z.object({
    requestId: UUID,
    initialJobKey: z.literal('coordinator:bootstrap'),
    allocationId: UUID,
    replayed: z.boolean(),
}).strict();

export interface BetaApifyPlanAdmissionStoreClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

export interface BetaApifyPlanAdmissionStore {
    loadPreflightHold(preflightId: string): Promise<Readonly<{
        allocationId: string;
        preflightId: string;
        credentialSlot: BetaApifyFreeCredentialSlot;
        targetProfileBudgetUsd: number;
    }> | null>;
    loadSnapshots(maxSnapshotAgeSeconds: number): Promise<readonly BetaApifyPoolSnapshot[]>;
    activate(input: Readonly<{
        preflightId: string;
        userId: string;
        admissionToken: string;
        admissionGeneration: number;
        selectedPlanId: PlanId;
        maxSnapshotAgeSeconds: number;
        operationSlotMap: BetaApifyOperationSlotMap;
        operationBudgetMap: BetaApifyOperationBudgetMap;
    }>): Promise<z.infer<typeof resultSchema>>;
}

function capacityError(): Error {
    return new Error(BETA_APIFY_PLAN_ADMISSION_ERROR);
}

function validUuid(value: string): string {
    try { return UUID.parse(value).toLowerCase(); } catch { throw capacityError(); }
}

function validAge(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 900) throw capacityError();
    return value;
}

function validGeneration(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw capacityError();
    return value;
}

function normalizeResult(data: unknown): unknown {
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function parsedResult(data: unknown): z.infer<typeof resultSchema> {
    const parsed = resultSchema.safeParse(normalizeResult(data));
    if (!parsed.success) throw capacityError();
    return Object.freeze(parsed.data);
}

/**
 * Narrow service-role adapter. Inputs are frozen aliases, maps, and aggregate USD
 * budgets only; no provider token or account identity reaches the database.
 */
export function createBetaApifyPlanAdmissionStore(client: BetaApifyPlanAdmissionStoreClient): Pick<BetaApifyPlanAdmissionStore, 'activate'> {
    return Object.freeze({
        async activate(input) {
            const slots = operationSlots.safeParse(input.operationSlotMap);
            const budgets = operationBudgets.safeParse(input.operationBudgetMap);
            if (!slots.success || !budgets.success
                || budgets.data['target-profile'] !== BETA_APIFY_TARGET_PROFILE_BUDGET_USD) {
                throw capacityError();
            }
            let response: Awaited<ReturnType<BetaApifyPlanAdmissionStoreClient['rpc']>>;
            try {
                response = await client.rpc('admit_analysis_v2_betatest_plan', {
                    p_preflight_id: validUuid(input.preflightId),
                    p_user_id: validUuid(input.userId),
                    p_admission_token: validUuid(input.admissionToken),
                    p_admission_generation: validGeneration(input.admissionGeneration),
                    p_selected_plan_id: planId.parse(input.selectedPlanId),
                    p_operation_slot_map: slots.data,
                    p_operation_budget_map: budgets.data,
                    p_max_snapshot_age_seconds: validAge(input.maxSnapshotAgeSeconds),
                });
            } catch {
                throw capacityError();
            }
            if (response.error) throw capacityError();
            return parsedResult(response.data);
        },
    });
}

function exactHold(
    value: Awaited<ReturnType<BetaApifyPlanAdmissionStore['loadPreflightHold']>>,
    preflightId: string
): value is NonNullable<Awaited<ReturnType<BetaApifyPlanAdmissionStore['loadPreflightHold']>>> {
    return value !== null
        && value.preflightId.toLowerCase() === preflightId.toLowerCase()
        && slot.safeParse(value.credentialSlot).success
        && value.targetProfileBudgetUsd === BETA_APIFY_TARGET_PROFILE_BUDGET_USD
        && UUID.safeParse(value.allocationId).success;
}

/**
 * Plans from current sanitized snapshots, but leaves the final capacity fence,
 * request creation, and policy bind to one database transaction.
 */
export async function admitBetaApifyPlan(input: Readonly<{
    preflightId: string;
    userId: string;
    admissionToken: string;
    admissionGeneration: number;
    selectedPlanId: PlanId;
    maxSnapshotAgeSeconds: number;
    store: BetaApifyPlanAdmissionStore;
    env?: Record<string, string | undefined>;
}>): Promise<z.infer<typeof resultSchema>> {
    try {
        const preflightId = validUuid(input.preflightId);
        const userId = validUuid(input.userId);
        const admissionToken = validUuid(input.admissionToken);
        const admissionGeneration = validGeneration(input.admissionGeneration);
        const age = validAge(input.maxSnapshotAgeSeconds);
        const selectedPlanId = planId.parse(input.selectedPlanId);
        if (!getBetaApifyCreditPoolRuntimeConfig(input.env).enabled) throw capacityError();
        const hold = await input.store.loadPreflightHold(preflightId);
        if (!exactHold(hold, preflightId)) throw capacityError();
        const snapshots = await input.store.loadSnapshots(age);
        const allocation = planBetaApifyCreditAllocation({
            effectiveHeadrooms: snapshots,
            targetProfileSlot: hold.credentialSlot,
            selectedPlanId,
            env: input.env,
        });
        const result = await input.store.activate({
            preflightId, userId, admissionToken, admissionGeneration, selectedPlanId, maxSnapshotAgeSeconds: age,
            operationSlotMap: allocation.operationSlotMap,
            operationBudgetMap: allocation.operationBudgetMap,
        });
        return parsedResult(result);
    } catch {
        throw capacityError();
    }
}
