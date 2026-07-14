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

type RecoveryOutcome = keyof Omit<AnalysisV2RecoverySummary, 'scanned'>;

function assertRecoverableDelivery(job: AnalysisV2DispatchableJob): {
    requestId: string;
    jobKey: string;
    generation: number;
    reservationToken: string;
} {
    if (job.generation < 1 || !job.reservationToken) {
        throw new Error('ANALYSIS_V2_RECOVERY_ERROR: incomplete delivery fence.');
    }
    return {
        requestId: job.requestId,
        jobKey: job.jobKey,
        generation: job.generation,
        reservationToken: job.reservationToken,
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
    if (task === 'exists') return 'taskPresent';

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
