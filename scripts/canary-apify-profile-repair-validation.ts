import { APIFY_PROFILE_ACTOR_ID } from '../lib/services/instagram/providers/apify';
import type {
    ProfileAttemptResult,
} from '../lib/services/instagram/providers/types';
import { isInstagramUsername } from '../lib/services/instagram/username';
import {
    PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT,
    type ProfileRepairCanaryOptions,
    type SafeProfileRepairCanaryRunReport,
} from './canary-apify-profile-repair-options';

const FIXED_TARGET = '0_min._.00';
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$/;
const OPERATION_KEY_PATTERN = /^profile-fallback:[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const SOURCE_BATCH_MAX_USERNAMES = 100;

export const PROFILE_REPAIR_CANARY_SOURCE_RUN_COUNT = 8;

export interface ProfileRepairCanarySourceRequest {
    sourceRequestId: string;
    userId: string;
    ownerEmail: string;
    targetInstagramId: string;
    pipelineVersion: string;
    status: string;
}

export interface ProfileRepairCanarySourceRun {
    jobKey: string;
    operationKey: string;
    status: string;
    runId: string | null;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
}

export interface ProfileRepairCanarySourceBundle {
    request: ProfileRepairCanarySourceRequest;
    runs: ProfileRepairCanarySourceRun[];
}

export interface ProfileRepairCanaryResultCounts {
    terminalCount: number;
    successCount: number;
    unavailableCount: number;
    incompleteCount: number;
    otherFailureCount: number;
    criticalRecoveredCount: number;
    gatePassed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(code: string): never {
    throw new Error(code);
}

function numberValue(value: unknown): number | null {
    if (
        typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value))
    ) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseSourceBundle(value: unknown): ProfileRepairCanarySourceBundle {
    if (!isRecord(value) || !isRecord(value.request) || !Array.isArray(value.runs)) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_INVALID');
    }
    const request = value.request;
    const parsedRequest: ProfileRepairCanarySourceRequest = {
        sourceRequestId: String(request.sourceRequestId ?? ''),
        userId: String(request.userId ?? ''),
        ownerEmail: String(request.ownerEmail ?? ''),
        targetInstagramId: String(request.targetInstagramId ?? ''),
        pipelineVersion: String(request.pipelineVersion ?? ''),
        status: String(request.status ?? ''),
    };
    const runs = value.runs.map((raw): ProfileRepairCanarySourceRun => {
        if (!isRecord(raw)) invalid('PROFILE_REPAIR_CANARY_SOURCE_LEDGER_INVALID');
        const maxChargeUsd = numberValue(raw.maxChargeUsd);
        if (maxChargeUsd === null) {
            invalid('PROFILE_REPAIR_CANARY_SOURCE_LEDGER_INVALID');
        }
        return {
            jobKey: String(raw.jobKey ?? ''),
            operationKey: String(raw.operationKey ?? ''),
            status: String(raw.status ?? ''),
            runId: raw.runId === null ? null : String(raw.runId ?? ''),
            actorId: String(raw.actorId ?? ''),
            credentialSlot: String(raw.credentialSlot ?? ''),
            maxChargeUsd,
        };
    });
    return { request: parsedRequest, runs };
}

export function validateProfileRepairCanarySource(
    value: unknown,
    options: ProfileRepairCanaryOptions,
    ownerId: string,
    ownerEmail: string
): ProfileRepairCanarySourceBundle {
    const source = parseSourceBundle(value);
    if (
        !UUID_PATTERN.test(source.request.sourceRequestId)
        || source.request.sourceRequestId.toLowerCase() !== options.sourceRequestId
        || !UUID_PATTERN.test(source.request.userId)
        || source.request.userId.toLowerCase() !== ownerId.toLowerCase()
        || source.request.ownerEmail.toLowerCase() !== ownerEmail.toLowerCase()
        || source.request.targetInstagramId !== FIXED_TARGET
        || source.request.pipelineVersion !== 'v2'
        || source.request.status !== 'failed'
    ) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_INVALID');
    }
    if (source.runs.length !== PROFILE_REPAIR_CANARY_SOURCE_RUN_COUNT) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_LEDGER_INVALID');
    }
    const jobKeys = new Set<string>();
    const runIds = new Set<string>();
    for (const run of source.runs) {
        if (
            !JOB_KEY_PATTERN.test(run.jobKey)
            || !OPERATION_KEY_PATTERN.test(run.operationKey)
            || run.status !== 'succeeded'
            || run.runId === null
            || !RUN_ID_PATTERN.test(run.runId)
            || run.actorId !== APIFY_PROFILE_ACTOR_ID
            || run.credentialSlot !== options.credentialSlot
            || !Number.isFinite(run.maxChargeUsd)
            || run.maxChargeUsd < 0
            || run.maxChargeUsd > 100_000
            || jobKeys.has(run.jobKey)
            || runIds.has(run.runId)
        ) {
            invalid('PROFILE_REPAIR_CANARY_SOURCE_LEDGER_INVALID');
        }
        jobKeys.add(run.jobKey);
        runIds.add(run.runId);
    }
    if (!jobKeys.has(options.criticalJobKey)) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_LEDGER_INVALID');
    }
    return {
        request: source.request,
        runs: [...source.runs].sort((left, right) => {
            const leftBatch = Number(left.jobKey.slice(left.jobKey.lastIndexOf(':') + 1));
            const rightBatch = Number(right.jobKey.slice(right.jobKey.lastIndexOf(':') + 1));
            return leftBatch - rightBatch;
        }),
    };
}

export function parseProfileRepairCanarySourceInput(value: unknown): string[] {
    if (!isRecord(value) || !isRecord(value.value)) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_INPUT_INVALID');
    }
    const input = value.value;
    if (
        Object.keys(input).some(key => key !== 'usernames')
        || !Array.isArray(input.usernames)
        || input.usernames.length < 1
        || input.usernames.length > SOURCE_BATCH_MAX_USERNAMES
    ) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_INPUT_INVALID');
    }
    const usernames = input.usernames.map(username => {
        if (typeof username !== 'string' || !isInstagramUsername(username)) {
            invalid('PROFILE_REPAIR_CANARY_SOURCE_INPUT_INVALID');
        }
        return username.toLowerCase();
    });
    if (new Set(usernames).size !== usernames.length) {
        invalid('PROFILE_REPAIR_CANARY_SOURCE_INPUT_INVALID');
    }
    return usernames;
}

export function countProfileRepairCanaryResults(
    results: readonly ProfileAttemptResult[],
    criticalUsernames: ReadonlySet<string>
): ProfileRepairCanaryResultCounts {
    let successCount = 0;
    let unavailableCount = 0;
    let incompleteCount = 0;
    let otherFailureCount = 0;
    let criticalRecoveredCount = 0;
    for (const result of results) {
        const outcome = result.outcome;
        if (outcome.status === 'success') {
            successCount += 1;
            if (criticalUsernames.has(outcome.requestedUsername)) {
                criticalRecoveredCount += 1;
            }
        } else if (outcome.status === 'unavailable') {
            unavailableCount += 1;
        } else if (outcome.failureCategory === 'incomplete') {
            incompleteCount += 1;
        } else {
            otherFailureCount += 1;
        }
    }
    const terminalCount = results.length;
    const gatePassed = terminalCount === PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT
        && successCount >= 14
        && unavailableCount <= 1
        && otherFailureCount === 0
        && criticalRecoveredCount >= 1;
    return {
        terminalCount,
        successCount,
        unavailableCount,
        incompleteCount,
        otherFailureCount,
        criticalRecoveredCount,
        gatePassed,
    };
}

export function requireProfileRepairCanaryOperatorIdentity(
    env: Record<string, string | undefined>
): { ownerId: string; ownerEmail: string } {
    const ownerId = env.AUTHORIZED_E2E_OWNER_ID?.trim() ?? '';
    const ownerEmail = env.AUTHORIZED_E2E_OWNER_EMAIL?.trim() ?? '';
    if (
        !UUID_PATTERN.test(ownerId)
        || ownerEmail.length < 3
        || ownerEmail.length > 255
        || !ownerEmail.includes('@')
    ) {
        invalid('PROFILE_REPAIR_CANARY_OPERATOR_IDENTITY_INVALID');
    }
    return { ownerId: ownerId.toLowerCase(), ownerEmail };
}

export function profileRepairCanaryReportCost(
    runs: readonly SafeProfileRepairCanaryRunReport[]
): {
    totalActualCostUsd: number | null;
    costStatus: 'actual' | 'conservative' | 'unknown';
} {
    if (runs.some(run => run.cost_status === 'unknown')) {
        return { totalActualCostUsd: null, costStatus: 'unknown' };
    }
    if (runs.some(run => run.cost_status !== 'actual')) {
        return { totalActualCostUsd: null, costStatus: 'conservative' };
    }
    return {
        totalActualCostUsd: Number(runs.reduce(
            (sum, run) => sum + (run.actual_cost_usd ?? 0),
            0
        ).toFixed(12)),
        costStatus: 'actual',
    };
}
