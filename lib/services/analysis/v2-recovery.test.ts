import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisV2JobFenceError,
    type AnalysisV2DispatchableJob,
    type AnalysisV2JobStore,
} from './v2-job-store';
import { recoverAnalysisV2Jobs } from './v2-recovery';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const reservationToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture

function job(
    jobKey: string,
    dispatchState: AnalysisV2DispatchableJob['dispatchState']
): AnalysisV2DispatchableJob {
    const hasDelivery = dispatchState === 'enqueued' || dispatchState === 'delivered';
    return {
        requestId,
        jobKey,
        status: dispatchState === 'delivered' ? 'processing' : 'pending',
        dispatchState,
        generation: dispatchState === 'pending' ? 0 : 1,
        reservationToken: dispatchState === 'pending' ? null : reservationToken,
        reservedAt: dispatchState === 'pending' ? null : '2030-07-13T00:00:00Z',
        dispatchedAt: hasDelivery ? '2030-07-13T00:00:01Z' : null,
        taskName: hasDelivery
            ? 'projects/example-project/locations/asia-northeast3/queues/analysis-v2/tasks/analysis-v2-task'
            : null,
        leaseExpiresAt: dispatchState === 'delivered'
            ? '2030-07-13T00:05:00Z'
            : null,
    };
}

function store(jobs: AnalysisV2DispatchableJob[]): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(async input => ({
            requestId: input.requestId,
            jobKey: input.jobKey,
            reserved: true,
            generation: input.expectedGeneration + 1,
            reservationToken,
            status: 'pending' as const,
            dispatchState: 'reserved' as const,
            taskName: null,
        })),
        deferRecovery: vi.fn(async () => true),
        markDispatched: vi.fn(),
        claim: vi.fn(),
        deferTerminalCleanup: vi.fn(),
        deferAiCapacity: vi.fn(),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(),
        listDispatchable: vi.fn(async () => jobs),
    };
}

function providerRecovery() {
    return {
        recoverFulfillments: vi.fn(async () => ({
            reconciled: {
                scanned: 0,
                completed: 0,
                manualReview: 0,
                retryable: 0,
            },
            scanned: 0,
            advanced: 0,
            failed: 0,
        })),
        cleanupProviderRuns: vi.fn(async () => ({
            scanned: 0,
            settled: 0,
            failed: 0,
            unconfirmedStarts: 0,
            hasMore: false,
        })),
        reconcileProviderUsage: vi.fn(async () => ({
            eligible: 0,
            reconciled: 0,
            failed: 0,
            hasMore: false,
        })),
    };
}

describe('analysis V2 dispatch recovery', () => {
    it('dispatches pending/reserved jobs and preserves task identities that still exist', async () => {
        const jobStore = store([
            job('coordinator:pending', 'pending'),
            job('coordinator:reserved', 'reserved'),
            job('coordinator:existing', 'enqueued'),
        ]);
        const dispatch = vi.fn(async () => 'enqueued');
        const lookup = vi.fn(async () => 'exists' as const);
        const cleanupTerminalMedia = vi.fn(async () => undefined);

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            dispatch,
            lookup,
            cleanupTerminalMedia,
        })).resolves.toEqual({
            scanned: 3,
            dispatched: 2,
            taskPresent: 1,
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
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.deferRecovery).toHaveBeenCalledWith({
            requestId,
            jobKey: 'coordinator:existing',
            expectedGeneration: 1,
            expectedReservationToken: reservationToken,
            expectedStatus: 'pending',
            expectedLeaseExpiresAt: null,
        });
        expect(jobStore.rearmDispatch).not.toHaveBeenCalled();
        expect(cleanupTerminalMedia).toHaveBeenCalledOnce();
    });

    it('rotates task-present rows so the next bounded scan reaches later work', async () => {
        const taskPresentJobs = Array.from({ length: 100 }, (_, index) => (
            job(`track:profiles:batch:${index}`, 'enqueued')
        ));
        const actionable = job('coordinator:pending', 'pending');
        const jobStore = store([...taskPresentJobs, actionable]);
        const deferred = new Set<string>();
        jobStore.listDispatchable = vi.fn(async ({ limit = 100 } = {}) => (
            [...taskPresentJobs, actionable]
                .filter(candidate => !deferred.has(candidate.jobKey))
                .slice(0, limit)
        ));
        jobStore.deferRecovery = vi.fn(async input => {
            deferred.add(input.jobKey);
            return true;
        });
        const dispatch = vi.fn(async () => 'enqueued');

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            lookup: async () => 'exists',
            dispatch,
        })).resolves.toMatchObject({
            scanned: 100,
            taskPresent: 100,
            dispatched: 0,
        });
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            lookup: async () => 'exists',
            dispatch,
        })).resolves.toMatchObject({
            scanned: 1,
            taskPresent: 0,
            dispatched: 1,
        });
        expect(dispatch).toHaveBeenCalledWith(requestId, actionable.jobKey);
    });

    it('rearms only after Cloud Tasks proves the exact generation is missing', async () => {
        const missing = job('coordinator:missing', 'enqueued');
        const jobStore = store([missing]);
        const dispatch = vi.fn(async () => 'enqueued');

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            dispatch,
            lookup: async () => 'not_found',
        })).resolves.toMatchObject({ dispatched: 1, failed: 0 });
        expect(jobStore.rearmDispatch).toHaveBeenCalledWith({
            requestId,
            jobKey: missing.jobKey,
            expectedGeneration: 1,
            expectedReservationToken: reservationToken,
        });
        expect(dispatch).toHaveBeenCalledAfter(
            (jobStore.rearmDispatch as ReturnType<typeof vi.fn>)
        );
    });

    it('never rearms an ambiguous lookup failure and tolerates a concurrent recovery race', async () => {
        const ambiguousStore = store([job('coordinator:ambiguous', 'enqueued')]);
        const ambiguous = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: ambiguousStore,
            lookup: async () => { throw new Error('permission denied'); },
            dispatch: vi.fn(),
        });
        expect(ambiguous).toMatchObject({ failed: 1, dispatched: 0 });
        expect(ambiguousStore.rearmDispatch).not.toHaveBeenCalled();

        const raceStore = store([job('coordinator:race', 'enqueued')]);
        raceStore.rearmDispatch = vi.fn(async () => {
            throw new AnalysisV2JobFenceError();
        });
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: raceStore,
            lookup: async () => 'not_found',
            dispatch: vi.fn(),
        })).resolves.toMatchObject({ lostRace: 1, failed: 0 });

        const deferRaceStore = store([job('coordinator:defer-race', 'enqueued')]);
        deferRaceStore.deferRecovery = vi.fn(async () => false);
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: deferRaceStore,
            lookup: async () => 'exists',
            dispatch: vi.fn(),
        })).resolves.toMatchObject({ lostRace: 1, taskPresent: 0, failed: 0 });
    });

    it('reports a terminal media cleanup failure for the scheduler to retry', async () => {
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupTerminalMedia: async () => {
                throw new Error('temporary cleanup failure');
            },
        })).resolves.toEqual({
            scanned: 0,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 1,
            providerRunsSettled: 0,
            providerRunsBlocked: 0,
            providerUsageReconciled: 0,
            fulfillmentsScanned: 0,
            fulfillmentsAdvanced: 0,
            fulfillmentsCompleted: 0,
            fulfillmentsManualReview: 0,
            fulfillmentsFailed: 0,
        });
    });

    it('repeats provider abort and usage reconciliation and reports unresolved cleanup', async () => {
        const cleanupProviderRuns = vi.fn(async () => ({
            scanned: 3,
            settled: 2,
            failed: 1,
            unconfirmedStarts: 1,
            hasMore: false,
        }));
        const reconcileProviderUsage = vi.fn(async () => ({
            eligible: 2,
            reconciled: 1,
            failed: 1,
            hasMore: false,
        }));

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupProviderRuns,
            reconcileProviderUsage,
            cleanupTerminalMedia: vi.fn(async () => undefined),
        })).resolves.toEqual({
            scanned: 0,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 2,
            providerRunsSettled: 2,
            providerRunsBlocked: 2,
            providerUsageReconciled: 1,
            fulfillmentsScanned: 0,
            fulfillmentsAdvanced: 0,
            fulfillmentsCompleted: 0,
            fulfillmentsManualReview: 0,
            fulfillmentsFailed: 0,
        });
        expect(cleanupProviderRuns).toHaveBeenCalledOnce();
        expect(reconcileProviderUsage).toHaveBeenCalledOnce();
    });

    it('replays only operator-admitted fulfillments and surfaces their recovery state', async () => {
        const recoverFulfillments = vi.fn(async () => ({
            reconciled: {
                scanned: 2,
                completed: 1,
                manualReview: 1,
                retryable: 0,
            },
            scanned: 3,
            advanced: 2,
            failed: 1,
        }));
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverFulfillments,
        })).resolves.toMatchObject({
            failed: 1,
            fulfillmentsScanned: 3,
            fulfillmentsAdvanced: 2,
            fulfillmentsCompleted: 1,
            fulfillmentsManualReview: 1,
            fulfillmentsFailed: 1,
        });
        expect(recoverFulfillments).toHaveBeenCalledOnce();
    });
});
