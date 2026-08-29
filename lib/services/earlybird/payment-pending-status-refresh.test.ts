import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createSingleFlightEarlybirdStatusRefresh,
    earlybirdStatusRefreshMode,
    scheduleEarlybirdStatusSnapshotRefresh,
    shouldAutomaticallyRedirectEarlybirdStatus,
    shouldRefreshEarlybirdStatusSnapshot,
} from './payment-pending-status-refresh';

describe('earlybird payment-pending status refresh', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces overlapping owner status reads and never mutates fulfillment', async () => {
        let resolveRequest: ((response: Response) => void) | undefined;
        const request = vi.fn<(
            input: RequestInfo | URL,
            init?: RequestInit,
        ) => Promise<Response>>(() => new Promise<Response>(resolve => {
            resolveRequest = resolve;
        }));
        const onSnapshot = vi.fn();
        const refresh = createSingleFlightEarlybirdStatusRefresh(
            'standard',
            onSnapshot,
            request,
        );

        const first = refresh.refresh();
        const second = refresh.refresh();
        expect(second).toBe(first);
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0]?.[0]).toBe('/api/earlybird/orders/latest?plan=standard');
        expect(request.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ cache: 'no-store' }));

        resolveRequest?.(new Response(JSON.stringify({ order: null }), { status: 200 }));
        await first;
        expect(onSnapshot).not.toHaveBeenCalled();
        refresh.stop();
        expect(request.mock.calls[0]?.[1]).not.toEqual(expect.objectContaining({ method: 'POST' }));
    });

    it('refreshes a pending payment through the full burst', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        scheduleEarlybirdStatusSnapshotRefresh(refresh);

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
    });

    it('continues payment confirmation with a bounded low-frequency tail', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        scheduleEarlybirdStatusSnapshotRefresh(refresh, 'payment_pending');

        vi.advanceTimersByTime(60_000);
        expect(refresh).toHaveBeenCalledTimes(7);
        vi.advanceTimersByTime(59_999);
        expect(refresh).toHaveBeenCalledTimes(7);
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(8);
        vi.advanceTimersByTime(5 * 60_000);
        expect(refresh).toHaveBeenCalledTimes(13);
    });

    it('cancels the recurring payment tail when the status view stops refreshing', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        const stop = scheduleEarlybirdStatusSnapshotRefresh(refresh, 'payment_pending');
        vi.advanceTimersByTime(120_000);
        expect(refresh).toHaveBeenCalledTimes(8);

        stop();
        vi.advanceTimersByTime(10 * 60_000);
        expect(refresh).toHaveBeenCalledTimes(8);
    });

    it('cancels every scheduled refresh when the status view unmounts', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        const stop = scheduleEarlybirdStatusSnapshotRefresh(refresh);
        vi.advanceTimersByTime(1_000);
        stop();
        vi.advanceTimersByTime(10 * 60_000);

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('refreshes only the pending snapshot window and stops at support fallback', () => {
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

    it('keeps the automatic fulfillment fast burst cadence', () => {
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
        vi.advanceTimersByTime(31 * 60_000);
        expect(refresh).toHaveBeenCalledTimes(39);
    });

    it('cancels the recurring automatic tail when the status view stops refreshing', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();

        const stop = scheduleEarlybirdStatusSnapshotRefresh(refresh, 'automatic');
        vi.advanceTimersByTime(120_000);
        expect(refresh).toHaveBeenCalledTimes(8);

        stop();
        vi.advanceTimersByTime(10 * 60_000);
        expect(refresh).toHaveBeenCalledTimes(8);
    });
});
