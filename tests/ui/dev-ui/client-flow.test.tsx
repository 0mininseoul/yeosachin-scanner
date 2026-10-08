// @vitest-environment jsdom
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevUiCheckout } from '@/app/dev-ui/checkout/[orderId]/checkout';
import { DevUiOrderList } from '@/components/dev-ui/order-list';
import { useAnalysisV2Preflight } from '@/hooks/useAnalysisV2Preflight';
import ResultPage from '@/app/result/[requestId]/page';
import { projectDevUiResult } from '@/lib/services/dev-ui/projection';
import { buildDevUiPlanSnapshot } from '@/lib/services/dev-ui/contracts';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), readyKakao: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/services/kakao-share', () => ({ kakaoJavascriptKey: () => null, readyKakao: router.readyKakao, shareResultToKakao: vi.fn(), shareToKakaoNow: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...props}>{children}</a> }));

const orderId = '123e4567-e89b-42d3-a456-426614174003';
const runId = '123e4567-e89b-42d3-a456-426614174004';
const order = { orderId, targetInstagramId: 'dev_synthetic', planId: 'basic',
    price: { status: 'quoted', currency: 'KRW', amountKrw: 4900 }, status: 'pending', fixtureScenario: 'complete',
    createdAt: '2026-10-09T00:00:00.000Z', expiresAt: '2026-10-09T00:30:00.000Z', completedAt: null,
    run: null, runStatus: null, nextUrl: `/dev-ui/checkout/${orderId}`, simulation: true };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function render(element: React.ReactNode) { await act(async () => { root.render(element); await Promise.resolve(); await Promise.resolve(); }); }
async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label));
    expect(button).toBeDefined(); await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
}
function PreflightHarness() {
    const flow = useAnalysisV2Preflight();
    return <button onClick={() => void flow.startPreflight('dev_synthetic', 'partial')}>합성 사전 점검</button>;
}

describe('Dev mock checkout and order reading UI', () => {
    it('loads the existing result UI through Dev V2 without auto sharing, feedback, or deletion calls', async () => {
        const snapshot = buildDevUiPlanSnapshot().basic;
        const fixture = projectDevUiResult({ runId, orderId, preflightId: orderId, targetInstagramId: 'dev_synthetic', planId: 'basic', pricingVersion: snapshot.pricingVersion,
            planSnapshot: snapshot, fixtureVersion: 'dev-ui-synthetic-v1', fixtureScenario: 'empty', durationSeconds: 45,
            createdAt: '2026-10-09T00:00:00.000Z', startedAt: '2026-10-09T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', simulation: true },
            { now: new Date('2026-10-09T00:01:00.000Z'), femaleCursor: null, privateCursor: null, pageSize: 50 });
        const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json', 'x-external-profile-links': 'disabled', 'x-analytics-eligible': '0' } }));
        vi.stubGlobal('fetch', fetchSpy);
        const params = Promise.resolve({ requestId: runId });
        await render(<Suspense fallback={null}><ResultPage params={params} /></Suspense>);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(fetchSpy.mock.calls[0][0]).toBe(`/api/analysis/v2/result/${runId}?pageSize=50`);
        expect(container.textContent).toContain('dev_synthetic');
        expect(fetchSpy).toHaveBeenCalledTimes(1); expect(router.readyKakao).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('이 판독 기록 삭제');
        expect(container.textContent).not.toContain('리포트 공유하기');
    });
    it('passes the selected fixture scenario only from the compiled Dev UI', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(response({ error: 'synthetic response', code: 'DEV_UI_UNAVAILABLE' }, 503));
        vi.stubGlobal('fetch', fetchSpy); await render(<PreflightHarness />); await click('합성 사전 점검');
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/analysis/preflight');
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ targetInstagramId: 'dev_synthetic', fixtureScenario: 'partial' });
    });
    it('shows mock checkout and begins progress only after confirmed success', async () => {
        const fetchSpy = vi.fn().mockResolvedValueOnce(response({ simulation: true, order })).mockResolvedValueOnce(response({ status: 'success', orderId, runId, replayed: false }));
        vi.stubGlobal('fetch', fetchSpy);
        await render(<DevUiCheckout orderId={orderId} />);
        expect(container.textContent).toContain('실제 카드 과금은 발생하지 않습니다');
        expect(router.replace).not.toHaveBeenCalled();
        await click('성공');
        expect(fetchSpy.mock.calls[1][0]).toBe(`/api/dev-ui/checkout/${orderId}`);
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ outcome: 'success' });
        expect(router.replace).toHaveBeenCalledWith(`/progress/${runId}`);
    });
    it.each(['cancel', 'failure'] as const)('shows %s as terminal without navigating to a run', async outcome => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ simulation: true, order })).mockResolvedValueOnce(response({ status: outcome, orderId, runId: null, replayed: false })).mockResolvedValueOnce(response({ simulation: true, order: { ...order, status: outcome } })));
        await render(<DevUiCheckout orderId={orderId} />);
        await click(outcome === 'cancel' ? '취소' : '실패');
        expect(router.replace).not.toHaveBeenCalled();
        expect(container.querySelector('a[href="/analyze"]')).not.toBeNull();
    });
    it('recovers a completed order on revisit with the same stored run', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ simulation: true, order: { ...order, status: 'success', run: { runId }, runStatus: 'processing', nextUrl: `/progress/${runId}` } })));
        await render(<DevUiCheckout orderId={orderId} />);
        expect(router.replace).toHaveBeenCalledWith(`/progress/${runId}`);
    });
    it('shows an owner permission error without revealing a checkout or calling a provider', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(response({ code: 'DEV_UI_ACCESS_DENIED', error: '등록된 테스트 계정만 이용할 수 있습니다.' }, 403));
        vi.stubGlobal('fetch', fetchSpy); await render(<DevUiCheckout orderId={orderId} />);
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('등록된 테스트 계정');
        expect(fetchSpy).toHaveBeenCalledTimes(1); expect(container.textContent).not.toContain('모의 결제 성공');
    });
    it('reads the archive endpoint and renders an explicit empty state', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(response({ simulation: true, orders: [] }));
        vi.stubGlobal('fetch', fetchSpy); await render(<DevUiOrderList />);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/dev-ui/orders'); expect(container.textContent).toContain('모의 주문이 없습니다');
    });
    it('reads only mock audit resources and has no provider refresh or dispatch control', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(response({ simulation: true, orders: [order] }));
        vi.stubGlobal('fetch', fetchSpy); await render(<DevUiOrderList administrator />);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/admin/order-audit'); expect(container.textContent).toContain('dev_synthetic');
        expect(container.textContent).not.toMatch(/Apify|dispatch|실제 실행/);
    });
    it('rejects a non-mock response or external continuation before navigation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ simulation: true, order: { ...order, status: 'success', run: { runId }, nextUrl: 'https://yeosachin.com/' } })));
        await render(<DevUiCheckout orderId={orderId} />);
        expect(router.replace).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
});
