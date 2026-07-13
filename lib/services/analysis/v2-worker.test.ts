import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import type {
    AnalysisV2JobStore,
    ClaimedAnalysisV2Job,
} from './v2-job-store';
import {
    AnalysisV2JobExecutionError,
    executeAnalysisV2FoundationJob,
    processAnalysisV2TaskDelivery,
} from './v2-worker';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const reservationToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const delivery = {
    requestId,
    jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    generation: 1,
    reservationToken,
};
const claim: ClaimedAnalysisV2Job = {
    ...delivery,
    track: 'coordinator',
    kind: 'bootstrap',
    batch: null,
    inputHash: analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
    claimToken,
    attemptCount: 1,
};

function store(overrides: Partial<AnalysisV2JobStore> = {}): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => claim),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(async () => [
            { requestId, jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY },
            { requestId, jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY },
        ]),
        listDispatchable: vi.fn(),
        ...overrides,
    };
}

describe('analysis V2 worker foundation', () => {
    it('completes bootstrap before dispatching its durable parallel successors', async () => {
        const jobStore = store();
        const dispatch = vi.fn()
            .mockResolvedValueOnce('enqueued')
            .mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            dispatch,
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 2,
            pendingRecoveryCount: 1,
        });
        expect(jobStore.completeAndFanout).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('does not run or fan out an already-terminal delivery', async () => {
        const jobStore = store({ claim: vi.fn(async () => null) });
        const handler = vi.fn();
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
        })).resolves.toEqual({ status: 'already_terminal' });
        expect(handler).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('releases retryable handler failures without completing the job', async () => {
        const jobStore = store({
            releaseClaim: vi.fn(async () => ({
                released: true,
                status: 'pending' as const,
                attemptCount: 1,
                requestStatus: 'processing',
            })),
        });
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('provider detail');
            },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('stops transport retries after a non-retryable failure is persisted', async () => {
        const jobStore = store({
            releaseClaim: vi.fn(async () => ({
                released: true,
                status: 'failed' as const,
                attemptCount: 1,
                requestStatus: 'failed',
            })),
        });
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new AnalysisV2JobExecutionError(
                    'ANALYSIS_V2_JOB_INPUT_MISMATCH',
                    false
                );
            },
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_JOB_INPUT_MISMATCH',
        });
    });

    it('rejects a corrupted bootstrap input hash before fanout', async () => {
        await expect(executeAnalysisV2FoundationJob({
            ...claim,
            inputHash: '0'.repeat(64),
        })).rejects.toMatchObject({
            code: 'ANALYSIS_V2_JOB_INPUT_MISMATCH',
            retryable: false,
        });
    });
});
