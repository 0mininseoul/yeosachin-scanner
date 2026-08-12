import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveEntry } from './archive-entries';
import type { OwnerAnalysisHistoryItemV1 } from './owner-history';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import AnalysisList from '@/app/mypage/analysis-list';

function completedAnalysisEntry(): ArchiveEntry {
    const item: OwnerAnalysisHistoryItemV1 = {
        id: '123e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: 'target.account',
        status: 'completed',
        createdAt: '2026-08-10T09:00:00.000Z',
        planType: 'standard',
        pipelineVersion: 'v2',
    };
    return { kind: 'analysis', item };
}

function awaitingDeliveryEntry(): ArchiveEntry {
    return {
        kind: 'awaiting_delivery',
        orderId: '223e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: 'awaiting.account',
        planId: 'basic',
        createdAt: '2026-08-11T09:00:00.000Z',
    };
}

describe('mypage archive list rendering', () => {
    it('renders an awaiting-delivery entry as 결과 대기 중', () => {
        const markup = renderToStaticMarkup(createElement(AnalysisList, {
            initialEntries: [awaitingDeliveryEntry()],
        }));

        expect(markup).toContain('결과 대기 중');
    });

    it('does not render the awaiting-delivery entry inside a button (not clickable)', () => {
        const markup = renderToStaticMarkup(createElement(AnalysisList, {
            initialEntries: [awaitingDeliveryEntry()],
        }));

        expect(markup).not.toContain('<button');
    });

    it('still renders a completed analysis entry as a button', () => {
        const markup = renderToStaticMarkup(createElement(AnalysisList, {
            initialEntries: [completedAnalysisEntry()],
        }));

        expect(markup).toContain('<button');
        expect(markup).toContain('@target.account');
    });
});
