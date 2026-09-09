/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisAuditWorkbench } from './workbench';

const timestamp = '2026-09-05T08:00:00.000Z';
const row = {
    instagramId: 'target.account',
    inputContext: 'target' as const,
    mappingStatus: 'anonymous_device' as const,
    rowCountInJourney: 2,
    firstSeenAt: timestamp,
    lastSeenAt: '2026-09-05T08:01:00.000Z',
};
const excludedRow = {
    ...row,
    instagramId: 'excluded.account',
    inputContext: 'excluded' as const,
    mappingStatus: 'authenticated_user' as const,
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

function renderWorkbench(): void {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' })));
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
    setter?.call(element, value);
}

describe('operator console landing Leads section', () => {
    it('renders Target/Excluded tabs, normalized filters, empty-safe rows, and keyset pagination', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory: [] });
            if (url.pathname === '/api/admin/order-audit') return jsonResponse({ rows: [], nextCursor: null });
            if (url.pathname === '/api/admin/landing-leads') {
                if (url.searchParams.get('context') === 'excluded') return jsonResponse({ rows: [excludedRow], nextCursor: null });
                if (url.searchParams.get('cursor') === 'cursor-1') return jsonResponse({ rows: [excludedRow], nextCursor: null });
                return jsonResponse({ rows: [row], nextCursor: 'cursor-1' });
            }
            return jsonResponse({ error: 'not found' }, 404);
        });
        vi.stubGlobal('fetch', fetchMock);
        renderWorkbench();
        await settle();

        expect(container!.querySelector('[data-testid="landing-leads-panel"]')).toBeTruthy();
        expect(container!.textContent).toContain('Target');
        expect(container!.textContent).toContain('Excluded');
        expect(container!.textContent).toContain('@target.account');

        const leadsPanel = container!.querySelector('[data-testid="landing-leads-panel"]')!;
        const next = [...leadsPanel.querySelectorAll('button')].find(button => button.textContent?.includes('다음 25건')) as HTMLButtonElement;
        expect(next.disabled).toBe(false);
        await act(async () => next.click());
        await settle();
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('cursor=cursor-1'))).toBe(true);

        const contextExcluded = container!.querySelector('[data-landing-lead-context="excluded"]') as HTMLButtonElement;
        await act(async () => contextExcluded.click());
        await settle();
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('context=excluded'))).toBe(true);
        expect(container!.textContent).toContain('@excluded.account');

        const select = container!.querySelector('[aria-label="리드 필터"] select') as HTMLSelectElement;
        await act(async () => {
            setNativeValue(select, 'authenticated_user');
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const input = container!.querySelector('input[type="search"]') as HTMLInputElement;
        await act(async () => {
            setNativeValue(input, ' @Target.Account ');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const dates = container!.querySelectorAll('input[type="date"]');
        await act(async () => {
            setNativeValue(dates[0] as HTMLInputElement, '2026-09-05');
            dates[0]!.dispatchEvent(new Event('change', { bubbles: true }));
            setNativeValue(dates[1] as HTMLInputElement, '2026-09-06');
            dates[1]!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settle();
        expect(fetchMock.mock.calls.some(([input]) => {
            const url = new URL(String(input), 'http://localhost');
            return url.searchParams.get('mappingStatus') === 'authenticated_user'
                && url.searchParams.get('instagramId') === 'target.account'
                && url.searchParams.get('from') === '2026-09-05T00:00:00.000Z'
                && url.searchParams.get('to') === '2026-09-06T23:59:59.999Z';
        })).toBe(true);
    });

    it('shows loading, error, and empty states without exposing internals', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            if (url.pathname === '/api/admin/apify-accounts') return jsonResponse({ inventory: [] });
            if (url.pathname === '/api/admin/order-audit') return jsonResponse({ rows: [], nextCursor: null });
            if (url.pathname === '/api/admin/landing-leads') return jsonResponse({ error: 'secret' }, 503);
            return jsonResponse({ error: 'not found' }, 404);
        });
        vi.stubGlobal('fetch', fetchMock);
        renderWorkbench();
        await settle();
        expect(container!.textContent).toContain('운영 데이터를 불러오지 못했습니다.');
        expect(container!.textContent).not.toContain('secret');
    });
});
