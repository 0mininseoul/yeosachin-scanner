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
    type AnalysisV2ProviderCleanupSummary,
    type AnalysisV2ProviderReconciliationSummary,
} from './v2-provider-lifecycle';
import {
    recoverEarlybirdFulfillments,
    type EarlybirdFulfillmentRecoverySummary,
} from '@/lib/services/earlybird/fulfillment-store';

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
        recoverFulfillments?: FulfillmentRecovery;
    } = {}
): Promise<AnalysisV2RecoverySummary> {
    const store = dependencies.store ?? analysisV2JobStore;
    const lookup = dependencies.lookup ?? (input => lookupAnalysisV2Task(input));
    const dispatch = dependencies.dispatch ?? dispatchAnalysisV2Job;
    const limit = dependencies.limit ?? ANALYSIS_V2_RECOVERY_MAX_JOBS;
    const concurrency = dependencies.concurrency ?? ANALYSIS_V2_RECOVERY_CONCURRENCY;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ANALYSIS_V2_RECOVERY_MAX_JOBS) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid limit.');
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: invalid concurrency.');
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
    };
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
            ?? (() => reconcileAnalysisV2ProviderUsage())
        )();
        summary.providerUsageReconciled = reconciliation.reconciled;
        if (reconciliation.failed > 0 || reconciliation.hasMore) summary.failed += 1;
    } catch {
        summary.failed += 1;
    }
    return Object.freeze(summary);
}
