import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    earlybirdStatusRefreshMode,
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
            deliveryMode: 'concierge',
            progressUrl: null,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'paid',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: null,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'paid',
            requiresSupport: false,
            deliveryMode: 'concierge',
            progressUrl: null,
            resultUrl: null,
        })).toBe(false);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'analysis_in_progress',
            requiresSupport: true,
            deliveryMode: 'support',
            progressUrl: null,
            resultUrl: null,
        })).toBe(false);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: null,
            resultUrl: null,
        })).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'completed',
            requiresSupport: true,
            deliveryMode: 'support',
            progressUrl: null,
            resultUrl: '/result/example',
        })).toBe(false);
    });

    it('keeps manual-review support on the page without polling', () => {
        const manualReview = {
            systemStatus: 'analysis_in_progress' as const,
            requiresSupport: true,
            deliveryMode: 'support' as const,
            progressUrl: null,
            resultUrl: null,
        };

        expect(shouldRefreshEarlybirdStatusSnapshot(manualReview)).toBe(false);
        expect(earlybirdStatusRefreshMode(manualReview)).toBe(null);
        expect(shouldAutomaticallyRedirectEarlybirdStatus(manualReview)).toBe(false);
    });

    it('keeps paid and in-progress orders on the email-delivery notice', () => {
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'paid',
            requiresSupport: false,
            deliveryMode: 'concierge',
            progressUrl: null,
            resultUrl: null,
        })).toBe(false);
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            deliveryMode: 'concierge',
            progressUrl: null,
            resultUrl: null,
        })).toBe(false);
    });

    it('redirects when a nonterminal owner progress path is available', () => {
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'paid',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
            resultUrl: null,
        })).toBe(true);
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
            resultUrl: null,
        })).toBe(true);
    });

    it('keeps an unpublished completed result on the owner progress path without making concierge orders automatic', () => {
        const laggingCompletedOrder = {
            systemStatus: 'analysis_in_progress' as const,
            requiresSupport: false,
            deliveryMode: 'concierge' as const,
            progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
            resultUrl: null,
        };

        expect(earlybirdStatusRefreshMode(laggingCompletedOrder)).toBe(null);
        expect(shouldAutomaticallyRedirectEarlybirdStatus(laggingCompletedOrder)).toBe(true);
        expect(shouldRefreshEarlybirdStatusSnapshot(laggingCompletedOrder)).toBe(false);
    });

    it('redirects only when a completed result is available', () => {
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'completed',
            requiresSupport: false,
            deliveryMode: 'concierge',
            progressUrl: null,
            resultUrl: '/result/123e4567-e89b-42d3-a456-426614174000',
        })).toBe(true);
    });

    it('rejects arbitrary navigation URLs and keeps polling for an invalid progress path', () => {
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: 'https://evil.example/result/123e4567-e89b-42d3-a456-426614174000',
            resultUrl: null,
        })).toBe(false);
        expect(shouldRefreshEarlybirdStatusSnapshot({
            systemStatus: 'analysis_in_progress',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: '/progress/not-a-request-id',
            resultUrl: null,
        })).toBe(true);
        expect(shouldAutomaticallyRedirectEarlybirdStatus({
            systemStatus: 'completed',
            requiresSupport: false,
            deliveryMode: 'automatic',
            progressUrl: null,
            resultUrl: 'https://evil.example/result/123e4567-e89b-42d3-a456-426614174000',
        })).toBe(false);
    });

    it('keeps pre-cutoff concierge orders off the automatic refresh and redirect paths', () => {
        const concierge = {
            systemStatus: 'analysis_in_progress' as const,
            requiresSupport: false,
            deliveryMode: 'concierge' as const,
            progressUrl: null,
            resultUrl: null,
        };

        expect(earlybirdStatusRefreshMode(concierge)).toBe(null);
        expect(shouldRefreshEarlybirdStatusSnapshot(concierge)).toBe(false);
        expect(shouldAutomaticallyRedirectEarlybirdStatus(concierge)).toBe(false);
    });

    it('gives automatic fulfillment a longer bounded low-load polling window', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        scheduleEarlybirdStatusSnapshotRefresh(refresh, 'automatic');

        vi.advanceTimersByTime(999);
        expect(refresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(2_000);
        expect(refresh).toHaveBeenCalledTimes(3);
        vi.advanceTimersByTime(4_000);
        expect(refresh).toHaveBeenCalledTimes(4);
        vi.advanceTimersByTime(7_000);
        expect(refresh).toHaveBeenCalledTimes(5);
        vi.advanceTimersByTime(15_000);
        expect(refresh).toHaveBeenCalledTimes(6);
        vi.advanceTimersByTime(30_000);
        expect(refresh).toHaveBeenCalledTimes(7);
        vi.runAllTimers();
        expect(refresh).toHaveBeenCalledTimes(37);
    });

    it('continues automatic fulfillment with a bounded low-frequency tail', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        scheduleEarlybirdStatusSnapshotRefresh(refresh, 'automatic');

        vi.advanceTimersByTime(60_000);
        expect(refresh).toHaveBeenCalledTimes(7);
        vi.advanceTimersByTime(59_999);
        expect(refresh).toHaveBeenCalledTimes(7);
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(8);

        vi.runAllTimers();
        expect(refresh.mock.calls.length).toBeGreaterThan(8);
        const tailCalls = refresh.mock.calls.length;
        vi.runAllTimers();
        expect(refresh).toHaveBeenCalledTimes(tailCalls);
    });
});
