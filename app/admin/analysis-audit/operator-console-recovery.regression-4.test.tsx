/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIFY_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';
import { AnalysisAuditWorkbench } from './workbench';

const observedAt = '2026-09-05T08:00:00.000Z';
const inventory = APIFY_CREDENTIAL_SLOTS.map(credentialSlot => ({
    credentialSlot,
    workloadRole: credentialSlot === 'secondary' ? 'paid' as const : 'free' as const,
    healthState: 'healthy' as const,
    freshnessState: 'fresh' as const,
    monthlyLimitUsd: 5,
    monthlyUsageUsd: 0,
    effectiveRemainingUsd: 5,
    billingCycleStartAt: '2026-09-01T00:00:00.000Z',
    billingCycleEndAt: '2026-10-01T00:00:00.000Z',
    cycleResetAt: '2026-10-01T00:00:00.000Z',
    observedAt,
    refreshedAt: observedAt,
    manuallyExcluded: false,
}));

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

describe('operator console loading and recovery', () => {
    // Regression: ISSUE-004 — unresolved and failed requests were presented as a verified zero-item state.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it('distinguishes pending and unavailable attention data, then retries each failed source', async () => {
        const inventoryInitial = deferred<Response>();
        const ordersInitial = deferred<Response>();
        const leadsInitial = deferred<Response>();
        let inventoryRequests = 0;
        let orderRequests = 0;
        let leadsRequests = 0;
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') {
                inventoryRequests += 1;
                return inventoryRequests === 1
                    ? inventoryInitial.promise
                    : Promise.resolve(jsonResponse({ inventory }));
            }
            if (url.pathname === '/api/admin/order-audit') {
                orderRequests += 1;
                return orderRequests === 1
                    ? ordersInitial.promise
                    : Promise.resolve(jsonResponse({ rows: [], nextCursor: null }));
            }
            if (url.pathname === '/api/admin/landing-leads') {
                leadsRequests += 1;
                return leadsRequests === 1
                    ? leadsInitial.promise
                    : Promise.resolve(jsonResponse({ rows: [], nextCursor: null }));
            }
            return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
        });
        vi.stubGlobal('fetch', fetchMock);

        container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        act(() => root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' })));

        const attention = container.querySelector('[aria-labelledby="attention-title"]');
        const orders = container.querySelector('[aria-labelledby="orders-title"]');
        const leads = container.querySelector('[data-testid="landing-leads-panel"]');
        expect(attention?.textContent).toContain('확인 중');
        expect(attention?.textContent).not.toContain('0건');
        expect(attention?.textContent).not.toContain('확인이 필요한 항목이 없습니다');
        expect(orders?.textContent).toContain('확인 중');
        expect(orders?.textContent).not.toContain('0건 표시');
        expect(leads?.textContent).toContain('확인 중');

        await act(async () => {
            inventoryInitial.resolve(jsonResponse({ error: 'failed' }, 500));
            ordersInitial.resolve(jsonResponse({ error: 'failed' }, 500));
            leadsInitial.resolve(jsonResponse({ error: 'failed' }, 500));
        });
        await settle();

        expect(attention?.textContent).toContain('확인 불가');
        expect(attention?.textContent).toContain('확인 필요 여부를 계산할 수 없습니다');
        expect(attention?.textContent).not.toContain('확인이 필요한 항목이 없습니다');
        expect(orders?.textContent).toContain('확인 불가');
        expect(orders?.textContent).not.toContain('0건 표시');
        expect(leads?.textContent).toContain('확인 불가');

        const inventoryRetry = [...container.querySelectorAll('button')]
            .find(button => button.textContent === '계정 다시 시도');
        const ordersRetry = [...container.querySelectorAll('button')]
            .find(button => button.textContent === '주문 다시 시도');
        const leadsRetry = [...container.querySelectorAll('button')]
            .find(button => button.textContent === '리드 다시 시도');
        expect(inventoryRetry).toBeDefined();
        expect(ordersRetry).toBeDefined();
        expect(leadsRetry).toBeDefined();

        await act(async () => {
            inventoryRetry!.click();
            ordersRetry!.click();
            leadsRetry!.click();
        });
        await settle();
        await settle();

        expect(inventoryRequests).toBe(2);
        expect(orderRequests).toBe(2);
        expect(leadsRequests).toBe(2);
        expect([...container.querySelectorAll('[role="alert"]')].map(node => node.textContent)).toEqual([]);
        expect(attention?.textContent).toContain('0건');
        expect(attention?.textContent).toContain('확인이 필요한 항목이 없습니다');
        expect(orders?.textContent).toContain('0건 표시');
        expect(container.textContent).not.toContain('운영 데이터를 불러오지 못했습니다');
    });
});
