import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isAnalysisV2WorkerAvailable } from './v2-execution-gate';
import {
    reconcileAnalysisV2ProviderUsage,
    type AnalysisV2ProviderReconciliationFailure,
    type AnalysisV2ProviderReconciliationSummary,
} from './v2-provider-lifecycle';
import {
    analysisV2ProviderRunStore,
    type AnalysisV2ProviderRunStore,
    type StoredAnalysisV2ProviderRun,
} from './v2-provider-run-store';
import { dispatchAnalysisV2Job } from './v2-tasks';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';

export const FIRST15_CANARY_PROVIDER_FAILURE_CODES = [
    'SCRAPING_INCOMPLETE_ERROR',
    'SCRAPING_PROVIDER_QUOTA_ERROR',
    'SCRAPING_PROVIDER_START_REJECTED_ERROR',
] as const;

type First15CanaryProviderFailureCode =
    typeof FIRST15_CANARY_PROVIDER_FAILURE_CODES[number];

const first15FailureCodeSchema = z.enum(FIRST15_CANARY_PROVIDER_FAILURE_CODES);
const first15RearmSourceFailureCodeSchema = z.enum([
    ...FIRST15_CANARY_PROVIDER_FAILURE_CODES,
    'ANALYSIS_V2_JOB_HANDLER_FAILED',
    'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
    'JOB_ATTEMPTS_EXHAUSTED',
]);
type First15CanaryProviderRearmSourceFailureCode = z.infer<
    typeof first15RearmSourceFailureCodeSchema
>;
const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const credentialSlotSchema = z.enum([
    'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary',
]);
const providerRunStatusSchema = z.enum([
    'starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted', 'timed_out',
]);

const fallbackSlotBySource: Readonly<Partial<Record<
    ApifyCredentialSlot,
    ApifyCredentialSlot
>>> = Object.freeze({
    senary: 'tertiary',
    tertiary: 'quinary',
    quinary: 'primary',
    primary: 'secondary',
});

const initialFailureCodes = new Set<string>(FIRST15_CANARY_PROVIDER_FAILURE_CODES);
const terminalProviderStatuses = new Set([
    'succeeded', 'failed', 'aborted', 'timed_out',
]);

export interface First15CanaryProviderRecoveryCandidate {
    orderId: string;
    requestId: string;
    preflightId: string;
    errorCode: First15CanaryProviderFailureCode;
    credentialSlot: ApifyCredentialSlot;
}

export interface First15CanaryProviderRecoveryRearm {
    orderId: string;
    rearmedPreflightId: string;
    rearmGeneration: number;
    sourceFailureCode: First15CanaryProviderRearmSourceFailureCode;
}

export interface First15CanaryProviderRecoveryDependencies {
    workerAvailable(): boolean;
    loadCandidates(): Promise<readonly First15CanaryProviderRecoveryCandidate[]>;
    loadRearms(): Promise<readonly First15CanaryProviderRecoveryRearm[]>;
    loadProviderRuns(requestIds: readonly string[]): Promise<readonly StoredAnalysisV2ProviderRun[]>;
    reconcileProviderRuns(
        runs: readonly StoredAnalysisV2ProviderRun[],
        reportFailure?: (failure: AnalysisV2ProviderReconciliationFailure) => void,
    ): Promise<AnalysisV2ProviderReconciliationSummary>;
    rearm(input: {
        orderId: string;
        requestId: string;
        fallbackCredentialSlot: ApifyCredentialSlot;
    }): Promise<{
        applied: boolean;
        requestId: string;
        initialJobKey: 'coordinator:bootstrap';
    }>;
    dispatch(requestId: string, jobKey: 'coordinator:bootstrap'): Promise<unknown>;
}

export interface First15CanaryProviderRecoverySummary {
    candidates: number;
    reconciledProviderRuns: number;
    rearmed: number;
    dispatched: number;
}

const rawCandidateSchema = z.object({
    order_id: uuidSchema,
    request_id: uuidSchema,
    preflight_id: uuidSchema,
    error_code: first15FailureCodeSchema,
    credential_slot: credentialSlotSchema,
}).strict();

const rawRearmSchema = z.object({
    order_id: uuidSchema,
    rearmed_preflight_id: uuidSchema,
    rearm_generation: z.number().int().min(1).max(4),
    source_failure_code: first15RearmSourceFailureCodeSchema,
}).strict();

const rawProviderRunSchema = z.object({
    request_id: uuidSchema,
    job_key: z.string().min(1).max(160),
    operation_key: z.string().min(1).max(87),
    input_hash: z.string().regex(/^[0-9a-f]{64}$/),
    reservation_token: uuidSchema,
    logical_provider: z.enum(['apify', 'coderx']),
    actor_id: z.string().min(3).max(200),
    credential_slot: credentialSlotSchema,
    max_charge_usd: z.coerce.number().min(0).max(100_000),
    status: providerRunStatusSchema,
    run_id: z.string().regex(/^[A-Za-z0-9]{8,64}$/).nullable(),
    actual_usage_usd: z.coerce.number().min(0).max(100_000).nullable(),
    reserved_at: z.string().datetime({ offset: true }),
    run_started_at: z.string().datetime({ offset: true }).nullable(),
    terminalized_at: z.string().datetime({ offset: true }).nullable(),
    usage_reconciled_at: z.string().datetime({ offset: true }).nullable(),
}).strict();

function noOutputError(code: string): Error {
    return new Error(code);
}

const first15ReconciliationFailureCode = Object.freeze({
    provider_auth_failed: 'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_AUTH_FAILED',
    provider_run_missing: 'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_RUN_NOT_FOUND',
    provider_rate_limited: 'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_RATE_LIMITED',
    provider_read_failed: 'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_READ_FAILED',
    remote_status_mismatch: 'FIRST15_CANARY_RECOVERY_SENARY_REMOTE_STATUS_MISMATCH',
    remote_usage_missing: 'FIRST15_CANARY_RECOVERY_SENARY_REMOTE_USAGE_MISSING',
    remote_usage_invalid: 'FIRST15_CANARY_RECOVERY_SENARY_REMOTE_USAGE_INVALID',
    ledger_write_failed: 'FIRST15_CANARY_RECOVERY_PROVIDER_LEDGER_WRITE_FAILED',
    revenue_settlement_unavailable: 'FIRST15_CANARY_RECOVERY_REVENUE_SETTLEMENT_UNAVAILABLE',
    revenue_settlement_failed: 'FIRST15_CANARY_RECOVERY_REVENUE_SETTLEMENT_FAILED',
    stored_run_invalid: 'FIRST15_CANARY_RECOVERY_PROVIDER_LEDGER_INVALID',
} satisfies Record<AnalysisV2ProviderReconciliationFailure['reason'], string>);

function reconciliationFailureCode(
    failures: readonly AnalysisV2ProviderReconciliationFailure[],
): string | undefined {
    if (
        failures.length === 0
        || failures.some(failure => failure.credentialSlot !== 'senary')
    ) {
        return undefined;
    }
    const reasons = new Set(failures.map(failure => failure.reason));
    if (reasons.size !== 1) return undefined;
    return first15ReconciliationFailureCode[failures[0].reason];
}

function candidateKey(candidate: Pick<First15CanaryProviderRecoveryCandidate, 'orderId' | 'preflightId'>): string {
    return `${candidate.orderId}:${candidate.preflightId}`;
}

function orderedFallback(
    credentialSlot: ApifyCredentialSlot,
): ApifyCredentialSlot {
    const fallback = fallbackSlotBySource[credentialSlot];
    if (!fallback) throw noOutputError('FIRST15_CANARY_RECOVERY_FALLBACK_EXHAUSTED');
    return fallback;
}

function uniqueByOrder(
    candidates: readonly First15CanaryProviderRecoveryCandidate[],
): void {
    if (new Set(candidates.map(candidate => candidate.orderId)).size !== candidates.length) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_ORDER_SCOPE_MISMATCH');
    }
}

function selectScopedCandidates(
    candidates: readonly First15CanaryProviderRecoveryCandidate[],
    rearmRows: readonly First15CanaryProviderRecoveryRearm[],
): readonly First15CanaryProviderRecoveryCandidate[] {
    if (rearmRows.length > 12) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_REARM_SCOPE_MISMATCH');
    }
    const rearmByDestination = new Map(
        rearmRows.map(rearm => [`${rearm.orderId}:${rearm.rearmedPreflightId}`, rearm]),
    );
    if (rearmByDestination.size !== rearmRows.length) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_REARM_SCOPE_MISMATCH');
    }
    const rearmedOrders = new Set(rearmRows.map(rearm => rearm.orderId));
    const recordedInitialCodes = new Set(rearmRows
        .filter(rearm => rearm.rearmGeneration === 1)
        .map(rearm => rearm.sourceFailureCode));
    if (
        recordedInitialCodes.size > FIRST15_CANARY_PROVIDER_FAILURE_CODES.length
        || [...recordedInitialCodes].some(code => !initialFailureCodes.has(code))
    ) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_REARM_SCOPE_MISMATCH');
    }

    const initial = candidates.filter(candidate => (
        candidate.credentialSlot === 'senary'
        && !rearmedOrders.has(candidate.orderId)
    ));
    const recorded = candidates.filter(candidate => (
        rearmByDestination.has(candidateKey(candidate))
    ));
    const scoped = [...initial, ...recorded];
    if (scoped.length === 0 || scoped.length > 3) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_SCOPE_MISMATCH');
    }
    uniqueByOrder(scoped);

    const expectedInitialCodes = new Set(
        FIRST15_CANARY_PROVIDER_FAILURE_CODES.filter(code => !recordedInitialCodes.has(code)),
    );
    const actualInitialCodes = new Set(initial.map(candidate => candidate.errorCode));
    if (
        actualInitialCodes.size !== initial.length
        || actualInitialCodes.size !== expectedInitialCodes.size
        || [...actualInitialCodes].some(code => !expectedInitialCodes.has(code))
    ) {
        throw noOutputError(
            rearmRows.length === 0
                ? 'FIRST15_CANARY_RECOVERY_INITIAL_SCOPE_MISMATCH'
                : 'FIRST15_CANARY_RECOVERY_SCOPE_MISMATCH',
        );
    }
    if (
        rearmRows.length === 0
        && (scoped.length !== 3 || recorded.length !== 0)
    ) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_INITIAL_SCOPE_MISMATCH');
    }

    return Object.freeze([...scoped].sort((left, right) => (
        FIRST15_CANARY_PROVIDER_FAILURE_CODES.indexOf(left.errorCode)
            - FIRST15_CANARY_PROVIDER_FAILURE_CODES.indexOf(right.errorCode)
        || left.orderId.localeCompare(right.orderId)
    )));
}

function validateProviderRuns(
    providerRuns: readonly StoredAnalysisV2ProviderRun[],
    requestIds: readonly string[],
): readonly StoredAnalysisV2ProviderRun[] {
    const requestIdSet = new Set(requestIds);
    if (
        providerRuns.some(run => !requestIdSet.has(run.requestId))
        || providerRuns.some(run => run.status === 'starting' || run.status === 'running')
    ) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_ACTIVE_PROVIDER_RUNS');
    }
    const unreconciled = providerRuns.filter(run => (
        terminalProviderStatuses.has(run.status)
        && run.actualUsageUsd === null
        && run.usageReconciledAt === null
    ));
    if (providerRuns.some(run => (
        terminalProviderStatuses.has(run.status)
        && ((run.actualUsageUsd === null) !== (run.usageReconciledAt === null))
    ))) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_PROVIDER_LEDGER_INVALID');
    }
    if (unreconciled.some(run => run.runId === null)) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_PROVIDER_LEDGER_INVALID');
    }
    return Object.freeze(unreconciled);
}

async function loadCandidates(): Promise<readonly First15CanaryProviderRecoveryCandidate[]> {
    const { data, error } = await supabaseAdmin.rpc(
        'list_earlybird_first15_canary_provider_recovery_candidates',
    );
    if (error || !Array.isArray(data) || data.length === 24) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_CANDIDATE_READ_FAILED');
    }
    return Object.freeze(data.map(value => {
        const row = rawCandidateSchema.parse(value);
        return {
            orderId: row.order_id,
            requestId: row.request_id,
            preflightId: row.preflight_id,
            errorCode: row.error_code,
            credentialSlot: row.credential_slot,
        };
    }));
}

async function loadRearms(): Promise<readonly First15CanaryProviderRecoveryRearm[]> {
    const { data, error } = await supabaseAdmin.rpc(
        'list_earlybird_first15_canary_provider_rearms',
    );
    if (error || !Array.isArray(data) || data.length > 12) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_REARM_READ_FAILED');
    }
    return Object.freeze(data.map(value => {
        const row = rawRearmSchema.parse(value);
        return {
            orderId: row.order_id,
            rearmedPreflightId: row.rearmed_preflight_id,
            rearmGeneration: row.rearm_generation,
            sourceFailureCode: row.source_failure_code,
        };
    }));
}

async function loadProviderRuns(
    requestIds: readonly string[],
): Promise<readonly StoredAnalysisV2ProviderRun[]> {
    const { data, error } = await supabaseAdmin.rpc(
        'list_earlybird_first15_canary_provider_runs',
        { p_request_ids: [...requestIds] },
    );
    if (error || !Array.isArray(data) || data.length === 64) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_PROVIDER_READ_FAILED');
    }
    return Object.freeze(data.map(value => {
        const row = rawProviderRunSchema.parse(value);
        return {
            requestId: row.request_id,
            jobKey: row.job_key,
            operationKey: row.operation_key,
            inputHash: row.input_hash,
            reservationToken: row.reservation_token,
            logicalProvider: row.logical_provider,
            actorId: row.actor_id,
            credentialSlot: row.credential_slot,
            maxChargeUsd: row.max_charge_usd,
            status: row.status,
            runId: row.run_id,
            actualUsageUsd: row.actual_usage_usd,
            reservedAt: row.reserved_at,
            runStartedAt: row.run_started_at,
            terminalizedAt: row.terminalized_at,
            usageReconciledAt: row.usage_reconciled_at,
        };
    }));
}

async function reconcileProviderRuns(
    runs: readonly StoredAnalysisV2ProviderRun[],
    reportFailure?: (failure: AnalysisV2ProviderReconciliationFailure) => void,
): Promise<AnalysisV2ProviderReconciliationSummary> {
    const scopedStore: AnalysisV2ProviderRunStore = {
        ...analysisV2ProviderRunStore,
        listUnreconciled: async () => [...runs],
    };
    return reconcileAnalysisV2ProviderUsage({
        store: scopedStore,
        concurrency: 3,
        maxBatches: 1,
        onUsageReconciliationFailure: reportFailure,
    });
}

async function rearm(input: {
    orderId: string;
    requestId: string;
    fallbackCredentialSlot: ApifyCredentialSlot;
}): Promise<{
    applied: boolean;
    requestId: string;
    initialJobKey: 'coordinator:bootstrap';
}> {
    const { data, error } = await supabaseAdmin.rpc(
        'rearm_earlybird_first15_canary_provider_failure',
        {
            p_order_id: input.orderId,
            p_expected_failed_request_id: input.requestId,
            p_fallback_credential_slot: input.fallbackCredentialSlot,
        },
    );
    const row = z.array(z.object({
        applied: z.boolean(),
        fulfillment_status: z.literal('analysis_in_progress'),
        request_id: uuidSchema,
        initial_job_key: z.literal('coordinator:bootstrap'),
    }).strict()).length(1).safeParse(data);
    if (error || !row.success) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_REARM_FAILED');
    }
    return {
        applied: row.data[0].applied,
        requestId: row.data[0].request_id,
        initialJobKey: row.data[0].initial_job_key,
    };
}

function defaultDependencies(): First15CanaryProviderRecoveryDependencies {
    return {
        workerAvailable: () => isAnalysisV2WorkerAvailable(),
        loadCandidates,
        loadRearms,
        loadProviderRuns,
        reconcileProviderRuns,
        rearm,
        dispatch: dispatchAnalysisV2Job,
    };
}

/**
 * Performs exactly the isolated first15 recovery cohort. It intentionally has
 * no fallback to global job/fulfillment maintenance and emits only counts.
 */
export async function runFirst15CanaryProviderRecovery(
    dependencies: First15CanaryProviderRecoveryDependencies = defaultDependencies(),
): Promise<First15CanaryProviderRecoverySummary> {
    if (!dependencies.workerAvailable()) {
        throw noOutputError('FIRST15_CANARY_RECOVERY_WORKER_UNAVAILABLE');
    }
    const [candidates, rearmRows] = await Promise.all([
        dependencies.loadCandidates(),
        dependencies.loadRearms(),
    ]);
    const scoped = selectScopedCandidates(candidates, rearmRows);
    const requestIds = scoped.map(candidate => candidate.requestId);
    const providerRuns = await dependencies.loadProviderRuns(requestIds);
    const unreconciled = validateProviderRuns(providerRuns, requestIds);
    const reconciliationFailures: AnalysisV2ProviderReconciliationFailure[] = [];
    const reconciliation = await dependencies.reconcileProviderRuns(
        unreconciled,
        failure => reconciliationFailures.push(failure),
    );
    if (
        reconciliation.eligible !== unreconciled.length
        || reconciliation.reconciled !== unreconciled.length
        || reconciliation.failed !== 0
        || reconciliation.hasMore
    ) {
        throw noOutputError(
            reconciliationFailureCode(reconciliationFailures)
                ?? 'FIRST15_CANARY_RECOVERY_PROVIDER_RECONCILIATION_FAILED',
        );
    }

    let rearmed = 0;
    let dispatched = 0;
    for (const candidate of scoped) {
        const replay = await dependencies.rearm({
            orderId: candidate.orderId,
            requestId: candidate.requestId,
            fallbackCredentialSlot: orderedFallback(candidate.credentialSlot),
        });
        rearmed += Number(replay.applied);
        await dependencies.dispatch(replay.requestId, replay.initialJobKey);
        dispatched += 1;
    }
    return Object.freeze({
        candidates: scoped.length,
        reconciledProviderRuns: reconciliation.reconciled,
        rearmed,
        dispatched,
    });
}
