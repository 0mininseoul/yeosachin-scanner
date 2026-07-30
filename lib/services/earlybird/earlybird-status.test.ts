import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EarlybirdOrderStatusDto } from './order-status';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/services/analytics', () => ({
    EVENTS: {
        EARLYBIRD_STATUS_VIEWED: 'earlybird_status_viewed',
        PAYMENT_CONFIRMED_VIEWED: 'payment_confirmed_viewed',
    },
    trackEvent: vi.fn(),
}));
vi.mock('@/lib/services/analytics-funnel', () => ({
    availableAnalyticsStorage: () => undefined,
    tryClaimAnalyticsEvent: () => false,
}));

import { EarlybirdStatus } from '@/app/earlybird/earlybird-status';

function cancelledOrder(): EarlybirdOrderStatusDto {
    return {
        orderId: '123e4567-e89b-42d3-a456-426614174001',
        preflightId: '123e4567-e89b-42d3-a456-426614174003',
        targetInstagramId: 'target.account',
        planId: 'standard',
        planName: 'Standard',
        actualAmountKrw: null,
        acceptedAt: null,
        dueAt: null,
        planSequence: null,
        systemStatus: 'cancelled',
        displayStatus: '취소됨',
        requiresSupport: false,
        progressUrl: null,
        resultUrl: null,
    };
}

describe('earlybird cancelled order status', () => {
    it('holds safely without claiming the cancelled checkout can resume', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: cancelledOrder(),
        }));

        expect(markup).toContain('취소된 주문입니다');
        expect(markup).toContain('새로 결제하지 말고');
        expect(markup).not.toContain('결제 계속하기');
        expect(markup).not.toContain('이메일 알림 받기');
    });
});

describe('earlybird support fallback', () => {
    it('stops on a generic status card without exposing fulfillment internals', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'analysis_in_progress',
                displayStatus: '판독 중',
                requiresSupport: true,
            },
        }));

        expect(markup).toContain('판독 상태를 확인하고 있어요');
        expect(markup).toContain('가입하신 이메일로 안내해드릴게요');
        expect(markup).not.toContain('manual_review');
        expect(markup).not.toContain('판독을 자동으로 시작하고 있어요');
    });
});
