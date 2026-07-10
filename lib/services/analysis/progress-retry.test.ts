import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_LEASE_RETRY_DELAY_MS,
    ANALYSIS_PROGRESS_STEPS,
    ANALYSIS_STEP_RECOVERY_DELAY_MS,
    decideAnalysisStepFailure,
    shouldClientDriveAnalysis,
} from './progress-retry';

describe('analysis progress retry decisions', () => {
    it('waits through repeated lease contention without consuming transient retries', () => {
        let retryCount = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
            const decision = decideAnalysisStepFailure(409, false, retryCount);
            expect(decision).toEqual({
                kind: 'lease_wait',
                delayMs: ANALYSIS_LEASE_RETRY_DELAY_MS,
                nextRetryCount: 0,
            });
            retryCount = decision.kind === 'lease_wait' ? decision.nextRetryCount : retryCount;
        }
    });

    it('stops on authorization/not-found responses and persisted pipeline failures', () => {
        expect(decideAnalysisStepFailure(401, false, 0)).toEqual({ kind: 'terminal' });
        expect(decideAnalysisStepFailure(403, false, 0)).toEqual({ kind: 'terminal' });
        expect(decideAnalysisStepFailure(404, false, 0)).toEqual({ kind: 'terminal' });
        expect(decideAnalysisStepFailure(500, true, 0))
            .toEqual({ kind: 'persisted_failure' });
    });

    it('bounds transient failures to 2s, 4s, and 8s retries', () => {
        expect(ANALYSIS_STEP_RECOVERY_DELAY_MS).toBe(30_000);
        expect(decideAnalysisStepFailure(504, false, 0)).toEqual({
            kind: 'transient_retry', delayMs: 2_000, nextRetryCount: 1,
        });
        expect(decideAnalysisStepFailure(504, false, 1)).toEqual({
            kind: 'transient_retry', delayMs: 4_000, nextRetryCount: 2,
        });
        expect(decideAnalysisStepFailure(504, false, 2)).toEqual({
            kind: 'transient_retry', delayMs: 8_000, nextRetryCount: 3,
        });
        expect(decideAnalysisStepFailure(504, false, 3)).toEqual({ kind: 'exhausted' });
    });

    it('keeps progress labels unique and aligned to persisted stage boundaries', () => {
        expect(ANALYSIS_PROGRESS_STEPS.map(step => step.threshold))
            .toEqual([25, 30, 50, 82, 92, 97, 100]);
        expect(new Set(ANALYSIS_PROGRESS_STEPS.map(step => step.label)).size)
            .toBe(ANALYSIS_PROGRESS_STEPS.length);
    });

    it('never drives paid steps from the browser once background mode is active', () => {
        expect(shouldClientDriveAnalysis('pending', false)).toBe(true);
        expect(shouldClientDriveAnalysis('processing', undefined)).toBe(true);
        expect(shouldClientDriveAnalysis('pending', true)).toBe(false);
        expect(shouldClientDriveAnalysis('processing', true)).toBe(false);
        expect(shouldClientDriveAnalysis('completed', false)).toBe(false);
        expect(shouldClientDriveAnalysis('failed', false)).toBe(false);
    });
});
