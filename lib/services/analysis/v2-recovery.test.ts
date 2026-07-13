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
        markDispatched: vi.fn(),
        claim: vi.fn(),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(),
        listDispatchable: vi.fn(async () => jobs),
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

        await expect(recoverAnalysisV2Jobs({
            store: jobStore,
            dispatch,
            lookup,
        })).resolves.toEqual({
            scanned: 3,
            dispatched: 2,
            taskPresent: 1,
            lostRace: 0,
            failed: 0,
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.rearmDispatch).not.toHaveBeenCalled();
    });

    it('rearms only after Cloud Tasks proves the exact generation is missing', async () => {
        const missing = job('coordinator:missing', 'enqueued');
        const jobStore = store([missing]);
        const dispatch = vi.fn(async () => 'enqueued');

        await expect(recoverAnalysisV2Jobs({
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
            store: raceStore,
            lookup: async () => 'not_found',
            dispatch: vi.fn(),
        })).resolves.toMatchObject({ lostRace: 1, failed: 0 });
    });
});
