import {
    AnalysisV2JobFenceError,
    analysisV2JobStore,
    type AnalysisV2DispatchableJob,
    type AnalysisV2JobStore,
} from './v2-job-store';
import {
    dispatchAnalysisV2Job,
    lookupAnalysisV2Task,
    type AnalysisV2TaskLookupOutcome,
} from './v2-tasks';
import {
    cleanupConfiguredAnalysisV2TerminalMedia,
} from './v2-media-artifact-store';
import {
    reconcileAnalysisV2ProviderUsage,
    settleActiveAnalysisV2ProviderRuns,
    type AnalysisV2ProviderUsageRevenueCostSettlement,
    type AnalysisV2ProviderCleanupSummary,
    type AnalysisV2ProviderReconciliationSummary,
} from './v2-provider-lifecycle';
import {
    analysisV2RevenueCostProviderRunSettlement,
} from './revenue-cost-provider-run-reconciliation';
import {
    recoverEarlybirdFulfillments,
    type EarlybirdFulfillmentRecoverySummary,
} from '@/lib/services/earlybird/fulfillment-store';
import { analysisV2GeminiLeaseStore } from './v2-gemini-lease-store';
import {
    reapAnalysisV2SchedulerGeminiLeases,
    recoverAnalysisV2SchedulerOperations,
} from './v2-ai-scheduler-operation-store';
import { recoverQueuedAnalysisScoreAudits } from './score-audit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { operationalLogger } from '@/lib/observability/server';
import {
    archiveSettledBetaApifyCredit,
    recoverBetaApifyCredit,
    refreshBetaApifyCreditSnapshots,
} from './beta-apify-credit-settlement-runtime';
import { getBetaApifyCreditPoolRuntimeConfig } from './beta-apify-credit-runtime';

export const ANALYSIS_V2_RECOVERY_MAX_JOBS = 100;
export const ANALYSIS_V2_RECOVERY_CONCURRENCY = 10;

export interface AnalysisV2RecoverySummary {
    scanned: number;
    dispatched: number;
    taskPresent: number;
    lostRace: number;
    failed: number;
    providerRunsSettled: number;
    providerRunsBlocked: number;
    providerUsageReconciled: number;
    fulfillmentsScanned: number;
    fulfillmentsAdvanced: number;
    fulfillmentsCompleted: number;
    fulfillmentsManualReview: number;
    fulfillmentsFailed: number;
    geminiCutoffAttemptsRecovered: number;
    geminiCutoffLeasesReaped: number;
    schedulerOperationsRecovered: number;
    schedulerGeminiLeasesReaped: number;
    betaCreditRecovered: number;
    betaCreditArchived: number;
    betaCreditRecoveryFailures: number;
    betaCreditArchiveFailures: number;
    betaCreditRefreshAttempts: number;
    betaCreditRefreshFailures: number;
}

type RecoveryLookup = (job: {
    requestId: string;
    jobKey: string;
    generation: number;
}) => Promise<AnalysisV2TaskLookupOutcome>;

type RecoveryDispatch = (requestId: string, jobKey: string) => Promise<unknown>;
type TerminalMediaCleanup = () => Promise<unknown>;
type ProviderRunCleanup = () => Promise<AnalysisV2ProviderCleanupSummary>;
type ProviderUsageReconciliation = () => Promise<AnalysisV2ProviderReconciliationSummary>;
type FulfillmentRecovery = () => Promise<EarlybirdFulfillmentRecoverySummary>;
type GeminiCutoffAttemptRecovery = () => Promise<number>;
type GeminiCutoffLeaseReaper = () => Promise<number>;
type SchedulerOperationRecovery = () => Promise<number>;
type SchedulerGeminiLeaseReaper = () => Promise<number>;
type ScoreAuditRecovery = () => Promise<void>;
type BetaCreditMaintenance = () => Promise<number>;
type BetaCreditRefresh = () => Promise<void>;

function betaPoolSnapshotAge(
    env: Record<string, string | undefined> | undefined,
): number | undefined {
    try {
        return getBetaApifyCreditPoolRuntimeConfig(env).maxSnapshotAgeSeconds;
    } catch {
        // Invalid admission configuration must not suppress terminal settlement.
        return undefined;
    }
}

function betaRecoveryObservability(
    env: Record<string, string | undefined> | undefined,
) {
    const maxSnapshotAgeSeconds = betaPoolSnapshotAge(env);
    return {
        telemetry: operationalLogger,
        ...(maxSnapshotAgeSeconds === undefined ? {} : { maxSnapshotAgeSeconds }),
    };
}

type RecoveryOutcome =
    | 'dispatched'
    | 'taskPresent'
    | 'lostRace'
    | 'failed';

function assertRecoverableDelivery(job: AnalysisV2DispatchableJob): {
    requestId: string;
    jobKey: string;
    generation: number;
    reservationToken: string;
    status: 'pending' | 'processing';
    leaseExpiresAt: string | null;
} {
    if (job.generation < 1 || !job.reservationToken) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: incomplete delivery fence.');
    }
    if (job.status !== 'pending' && job.status !== 'processing') {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid recoverable state.');
    }
    if (
        (job.status === 'pending' && job.leaseExpiresAt !== null)
        || (job.status === 'processing' && job.leaseExpiresAt === null)
    ) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid recoverable state.');
    }
    return {
        requestId: job.requestId,
        jobKey: job.jobKey,
        generation: job.generation,
        reservationToken: job.reservationToken,
        status: job.status,
        leaseExpiresAt: job.leaseExpiresAt,
    };
}

async function boundedBestEffort(
    operation: () => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation(),
            new Promise<void>(resolve => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function recoverOne(
    job: AnalysisV2DispatchableJob,
    store: AnalysisV2JobStore,
    lookup: RecoveryLookup,
    dispatch: RecoveryDispatch
): Promise<RecoveryOutcome> {
    if (job.dispatchState === 'pending' || job.dispatchState === 'reserved') {
        await dispatch(job.requestId, job.jobKey);
        return 'dispatched';
    }

    const delivery = assertRecoverableDelivery(job);
    const task = await lookup({
        requestId: delivery.requestId,
        jobKey: delivery.jobKey,
        generation: delivery.generation,
    });
    if (task === 'exists') {
        const deferred = await store.deferRecovery({
            requestId: delivery.requestId,
            jobKey: delivery.jobKey,
            expectedGeneration: delivery.generation,
            expectedReservationToken: delivery.reservationToken,
            expectedStatus: delivery.status,
            expectedLeaseExpiresAt: delivery.leaseExpiresAt,
        });
        return deferred ? 'taskPresent' : 'lostRace';
    }

    try {
        await store.rearmDispatch({
            requestId: delivery.requestId,
            jobKey: delivery.jobKey,
            expectedGeneration: delivery.generation,
            expectedReservationToken: delivery.reservationToken,
        });
    } catch (error) {
        if (error instanceof AnalysisV2JobFenceError) return 'lostRace';
        throw error;
    }
    await dispatch(delivery.requestId, delivery.jobKey);
    return 'dispatched';
}

async function cleanupTerminalMedia(): Promise<void> {
    await cleanupConfiguredAnalysisV2TerminalMedia();
}

export async function recoverAnalysisV2Jobs(
    dependencies: {
        store?: AnalysisV2JobStore;
        lookup?: RecoveryLookup;
        dispatch?: RecoveryDispatch;
        limit?: number;
        concurrency?: number;
        cleanupTerminalMedia?: TerminalMediaCleanup;
        cleanupProviderRuns?: ProviderRunCleanup;
        reconcileProviderUsage?: ProviderUsageReconciliation;
        revenueCostSettlement?: AnalysisV2ProviderUsageRevenueCostSettlement;
        recoverFulfillments?: FulfillmentRecovery;
        recoverGeminiCutoffAttempts?: GeminiCutoffAttemptRecovery;
        reapGeminiCutoffLeases?: GeminiCutoffLeaseReaper;
        recoverSchedulerOperations?: SchedulerOperationRecovery;
        reapSchedulerGeminiLeases?: SchedulerGeminiLeaseReaper;
        recoverScoreAudits?: ScoreAuditRecovery;
        recoverBetaCredit?: BetaCreditMaintenance;
        archiveBetaCredit?: BetaCreditMaintenance;
        refreshBetaCredit?: BetaCreditRefresh;
        env?: Record<string, string | undefined>;
        scoreAuditTimeoutMs?: number;
    } = {}
): Promise<AnalysisV2RecoverySummary> {
    const store = dependencies.store ?? analysisV2JobStore;
    const lookup = dependencies.lookup ?? (input => lookupAnalysisV2Task(input));
    const dispatch = dependencies.dispatch ?? dispatchAnalysisV2Job;
    const limit = dependencies.limit ?? ANALYSIS_V2_RECOVERY_MAX_JOBS;
    const concurrency = dependencies.concurrency ?? ANALYSIS_V2_RECOVERY_CONCURRENCY;
    const scoreAuditTimeoutMs = dependencies.scoreAuditTimeoutMs ?? 250;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ANALYSIS_V2_RECOVERY_MAX_JOBS) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid limit.');
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid concurrency.');
    }
    if (
        !Number.isSafeInteger(scoreAuditTimeoutMs)
        || scoreAuditTimeoutMs < 25
        || scoreAuditTimeoutMs > 5_000
    ) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid audit timeout.');
    }

    const jobs = await store.listDispatchable({ limit });
    const summary: AnalysisV2RecoverySummary = {
        scanned: jobs.length,
        dispatched: 0,
        taskPresent: 0,
        lostRace: 0,
        failed: 0,
        providerRunsSettled: 0,
        providerRunsBlocked: 0,
        providerUsageReconciled: 0,
        fulfillmentsScanned: 0,
        fulfillmentsAdvanced: 0,
        fulfillmentsCompleted: 0,
        fulfillmentsManualReview: 0,
        fulfillmentsFailed: 0,
        geminiCutoffAttemptsRecovered: 0,
        geminiCutoffLeasesReaped: 0,
        schedulerOperationsRecovered: 0,
        schedulerGeminiLeasesReaped: 0,
        betaCreditRecovered: 0,
        betaCreditArchived: 0,
        betaCreditRecoveryFailures: 0,
        betaCreditArchiveFailures: 0,
        betaCreditRefreshAttempts: 0,
        betaCreditRefreshFailures: 0,
    };
    try {
        summary.geminiCutoffAttemptsRecovered = await (
            dependencies.recoverGeminiCutoffAttempts
            ?? (() => analysisV2GeminiLeaseStore.recoverCutoffAttempts({ limit: 8 }))
        )();
    } catch {
        summary.failed += 1;
    }
    try {
        summary.geminiCutoffLeasesReaped = await (
            dependencies.reapGeminiCutoffLeases
            ?? (() => analysisV2GeminiLeaseStore.reapCutoff({ limit: 8 }))
        )();
    } catch {
        summary.failed += 1;
    }
    try {
        summary.schedulerOperationsRecovered = await (
            dependencies.recoverSchedulerOperations
            ?? (() => recoverAnalysisV2SchedulerOperations({ limit: 8 }))
        )();
    } catch {
        summary.failed += 1;
    }
    try {
        summary.schedulerGeminiLeasesReaped = await (
            dependencies.reapSchedulerGeminiLeases
            ?? (() => reapAnalysisV2SchedulerGeminiLeases({ limit: 8 }))
        )();
    } catch {
        summary.failed += 1;
    }
    let cursor = 0;
    const worker = async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            try {
                const outcome = await recoverOne(job, store, lookup, dispatch);
                summary[outcome] += 1;
            } catch {
                summary.failed += 1;
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
    );
    try {
        const fulfillment = await (
            dependencies.recoverFulfillments
            ?? (() => recoverEarlybirdFulfillments())
        )();
        summary.fulfillmentsScanned = fulfillment.scanned;
        summary.fulfillmentsAdvanced = fulfillment.advanced;
        summary.fulfillmentsCompleted = fulfillment.reconciled.completed;
        summary.fulfillmentsManualReview =
            fulfillment.reconciled.manualReview;
        summary.fulfillmentsFailed = fulfillment.failed;
        summary.failed += fulfillment.failed;
    } catch {
        summary.fulfillmentsFailed += 1;
        summary.failed += 1;
    }
    try {
        await (dependencies.cleanupTerminalMedia ?? cleanupTerminalMedia)();
    } catch {
        summary.failed += 1;
    }
    try {
        const providerCleanup = await (
            dependencies.cleanupProviderRuns
            ?? (() => settleActiveAnalysisV2ProviderRuns())
        )();
        summary.providerRunsSettled = providerCleanup.settled;
        summary.providerRunsBlocked = providerCleanup.unconfirmedStarts
            + providerCleanup.failed
            + (providerCleanup.hasMore ? 1 : 0);
        if (summary.providerRunsBlocked > 0) summary.failed += 1;
    } catch {
        summary.failed += 1;
        summary.providerRunsBlocked += 1;
    }
    try {
        const reconciliation = await (
            dependencies.reconcileProviderUsage
            ?? (() => reconcileAnalysisV2ProviderUsage({
                revenueCostSettlement: dependencies.revenueCostSettlement
                    ?? analysisV2RevenueCostProviderRunSettlement,
            }))
        )();
        summary.providerUsageReconciled = reconciliation.reconciled;
        if (reconciliation.failed > 0 || reconciliation.hasMore) summary.failed += 1;
    } catch {
        summary.failed += 1;
    }
    // Provider lifecycle is reconciled first.  Credit recovery is deliberately
    // post-terminal and feature-flag independent; refresh is only advisory.
    const hasBetaMaintenance = Boolean(
        dependencies.recoverBetaCredit
        || dependencies.archiveBetaCredit
        || dependencies.refreshBetaCredit
        || typeof (supabaseAdmin as { rpc?: unknown }).rpc === 'function'
    );
    if (hasBetaMaintenance) {
        try {
            summary.betaCreditRecovered = await (dependencies.recoverBetaCredit
                ?? (() => recoverBetaApifyCredit(
                    supabaseAdmin,
                    100,
                    betaRecoveryObservability(dependencies.env),
                )))();
        } catch {
            summary.failed += 1;
            summary.betaCreditRecoveryFailures += 1;
        }
        try {
            summary.betaCreditArchived = await (dependencies.archiveBetaCredit
                ?? (() => archiveSettledBetaApifyCredit(supabaseAdmin)))();
        } catch {
            summary.failed += 1;
            summary.betaCreditArchiveFailures += 1;
        }
        if (summary.betaCreditRecovered > 0) {
            summary.betaCreditRefreshAttempts = 1;
            try {
                await (dependencies.refreshBetaCredit
                    ?? (() => refreshBetaApifyCreditSnapshots(supabaseAdmin, {
                        env: dependencies.env,
                        telemetry: operationalLogger,
                    })))();
            } catch {
                summary.betaCreditRefreshFailures = 1;
            }
        }
    }
    // The durable audit outbox drains only after provider safety cleanup and reconciliation.
    // A hung audit cannot extend this recovery pass beyond the small fixed budget.
    try {
        await boundedBestEffort(
            dependencies.recoverScoreAudits
                ?? (() => recoverQueuedAnalysisScoreAudits(supabaseAdmin, 5)),
            scoreAuditTimeoutMs,
        );
    } catch {
        // Audit observability never changes analysis/provider cleanup success.
    }
    return Object.freeze(summary);
}
