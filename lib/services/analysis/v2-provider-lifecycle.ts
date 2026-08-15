import { ApifyApiError } from 'apify-client';
import { getApifyClient } from '@/lib/services/instagram/providers/apify-relationship';
import type {
    ApifyCredentialSlot,
    ProviderCostTerminalStatus,
} from '@/lib/services/instagram/providers/types';
import {
    analysisV2ProviderRunStore,
    type AnalysisV2ProviderRunCleanupIntentInput,
    type AnalysisV2ProviderRunStore,
    type StoredAnalysisV2ProviderRun,
} from './v2-provider-run-store';

export const ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_ROWS = 64;
export const ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_BATCHES = 4;
export const ANALYSIS_V2_PROVIDER_LIFECYCLE_CONCURRENCY = 4;
const ABORT_WAIT_SECS = 30;

interface ApifyRunSnapshot {
    status?: unknown;
    usageTotalUsd?: unknown;
}

interface LifecycleApifyRunClient {
    get(): Promise<ApifyRunSnapshot | undefined>;
    abort(): Promise<ApifyRunSnapshot>;
    waitForFinish(options: { waitSecs: number }): Promise<ApifyRunSnapshot>;
}

interface LifecycleApifyClient {
    run(runId: string): LifecycleApifyRunClient;
}

export interface AnalysisV2ProviderCleanupSummary {
    scanned: number;
    settled: number;
    failed: number;
    unconfirmedStarts: number;
    hasMore: boolean;
}

export interface AnalysisV2ProviderReconciliationSummary {
    eligible: number;
    reconciled: number;
    failed: number;
    hasMore: boolean;
}

export const ANALYSIS_V2_PROVIDER_RECONCILIATION_FAILURE_REASONS = [
    'provider_auth_failed',
    'provider_run_missing',
    'provider_rate_limited',
    'provider_read_failed',
    'remote_status_mismatch',
    'remote_usage_missing',
    'remote_usage_invalid',
    'ledger_write_failed',
    'revenue_settlement_unavailable',
    'revenue_settlement_failed',
    'stored_run_invalid',
] as const;

export type AnalysisV2ProviderReconciliationFailureReason =
    typeof ANALYSIS_V2_PROVIDER_RECONCILIATION_FAILURE_REASONS[number];

export interface AnalysisV2ProviderReconciliationFailure {
    credentialSlot: ApifyCredentialSlot;
    reason: AnalysisV2ProviderReconciliationFailureReason;
}

export interface AnalysisV2ProviderUsageRevenueCostSettlement {
    settleAfterUsageReconciliation(
        run: StoredAnalysisV2ProviderRun,
        options?: { knownRevenueCostOperation?: boolean },
    ): Promise<void>;
}

export interface ProviderLifecycleDependencies {
    store?: AnalysisV2ProviderRunStore;
    env?: Record<string, string | undefined>;
    clientForSlot?: (slot: ApifyCredentialSlot) => LifecycleApifyClient;
    revenueCostSettlement?: AnalysisV2ProviderUsageRevenueCostSettlement;
    /**
     * Optional PII-free observability hook. It receives no provider run,
     * request, actor, token, or remote error identifiers.
     */
    onUsageReconciliationFailure?: (
        failure: AnalysisV2ProviderReconciliationFailure,
    ) => void;
    concurrency?: number;
    maxBatches?: number;
}

function providerReadFailureReason(error: unknown): AnalysisV2ProviderReconciliationFailureReason {
    if (error instanceof ApifyApiError) {
        if (error.statusCode === 401 || error.statusCode === 403) {
            return 'provider_auth_failed';
        }
        if (error.statusCode === 404) return 'provider_run_missing';
        if (error.statusCode === 429) return 'provider_rate_limited';
    }
    return 'provider_read_failed';
}

function reportUsageReconciliationFailure(
    run: StoredAnalysisV2ProviderRun,
    reason: AnalysisV2ProviderReconciliationFailureReason,
    dependencies: ProviderLifecycleDependencies,
): void {
    try {
        dependencies.onUsageReconciliationFailure?.({
            credentialSlot: run.credentialSlot,
            reason,
        });
    } catch {
        // Observability must not alter authoritative reconciliation behavior.
    }
}

function terminalStatus(value: unknown): ProviderCostTerminalStatus | undefined {
    switch (value) {
        case 'SUCCEEDED': return 'succeeded';
        case 'FAILED': return 'failed';
        case 'ABORTED': return 'aborted';
        case 'TIMED-OUT': return 'timed_out';
        default: return undefined;
    }
}

function terminalUsageTotalUsd(
    snapshot: ApifyRunSnapshot,
    maximumChargeUsd: number
): number | null {
    if (snapshot.usageTotalUsd === undefined || snapshot.usageTotalUsd === null) {
        return null;
    }
    if (
        typeof snapshot.usageTotalUsd !== 'number'
        || !Number.isFinite(snapshot.usageTotalUsd)
        || snapshot.usageTotalUsd < 0
        || snapshot.usageTotalUsd > maximumChargeUsd + 0.000000001
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_INVALID_USAGE');
    }
    return Number(snapshot.usageTotalUsd.toFixed(12));
}

function lifecycleClient(
    slot: ApifyCredentialSlot,
    dependencies: ProviderLifecycleDependencies
): LifecycleApifyClient {
    return dependencies.clientForSlot?.(slot)
        ?? getApifyClient(dependencies.env ?? process.env, slot);
}

async function confirmTerminalSnapshot(
    run: StoredAnalysisV2ProviderRun,
    dependencies: ProviderLifecycleDependencies
): Promise<Readonly<{
    status: ProviderCostTerminalStatus;
    usageTotalUsd: number | null;
}>> {
    if (!run.runId || run.status !== 'running') {
        throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_INVALID_RUN');
    }
    const remote = lifecycleClient(run.credentialSlot, dependencies).run(run.runId);
    let snapshot = await remote.get();
    if (!snapshot) throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_RUN_NOT_FOUND');
    let status = terminalStatus(snapshot.status);
    if (!status) {
        if (snapshot.status === 'READY' || snapshot.status === 'RUNNING') {
            snapshot = await remote.abort();
            status = terminalStatus(snapshot.status);
        } else if (snapshot.status !== 'ABORTING' && snapshot.status !== 'TIMING-OUT') {
            throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_UNKNOWN_STATUS');
        }
        if (!status) {
            snapshot = await remote.waitForFinish({ waitSecs: ABORT_WAIT_SECS });
            status = terminalStatus(snapshot.status);
        }
    }
    if (!status) throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_NOT_TERMINAL');
    return Object.freeze({
        status,
        // Terminal Actor responses can expose preliminary Store-event cost. Leave
        // usage open for the authenticated post-settlement reconciliation sweep.
        usageTotalUsd: null,
    });
}

async function runBounded<T, R>(
    values: readonly T[],
    concurrency: number,
    task: (value: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (cursor < values.length) {
                const index = cursor++;
                results[index] = await task(values[index]);
            }
        }
    ));
    return results;
}

function lifecycleBounds(dependencies: ProviderLifecycleDependencies): {
    concurrency: number;
    maxBatches: number;
} {
    const concurrency = dependencies.concurrency
        ?? ANALYSIS_V2_PROVIDER_LIFECYCLE_CONCURRENCY;
    const maxBatches = dependencies.maxBatches
        ?? ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_BATCHES;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_INVALID_CONCURRENCY');
    }
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 8) {
        throw new Error('ANALYSIS_V2_PROVIDER_CLEANUP_INVALID_BATCH_LIMIT');
    }
    return { concurrency, maxBatches };
}

/**
 * Aborts or confirms only runs whose IDs are already durably checkpointed. A
 * starting intent has no safe remote identity and remains an explicit blocker.
 */
export async function settleActiveAnalysisV2ProviderRuns(
    requestId?: string,
    dependencies: ProviderLifecycleDependencies = {}
): Promise<AnalysisV2ProviderCleanupSummary> {
    const store = dependencies.store ?? analysisV2ProviderRunStore;
    const { concurrency, maxBatches } = lifecycleBounds(dependencies);
    const summary: AnalysisV2ProviderCleanupSummary = {
        scanned: 0,
        settled: 0,
        failed: 0,
        unconfirmedStarts: 0,
        hasMore: false,
    };

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
        const batch = await store.listActiveForCleanup({
            ...(requestId ? { requestId } : {}),
            limit: ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_ROWS,
        });
        summary.unconfirmedStarts = batch.startingCount;
        if (batch.runs.length === 0) break;
        summary.scanned += batch.runs.length;
        const outcomes = await runBounded(batch.runs, concurrency, async run => {
            try {
                const terminal = await confirmTerminalSnapshot(run, dependencies);
                await store.settleForCleanup({
                    reservationToken: run.reservationToken,
                    runId: run.runId as string,
                    logicalProvider: run.logicalProvider,
                    actorId: run.actorId,
                    credentialSlot: run.credentialSlot,
                    maxChargeUsd: run.maxChargeUsd,
                    status: terminal.status,
                    actualUsageUsd: terminal.usageTotalUsd,
                });
                return true;
            } catch {
                return false;
            }
        });
        const settled = outcomes.filter(Boolean).length;
        summary.settled += settled;
        summary.failed += outcomes.length - settled;
        if (settled !== outcomes.length) break;
        if (batch.runs.length < ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_ROWS) break;
        if (batchIndex === maxBatches - 1) summary.hasMore = true;
    }
    return Object.freeze(summary);
}

/** Authenticated eventual-cost reconciliation for terminal V2 runs. */
export async function reconcileAnalysisV2ProviderUsage(
    dependencies: ProviderLifecycleDependencies = {}
): Promise<AnalysisV2ProviderReconciliationSummary> {
    const store = dependencies.store ?? analysisV2ProviderRunStore;
    const { concurrency } = lifecycleBounds(dependencies);
    const rows = await store.listUnreconciled(ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_ROWS);
    const outcomes = await runBounded(rows, concurrency, async run => {
        if (
            run.revenueCostSettlementRequired
            && hasAuthoritativeRevenueCostSettlement(run)
        ) {
            const settlement = dependencies.revenueCostSettlement;
            if (!settlement) {
                reportUsageReconciliationFailure(
                    run,
                    'revenue_settlement_unavailable',
                    dependencies,
                );
                return false;
            }
            try {
                await settlement.settleAfterUsageReconciliation(run, {
                    knownRevenueCostOperation: true,
                });
                return true;
            } catch {
                reportUsageReconciliationFailure(
                    run,
                    'revenue_settlement_failed',
                    dependencies,
                );
                return false;
            }
        }
        if (!run.runId || !terminalStatusForStored(run.status)) {
            reportUsageReconciliationFailure(run, 'stored_run_invalid', dependencies);
            return false;
        }

        let snapshot: ApifyRunSnapshot | undefined;
        try {
            snapshot = await lifecycleClient(
                run.credentialSlot,
                dependencies
            ).run(run.runId).get();
            if (!snapshot) {
                reportUsageReconciliationFailure(run, 'provider_run_missing', dependencies);
                return false;
            }
        } catch (error) {
            reportUsageReconciliationFailure(
                run,
                providerReadFailureReason(error),
                dependencies,
            );
            return false;
        }

        const status = terminalStatus(snapshot.status);
        if (status !== run.status) {
            reportUsageReconciliationFailure(run, 'remote_status_mismatch', dependencies);
            return false;
        }
        let usageTotalUsd: number | null;
        try {
            usageTotalUsd = terminalUsageTotalUsd(snapshot, run.maxChargeUsd);
        } catch {
            reportUsageReconciliationFailure(run, 'remote_usage_invalid', dependencies);
            return false;
        }
        if (usageTotalUsd === null) {
            reportUsageReconciliationFailure(run, 'remote_usage_missing', dependencies);
            return false;
        }
        let reconciled: StoredAnalysisV2ProviderRun;
        try {
            reconciled = await store.reconcileUsage({
                reservationToken: run.reservationToken,
                runId: run.runId,
                logicalProvider: run.logicalProvider,
                actorId: run.actorId,
                credentialSlot: run.credentialSlot,
                maxChargeUsd: run.maxChargeUsd,
                status,
                actualUsageUsd: usageTotalUsd,
            });
        } catch {
            reportUsageReconciliationFailure(run, 'ledger_write_failed', dependencies);
            return false;
        }
        if (!run.revenueCostSettlementRequired) return true;
        const settlement = dependencies.revenueCostSettlement;
        if (!settlement) {
            reportUsageReconciliationFailure(
                run,
                'revenue_settlement_unavailable',
                dependencies,
            );
            return false;
        }
        try {
            await settlement.settleAfterUsageReconciliation(reconciled, {
                knownRevenueCostOperation: true,
            });
            return true;
        } catch {
            reportUsageReconciliationFailure(
                run,
                'revenue_settlement_failed',
                dependencies,
            );
            return false;
        }
    });
    const reconciled = outcomes.filter(Boolean).length;
    return Object.freeze({
        eligible: rows.length,
        reconciled,
        failed: outcomes.length - reconciled,
        hasMore: rows.length === ANALYSIS_V2_PROVIDER_LIFECYCLE_MAX_ROWS,
    });
}

function terminalStatusForStored(
    status: StoredAnalysisV2ProviderRun['status']
): status is ProviderCostTerminalStatus {
    return status === 'succeeded'
        || status === 'failed'
        || status === 'aborted'
        || status === 'timed_out';
}

function hasAuthoritativeRevenueCostSettlement(
    run: StoredAnalysisV2ProviderRun
): boolean {
    if (run.status === 'rejected') {
        return run.runId === null
            && run.runStartedAt === null
            && run.terminalizedAt !== null
            && run.actualUsageUsd === 0
            && run.usageReconciledAt !== null;
    }
    return terminalStatusForStored(run.status)
        && run.runId !== null
        && run.runStartedAt !== null
        && run.terminalizedAt !== null
        && run.actualUsageUsd !== null
        && run.usageReconciledAt !== null;
}

export async function prepareAnalysisV2ProviderRunsForTerminalFailure(
    input: AnalysisV2ProviderRunCleanupIntentInput,
    dependencies: ProviderLifecycleDependencies = {}
): Promise<AnalysisV2ProviderCleanupSummary> {
    const store = dependencies.store ?? analysisV2ProviderRunStore;
    await store.requestCleanup(input);
    const summary = await settleActiveAnalysisV2ProviderRuns(input.requestId, {
        ...dependencies,
        store,
    });
    if (
        summary.failed > 0
        || summary.unconfirmedStarts > 0
        || summary.hasMore
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
    }
    return summary;
}
