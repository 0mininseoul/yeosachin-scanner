import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import registry from '@/config/dev-ui-deployment.json';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';
import { DevUiStoreError, buildDevUiPlanSnapshot, type DevUiRun } from '@/lib/services/dev-ui/contracts';

const spies = vi.hoisted(() => ({
    createClient: vi.fn(), getUser: vi.fn(), provider: vi.fn(), observe: vi.fn(),
    store: {
        createOrReplayPreflight: vi.fn(), readPreflight: vi.fn(), createOrReplayCheckout: vi.fn(),
        readCheckout: vi.fn(), completeCheckout: vi.fn(), readRun: vi.fn(),
        listOwnerOrders: vi.fn(), listAdminOrders: vi.fn(), readAdminOrder: vi.fn(),
    },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: spies.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: spies.provider, from: spies.provider } }));
vi.mock('@/lib/services/dev-ui/store', () => ({ createDevUiStore: () => spies.store }));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: spies.observe,
    suppressOperationalObservation: (response: Response) => response,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), notFound: () => { throw new Error('NOT_FOUND'); } }));

import { POST as createPreflight } from '@/app/api/analysis/preflight/route';
import { GET as readPreflight } from '@/app/api/analysis/preflight/[preflightId]/route';
import { POST as createCheckout } from '@/app/api/earlybird/checkout/route';
import { GET as readResult } from '@/app/api/analysis/v2/result/[requestId]/route';
import { GET as readMe } from '@/app/api/user/me/route';
import * as checkoutResource from '@/app/api/dev-ui/checkout/[orderId]/route';
import { GET as readProgress } from '@/app/api/analysis/v2/progress/[requestId]/route';
import { GET as readOrders } from '@/app/api/dev-ui/orders/route';
import { GET as readAdminOrders } from '@/app/api/admin/order-audit/route';
import { GET as readAdminOrder } from '@/app/api/admin/order-audit/[requestId]/route';
import DevUiCheckoutPage from '@/app/dev-ui/checkout/[orderId]/page';

const owner = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';
const preflightId = '123e4567-e89b-42d3-a456-426614174002';
const orderId = '123e4567-e89b-42d3-a456-426614174003';
const runId = '123e4567-e89b-42d3-a456-426614174004';
const registered = registry.deployments[0];
const started = '2026-10-09T00:00:00.000Z';

function request(path: string, body?: unknown, origin = DEV_UI_APP_ORIGIN): Request {
    return new Request(`${DEV_UI_APP_ORIGIN}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json', origin, 'idempotency-key': 'dev-ui-route-preflight-0001' },
        body: JSON.stringify(body),
    });
}
function run(scenario: DevUiRun['fixtureScenario'] = 'complete'): DevUiRun {
    return { runId, orderId, preflightId, targetInstagramId: 'dev_synthetic', planId: 'basic',
        pricingVersion: buildDevUiPlanSnapshot().basic.pricingVersion, planSnapshot: buildDevUiPlanSnapshot().basic,
        fixtureVersion: 'dev-ui-synthetic-v1', fixtureScenario: scenario, durationSeconds: 45,
        createdAt: started, startedAt: started, expiresAt: '2026-10-16T00:00:00.000Z', simulation: true };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DEPLOYMENT_ROLE', 'dev'); vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
    vi.stubEnv('VERCEL_PROJECT_ID', registered.vercelProjectId);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${registered.supabaseProjectRef}.supabase.co`);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', DEV_UI_APP_ORIGIN);
    vi.stubEnv('DEV_UI_TEST_USER_IDS', owner); vi.stubEnv('DEV_UI_ADMIN_USER_IDS', owner);
    spies.createClient.mockResolvedValue({ auth: { getUser: spies.getUser } });
    spies.getUser.mockResolvedValue({ data: { user: { id: owner, email: 'synthetic@example.invalid', app_metadata: { provider: 'kakao' }, created_at: started } }, error: null });
    spies.observe.mockImplementation(() => { throw new Error('Production observation must not run'); });
    spies.provider.mockImplementation(() => { throw new Error('Production/provider client must not run'); });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch must not run'); }));
    vi.setSystemTime(new Date(started));
});
afterEach(() => {
    expect(spies.provider).not.toHaveBeenCalled(); expect(spies.observe).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Dev UI actual route boundary', () => {
    it('offers a Dev Kakao login gate for an unauthenticated mock checkout deep link', async () => {
        spies.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const html = renderToStaticMarkup(await DevUiCheckoutPage({ params: Promise.resolve({ orderId }) }));
        expect(html).toContain('카카오로 3초 만에 시작하기');
        expect(html).toContain('모의 결제 로그인');
        expect(spies.store.readCheckout).not.toHaveBeenCalled();
    });
    it('accepts a synthetic preflight without starting a run or issuing the demo result cookie', async () => {
        spies.store.createOrReplayPreflight.mockResolvedValue({ preflightId, expiresAt: '2026-10-09T00:30:00.000Z', created: true });
        const response = await createPreflight(request('/api/analysis/preflight', { targetInstagramId: 'dev_synthetic', fixtureScenario: 'partial' }));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ schemaVersion: 1, preflightId, expiresAt: '2026-10-09T00:30:00.000Z', status: 'pending', exclusionDecision: 'pending' });
        expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(spies.store.createOrReplayPreflight).toHaveBeenCalledWith({ userId: owner, targetInstagramId: 'dev_synthetic', fixtureScenario: 'partial', idempotencyKey: 'dev-ui-route-preflight-0001' });
        expect(spies.store.completeCheckout).not.toHaveBeenCalled();
    });
    it('denies a mismatched actual deployment before Auth or store clients', async () => {
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_wrong');
        expect((await createPreflight(request('/api/analysis/preflight', { targetInstagramId: 'dev_synthetic' }))).status).toBe(403);
        expect(spies.createClient).not.toHaveBeenCalled(); expect(spies.store.createOrReplayPreflight).not.toHaveBeenCalled();
    });
    it('denies an authenticated unregistered tester before synthetic writes', async () => {
        spies.getUser.mockResolvedValue({ data: { user: { id: other } }, error: null });
        expect((await createPreflight(request('/api/analysis/preflight', { targetInstagramId: 'dev_synthetic' }))).status).toBe(403);
        expect(spies.store.createOrReplayPreflight).not.toHaveBeenCalled();
    });
    it.each([{ userId: other }, { fixtureScenario: 'production' }, { DEPLOYMENT_ROLE: 'dev' }])('denies unsupported request selectors before synthetic writes: %j', async extra => {
        const response = await createPreflight(request('/api/analysis/preflight', { targetInstagramId: 'dev_synthetic', ...extra }));
        expect(response.status).toBe(400); expect(spies.store.createOrReplayPreflight).not.toHaveBeenCalled();
    });
    it('distinguishes an Auth service outage from a login-required response without store fallback', async () => {
        spies.getUser.mockResolvedValue({ data: { user: null }, error: { status: 503, name: 'AuthApiError' } });
        const response = await createPreflight(request('/api/analysis/preflight', { targetInstagramId: 'dev_synthetic' }));
        expect(response.status).toBe(503); expect(spies.store.createOrReplayPreflight).not.toHaveBeenCalled();
    });
    it('rejects cross-origin checkout before Auth and persistence', async () => {
        const response = await createCheckout(request('/api/earlybird/checkout', { preflightId, planId: 'basic', disclosureAccepted: true }, 'https://yeosachin.com'));
        expect(response.status).toBe(403); expect(spies.createClient).not.toHaveBeenCalled();
    });
    it('uses only the persisted checkout snapshot and returns the exact mock checkout path', async () => {
        spies.store.createOrReplayCheckout.mockResolvedValue({ orderId, nextUrl: `/dev-ui/checkout/${orderId}`, expiresAt: '2026-10-09T00:30:00.000Z' });
        const response = await createCheckout(request('/api/earlybird/checkout', { preflightId, planId: 'standard', disclosureAccepted: true }));
        expect(response.status).toBe(200); expect((await response.json()).nextUrl).toBe(`/dev-ui/checkout/${orderId}`);
        expect(spies.store.createOrReplayCheckout).toHaveBeenCalledWith({ userId: owner, preflightId, planId: 'standard', disclosureAccepted: true });
    });
    it('returns a stable expiration response without falling back to production preflight', async () => {
        spies.store.readPreflight.mockResolvedValue({ status: 'expired', snapshot: null });
        const response = await readPreflight(request(`/api/analysis/preflight/${preflightId}`), { params: Promise.resolve({ preflightId }) });
        expect(response.status).toBe(410); expect((await response.json()).code).toBe('PREFLIGHT_EXPIRED');
    });
    it('denies early result access even with a production demo result cookie', async () => {
        spies.store.readRun.mockResolvedValue(run());
        const input = request(`/api/analysis/v2/result/${runId}`);
        input.headers.set('cookie', `demo-result-${runId}=forged`);
        const response = await readResult(input, { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(404); expect((await response.json()).code).toBe('RESULT_PENDING');
    });
    it('forwards only verified ownership and hides an inaccessible run', async () => {
        vi.stubEnv('DEV_UI_TEST_USER_IDS', `${owner},${other}`);
        spies.getUser.mockResolvedValue({ data: { user: { id: other } }, error: null });
        spies.store.readRun.mockResolvedValue(null);
        const response = await readResult(request(`/api/analysis/v2/result/${runId}`), { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(404); expect(spies.store.readRun).toHaveBeenCalledWith({ userId: other, runId });
    });
    it('allows the Auth bootstrap before tester registration without any principal writer', async () => {
        vi.stubEnv('DEV_UI_TEST_USER_IDS', '');
        const response = await readMe(request('/api/user/me'));
        expect(response.status).toBe(200); expect((await response.json()).user).toMatchObject({ id: owner, provider: 'kakao', analysis_count: 0, is_paid_user: false });
    });
    it('maps sanitized store failures without leaking the original error', async () => {
        spies.store.createOrReplayCheckout.mockRejectedValue(new DevUiStoreError('DEV_UI_IDEMPOTENCY_CONFLICT'));
        const response = await createCheckout(request('/api/earlybird/checkout', { preflightId, planId: 'basic', disclosureAccepted: true }));
        expect(response.status).toBe(409); expect((await response.json()).code).toBe('DEV_UI_IDEMPOTENCY_CONFLICT');
    });
    it.each(['cancel', 'failure'] as const)('mock %s completion creates no run and stays owner scoped', async outcome => {
        spies.store.completeCheckout.mockResolvedValue({ status: outcome, orderId, runId: null, replayed: false });
        const response = await checkoutResource.POST(request(`/api/dev-ui/checkout/${orderId}`, { outcome }), { params: Promise.resolve({ orderId }) });
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: outcome, runId: null });
        expect(spies.store.completeCheckout).toHaveBeenCalledWith({ userId: owner, orderId, outcome });
    });
    it('replays mock success with the same persisted run', async () => {
        spies.store.completeCheckout.mockResolvedValue({ status: 'success', orderId, runId, replayed: true });
        const response = await checkoutResource.POST(request(`/api/dev-ui/checkout/${orderId}`, { outcome: 'success' }), { params: Promise.resolve({ orderId }) });
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ runId, replayed: true });
    });
    it('rejects mock checkout endpoints on Production before Auth or store', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'production'); vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'production');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_production'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://productionexample.supabase.co');
        const input = new Request(`https://yeosachin.com/api/dev-ui/checkout/${orderId}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://yeosachin.com' }, body: JSON.stringify({ outcome: 'success' }) });
        expect((await checkoutResource.POST(input, { params: Promise.resolve({ orderId }) })).status).toBe(403);
        expect(spies.createClient).not.toHaveBeenCalled(); expect(spies.store.completeCheckout).not.toHaveBeenCalled();
    });
    it('denies malformed/encoded resource paths before any Auth client', async () => {
        const response = await checkoutResource.GET(request(`/api/dev-ui/checkout/%31${orderId.slice(1)}`), { params: Promise.resolve({ orderId }) });
        expect(response.status).toBe(403); expect(spies.createClient).not.toHaveBeenCalled();
    });
    it('reads an owner checkout without creating or completing it', async () => {
        spies.store.readCheckout.mockResolvedValue({ orderId, status: 'pending', simulation: true });
        const response = await checkoutResource.GET(request(`/api/dev-ui/checkout/${orderId}`), { params: Promise.resolve({ orderId }) });
        expect(response.status).toBe(200); expect((await response.json()).order.orderId).toBe(orderId);
        expect(spies.store.readCheckout).toHaveBeenCalledWith({ userId: owner, orderId });
        expect(spies.store.completeCheckout).not.toHaveBeenCalled();
    });
    it('reads synthetic progress and events without worker/admission calls', async () => {
        spies.store.readRun.mockResolvedValue(run());
        vi.setSystemTime(new Date(Date.parse(started) + 15_000));
        const response = await readProgress(request(`/api/analysis/v2/progress/${runId}?afterSeq=0&limit=200`), { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(200); expect((await response.json()).snapshot).toMatchObject({ requestId: runId, status: 'processing' });
    });
    it('rejects invalid progress cursors without a store read', async () => {
        const response = await readProgress(request(`/api/analysis/v2/progress/${runId}?afterSeq=-1`), { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(400); expect(spies.store.readRun).not.toHaveBeenCalled();
    });
    it.each(['complete', 'partial', 'empty'] as const)('returns the existing result contract for the %s fixture after completion', async scenario => {
        spies.store.readRun.mockResolvedValue(run(scenario));
        vi.setSystemTime(new Date(Date.parse(started) + 45_000));
        const response = await readResult(request(`/api/analysis/v2/result/${runId}?pageSize=50`), { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.schemaVersion).toBe(1); expect(result.summary.targetInstagramId).toBe('dev_synthetic');
        if (scenario === 'partial') expect(result.summary.followers.exactCountMatch).toBe(false);
        if (scenario === 'empty') expect(result.femaleAccounts).toHaveLength(0);
    });
    it('returns the failed progress and denies its result', async () => {
        spies.store.readRun.mockResolvedValue(run('failed'));
        vi.setSystemTime(new Date(Date.parse(started) + 40_000));
        expect((await (await readProgress(request(`/api/analysis/v2/progress/${runId}`), { params: Promise.resolve({ requestId: runId }) })).json()).snapshot.status).toBe('failed');
        const response = await readResult(request(`/api/analysis/v2/result/${runId}`), { params: Promise.resolve({ requestId: runId }) });
        expect(response.status).toBe(404); expect((await response.json()).code).toBe('DEV_UI_RUN_FAILED');
    });
    it('reads archive using only the owner DTO projection', async () => {
        spies.store.listOwnerOrders.mockResolvedValue([]);
        expect(await (await readOrders(request('/api/dev-ui/orders'))).json()).toEqual({ simulation: true, orders: [] });
        expect(spies.store.listOwnerOrders).toHaveBeenCalledWith({ userId: owner });
    });
    it('requires both tester and administrator membership for the mock audit', async () => {
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', other);
        expect((await readAdminOrders(request('/api/admin/order-audit'))).status).toBe(403);
        expect(spies.store.listAdminOrders).not.toHaveBeenCalled();
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', owner); vi.stubEnv('DEV_UI_TEST_USER_IDS', other);
        expect((await readAdminOrders(request('/api/admin/order-audit'))).status).toBe(403);
        expect(spies.store.listAdminOrders).not.toHaveBeenCalled();
    });
    it('returns explicit mock audit DTOs instead of production audit loaders', async () => {
        spies.store.listAdminOrders.mockResolvedValue([]); spies.store.readAdminOrder.mockResolvedValue({ orderId, simulation: true });
        expect(await (await readAdminOrders(request('/api/admin/order-audit'))).json()).toEqual({ simulation: true, orders: [] });
        expect(await (await readAdminOrder(request(`/api/admin/order-audit/${orderId}`), { params: Promise.resolve({ requestId: orderId }) })).json()).toMatchObject({ simulation: true, order: { orderId } });
    });
});
