import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EarlybirdOrderStatusDto } from './order-status';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { id: '123e4567-e89b-42d3-a456-426614174000' }, loading: false }),
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
        deliveryMode: 'concierge',
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
                deliveryMode: 'support',
            },
        }));

        expect(markup).toContain('판독 상태를 확인하고 있어요');
        expect(markup).toContain('결제 확인이 지연되고 있어요. 같은 화면이 계속되면 고객센터로 문의해주세요.');
        expect(markup).not.toContain('manual_review');
        expect(markup).not.toContain('판독을 자동으로 시작하고 있어요');
    });
});

describe('earlybird paid delivery notice', () => {
    it.each(['paid', 'analysis_in_progress'] as const)(
        'explains automatic analysis for %s instead of promising concierge email delivery',
        systemStatus => {
            const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
                order: {
                    ...cancelledOrder(),
                    systemStatus,
                    displayStatus: '판독 대기',
                    deliveryMode: 'automatic',
                    actualAmountKrw: 990,
                    acceptedAt: '2026-08-08T12:41:11.649881+00:00',
                },
            }));

            expect(markup).toContain('결제가 완료되었어요');
            expect(markup).toContain('결제 확인 후 판독이 자동으로 시작됩니다. 진행 화면이 준비되면 바로 연결해드릴게요.');
            expect(markup).not.toContain('2일 이내');
            expect(markup).not.toContain('판독을 자동으로 시작하고 있어요');
            expect(markup).not.toContain('잠시만 기다리면 진행 화면으로 이어집니다');
        }
    );

    it('shows the automatic-start bridge when a validated progress path is available', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'analysis_in_progress',
                displayStatus: '판독 중',
                deliveryMode: 'automatic',
                progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
            },
        }));

        expect(markup).toContain('판독을 자동으로 시작하고 있어요');
        expect(markup).toContain('잠시만 기다리면 진행 화면으로 이어집니다');
        expect(markup).not.toContain('2일 이내');
    });

    it('keeps the publication-lag bridge generic for a concierge order', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'analysis_in_progress',
                displayStatus: '판독 중',
                deliveryMode: 'concierge',
                progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
            },
        }));

        expect(markup).toContain('판독 진행 화면으로 이동하고 있어요');
        expect(markup).not.toContain('판독을 자동으로 시작하고 있어요');
        expect(markup).not.toContain('2일 이내');
    });

    it('does not render an arbitrary result URL as an owner navigation target', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'completed',
                displayStatus: '결과 전달 완료',
                deliveryMode: 'automatic',
                resultUrl: 'https://evil.example/result/123e4567-e89b-42d3-a456-426614174000',
            },
        }));

        expect(markup).not.toContain('evil.example');
        expect(markup).not.toContain('판독 결과 확인하기');
    });

    it('keeps a pre-cutoff concierge order on its existing delivery expectation', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'paid',
                displayStatus: '판독 대기',
                deliveryMode: 'concierge',
                actualAmountKrw: 990,
                acceptedAt: '2026-08-08T12:41:11.649881+00:00',
            },
        }));

        expect(markup).toContain('결제가 완료되었어요');
        expect(markup).toContain('판독 결과가 완성되면 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요.');
        expect(markup).not.toContain('결제 확인 후 판독이 자동으로 시작됩니다');
    });
});
