import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { getApprovedDevLiveDelivery, handleDevLiveAvailability, withDevLiveApproval, withDevLiveRead } from '@/lib/services/dev-ui/live-analysis';

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
const standardApproval = { ...approval, planId: 'standard', expiresAt: '2026-11-19T03:30:00.000Z', apifyMaxCents: 600, aiMaxCents: 1_800 };
const durableStandardApproval = { ...standardApproval, expiresAt: null };
const standardKey = 'dev-live:owner:standard:' + id;
const standardPreflight = { id, idempotency_key: standardKey, target_instagram_id: approval.targetInstagramId, user_id: 'synthetic-owner' };

function start(origin = host, plan?: string) {
    return new Request(endpoint, { method: 'POST', headers: {
        origin, 'content-type': 'application/json', 'x-dev-live-attempt-id': attempt,
        ...(plan ? { 'x-dev-live-plan': plan } : {}),
    }, body: JSON.stringify({ targetInstagramId: approval.targetInstagramId }) });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-11-19T01:10:00Z'));
    vi.stubEnv('DEV_LIVE_ANALYSIS_ARMED', 'true');
    vi.stubEnv('DEV_LIVE_ANALYSIS_MODE', 'owner_start');
    vi.stubEnv('DEV_LIVE_STANDARD_TARGET', undefined);
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
            ...approval, planId: 'basic', idempotencyKey: 'dev-live:owner:' + id, nonce: 'dev-live-' + id,
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

    it('only grants Standard to the configured target and pins the plan and caps', async () => {
        vi.stubEnv('DEV_LIVE_STANDARD_TARGET', approval.targetInstagramId);
        mocks.rpc.mockResolvedValue({ data: durableStandardApproval, error: null });
        const handler = vi.fn(async () => NextResponse.json({}, { status: 202 }));

        expect((await withDevLiveApproval(start(host, 'basic'), handler)).status).toBe(409);
        expect((await withDevLiveApproval(start(host, 'standard'), handler)).status).toBe(409);
        expect((await withDevLiveApproval(start(host, 'standard:400'), handler)).status).toBe(409);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect((await withDevLiveApproval(start(host, 'standard:1800'), handler)).status).toBe(202);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('dev_live_owner_start_v4', {
            p_user_id: 'synthetic-owner', p_target_instagram_id: approval.targetInstagramId, p_attempt_id: attempt,
        });
        expect(handler).toHaveBeenCalledWith({ id: 'synthetic-owner' }, {
            ...durableStandardApproval, idempotencyKey: standardKey, nonce: 'dev-live-' + id,
        });

        handler.mockClear();
        mocks.rpc.mockResolvedValue({ data: standardApproval, error: null });
        expect((await withDevLiveApproval(start(host, 'standard:1800'), handler)).status).toBe(503);
        mocks.rpc.mockResolvedValue({ data: { ...durableStandardApproval, aiMaxCents: 400 }, error: null });
        expect((await withDevLiveApproval(start(host, 'standard:1800'), handler)).status).toBe(503);
        expect(handler).not.toHaveBeenCalled();
    });

    it('continues a bound $4 Standard preflight using its original grant', async () => {
        vi.stubEnv('DEV_LIVE_STANDARD_TARGET', approval.targetInstagramId);
        const query = { select: () => query, eq: () => query,
            maybeSingle: async () => ({ data: standardPreflight }) };
        mocks.from.mockReturnValue(query);
        const legacy = { ...standardApproval, aiMaxCents: 400 };
        mocks.rpc.mockResolvedValue({ data: legacy, error: null });
        const handler = vi.fn(async () => NextResponse.json({}, { status: 202 }));

        expect((await withDevLiveApproval(start(host, 'standard'), handler, id)).status).toBe(202);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('dev_live_owner_start_lookup_v2', {
            p_grant_id: id, p_user_id: 'synthetic-owner', p_target_instagram_id: approval.targetInstagramId,
        });
        expect(handler).toHaveBeenCalledWith({ id: 'synthetic-owner' }, expect.objectContaining({ aiMaxCents: 400 }));
    });

    it('allows an aged durable Standard delivery while a finite Standard approval expires', async () => {
        vi.stubEnv('DEV_LIVE_STANDARD_TARGET', approval.targetInstagramId);
        vi.setSystemTime(new Date('2026-11-20T01:10:00Z'));
        const query = (data: unknown) => ({
            select: () => query(data), eq: () => query(data), maybeSingle: async () => ({ data }),
        });
        mocks.from.mockImplementation(table => query(table === 'analysis_preflights'
            ? standardPreflight : { id, selected_plan_id_snapshot: 'standard' }));

        mocks.rpc.mockResolvedValue({ data: durableStandardApproval, error: null });
        await expect(getApprovedDevLiveDelivery({ requestId: id })).resolves.toMatchObject({
            expiresAt: null, planId: 'standard', aiMaxCents: 1_800,
        });
        mocks.rpc.mockResolvedValue({ data: standardApproval, error: null });
        await expect(getApprovedDevLiveDelivery({ requestId: id })).resolves.toBeNull();
    });

    it('reports Standard readiness without issuing a grant', async () => {
        vi.stubEnv('DEV_LIVE_STANDARD_TARGET', approval.targetInstagramId);
        const query = { select: () => query, eq: () => query, like: () => query,
            order: () => query, limit: () => query, maybeSingle: async () => ({ data: null }) };
        mocks.from.mockReturnValue(query);
        mocks.rpc.mockResolvedValue({ data: true, error: null });

        const response = await handleDevLiveAvailability(new Request(host + '/api/dev-ui/live/availability'));
        expect(await response.json()).toEqual({ available: true, recentPreflightId: null,
            standardTarget: approval.targetInstagramId, standardAvailable: true });
        expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
            'dev_live_owner_start_ready_v1', 'dev_live_owner_start_ready_v4',
        ]);
        expect(mocks.budget).not.toHaveBeenCalled();
    });

    it('reads the persisted plan without issuing a grant and rejects a mismatched paid delivery', async () => {
        vi.stubEnv('DEV_LIVE_STANDARD_TARGET', approval.targetInstagramId);
        const query = (data: unknown) => ({
            select: () => query(data), eq: () => query(data), maybeSingle: async () => ({ data }),
        });
        mocks.from.mockImplementation(table => query(table === 'analysis_preflights'
            ? standardPreflight : { id, selected_plan_id_snapshot: 'basic' }));
        mocks.rpc.mockResolvedValue({ data: standardApproval, error: null });

        const response = await withDevLiveRead(new Request(endpoint), { preflightId: id },
            async () => NextResponse.json({}));
        expect(response.headers.get('x-dev-live-plan')).toBe('standard');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(await getApprovedDevLiveDelivery({ requestId: id })).toBeNull();
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('dev_live_owner_start_lookup_v2', {
            p_grant_id: id, p_user_id: 'synthetic-owner', p_target_instagram_id: approval.targetInstagramId,
        });
    });
});
