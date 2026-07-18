import {
    APIFY_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '../lib/services/instagram/providers/types';

export const PROFILE_REPAIR_CANARY_REPEATS = 2;
export const PROFILE_REPAIR_CANARY_MAX_RUN_USD = 0.05;
export const PROFILE_REPAIR_CANARY_MAX_TOTAL_USD = 0.10;
export const PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT = 15;

export const MAX_RUN_USD = PROFILE_REPAIR_CANARY_MAX_RUN_USD;
export const MAX_TOTAL_USD = PROFILE_REPAIR_CANARY_MAX_TOTAL_USD;
export const EXPECTED_INPUT_COUNT = PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRITICAL_JOB_KEY_PATTERN = /^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$/;
const VALUE_FLAGS = new Set([
    '--source-request-id',
    '--critical-job-key',
    '--credential-slot',
]);
const PAID_OVERRIDE_FLAGS = new Set([
    '--repeats',
    '--repeat-count',
    '--max-run-usd',
    '--max-total-usd',
    '--maximum-run-charge-usd',
    '--maximum-total-charge-usd',
]);
const CONFIRMATION_FLAG = '--confirm-paid-api-call';

export interface ProfileRepairCanaryOptions {
    sourceRequestId: string;
    criticalJobKey: string;
    credentialSlot: ApifyCredentialSlot;
    confirmPaidApiCall: boolean;
    repeats: 0 | typeof PROFILE_REPAIR_CANARY_REPEATS;
    maximumRunChargeUsd: 0 | typeof PROFILE_REPAIR_CANARY_MAX_RUN_USD;
    maximumTotalChargeUsd: 0 | typeof PROFILE_REPAIR_CANARY_MAX_TOTAL_USD;
}

function inputError(detail: string): never {
    throw new Error(`PROFILE_REPAIR_CANARY_INVALID_ARGUMENTS: ${detail}`);
}

export function parseProfileRepairCanaryArgs(
    args: readonly string[]
): ProfileRepairCanaryOptions {
    const values = new Map<string, string>();
    let confirmationCount = 0;

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const flag = argument.split('=', 1)[0];
        if (PAID_OVERRIDE_FLAGS.has(flag)) {
            inputError('fixed paid limits cannot be overridden');
        }
        if (argument.startsWith(CONFIRMATION_FLAG)) {
            if (argument !== CONFIRMATION_FLAG) {
                inputError('confirmation flag must be exact and valueless');
            }
            confirmationCount += 1;
            continue;
        }

        const equalsAt = argument.indexOf('=');
        const valueFlag = equalsAt < 0 ? argument : argument.slice(0, equalsAt);
        if (!VALUE_FLAGS.has(valueFlag)) {
            inputError(`unknown argument ${valueFlag}`);
        }
        if (values.has(valueFlag)) {
            inputError(`${valueFlag} must appear exactly once`);
        }
        const value = equalsAt < 0 ? args[++index] : argument.slice(equalsAt + 1);
        if (!value || value.startsWith('--')) {
            inputError(`${valueFlag} value is required`);
        }
        values.set(valueFlag, value);
    }

    if (confirmationCount > 1) {
        inputError('confirmation flag must appear exactly once');
    }
    for (const flag of VALUE_FLAGS) {
        if (!values.has(flag)) inputError(`${flag} is required`);
    }

    const sourceRequestId = values.get('--source-request-id')!;
    const criticalJobKey = values.get('--critical-job-key')!;
    const credentialSlot = values.get('--credential-slot')!;
    if (
        !UUID_PATTERN.test(sourceRequestId)
        || !CRITICAL_JOB_KEY_PATTERN.test(criticalJobKey)
        || !APIFY_CREDENTIAL_SLOTS.includes(credentialSlot as ApifyCredentialSlot)
    ) {
        inputError('invalid arguments');
    }

    const confirmPaidApiCall = confirmationCount === 1;
    return Object.freeze({
        sourceRequestId: sourceRequestId.toLowerCase(),
        criticalJobKey,
        credentialSlot: credentialSlot as ApifyCredentialSlot,
        confirmPaidApiCall,
        repeats: confirmPaidApiCall ? PROFILE_REPAIR_CANARY_REPEATS : 0,
        maximumRunChargeUsd: confirmPaidApiCall
            ? PROFILE_REPAIR_CANARY_MAX_RUN_USD
            : 0,
        maximumTotalChargeUsd: confirmPaidApiCall
            ? PROFILE_REPAIR_CANARY_MAX_TOTAL_USD
            : 0,
    });
}

type CostStatus = 'actual' | 'conservative' | 'unknown';
type LifecycleStatus = 'succeeded' | 'failed' | 'ambiguous' | 'not_started';

export interface SafeProfileRepairCanaryRunReport {
    repetition: 1 | 2;
    lifecycle_status: LifecycleStatus;
    terminal_count: number;
    success_count: number;
    unavailable_count: number;
    incomplete_count: number;
    other_failure_count: number;
    latency_ms: number;
    actual_cost_usd: number | null;
    cost_status: CostStatus;
    gate_passed: boolean;
}

export interface SafeProfileRepairCanaryReport {
    mode?: 'replay' | 'paid_canary';
    source_run_count?: number;
    requested_count?: number;
    critical_incomplete_count?: number;
    runs?: SafeProfileRepairCanaryRunReport[];
    total_actual_cost_usd?: number | null;
    session_maximum_exposure_usd?: number;
    cost_status?: CostStatus;
    gate_passed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidReport(): never {
    throw new Error('PROFILE_REPAIR_CANARY_INVALID_REPORT: invalid report');
}

function boundedInteger(value: unknown, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
        invalidReport();
    }
    return value as number;
}

function boundedMoney(value: unknown, maximum: number, nullable = false): number | null {
    if (nullable && value === null) return null;
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < 0
        || value > maximum + Number.EPSILON
    ) {
        invalidReport();
    }
    return Number(value.toFixed(12));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
    if (!allowed.includes(value as T)) invalidReport();
    return value as T;
}

function booleanValue(value: unknown): boolean {
    if (typeof value !== 'boolean') invalidReport();
    return value;
}

function sanitizeRun(value: unknown): SafeProfileRepairCanaryRunReport {
    if (!isRecord(value)) invalidReport();
    const repetition = boundedInteger(value.repetition, PROFILE_REPAIR_CANARY_REPEATS);
    if (repetition !== 1 && repetition !== 2) invalidReport();
    const terminalCount = boundedInteger(
        value.terminalCount,
        PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
    );
    const successCount = boundedInteger(
        value.successCount,
        PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
    );
    const unavailableCount = boundedInteger(
        value.unavailableCount,
        PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
    );
    const incompleteCount = boundedInteger(
        value.incompleteCount,
        PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
    );
    const otherFailureCount = boundedInteger(
        value.otherFailureCount,
        PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
    );
    if (
        successCount + unavailableCount + incompleteCount + otherFailureCount
        !== terminalCount
    ) {
        invalidReport();
    }
    return {
        repetition,
        lifecycle_status: enumValue(value.lifecycleStatus, [
            'succeeded',
            'failed',
            'ambiguous',
            'not_started',
        ] as const),
        terminal_count: terminalCount,
        success_count: successCount,
        unavailable_count: unavailableCount,
        incomplete_count: incompleteCount,
        other_failure_count: otherFailureCount,
        latency_ms: boundedInteger(value.latencyMs, 300_000),
        actual_cost_usd: boundedMoney(
            value.actualCostUsd,
            PROFILE_REPAIR_CANARY_MAX_RUN_USD,
            true
        ),
        cost_status: enumValue(value.costStatus, [
            'actual',
            'conservative',
            'unknown',
        ] as const),
        gate_passed: booleanValue(value.gatePassed),
    };
}

/**
 * Projects an arbitrary internal result into the only JSON shape permitted on stdout.
 * Sensitive and unknown properties are deliberately ignored instead of copied.
 */
export function sanitizeProfileRepairCanaryResult(
    input: unknown
): SafeProfileRepairCanaryReport {
    if (!isRecord(input)) invalidReport();
    const result: SafeProfileRepairCanaryReport = {};
    if (input.mode !== undefined) {
        result.mode = enumValue(input.mode, ['replay', 'paid_canary'] as const);
    }
    if (input.sourceRunCount !== undefined) {
        result.source_run_count = boundedInteger(input.sourceRunCount, 8);
    }
    if (input.requestedCount !== undefined) {
        result.requested_count = boundedInteger(
            input.requestedCount,
            PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
        );
    }
    if (input.criticalIncompleteCount !== undefined) {
        result.critical_incomplete_count = boundedInteger(
            input.criticalIncompleteCount,
            PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
        );
    }
    if (input.runs !== undefined) {
        if (!Array.isArray(input.runs) || input.runs.length > PROFILE_REPAIR_CANARY_REPEATS) {
            invalidReport();
        }
        result.runs = input.runs.map(sanitizeRun);
        if (new Set(result.runs.map(run => run.repetition)).size !== result.runs.length) {
            invalidReport();
        }
    }
    if (input.totalActualCostUsd !== undefined) {
        result.total_actual_cost_usd = boundedMoney(
            input.totalActualCostUsd,
            PROFILE_REPAIR_CANARY_MAX_TOTAL_USD,
            true
        );
    }
    if (input.sessionMaximumExposureUsd !== undefined) {
        result.session_maximum_exposure_usd = boundedMoney(
            input.sessionMaximumExposureUsd,
            PROFILE_REPAIR_CANARY_MAX_TOTAL_USD
        ) as number;
    }
    if (input.costStatus !== undefined) {
        result.cost_status = enumValue(input.costStatus, [
            'actual',
            'conservative',
            'unknown',
        ] as const);
    }
    if (input.gatePassed !== undefined) {
        result.gate_passed = booleanValue(input.gatePassed);
    }
    return Object.freeze(result);
}
