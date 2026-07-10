import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_STALE_AFTER_MS } from './failure';
import { expireStaleAnalysisBeforeStart } from './start-cleanup';
import type { AnalysisRequestLease } from './request-lease';

const nowMs = Date.parse('2026-07-11T12:00:00.000Z');
const candidate = {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'processing',
    current_step: 'interactions',
    created_at: new Date(nowMs - ANALYSIS_STALE_AFTER_MS).toISOString(),
    idempotency_key: 'old-idempotency-key',
};

function dependencies(row: unknown = candidate) {
    const order: string[] = [];
    const loadActiveRequest = vi.fn(async () => row);
    const acquireCleanupLease = vi.fn<() => Promise<AnalysisRequestLease | null>>(async () => {
        order.push('lease');
        return { requestId: candidate.id, token: 'cleanup-token' };
    });
    const releaseCleanupLease = vi.fn(async () => { order.push('release'); });
    const abortProviderRuns = vi.fn(async () => { order.push('abort'); });
    const failRequest = vi.fn(async () => {
        order.push('fail');
        return true;
    });
    return {
        deps: {
            loadActiveRequest,
            acquireCleanupLease,
            releaseCleanupLease,
            abortProviderRuns,
            failRequest,
            nowMs,
        },
        acquireCleanupLease,
        releaseCleanupLease,
        abortProviderRuns,
        failRequest,
        order,
    };
}

describe('stale analysis cleanup before start', () => {
    it('aborts and reconciles paid runs before terminalizing stale work', async () => {
        const { deps, order } = dependencies();

        await expect(expireStaleAnalysisBeforeStart('new-idempotency-key', deps))
            .resolves.toBe(true);
        expect(order).toEqual(['lease', 'abort', 'fail']);
    });

    it('preserves a same-key idempotent replay and a healthy active request', async () => {
        const sameKey = dependencies();
        await expect(expireStaleAnalysisBeforeStart('old-idempotency-key', sameKey.deps))
            .resolves.toBe(false);
        expect(sameKey.acquireCleanupLease).not.toHaveBeenCalled();
        expect(sameKey.abortProviderRuns).not.toHaveBeenCalled();

        const healthy = dependencies({
            ...candidate,
            created_at: new Date(nowMs - ANALYSIS_STALE_AFTER_MS + 1).toISOString(),
        });
        await expect(expireStaleAnalysisBeforeStart('new-idempotency-key', healthy.deps))
            .resolves.toBe(false);
        expect(healthy.acquireCleanupLease).not.toHaveBeenCalled();
        expect(healthy.abortProviderRuns).not.toHaveBeenCalled();
    });

    it('does not touch provider runs while a worker owns the request lease', async () => {
        const contended = dependencies();
        contended.acquireCleanupLease.mockResolvedValueOnce(null);

        await expect(expireStaleAnalysisBeforeStart('new-idempotency-key', contended.deps))
            .resolves.toBe(false);
        expect(contended.abortProviderRuns).not.toHaveBeenCalled();
        expect(contended.failRequest).not.toHaveBeenCalled();
        expect(contended.releaseCleanupLease).not.toHaveBeenCalled();
    });

    it('releases the cleanup lease when abort reconciliation fails', async () => {
        const failedAbort = dependencies();
        failedAbort.abortProviderRuns.mockRejectedValueOnce(new Error('provider unavailable'));

        await expect(expireStaleAnalysisBeforeStart('new-idempotency-key', failedAbort.deps))
            .rejects.toThrow('provider unavailable');
        expect(failedAbort.order).toEqual(['lease', 'release']);
        expect(failedAbort.failRequest).not.toHaveBeenCalled();
    });

    it('fails closed on malformed database state', async () => {
        const malformed = dependencies({ ...candidate, current_step: '' });
        await expect(expireStaleAnalysisBeforeStart('new-idempotency-key', malformed.deps))
            .rejects.toThrow('ANALYSIS_PERSISTENCE_ERROR');
        expect(malformed.acquireCleanupLease).not.toHaveBeenCalled();
        expect(malformed.abortProviderRuns).not.toHaveBeenCalled();
    });
});
