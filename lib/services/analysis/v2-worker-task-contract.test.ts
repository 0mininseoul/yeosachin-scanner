import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION,
    analysisV2WorkerTaskContractFromHeader,
} from './v2-worker-task-contract';

describe('analysis V2 worker task timing contract', () => {
    it('keeps versionless queued tasks on their original bounded execution contract', () => {
        expect(analysisV2WorkerTaskContractFromHeader(null)).toEqual({
            dispatchDeadlineSeconds: 300,
            handlerWindowMs: 300_000,
            jobLeaseSeconds: 360,
        });
    });

    it('uses the extended contract only for newly-enqueued v2 tasks', () => {
        expect(analysisV2WorkerTaskContractFromHeader(
            String(ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION),
        )).toEqual({
            dispatchDeadlineSeconds: 600,
            handlerWindowMs: 540_000,
            jobLeaseSeconds: 600,
        });
    });

    it('fails safe to the legacy contract for an absent or unknown header', () => {
        expect(analysisV2WorkerTaskContractFromHeader(undefined)).toEqual(
            analysisV2WorkerTaskContractFromHeader('3'),
        );
    });
});
