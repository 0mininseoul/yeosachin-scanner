import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { handleDevLiveAvailability, withDevLiveApproval } from '@/lib/services/dev-ui/live-analysis';

const mocks = vi.hoisted(() => ({
    owner: true,
    rpc: vi.fn(),
    from: vi.fn(),
    runtime: vi.fn(),
    entitlement: vi.fn(),
    runner: vi.fn(),
    budget: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/lib/services/identity/account-principal-store', () => ({ requireActiveE2eTestRunner: mocks.runner }));
vi.mock('@/lib/services/analysis/test-entitlement', () => ({ assertAnalysisTestEntitlementConfiguration: mocks.entitlement }));
vi.mock('@/lib/services/dev-ui/live-runtime', () => ({ assertDevLiveWebRuntime: mocks.runtime }));
vi.mock('@/lib/services/dev-ui/live-budget', () => ({ assertDevLiveBudgetAvailable: mocks.budget }));
vi.mock('@/lib/services/dev-ui/routes', () => ({
    devUiJson: (body: object, status = 200) => NextResponse.json(body, { status }),
    withDevUiSession: (_request: Request, handler: (user: { id: string }) => Promise<NextResponse>) => mocks.owner
        ? handler({ id: 'synthetic-owner' }) : NextResponse.json({}, { status: 403 }),
}));

const host = 'https://dev.yeosachin.com';
const endpoint = host + '/api/analysis/preflight?devAnalysis=live';
const id = '4cee181d-59f2-49c3-8001-0e53a4f379a4';
const attempt = 'd34dd847-cd00-4460-91e7-3926356aad67';
const approval = { id, targetInstagramId: 'dev_fixture', approvedAt: '2026-11-19T01:00:00.000Z',
    expiresAt: '2026-11-19T01:30:00.000Z', apifyMaxCents: 500, aiMaxCents: 200 };

function start(origin = host) {
    return new Request(endpoint, { method: 'POST', headers: {
        origin, 'content-type': 'application/json', 'x-dev-live-attempt-id': attempt,
    }, body: JSON.stringify({ targetInstagramId: approval.targetInstagramId }) });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-11-19T01:10:00Z'));
    vi.stubEnv('DEV_LIVE_ANALYSIS_ARMED', 'true');
    vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', 'owner_start');
    mocks.owner = true;
    mocks.rpc.mockResolvedValue({ data: approval, error: null });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('owner-start live Dev approval', () => {
    it('issues a scoped run only after authenticated explicit same-origin start', async () => {
        const handler = vi.fn(async () => NextResponse.json({}, { status: 202 }));
        expect((await withDevLiveApproval(start(), handler)).status).toBe(202);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('dev_live_owner_start_v1', {
            p_user_id: 'synthetic-owner', p_target_instagram_id: approval.targetInstagramId, p_attempt_id: attempt,
        });
        expect(handler).toHaveBeenCalledWith({ id: 'synthetic-owner' }, {
            ...approval, idempotencyKey: 'dev-live:owner:' + id, nonce: 'dev-live-' + id,
        });
    });

    it('does not issue grants during availability checks', async () => {
        const query = { select: () => query, eq: () => query, like: () => query,
            order: () => query, limit: () => query, maybeSingle: async () => ({ data: null }) };
        mocks.from.mockReturnValue(query);
        mocks.rpc.mockResolvedValue({ data: true, error: null });
        const response = await handleDevLiveAvailability(new Request(host + '/api/dev-ui/live/availability'));
        expect(await response.json()).toEqual({ available: true, recentPreflightId: null });
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('dev_live_owner_start_ready_v1', { p_user_id: 'synthetic-owner' });
        expect(mocks.budget).not.toHaveBeenCalled();
    });

    it('blocks non-owner and cross-origin requests before touching the approval store', async () => {
        const handler = vi.fn();
        expect((await withDevLiveApproval(start('https://untrusted.example'), handler)).status).toBe(404);
        mocks.owner = false;
        expect((await withDevLiveApproval(start(), handler)).status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('tells the browser an expired attempt can be cleared without retrying the request', async () => {
        mocks.rpc.mockResolvedValue({ data: null,
            error: { code: 'P0001', message: 'DEV_LIVE_OWNER_START_UNAVAILABLE' } });
        const handler = vi.fn();
        const response = await withDevLiveApproval(start(), handler);
        expect(response.status).toBe(410);
        expect((await response.json()).code).toBe('DEV_LIVE_START_ATTEMPT_EXPIRED');
        expect(handler).not.toHaveBeenCalled();
    });

    it('keeps the per-run expiration and caps after the global approval was enabled', async () => {
        const handler = vi.fn();
        vi.setSystemTime(Date.parse(approval.expiresAt));
        expect((await withDevLiveApproval(start(), handler)).status).toBe(503);
        expect(handler).not.toHaveBeenCalled();
    });
});
