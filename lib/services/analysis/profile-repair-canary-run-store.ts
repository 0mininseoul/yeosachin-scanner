import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    isApifyCredentialSlot,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';

export const PROFILE_REPAIR_CANARY_VERSION = 'profile-repair-canary-v1' as const;
export const PROFILE_REPAIR_CANARY_ACTOR_ID =
    'apify/instagram-profile-scraper' as const;
export const PROFILE_REPAIR_CANARY_REQUESTED_COUNT = 15 as const;
export const PROFILE_REPAIR_CANARY_MAX_CHARGE_USD = 0.05 as const;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_v2_profile_repair_canary_run',
    reserveRpc: 'reserve_analysis_v2_profile_repair_canary_run',
    checkpointStartedRpc: 'checkpoint_analysis_v2_profile_repair_canary_run_started',
    markAmbiguousRpc: 'mark_analysis_v2_profile_repair_canary_run_ambiguous',
    terminalizeRpc: 'terminalize_analysis_v2_profile_repair_canary_run',
    reconcileUsageRpc: 'reconcile_analysis_v2_profile_repair_canary_run_usage',
    sourceRpc: 'load_analysis_v2_profile_repair_canary_source',
});

export type ProfileRepairCanaryRunState =
    | 'starting'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'ambiguous';
export type ProfileRepairCanaryCostStatus = 'actual' | 'conservative' | 'unknown';
export type ProfileRepairCanaryRepetition = 1 | 2;

export interface StoredProfileRepairCanaryRun {
    sourceRequestId: string;
    canaryVersion: typeof PROFILE_REPAIR_CANARY_VERSION;
    repetition: ProfileRepairCanaryRepetition;
    actorId: typeof PROFILE_REPAIR_CANARY_ACTOR_ID;
    credentialSlot: ApifyCredentialSlot;
    requestedCount: typeof PROFILE_REPAIR_CANARY_REQUESTED_COUNT;
    maxChargeUsd: typeof PROFILE_REPAIR_CANARY_MAX_CHARGE_USD;
    reservationToken: string;
    state: ProfileRepairCanaryRunState;
    runId: string | null;
    terminalCount: number | null;
    successCount: number | null;
    unavailableCount: number | null;
    incompleteCount: number | null;
    otherFailureCount: number | null;
    criticalRecoveredCount: number | null;
    latencyMs: number | null;
    gatePassed: boolean | null;
    actualUsageUsd: number | null;
    costStatus: ProfileRepairCanaryCostStatus;
    reservedAt: string;
    runStartedAt: string | null;
    ambiguousAt: string | null;
    terminalizedAt: string | null;
    usageReconciledAt: string | null;
    updatedAt: string;
}

interface RunKey {
    sourceRequestId: string;
    repetition: ProfileRepairCanaryRepetition;
}

interface ReservedRunKey extends RunKey {
    reservationToken: string;
}

export interface ProfileRepairCanaryTerminalInput extends ReservedRunKey {
    runId: string;
    state: Extract<ProfileRepairCanaryRunState, 'succeeded' | 'failed'>;
    terminalCount: number;
    successCount: number;
    unavailableCount: number;
    incompleteCount: number;
    otherFailureCount: number;
    criticalRecoveredCount: number;
    latencyMs: number;
    gatePassed: boolean;
}

export interface ProfileRepairCanaryRunStore {
    load(input: RunKey): Promise<StoredProfileRepairCanaryRun | null>;
    reserve(input: RunKey & { credentialSlot: ApifyCredentialSlot }): Promise<{
        created: boolean;
        run: StoredProfileRepairCanaryRun;
    }>;
    checkpointStarted(input: ReservedRunKey & { runId: string }):
        Promise<StoredProfileRepairCanaryRun>;
    markAmbiguous(input: ReservedRunKey): Promise<StoredProfileRepairCanaryRun>;
    terminalize(input: ProfileRepairCanaryTerminalInput):
        Promise<StoredProfileRepairCanaryRun>;
    reconcileUsage(input: ReservedRunKey & { runId: string; actualUsageUsd: number }):
        Promise<StoredProfileRepairCanaryRun>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface ProfileRepairCanaryRunSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

interface StoreDependencies {
    randomUUID?: () => string;
}

function validationError(): never {
    throw new Error('PROFILE_REPAIR_CANARY_RUN_VALIDATION_ERROR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function runKey(input: RunKey): RunKey {
    if (
        !UUID_PATTERN.test(input.sourceRequestId)
        || (input.repetition !== 1 && input.repetition !== 2)
    ) {
        validationError();
    }
    return {
        sourceRequestId: input.sourceRequestId.toLowerCase(),
        repetition: input.repetition,
    };
}

function reservationToken(value: string): string {
    if (!UUID_PATTERN.test(value)) validationError();
    return value.toLowerCase();
}

function runId(value: string): string {
    if (!RUN_ID_PATTERN.test(value)) validationError();
    return value;
}

function timestamp(value: unknown, nullable = false): string | null {
    if (nullable && value === null) return null;
    if (
        typeof value !== 'string'
        || !TIMESTAMP_PATTERN.test(value)
        || !Number.isFinite(Date.parse(value))
    ) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    return new Date(value).toISOString();
}

function integer(value: unknown, maximum: number, nullable = false): number | null {
    if (nullable && value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    return value as number;
}

function money(value: unknown, maximum: number, nullable = false): number | null {
    if (nullable && value === null) return null;
    if (
        typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value))
    ) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum + Number.EPSILON) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    return Number(parsed.toFixed(12));
}

function nullableRunId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    return value;
}

function parseStoredRun(value: unknown): StoredProfileRepairCanaryRun {
    if (!isRecord(value)) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    const sourceRequestId = String(value.sourceRequestId ?? '');
    const repetition = value.repetition;
    const credentialSlot = value.credentialSlot;
    const state = value.state;
    const costStatus = value.costStatus;
    if (
        !UUID_PATTERN.test(sourceRequestId)
        || (repetition !== 1 && repetition !== 2)
        || value.canaryVersion !== PROFILE_REPAIR_CANARY_VERSION
        || value.actorId !== PROFILE_REPAIR_CANARY_ACTOR_ID
        || !isApifyCredentialSlot(credentialSlot)
        || value.requestedCount !== PROFILE_REPAIR_CANARY_REQUESTED_COUNT
        || !['starting', 'running', 'succeeded', 'failed', 'ambiguous'].includes(String(state))
        || !['actual', 'conservative', 'unknown'].includes(String(costStatus))
    ) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    if (money(value.maxChargeUsd, PROFILE_REPAIR_CANARY_MAX_CHARGE_USD)
        !== PROFILE_REPAIR_CANARY_MAX_CHARGE_USD) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    const parsedRunId = nullableRunId(value.runId);
    const terminalCount = integer(value.terminalCount, 15, true);
    const successCount = integer(value.successCount, 15, true);
    const unavailableCount = integer(value.unavailableCount, 15, true);
    const incompleteCount = integer(value.incompleteCount, 15, true);
    const otherFailureCount = integer(value.otherFailureCount, 15, true);
    const criticalRecoveredCount = integer(value.criticalRecoveredCount, 15, true);
    const latencyMs = integer(value.latencyMs, 300_000, true);
    const actualUsageUsd = money(value.actualUsageUsd, 0.05, true);
    const runStartedAt = timestamp(value.runStartedAt, true);
    const ambiguousAt = timestamp(value.ambiguousAt, true);
    const terminalizedAt = timestamp(value.terminalizedAt, true);
    const usageReconciledAt = timestamp(value.usageReconciledAt, true);
    const gatePassed = value.gatePassed;
    const isTerminal = state === 'succeeded' || state === 'failed';
    const terminalFields = [
        terminalCount,
        successCount,
        unavailableCount,
        incompleteCount,
        otherFailureCount,
        criticalRecoveredCount,
        latencyMs,
    ];
    const allTerminalFields = terminalFields.every(field => field !== null);
    const noTerminalFields = terminalFields.every(field => field === null);
    if (
        (state === 'starting' && (
            parsedRunId !== null
            || runStartedAt !== null
            || ambiguousAt !== null
            || terminalizedAt !== null
            || !noTerminalFields
            || gatePassed !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
            || costStatus !== 'conservative'
        ))
        || (state === 'running' && (
            parsedRunId === null
            || runStartedAt === null
            || ambiguousAt !== null
            || terminalizedAt !== null
            || !noTerminalFields
            || gatePassed !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
            || costStatus !== 'conservative'
        ))
        || (state === 'ambiguous' && (
            parsedRunId !== null
            || runStartedAt !== null
            || ambiguousAt === null
            || terminalizedAt === null
            || !noTerminalFields
            || gatePassed !== null
            || actualUsageUsd !== null
            || usageReconciledAt !== null
            || costStatus !== 'unknown'
        ))
        || (isTerminal && (
            parsedRunId === null
            || runStartedAt === null
            || ambiguousAt !== null
            || terminalizedAt === null
            || !allTerminalFields
            || typeof gatePassed !== 'boolean'
            || (state === 'succeeded') !== gatePassed
            || ((actualUsageUsd === null) !== (usageReconciledAt === null))
            || (actualUsageUsd === null && costStatus !== 'conservative')
            || (actualUsageUsd !== null && costStatus !== 'actual')
        ))
    ) {
        throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
    }
    if (isTerminal) {
        const total = (successCount as number)
            + (unavailableCount as number)
            + (incompleteCount as number)
            + (otherFailureCount as number);
        const qualityGatePassed = (successCount as number) >= 14
            && (unavailableCount as number) <= 1
            && otherFailureCount === 0
            && (criticalRecoveredCount as number) >= 1;
        if (
            terminalCount !== 15
            || total !== terminalCount
            || (criticalRecoveredCount as number) > (successCount as number)
            || gatePassed !== qualityGatePassed
        ) {
            throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
        }
    }
    return Object.freeze({
        sourceRequestId: sourceRequestId.toLowerCase(),
        canaryVersion: PROFILE_REPAIR_CANARY_VERSION,
        repetition,
        actorId: PROFILE_REPAIR_CANARY_ACTOR_ID,
        credentialSlot,
        requestedCount: PROFILE_REPAIR_CANARY_REQUESTED_COUNT,
        maxChargeUsd: PROFILE_REPAIR_CANARY_MAX_CHARGE_USD,
        reservationToken: reservationToken(String(value.reservationToken ?? '')),
        state: state as ProfileRepairCanaryRunState,
        runId: parsedRunId,
        terminalCount,
        successCount,
        unavailableCount,
        incompleteCount,
        otherFailureCount,
        criticalRecoveredCount,
        latencyMs,
        gatePassed: gatePassed as boolean | null,
        actualUsageUsd,
        costStatus: costStatus as ProfileRepairCanaryCostStatus,
        reservedAt: timestamp(value.reservedAt)!,
        runStartedAt,
        ambiguousAt,
        terminalizedAt,
        usageReconciledAt,
        updatedAt: timestamp(value.updatedAt)!,
    });
}

const SAFE_RPC_ERRORS = [
    'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
    'PROFILE_REPAIR_CANARY_RUN_RUN_CONFLICT',
    'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
    'PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT',
    'PROFILE_REPAIR_CANARY_RUN_RECONCILIATION_CONFLICT',
    'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
] as const;

function throwRpcError(error: RpcError): never {
    const message = typeof error.message === 'string' ? error.message : '';
    const safe = SAFE_RPC_ERRORS.find(code => message.startsWith(code));
    if (safe) throw new Error(safe);
    const rpcCode = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
    throw new Error(`PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR (${rpcCode})`);
}

function terminalInput(input: ProfileRepairCanaryTerminalInput) {
    const key = runKey(input);
    const token = reservationToken(input.reservationToken);
    const confirmedRunId = runId(input.runId);
    const counts = [
        input.terminalCount,
        input.successCount,
        input.unavailableCount,
        input.incompleteCount,
        input.otherFailureCount,
        input.criticalRecoveredCount,
    ];
    const qualityGatePassed = input.successCount >= 14
        && input.unavailableCount <= 1
        && input.otherFailureCount === 0
        && input.criticalRecoveredCount >= 1;
    if (
        !counts.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 15)
        || input.terminalCount !== 15
        || input.successCount
            + input.unavailableCount
            + input.incompleteCount
            + input.otherFailureCount !== input.terminalCount
        || input.criticalRecoveredCount > input.successCount
        || !Number.isSafeInteger(input.latencyMs)
        || input.latencyMs < 0
        || input.latencyMs > 300_000
        || input.gatePassed !== qualityGatePassed
        || (input.state === 'succeeded') !== input.gatePassed
    ) {
        validationError();
    }
    return { key, token, confirmedRunId };
}

export function createProfileRepairCanaryRunStore(
    client: ProfileRepairCanaryRunSupabaseClient = supabaseAdmin,
    dependencies: StoreDependencies = {}
): ProfileRepairCanaryRunStore {
    const rpc = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
        const { data, error } = await client.rpc(name, params);
        if (error) throwRpcError(error);
        return data;
    };

    return {
        async load(input) {
            const key = runKey(input);
            const data = await rpc(PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.loadRpc, {
                p_source_request_id: key.sourceRequestId,
                p_repetition: key.repetition,
            });
            return data === null ? null : parseStoredRun(data);
        },

        async reserve(input) {
            const key = runKey(input);
            if (!isApifyCredentialSlot(input.credentialSlot)) validationError();
            const proposedReservationToken = reservationToken(
                (dependencies.randomUUID ?? nodeRandomUUID)()
            );
            const data = await rpc(PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.reserveRpc, {
                p_source_request_id: key.sourceRequestId,
                p_repetition: key.repetition,
                p_credential_slot: input.credentialSlot,
                p_reservation_token: proposedReservationToken,
            });
            if (!isRecord(data) || typeof data.created !== 'boolean') {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_PERSISTENCE_ERROR');
            }
            const run = parseStoredRun(data.run);
            if (
                run.sourceRequestId !== key.sourceRequestId
                || run.repetition !== key.repetition
                || run.credentialSlot !== input.credentialSlot
                || (data.created && run.reservationToken !== proposedReservationToken)
            ) {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            return Object.freeze({ created: data.created, run });
        },

        async checkpointStarted(input) {
            const key = runKey(input);
            const token = reservationToken(input.reservationToken);
            const confirmedRunId = runId(input.runId);
            const run = parseStoredRun(await rpc(
                PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.checkpointStartedRpc,
                {
                    p_source_request_id: key.sourceRequestId,
                    p_repetition: key.repetition,
                    p_reservation_token: token,
                    p_run_id: confirmedRunId,
                }
            ));
            if (
                run.reservationToken !== token
                || run.runId !== confirmedRunId
                || run.state === 'starting'
            ) {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },

        async markAmbiguous(input) {
            const key = runKey(input);
            const token = reservationToken(input.reservationToken);
            const run = parseStoredRun(await rpc(
                PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.markAmbiguousRpc,
                {
                    p_source_request_id: key.sourceRequestId,
                    p_repetition: key.repetition,
                    p_reservation_token: token,
                }
            ));
            if (run.reservationToken !== token || run.state !== 'ambiguous') {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },

        async terminalize(input) {
            const { key, token, confirmedRunId } = terminalInput(input);
            const run = parseStoredRun(await rpc(
                PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.terminalizeRpc,
                {
                    p_source_request_id: key.sourceRequestId,
                    p_repetition: key.repetition,
                    p_reservation_token: token,
                    p_run_id: confirmedRunId,
                    p_state: input.state,
                    p_terminal_count: input.terminalCount,
                    p_success_count: input.successCount,
                    p_unavailable_count: input.unavailableCount,
                    p_incomplete_count: input.incompleteCount,
                    p_other_failure_count: input.otherFailureCount,
                    p_critical_recovered_count: input.criticalRecoveredCount,
                    p_latency_ms: input.latencyMs,
                    p_gate_passed: input.gatePassed,
                }
            ));
            if (
                run.reservationToken !== token
                || run.runId !== confirmedRunId
                || run.state !== input.state
            ) {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },

        async reconcileUsage(input) {
            const key = runKey(input);
            const token = reservationToken(input.reservationToken);
            const confirmedRunId = runId(input.runId);
            if (
                !Number.isFinite(input.actualUsageUsd)
                || input.actualUsageUsd < 0
                || input.actualUsageUsd > PROFILE_REPAIR_CANARY_MAX_CHARGE_USD + Number.EPSILON
            ) {
                validationError();
            }
            const actualUsageUsd = Number(input.actualUsageUsd.toFixed(12));
            const run = parseStoredRun(await rpc(
                PROFILE_REPAIR_CANARY_RUN_DATABASE_NAMES.reconcileUsageRpc,
                {
                    p_source_request_id: key.sourceRequestId,
                    p_repetition: key.repetition,
                    p_reservation_token: token,
                    p_run_id: confirmedRunId,
                    p_actual_usage_usd: actualUsageUsd,
                }
            ));
            if (
                run.reservationToken !== token
                || run.runId !== confirmedRunId
                || run.actualUsageUsd !== actualUsageUsd
                || run.costStatus !== 'actual'
            ) {
                throw new Error('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
            }
            return run;
        },
    };
}

export const profileRepairCanaryRunStore = createProfileRepairCanaryRunStore();
