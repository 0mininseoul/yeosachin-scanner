import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    scheduleEarlybirdStatusSnapshotRefresh,
    shouldAutomaticallyRedirectEarlybirdStatus,
    shouldRefreshEarlybirdStatusSnapshot,
} from './payment-pending-status-refresh';

describe('earlybird payment-pending status refresh', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes a pending payment a bounded number of times', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        scheduleEarlybirdStatusSnapshotRefresh(refresh);

        vi.advanceTimersByTime(999);
        expect(refresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(4_000);
        expect(refresh).toHaveBeenCalledTimes(3);
        vi.runAllTimers();
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('cancels every scheduled refresh when the status view unmounts', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        const stop = scheduleEarlybirdStatusSnapshotRefresh(refresh);
        vi.advanceTimersByTime(1_000);
        stop();
        vi.runAllTimers();

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('refreshes only the pending snapshot window and stale support fallback', () => {
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'payment_pending',
            requiresSupport: true,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'paid',
            requiresSupport: true,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'analysis_in_progress',
            requiresSupport: true,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            resultUrl: null,
        })).toBe(false);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'completed',
            requiresSupport: true,
            resultUrl: '/result/example',
        })).toBe(false);
    });

    it('keeps manual-review support on the page after its bounded refreshes', () => {
        const manualReview = {
            systemStatus: 'analysis_in_progress' as const,
            requiresSupport: true,
            resultUrl: null,
        };

        expect(shouldRefreshEarlybirdStatusSnapshot(manualReview)).toBe(true);
        expect(shouldAutomaticallyRedirectEarlybirdStatus(manualReview)).toBe(false);
    });
});
