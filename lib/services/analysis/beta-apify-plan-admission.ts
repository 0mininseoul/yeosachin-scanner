import { z } from 'zod';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    BETA_APIFY_POOL_CAPACITY_ERROR,
    BETA_APIFY_POOL_PERSISTENCE_ERROR,
    BETA_APIFY_RUNTIME_CONFIG_ERROR,
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    BETA_APIFY_OPERATION_FAMILIES,
    getBetaApifyCreditPoolRuntimeConfig,
    planBetaApifyCreditAllocation,
    type BetaApifyOperationBudgetMap,
    type BetaApifyOperationSlotMap,
    type BetaApifyPoolSnapshot,
} from './beta-apify-credit-runtime';
import type { BetaApifyFreeCredentialSlot } from './beta-apify-credit-pool';
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';
import {
    ANALYSIS_BETA_POOL_BUDGET_DRIFT,
} from './authorized-test-provider-policy';
import {
    getBetaApifyOperationBudgetCatalog,
    getRequiredBetaApifyOperationBudgetCatalog,
} from './beta-apify-operation-budget';
import {
    emitBetaApifyCreditTelemetry,
    type BetaApifyCreditTelemetry,
} from './beta-apify-credit-telemetry';

/** Public boundary for a checkout-free beta start. Never forwards provider details. */
export const BETA_APIFY_PLAN_ADMISSION_ERROR = BETA_APIFY_POOL_CAPACITY_ERROR;
export const BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR = BETA_APIFY_POOL_PERSISTENCE_ERROR;
export const BETA_APIFY_PLAN_ADMISSION_INVALID_INPUT = 'ANALYSIS_BETA_PLAN_ADMISSION_INVALID_INPUT';
export const BETA_APIFY_PLAN_ADMISSION_INVALID_RESULT = 'ANALYSIS_BETA_PLAN_ADMISSION_INVALID_RESULT';
export const BETA_APIFY_PLAN_ACCESS_UNAVAILABLE =
    'ANALYSIS_BETA_PLAN_ACCESS_UNAVAILABLE';
export const BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT =
    'ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT';

const UUID = z.string().uuid();
const planId = z.enum(['basic', 'standard', 'plus']);
const slot = z.enum(BETA_APIFY_FREE_CREDENTIAL_SLOTS);
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
    replay(input: Readonly<{
        preflightId: string;
        userId: string;
        admissionToken: string;
        admissionGeneration: number;
        selectedPlanId: PlanId;
    }>): Promise<z.infer<typeof resultSchema> | null>;
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

export interface BetaApifyConsumedReplayStore {
    replayConsumed(input: Readonly<{
        preflightId: string;
        userId: string;
        selectedPlanId: PlanId;
    }>): Promise<z.infer<typeof resultSchema> | null>;
}

function capacityError(): Error {
    return new Error(BETA_APIFY_PLAN_ADMISSION_ERROR);
}

function invalidInputError(): Error {
    return new Error(BETA_APIFY_PLAN_ADMISSION_INVALID_INPUT);
}

function persistenceError(): Error {
    return new Error(BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR);
}

function accessError(): Error {
    return new Error(BETA_APIFY_PLAN_ACCESS_UNAVAILABLE);
}

function invalidResultError(): Error {
    return new Error(BETA_APIFY_PLAN_ADMISSION_INVALID_RESULT);
}

function replayIdentityConflictError(): Error {
    return new Error(BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT);
}

function validUuid(value: string): string {
    try { return UUID.parse(value).toLowerCase(); } catch { throw invalidInputError(); }
}

function validAge(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 900) throw invalidInputError();
    return value;
}

function validGeneration(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw invalidInputError();
    return value;
}

function normalizeResult(data: unknown): unknown {
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function parsedResult(data: unknown): z.infer<typeof resultSchema> {
    const parsed = resultSchema.safeParse(normalizeResult(data));
    if (!parsed.success) throw invalidResultError();
    return Object.freeze(parsed.data);
}

/**
 * Narrow service-role adapter. Inputs are frozen aliases, maps, and aggregate USD
 * budgets only; no provider token or account identity reaches the database.
 */
const CAPACITY_FAILURE_CODES = Object.freeze([
    'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
    'ANALYSIS_BETA_POOL_SNAPSHOT_CONFLICT',
    'ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE',
    'ANALYSIS_BETA_POOL_SNAPSHOT_INVALID',
    'ANALYSIS_BETA_POOL_SNAPSHOT_STALE',
    'ANALYSIS_BETA_POOL_SNAPSHOT_UNHEALTHY',
    'ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE',
    'ANALYSIS_BETA_PREFLIGHT_NOT_ELIGIBLE',
    'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
]);

function knownAccessFailure(error: { message?: string }): boolean {
    return error.message === 'ANALYSIS_BETA_ACCESS_UNAVAILABLE'
        || error.message?.startsWith('ANALYSIS_BETA_ACCESS_UNAVAILABLE ') === true
        || error.message?.startsWith('ANALYSIS_BETA_ACCESS_UNAVAILABLE\n') === true;
}

function knownCapacityFailure(error: { message?: string }): boolean {
    return typeof error.message === 'string' && CAPACITY_FAILURE_CODES.some(code => (
        error.message === code
        || error.message?.startsWith(`${code} `)
        || error.message?.startsWith(`${code}\n`)
    ));
}

function knownReplayIdentityConflict(error: { message?: string }): boolean {
    return error.message === BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT
        || error.message?.startsWith(
            `${BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT} `
        ) === true
        || error.message?.startsWith(
            `${BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT}\n`
        ) === true;
}

function assertRuntimeBudgetsFitFrozenCatalog(
    selectedPlanId: PlanId,
    env?: Record<string, string | undefined>
): void {
    try {
        const required = getRequiredBetaApifyOperationBudgetCatalog(selectedPlanId, env);
        const frozen = getBetaApifyOperationBudgetCatalog(selectedPlanId);
        if (BETA_APIFY_OPERATION_FAMILIES.some(operation => (
            required[operation] > frozen[operation]
        ))) {
            throw new Error(ANALYSIS_BETA_POOL_BUDGET_DRIFT);
        }
    } catch {
        throw new Error(ANALYSIS_BETA_POOL_BUDGET_DRIFT);
    }
}

function sanitizedBoundaryError(error: unknown): Error {
    const message = error instanceof Error ? error.message : '';
    if ([
        BETA_APIFY_PLAN_ADMISSION_ERROR,
        BETA_APIFY_PLAN_ADMISSION_PERSISTENCE_ERROR,
        BETA_APIFY_PLAN_ADMISSION_INVALID_INPUT,
        BETA_APIFY_PLAN_ADMISSION_INVALID_RESULT,
        BETA_APIFY_PLAN_ACCESS_UNAVAILABLE,
        BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT,
        BETA_APIFY_RUNTIME_CONFIG_ERROR,
    ].includes(message)) return new Error(message);
    return persistenceError();
}

async function rpc(
    client: BetaApifyPlanAdmissionStoreClient,
    name: string,
    params: Record<string, unknown>
): Promise<unknown> {
    let response: Awaited<ReturnType<BetaApifyPlanAdmissionStoreClient['rpc']>>;
    try {
        response = await client.rpc(name, params);
    } catch {
        throw persistenceError();
    }
    if (response.error) {
        if (knownAccessFailure(response.error)) throw accessError();
        if (knownReplayIdentityConflict(response.error)) {
            throw replayIdentityConflictError();
        }
        if (knownCapacityFailure(response.error)) throw capacityError();
        throw persistenceError();
    }
    return normalizeResult(response.data);
}

function consumedIdentityParams(input: {
    preflightId: string;
    userId: string;
    selectedPlanId: PlanId;
}): Record<string, unknown> {
    let selectedPlanId: PlanId;
    try { selectedPlanId = planId.parse(input.selectedPlanId); } catch { throw invalidInputError(); }
    return {
        p_preflight_id: validUuid(input.preflightId),
        p_user_id: validUuid(input.userId),
        p_selected_plan_id: selectedPlanId,
    };
}

function identityParams(input: {
    preflightId: string;
    userId: string;
    admissionToken: string;
    admissionGeneration: number;
    selectedPlanId: PlanId;
}): Record<string, unknown> {
    let selectedPlanId: PlanId;
    try { selectedPlanId = planId.parse(input.selectedPlanId); } catch { throw invalidInputError(); }
    return {
        p_preflight_id: validUuid(input.preflightId),
        p_user_id: validUuid(input.userId),
        p_admission_token: validUuid(input.admissionToken),
        p_admission_generation: validGeneration(input.admissionGeneration),
        p_selected_plan_id: selectedPlanId,
    };
}

export function createBetaApifyPlanAdmissionStore(
    client: BetaApifyPlanAdmissionStoreClient
): Pick<BetaApifyPlanAdmissionStore, 'replay' | 'activate'>
    & BetaApifyConsumedReplayStore {
    return Object.freeze({
        async replayConsumed(
            input: Parameters<BetaApifyConsumedReplayStore['replayConsumed']>[0]
        ) {
            const data = await rpc(
                client,
                'load_analysis_v2_betatest_consumed_replay',
                consumedIdentityParams(input)
            );
            if (data === null) return null;
            return parsedResult(data);
        },
        async replay(input: Parameters<BetaApifyPlanAdmissionStore['replay']>[0]) {
            const data = await rpc(
                client,
                'load_analysis_v2_betatest_plan_replay',
                identityParams(input)
            );
            if (data === null) return null;
            return parsedResult(data);
        },
        async activate(input: Parameters<BetaApifyPlanAdmissionStore['activate']>[0]) {
            const slots = operationSlots.safeParse(input.operationSlotMap);
            const budgets = operationBudgets.safeParse(input.operationBudgetMap);
            if (!slots.success || !budgets.success
                || budgets.data['target-profile'] !== BETA_APIFY_TARGET_PROFILE_BUDGET_USD) {
                throw invalidInputError();
            }
            const data = await rpc(client, 'admit_analysis_v2_betatest_plan', {
                    ...identityParams(input),
                    p_operation_slot_map: slots.data,
                    p_operation_budget_map: budgets.data,
                    p_max_snapshot_age_seconds: validAge(input.maxSnapshotAgeSeconds),
                });
            return parsedResult(data);
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
    telemetry?: BetaApifyCreditTelemetry;
}>): Promise<z.infer<typeof resultSchema>> {
    const preflightId = validUuid(input.preflightId);
    const userId = validUuid(input.userId);
    const admissionToken = validUuid(input.admissionToken);
    const admissionGeneration = validGeneration(input.admissionGeneration);
    const age = validAge(input.maxSnapshotAgeSeconds);
    let selectedPlanId: PlanId;
    try { selectedPlanId = planId.parse(input.selectedPlanId); } catch { throw invalidInputError(); }
    const identity = { preflightId, userId, admissionToken, admissionGeneration, selectedPlanId };
    let existing: z.infer<typeof resultSchema> | null;
    try { existing = await input.store.replay(identity); } catch (error) {
        throw sanitizedBoundaryError(error);
    }
    if (existing) return parsedResult(existing);

    const emitRejected = () => emitBetaApifyCreditTelemetry(input.telemetry, {
        event: 'betatest_apify_credit.allocation_rejected',
        severity: 'warn',
    });

    const config = getBetaApifyCreditPoolRuntimeConfig(input.env);
    if (!config.enabled) throw new Error(BETA_APIFY_RUNTIME_CONFIG_ERROR);
    assertRuntimeBudgetsFitFrozenCatalog(selectedPlanId, input.env);
    let hold: Awaited<ReturnType<BetaApifyPlanAdmissionStore['loadPreflightHold']>>;
    try { hold = await input.store.loadPreflightHold(preflightId); } catch (error) {
        emitRejected();
        throw sanitizedBoundaryError(error);
    }
    if (!exactHold(hold, preflightId)) {
        emitRejected();
        throw capacityError();
    }
    let snapshots: readonly BetaApifyPoolSnapshot[];
    try { snapshots = await input.store.loadSnapshots(age); } catch (error) {
        emitRejected();
        throw sanitizedBoundaryError(error);
    }
    let allocation;
    try {
        allocation = planBetaApifyCreditAllocation({
            effectiveHeadrooms: snapshots,
            targetProfileSlot: hold.credentialSlot,
            selectedPlanId,
            env: input.env,
        });
    } catch (error) {
        emitRejected();
        throw error;
    }
    try {
        const result = await input.store.activate({
            preflightId, userId, admissionToken, admissionGeneration, selectedPlanId, maxSnapshotAgeSeconds: age,
            operationSlotMap: allocation.operationSlotMap,
            operationBudgetMap: allocation.operationBudgetMap,
        });
        const parsed = parsedResult(result);
        if (!parsed.replayed) {
            emitBetaApifyCreditTelemetry(input.telemetry, {
                event: 'betatest_apify_credit.allocation_accepted',
                severity: 'info',
                reservationUsd: Object.values(allocation.perSlotReservedUsd)
                    .reduce((total, amount) => total + amount, 0),
            });
        }
        return parsed;
    } catch (error) {
        let raced: z.infer<typeof resultSchema> | null;
        try { raced = await input.store.replay(identity); } catch (replayError) {
            emitRejected();
            throw sanitizedBoundaryError(replayError);
        }
        if (raced) return parsedResult(raced);
        emitRejected();
        throw sanitizedBoundaryError(error);
    }
}
