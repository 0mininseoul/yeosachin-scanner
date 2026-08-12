import { describe, expect, it } from 'vitest';
import { buildArchiveEntries } from './archive-entries';
import type { OwnerAnalysisHistoryItemV1 } from './owner-history';
import type { AwaitingEarlybirdDelivery } from '@/lib/services/earlybird/awaiting-delivery';

function analysisItem(overrides: Partial<OwnerAnalysisHistoryItemV1> = {}): OwnerAnalysisHistoryItemV1 {
    return {
        id: '123e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: 'target.account',
        status: 'completed',
        createdAt: '2026-08-10T09:00:00.000Z',
        planType: 'standard',
        pipelineVersion: 'v2',
        ...overrides,
    };
}

function awaitingDelivery(overrides: Partial<AwaitingEarlybirdDelivery> = {}): AwaitingEarlybirdDelivery {
    return {
        orderId: '223e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: 'awaiting.account',
        planId: 'basic',
        createdAt: '2026-08-11T09:00:00.000Z',
        resultRequestId: null,
        ...overrides,
    };
}

describe('buildArchiveEntries', () => {
    it('dedupes an awaiting entry whose resultRequestId matches an existing analysis id', () => {
        const analysis = analysisItem({ id: 'analysis-1' });
        const awaiting = awaitingDelivery({ resultRequestId: 'analysis-1' });

        const entries = buildArchiveEntries([analysis], [awaiting]);

        expect(entries).toEqual([{ kind: 'analysis', item: analysis }]);
    });

    it('keeps an awaiting entry whose resultRequestId is null', () => {
        const awaiting = awaitingDelivery({ resultRequestId: null });

        const entries = buildArchiveEntries([], [awaiting]);

        expect(entries).toEqual([{
            kind: 'awaiting_delivery',
            orderId: awaiting.orderId,
            targetInstagramId: awaiting.targetInstagramId,
            planId: awaiting.planId,
            createdAt: awaiting.createdAt,
        }]);
    });

    it('sorts merged entries by createdAt desc', () => {
        const older = analysisItem({ id: 'older', createdAt: '2026-08-09T00:00:00.000Z' });
        const newer = awaitingDelivery({ createdAt: '2026-08-12T00:00:00.000Z', resultRequestId: null });

        const entries = buildArchiveEntries([older], [newer]);

        expect(entries.map((entry) => entry.kind)).toEqual(['awaiting_delivery', 'analysis']);
    });

    it('filters out analysis items with statuses outside pending/processing/completed', () => {
        const failed = {
            ...analysisItem({ id: 'failed-1' }),
            status: 'failed',
        } as unknown as OwnerAnalysisHistoryItemV1;

        const entries = buildArchiveEntries([failed], []);

        expect(entries).toEqual([]);
    });
});
