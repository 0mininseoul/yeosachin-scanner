// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EarlybirdOrderStatusDto } from './order-status';

const routerMock = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
}));
const analyticsMocks = vi.hoisted(() => ({
    EVENTS: {
        EARLYBIRD_STATUS_VIEWED: 'earlybird_status_viewed',
        PAYMENT_CONFIRMED_VIEWED: 'payment_confirmed_viewed',
    },
    flushAnalytics: vi.fn().mockResolvedValue(undefined),
    trackEvent: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
    useRouter: () => routerMock,
}));
vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { id: '123e4567-e89b-42d3-a456-426614174000' }, loading: false }),
}));
vi.mock('@/lib/services/analytics', () => analyticsMocks);
vi.mock('@/lib/services/analytics-funnel', () => ({
    availableAnalyticsStorage: () => undefined,
    tryClaimAnalyticsEvent: () => true,
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
        checkoutRecoverable: false,
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

    it('keeps a server-denied pending lineage status-only without a client guard prop', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'payment_pending',
                displayStatus: '결제 확인',
                checkoutRecoverable: false,
            },
        }));

        expect(markup).not.toContain('결제 계속하기');
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
        'shows the same progress shell for %s while the request is materializing',
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

            expect(markup).toContain('판독 진행 중');
            expect(markup).toContain('준비 중');
            expect(markup).toContain('판독을 자동으로 준비하고 있습니다.');
            expect(markup).not.toContain('2일 이내');
            expect(markup).not.toContain('결제가 완료되었어요');
            expect(markup).not.toContain('잠시만 기다리면 진행 화면으로 이어집니다');
        }
    );

    it('keeps the return shell navigation-only when a validated progress path is available', () => {
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

    it('shows the analysis progress shell while automatic fulfillment is materializing a request', () => {
        const markup = renderToStaticMarkup(createElement(EarlybirdStatus, {
            order: {
                ...cancelledOrder(),
                systemStatus: 'paid',
                displayStatus: '판독 대기',
                deliveryMode: 'automatic',
                actualAmountKrw: 990,
                acceptedAt: '2026-08-30T12:41:11.649881+00:00',
                progressUrl: null,
            },
        }));

            expect(markup).toContain('판독 진행 중');
            expect(markup).toContain('준비 중');
            expect(markup).toContain('판독을 자동으로 준비하고 있습니다.');
            expect(markup).not.toContain('0%');
            expect(markup).not.toContain('결제가 완료되었어요');
    });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('earlybird mounted payment return recovery', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        routerMock.push.mockReset();
        routerMock.replace.mockReset();
        routerMock.refresh.mockReset();
        analyticsMocks.flushAnalytics.mockReset();
        analyticsMocks.flushAnalytics.mockResolvedValue(undefined);
        analyticsMocks.trackEvent.mockReset();
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function render(order: EarlybirdOrderStatusDto) {
        act(() => {
            root.render(createElement(EarlybirdStatus, { order }));
        });
    }

    function automaticPendingOrder(
        overrides: Partial<EarlybirdOrderStatusDto> = {},
    ): EarlybirdOrderStatusDto {
        return {
            ...cancelledOrder(),
            systemStatus: 'analysis_in_progress',
            displayStatus: '판독 중',
            deliveryMode: 'automatic',
            ...overrides,
        };
    }

    it('keeps polling after the fast burst so a late request materialization resumes automatically', async () => {
        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(8);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(9);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(31 * 60_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(40);
    });

    it('refreshes once when the browser returns from the background', async () => {
        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
        });

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('pageshow'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        act(() => window.dispatchEvent(new Event('focus')));
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not let a lifecycle cooldown suppress a scheduled refresh', async () => {
        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            vi.advanceTimersByTime(900);
            window.dispatchEvent(new Event('focus'));
            await Promise.resolve();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('coalesces lifecycle refreshes across separate tasks and cleans up after unmount', async () => {
        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
        });

        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
        });
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
            window.dispatchEvent(new Event('focus'));
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
            window.dispatchEvent(new Event('pageshow'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
            window.dispatchEvent(new Event('focus'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);

        act(() => root.unmount());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('pageshow'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('emits status and payment analytics at most once across order rerenders', () => {
        const order = automaticPendingOrder({
            systemStatus: 'paid',
            displayStatus: '결제 완료',
            actualAmountKrw: 990,
        });

        render(order);
        render({ ...order });

        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(2);
        expect(analyticsMocks.trackEvent).toHaveBeenNthCalledWith(
            1,
            analyticsMocks.EVENTS.EARLYBIRD_STATUS_VIEWED,
            expect.objectContaining({ status: 'paid' }),
        );
        expect(analyticsMocks.trackEvent).toHaveBeenNthCalledWith(
            2,
            analyticsMocks.EVENTS.PAYMENT_CONFIRMED_VIEWED,
            expect.objectContaining({ status: 'paid' }),
        );
    });

    it('mounts the analysis progress bridge before a request id exists', async () => {
        render(automaticPendingOrder({ systemStatus: 'paid' }));

        expect(container.querySelector('[data-earlybird-progress-bridge]')).toBeTruthy();
        expect(container.textContent).toContain('준비 중');
        expect(container.textContent).not.toContain('0%');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_999);
        });
        expect(container.querySelector('[data-earlybird-progress-bridge]')).toBeTruthy();
    });

    it('stops polling and navigates once when the progress path materializes', async () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        const pendingOrder = automaticPendingOrder();
        render(pendingOrder);
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(120_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(9);

        render({
            ...pendingOrder,
            progressUrl: `/progress/${requestId}`,
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        expect(routerMock.replace).toHaveBeenCalledWith(`/progress/${requestId}`);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('pageshow'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(9);

        render({
            ...pendingOrder,
            progressUrl: `/progress/${requestId}`,
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
    });

    it('removes polling and lifecycle listeners when support or another no-refresh state arrives', async () => {
        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        render({
            ...automaticPendingOrder(),
            requiresSupport: true,
            deliveryMode: 'support',
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('pageshow'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        render(automaticPendingOrder());
        await act(async () => {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);

        render({
            ...automaticPendingOrder(),
            deliveryMode: 'concierge',
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
            window.dispatchEvent(new Event('focus'));
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('keeps owner status refresh single-flight while a return snapshot is pending', async () => {
        let resolveRequest: ((response: Response) => void) | undefined;
        fetchMock.mockImplementation(() => new Promise<Response>(resolve => {
            resolveRequest = resolve;
        }));

        render(automaticPendingOrder());
        act(() => vi.advanceTimersByTime(60_000));

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/earlybird/orders/latest?plan=standard');

        await act(async () => {
            resolveRequest?.(new Response(JSON.stringify({
                order: automaticPendingOrder(),
            }), { status: 200 }));
            await Promise.resolve();
        });
    });

    it('replaces the pending bridge with the owner progress path once materialized', async () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        const pending = automaticPendingOrder();
        const materialized = automaticPendingOrder({
            progressUrl: `/progress/${requestId}`,
        });
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ order: pending }), { status: 200 }))
            .mockResolvedValue(new Response(JSON.stringify({ order: materialized }), { status: 200 }));

        render(pending);
        expect(container.querySelector('[data-earlybird-progress-bridge]')).toBeTruthy();
        await act(async () => {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(routerMock.replace).toHaveBeenCalledOnce();
        expect(routerMock.replace).toHaveBeenCalledWith(`/progress/${requestId}`);
        expect(container.querySelector('[data-earlybird-progress-bridge]')).toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600_000);
        });
        expect(routerMock.replace).toHaveBeenCalledOnce();
    });

    it('waits for the bounded analytics flush before navigating to a request-scoped progress URL', async () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        analyticsMocks.flushAnalytics.mockImplementation(
            () => new Promise<void>(resolve => setTimeout(resolve, 500)),
        );
        render(automaticPendingOrder());

        render(automaticPendingOrder({
            progressUrl: `/progress/${requestId}`,
        }));

        await act(async () => {
            await Promise.resolve();
        });
        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledOnce();
        expect(routerMock.replace).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(routerMock.replace).toHaveBeenCalledOnce();
        expect(routerMock.replace).toHaveBeenCalledWith(`/progress/${requestId}`);

        render(automaticPendingOrder({
            progressUrl: `/progress/${requestId}`,
        }));
        expect(routerMock.replace).toHaveBeenCalledOnce();
    });

    it('shares a pending same-target flush across StrictMode replay before navigating', async () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        const nextUrl = `/progress/${requestId}`;
        let resolveFlush!: () => void;
        const flushPromise = new Promise<void>(resolve => {
            resolveFlush = resolve;
        });
        analyticsMocks.flushAnalytics
            .mockImplementationOnce(() => flushPromise)
            .mockImplementationOnce(() => Promise.resolve());

        await act(async () => {
            root.render(createElement(
                StrictMode,
                null,
                createElement(EarlybirdStatus, {
                    order: automaticPendingOrder({
                        systemStatus: 'paid',
                        displayStatus: '결제 완료',
                        actualAmountKrw: 990,
                        progressUrl: nextUrl,
                    }),
                }),
            ));
            await Promise.resolve();
        });

        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledOnce();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveFlush();
            await flushPromise;
        });

        expect(routerMock.replace).toHaveBeenCalledOnce();
        expect(routerMock.replace).toHaveBeenCalledWith(nextUrl);
        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledOnce();
        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(2);
    });

    it('does not navigate when the owner truly unmounts before its flush resolves', async () => {
        let resolveFlush!: () => void;
        const flushPromise = new Promise<void>(resolve => {
            resolveFlush = resolve;
        });
        analyticsMocks.flushAnalytics.mockReturnValue(flushPromise);

        render(automaticPendingOrder({
            progressUrl: '/progress/123e4567-e89b-42d3-a456-426614174000',
        }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledOnce();

        act(() => root.unmount());
        await act(async () => {
            resolveFlush();
            await flushPromise;
        });

        expect(routerMock.replace).not.toHaveBeenCalled();
    });

    it('does not let an old target completion navigate after the target changes', async () => {
        const firstTarget = '/progress/123e4567-e89b-42d3-a456-426614174000';
        const secondTarget = '/progress/123e4567-e89b-42d3-a456-426614174002';
        let resolveFirstFlush!: () => void;
        let resolveSecondFlush!: () => void;
        const firstFlush = new Promise<void>(resolve => {
            resolveFirstFlush = resolve;
        });
        const secondFlush = new Promise<void>(resolve => {
            resolveSecondFlush = resolve;
        });
        analyticsMocks.flushAnalytics
            .mockImplementationOnce(() => firstFlush)
            .mockImplementationOnce(() => secondFlush);

        render(automaticPendingOrder({ progressUrl: firstTarget }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledOnce();

        render(automaticPendingOrder({ progressUrl: secondTarget }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(analyticsMocks.flushAnalytics).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveFirstFlush();
            await firstFlush;
        });
        expect(routerMock.replace).not.toHaveBeenCalled();

        await act(async () => {
            resolveSecondFlush();
            await secondFlush;
        });
        expect(routerMock.replace).toHaveBeenCalledOnce();
        expect(routerMock.replace).toHaveBeenCalledWith(secondTarget);
    });
});
