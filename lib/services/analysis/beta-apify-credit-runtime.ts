import { z } from 'zod';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    BETA_APIFY_FREE_CREDENTIAL_SLOTS,
    isBetaApifyFreeCredentialSlot,
    type BetaApifyFreeCredentialSlot,
} from './beta-apify-credit-pool';
import {
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    getBetaApifyOperationBudgetCatalog,
} from './beta-apify-operation-budget';
export {
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    getBetaApifyOperationBudgetCatalog,
    getRequiredBetaApifyOperationBudgetCatalog,
} from './beta-apify-operation-budget';

export const BETA_APIFY_RUNTIME_CONFIG_ERROR = 'ANALYSIS_BETA_RUNTIME_CONFIG_INVALID';
export const BETA_APIFY_POOL_CAPACITY_ERROR = 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE';
export const BETA_APIFY_POOL_PERSISTENCE_ERROR = 'ANALYSIS_BETA_POOL_PERSISTENCE_ERROR';

export const BETA_APIFY_OPERATION_FAMILIES = Object.freeze([
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'profile-repair',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const);

export type BetaApifyOperationFamily = typeof BETA_APIFY_OPERATION_FAMILIES[number];
export type BetaApifyOperationSlotMap = Readonly<Record<
    BetaApifyOperationFamily,
    BetaApifyFreeCredentialSlot
>>;
export type BetaApifyOperationBudgetMap = Readonly<Record<BetaApifyOperationFamily, number>>;
export type BetaApifySlotReservationMap = Readonly<Record<BetaApifyFreeCredentialSlot, number>>;

const MAX_USD = 100_000;
const MAX_BUDGET_USD = 1_000;
const DECIMAL_SCALE = 1_000_000_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = z.string().datetime({ offset: true });
const slotSchema = z.enum(BETA_APIFY_FREE_CREDENTIAL_SLOTS);
const usdSchema = z.number().finite().min(0).max(MAX_USD).refine(
    value => Math.abs(Math.round(value * DECIMAL_SCALE) - value * DECIMAL_SCALE) < 0.01,
    'USD must be representable at 12 decimal places.'
);
const budgetSchema = usdSchema.refine(
    value => value > 0 && value <= MAX_BUDGET_USD,
    'Budget must be positive and within database bounds.'
);

const persistedSnapshotSchema = z.object({
    credentialSlot: slotSchema,
    monthlyLimitUsd: usdSchema,
    monthlyUsageUsd: usdSchema,
    billingCycleStartAt: TIMESTAMP,
    billingCycleEndAt: TIMESTAMP,
    observedAt: TIMESTAMP,
    healthState: z.literal('healthy'),
}).strict();
const snapshotSchema = persistedSnapshotSchema.extend({
    effectiveHeadroomUsd: usdSchema,
}).strict().superRefine((value, context) => {
    if (Date.parse(value.billingCycleStartAt) > Date.parse(value.observedAt)
        || Date.parse(value.observedAt) >= Date.parse(value.billingCycleEndAt)) {
        context.addIssue({ code: 'custom', message: 'Snapshot cycle is invalid.' });
    }
});

const exactPoolSnapshotsSchema = z.array(snapshotSchema).length(
    BETA_APIFY_FREE_CREDENTIAL_SLOTS.length,
).superRefine((rows, context) => {
    const received = rows.map(row => row.credentialSlot);
    if (new Set(received).size !== BETA_APIFY_FREE_CREDENTIAL_SLOTS.length
        || BETA_APIFY_FREE_CREDENTIAL_SLOTS.some(slot => !received.includes(slot))) {
        context.addIssue({ code: 'custom', message: 'Exact beta slot set required.' });
    }
});

const operationSlotMapSchema = z.object(Object.fromEntries(
    BETA_APIFY_OPERATION_FAMILIES.map(operation => [operation, slotSchema])
) as Record<BetaApifyOperationFamily, typeof slotSchema>).strict();
const operationBudgetMapSchema = z.object(Object.fromEntries(
    BETA_APIFY_OPERATION_FAMILIES.map(operation => [operation, budgetSchema])
) as Record<BetaApifyOperationFamily, typeof budgetSchema>).strict();

const allocationSchema = z.object({
    allocationId: z.string().regex(UUID_PATTERN),
    preflightId: z.string().regex(UUID_PATTERN),
    requestId: z.string().regex(UUID_PATTERN).nullable(),
    lifecycleState: z.enum(['preflight_held', 'active', 'settled']),
    policyVersion: z.literal('betatest-free-pool-v1'),
    selectedPlanId: z.enum(['basic', 'standard', 'plus']).nullable(),
    operationSlotMap: operationSlotMapSchema.nullable(),
    operationBudgetMap: operationBudgetMapSchema.nullable(),
    expiresAt: TIMESTAMP,
}).strict();
const preflightHoldSchema = z.object({
    allocationId: z.string().regex(UUID_PATTERN),
    preflightId: z.string().regex(UUID_PATTERN),
    credentialSlot: slotSchema,
    targetProfileBudgetUsd: usdSchema.refine(
        value => value === BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
        'Target budget must remain frozen.'
    ),
}).strict();
const settlementSchema = z.object({
    allocationId: z.string().regex(UUID_PATTERN),
    lifecycleState: z.enum(['preflight_held', 'active', 'settled']),
    settledFamilies: z.number().int().min(0).max(8),
    heldFamilies: z.number().int().min(0).max(8),
    actualUsd: usdSchema,
    releasedUsd: usdSchema,
}).strict();

export interface BetaApifyPoolStoreClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

export type BetaApifyPoolSnapshot = z.infer<typeof snapshotSchema>;
export type BetaApifyPoolAllocation = z.infer<typeof allocationSchema>;

export interface BetaApifyAllocationPlan {
    readonly operationSlotMap: BetaApifyOperationSlotMap;
    readonly operationBudgetMap: BetaApifyOperationBudgetMap;
    readonly perSlotReservedUsd: BetaApifySlotReservationMap;
}

function exactUsd(value: number, limit = MAX_USD): number {
    if (!Number.isFinite(value) || value < 0 || value > limit) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    const rounded = Math.round(value * DECIMAL_SCALE) / DECIMAL_SCALE;
    if (Math.abs(Math.round(rounded * DECIMAL_SCALE) - rounded * DECIMAL_SCALE) >= 0.01) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    return rounded;
}

function parseStrictBoolean(value: string | undefined): boolean {
    if (value === undefined || value.trim() === '') return false;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
    throw new Error(BETA_APIFY_RUNTIME_CONFIG_ERROR);
}

function boundedInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    if (!/^\d+$/.test(value.trim())) throw new Error(BETA_APIFY_RUNTIME_CONFIG_ERROR);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 900) {
        throw new Error(BETA_APIFY_RUNTIME_CONFIG_ERROR);
    }
    return parsed;
}

/** Returns only non-secret runtime controls. Beta admission stays disabled unless explicitly set. */
export function getBetaApifyCreditPoolRuntimeConfig(
    env: Record<string, string | undefined> = process.env
): Readonly<{ enabled: boolean; maxSnapshotAgeSeconds: number; refreshIntervalSeconds: number }> {
    return Object.freeze({
        enabled: parseStrictBoolean(env.BETATEST_FREE_POOL_ENABLED),
        maxSnapshotAgeSeconds: boundedInteger(env.BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS, 300),
        refreshIntervalSeconds: boundedInteger(env.BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS, 60),
    });
}

function normalizedRpcData(data: unknown): unknown {
    return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function knownPoolFailure(error: { code?: string; message?: string }): string | null {
    const message = error.message;
    if (typeof message !== 'string') return null;
    if (/^ANALYSIS_BETA_POOL_(?:CAPACITY_UNAVAILABLE|SNAPSHOT_(?:STALE|UNHEALTHY|INCOMPLETE|INVALID)|ALLOCATION_(?:INVALID|CONFLICT))\b/.test(message)) {
        return BETA_APIFY_POOL_CAPACITY_ERROR;
    }
    return null;
}

function persistenceFailure(error: { code?: string; message?: string } | null): never {
    const known = error ? knownPoolFailure(error) : null;
    throw new Error(known ?? BETA_APIFY_POOL_PERSISTENCE_ERROR);
}

function ensureExactPoolSnapshots(value: unknown): readonly BetaApifyPoolSnapshot[] {
    const parsed = exactPoolSnapshotsSchema.safeParse(value);
    if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    return Object.freeze(parsed.data.map(row => Object.freeze({ ...row })));
}

function exactHeadrooms(value: readonly BetaApifyPoolSnapshot[]): Readonly<Record<BetaApifyFreeCredentialSlot, number>> {
    let snapshots: readonly BetaApifyPoolSnapshot[];
    try {
        snapshots = ensureExactPoolSnapshots(value);
    } catch {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    return Object.freeze(Object.fromEntries(BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(slot => {
        const snapshot = snapshots.find(row => row.credentialSlot === slot);
        if (!snapshot) throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
        return [slot, exactUsd(snapshot.effectiveHeadroomUsd)];
    })) as Record<BetaApifyFreeCredentialSlot, number>);
}

/** Pure best-fit/decreasing planner. The database repeats the headroom fence transactionally. */
export function planBetaApifyCreditAllocation(input: {
    readonly effectiveHeadrooms: readonly BetaApifyPoolSnapshot[];
    readonly targetProfileSlot: BetaApifyFreeCredentialSlot;
    readonly selectedPlanId: PlanId;
    readonly env?: Record<string, string | undefined>;
}): BetaApifyAllocationPlan {
    if (!isBetaApifyFreeCredentialSlot(input.targetProfileSlot)) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    const remaining = { ...exactHeadrooms(input.effectiveHeadrooms) };
    const budgets = getBetaApifyOperationBudgetCatalog(input.selectedPlanId, input.env);
    const slots: Partial<Record<BetaApifyOperationFamily, BetaApifyFreeCredentialSlot>> = {};
    if (remaining[input.targetProfileSlot] < budgets['target-profile']) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    slots['target-profile'] = input.targetProfileSlot;
    remaining[input.targetProfileSlot] = exactUsd(
        remaining[input.targetProfileSlot] - budgets['target-profile']
    );
    const operations = BETA_APIFY_OPERATION_FAMILIES
        .filter(operation => operation !== 'target-profile')
        .map((operation, order) => ({ operation, order, budget: budgets[operation] }))
        .sort((left, right) => right.budget - left.budget || left.order - right.order);
    for (const { operation, budget } of operations) {
        const selected = BETA_APIFY_FREE_CREDENTIAL_SLOTS
            .map((slot, order) => ({ slot, order, headroom: remaining[slot] }))
            .filter(candidate => candidate.headroom + Number.EPSILON >= budget)
            .sort((left, right) => (
                (left.headroom - budget) - (right.headroom - budget)
                || left.order - right.order
            ))[0];
        if (!selected) throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
        slots[operation] = selected.slot;
        remaining[selected.slot] = exactUsd(remaining[selected.slot] - budget);
    }
    const operationSlotMap = operationSlotMapSchema.safeParse(slots);
    const operationBudgetMap = operationBudgetMapSchema.safeParse(budgets);
    if (!operationSlotMap.success || !operationBudgetMap.success) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    const perSlotReserved = Object.fromEntries(BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(slot => [slot, 0])) as Record<BetaApifyFreeCredentialSlot, number>;
    for (const operation of BETA_APIFY_OPERATION_FAMILIES) {
        const slot = operationSlotMap.data[operation];
        perSlotReserved[slot] = exactUsd(perSlotReserved[slot] + operationBudgetMap.data[operation]);
    }
    const headrooms = exactHeadrooms(input.effectiveHeadrooms);
    const totalReservedUsd = exactUsd(
        Object.values(perSlotReserved).reduce((total, value) => total + value, 0),
        MAX_USD * BETA_APIFY_FREE_CREDENTIAL_SLOTS.length
    );
    const totalHeadroomUsd = exactUsd(
        Object.values(headrooms).reduce((total, value) => total + value, 0),
        MAX_USD * BETA_APIFY_FREE_CREDENTIAL_SLOTS.length
    );
    if (totalReservedUsd > totalHeadroomUsd + Number.EPSILON) {
        throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
    }
    for (const slot of BETA_APIFY_FREE_CREDENTIAL_SLOTS) {
        if (perSlotReserved[slot] > headrooms[slot] + Number.EPSILON) {
            throw new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
        }
    }
    return Object.freeze({
        operationSlotMap: Object.freeze({ ...operationSlotMap.data }),
        operationBudgetMap: Object.freeze({ ...operationBudgetMap.data }),
        perSlotReservedUsd: Object.freeze({ ...perSlotReserved }),
    });
}

export interface BetaApifyCreditPoolStore {
    upsertSnapshots(snapshots: readonly BetaApifyPoolSnapshot[]): Promise<readonly BetaApifyPoolSnapshot[]>;
    loadSnapshots(maxSnapshotAgeSeconds: number): Promise<readonly BetaApifyPoolSnapshot[]>;
    /** Service-only retry identity; intentionally excludes user ids and all provider data. */
    loadPreflightHold(preflightId: string): Promise<z.infer<typeof preflightHoldSchema> | null>;
    holdPreflight(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
        claimToken: string;
        credentialSlot: BetaApifyFreeCredentialSlot;
        maxSnapshotAgeSeconds: number;
    }): Promise<BetaApifyPoolAllocation>;
    activateRequest(input: { preflightId: string; requestId: string; userId: string; selectedPlanId: PlanId; operationSlotMap: BetaApifyOperationSlotMap; operationBudgetMap: BetaApifyOperationBudgetMap; maxSnapshotAgeSeconds: number }): Promise<BetaApifyPoolAllocation>;
    settle(allocationId: string, reason: 'request_terminal' | 'preflight_expired' | 'recovery'): Promise<z.infer<typeof settlementSchema>>;
    recover(limit?: number): Promise<readonly z.infer<typeof settlementSchema>[]>;
    archive(limit?: number): Promise<number>;
}

function checkedUuid(value: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    return value.toLowerCase();
}

function checkedAge(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 900) {
        throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    }
    return value;
}

async function invokeRaw(client: BetaApifyPoolStoreClient, name: string, params: Record<string, unknown>): Promise<unknown> {
    let result: Awaited<ReturnType<BetaApifyPoolStoreClient['rpc']>>;
    try {
        result = await client.rpc(name, params);
    } catch {
        throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    }
    const { data, error } = result;
    if (error) persistenceFailure(error);
    return data;
}

async function invoke(client: BetaApifyPoolStoreClient, name: string, params: Record<string, unknown>): Promise<unknown> {
    return normalizedRpcData(await invokeRaw(client, name, params));
}

export function createBetaApifyCreditPoolStore(client: BetaApifyPoolStoreClient): BetaApifyCreditPoolStore {
    const store: BetaApifyCreditPoolStore = {
        async upsertSnapshots(snapshots) {
            const parsed = exactPoolSnapshotsSchema.safeParse(snapshots);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            const payload = parsed.data.map(snapshot => ({
                credentialSlot: snapshot.credentialSlot,
                monthlyLimitUsd: snapshot.monthlyLimitUsd,
                monthlyUsageUsd: snapshot.monthlyUsageUsd,
                billingCycleStartAt: snapshot.billingCycleStartAt,
                billingCycleEndAt: snapshot.billingCycleEndAt,
                observedAt: snapshot.observedAt,
                healthState: snapshot.healthState,
            }));
            const data = await invoke(client, 'upsert_analysis_beta_apify_credit_snapshots', { p_snapshots: payload });
            // The RPC returns the same exact sanitized snapshot shape, without local headroom.
            return ensureExactPoolSnapshots(data);
        },
        async loadSnapshots(maxSnapshotAgeSeconds) {
            const data = await invoke(client, 'load_analysis_beta_apify_credit_pool', {
                p_max_age_seconds: checkedAge(maxSnapshotAgeSeconds),
            });
            return ensureExactPoolSnapshots(data);
        },
        async loadPreflightHold(preflightId) {
            const data = await invoke(client, 'load_analysis_beta_apify_preflight_hold', {
                p_preflight_id: checkedUuid(preflightId),
            });
            if (data === null) return null;
            const parsed = preflightHoldSchema.safeParse(data);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            return Object.freeze(parsed.data);
        },
        async holdPreflight(input) {
            const generation = z.number().int().min(1).max(100).parse(
                input.prepareGeneration
            );
            const data = await invoke(
                client,
                'prepare_analysis_beta_apify_preflight_credit',
                {
                p_preflight_id: checkedUuid(input.preflightId),
                p_user_id: checkedUuid(input.userId),
                p_prepare_generation: generation,
                p_prepare_token: checkedUuid(input.prepareToken),
                p_claim_token: checkedUuid(input.claimToken),
                p_credential_slot: slotSchema.parse(input.credentialSlot),
                p_target_profile_budget_usd: BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
                p_max_snapshot_age_seconds: checkedAge(input.maxSnapshotAgeSeconds),
                }
            );
            const parsed = allocationSchema.safeParse(data);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            return Object.freeze(parsed.data);
        },
        async activateRequest(input) {
            const slots = operationSlotMapSchema.safeParse(input.operationSlotMap);
            const budgets = operationBudgetMapSchema.safeParse(input.operationBudgetMap);
            if (!slots.success || !budgets.success || budgets.data['target-profile'] !== BETA_APIFY_TARGET_PROFILE_BUDGET_USD) {
                throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            }
            const data = await invoke(client, 'activate_analysis_beta_apify_request_credit', {
                p_preflight_id: checkedUuid(input.preflightId),
                p_request_id: checkedUuid(input.requestId),
                p_user_id: checkedUuid(input.userId),
                p_selected_plan_id: z.enum(['basic', 'standard', 'plus']).parse(input.selectedPlanId),
                p_operation_slot_map: slots.data,
                p_operation_budget_map: budgets.data,
                p_max_snapshot_age_seconds: checkedAge(input.maxSnapshotAgeSeconds),
            });
            const parsed = allocationSchema.safeParse(data);
            if (!parsed.success || parsed.data.lifecycleState !== 'active' || parsed.data.requestId !== input.requestId.toLowerCase()) {
                throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            }
            return Object.freeze(parsed.data);
        },
        async settle(allocationId, reason) {
            const data = await invoke(client, 'settle_analysis_beta_apify_credit_allocation', {
                p_allocation_id: checkedUuid(allocationId), p_reason: z.enum(['request_terminal', 'preflight_expired', 'recovery']).parse(reason),
            });
            const parsed = settlementSchema.safeParse(data);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            return Object.freeze(parsed.data);
        },
        async recover(limit = 100) {
            // The RPC's JSONB value is itself an array. Do not apply the generic
            // one-row unwrapping heuristic or a single recovered allocation
            // would be mistaken for a scalar object and discarded.
            const data = await invokeRaw(client, 'recover_analysis_beta_apify_credit_allocations', {
                p_limit: z.number().int().min(1).max(1000).parse(limit),
            });
            const parsed = z.array(settlementSchema).safeParse(data);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            return Object.freeze(parsed.data.map(value => Object.freeze(value)));
        },
        async archive(limit = 100) {
            const data = await invoke(client, 'archive_settled_analysis_beta_apify_credit_allocations', {
                p_limit: z.number().int().min(1).max(1000).parse(limit),
            });
            const parsed = z.number().int().min(0).safeParse(data);
            if (!parsed.success) throw new Error(BETA_APIFY_POOL_PERSISTENCE_ERROR);
            return parsed.data;
        },
    };
    return Object.freeze(store);
}
