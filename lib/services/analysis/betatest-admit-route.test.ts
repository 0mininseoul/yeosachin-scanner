import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(), getUser: vi.fn(), enabled: vi.fn(), hasAccess: vi.fn(),
    reserve: vi.fn(), admit: vi.fn(), dispatch: vi.fn(),
    admin: { from: vi.fn() }, query: { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/services/analysis/betatest-access', () => ({
    betaTestFreePoolEnabled: mocks.enabled, hasBetaTestAccess: mocks.hasAccess,
    BETA_TEST_ACCESS_UNAVAILABLE: 'BETA_ACCESS_UNAVAILABLE',
}));
vi.mock('@/lib/services/analysis/fresh-plan-admission', () => ({
    reserveAnalysisV2FreshAdmission: mocks.reserve,
    markAnalysisV2FreshAdmissionDispatched: vi.fn(),
}));
vi.mock('@/lib/services/analysis/beta-apify-plan-admission', () => ({
    admitBetaApifyPlan: mocks.admit, createBetaApifyPlanAdmissionStore: vi.fn(() => ({})),
    BETA_APIFY_PLAN_ADMISSION_ERROR: 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
}));
vi.mock('@/lib/services/analysis/beta-apify-credit-runtime', () => ({
    createBetaApifyCreditPoolStore: vi.fn(() => ({})),
}));
vi.mock('@/lib/services/analysis/v2-tasks', () => ({ dispatchAnalysisV2Job: mocks.dispatch }));

import { POST } from '@/app/api/analysis/betatest/preflight/[preflightId]/admit/route';

const userId = '223e4567-e89b-42d3-a456-426614174000';
const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '323e4567-e89b-42d3-a456-426614174000';
function request() { return new Request('https://example.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"planId":"basic"}' }); }
const context = { params: Promise.resolve({ preflightId }) };

describe('betatest plan admission route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser }, rpc: vi.fn() });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.enabled.mockReturnValue(true); mocks.hasAccess.mockResolvedValue(true);
        mocks.admin.from.mockReturnValue(mocks.query); mocks.query.select.mockReturnValue(mocks.query);
        mocks.query.eq.mockReturnValue(mocks.query);
        mocks.query.maybeSingle.mockResolvedValue({ data: { id: preflightId, user_id: userId, analysis_entry_channel: 'betatest' }, error: null });
        mocks.reserve.mockResolvedValue({ state: 'ready', generation: 1, admissionToken: '423e4567-e89b-42d3-a456-426614174000', selectedPlanAllowed: true, snapshot: {} });
        mocks.admit.mockResolvedValue({ requestId, initialJobKey: 'coordinator:bootstrap', allocationId: '523e4567-e89b-42d3-a456-426614174000', replayed: false });
        mocks.dispatch.mockResolvedValue('enqueued');
    });

    it('rechecks flag, grant, ownership, and beta channel before admission mutations', async () => {
        mocks.hasAccess.mockResolvedValue(false);
        expect((await POST(request(), context)).status).toBe(403);
        expect(mocks.reserve).not.toHaveBeenCalled();
        mocks.hasAccess.mockResolvedValue(true);
        mocks.query.maybeSingle.mockResolvedValue({ data: { id: preflightId, user_id: userId, analysis_entry_channel: 'standard' }, error: null });
        expect((await POST(request(), context)).status).toBe(403);
        expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('admits without checkout or test-entitlement credentials and returns normal request id', async () => {
        const response = await POST(request(), context);
        expect(response.status).toBe(200);
        expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            preflightId, userId, selectedPlanId: 'basic', entitlementJtiHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ preflightId, userId, selectedPlanId: 'basic' }));
        expect(mocks.dispatch).toHaveBeenCalledWith(requestId, 'coordinator:bootstrap');
        await expect(response.json()).resolves.toEqual(expect.objectContaining({ requestId, status: 'queued' }));
    });

    it('returns a stable pending response without trying to admit a request', async () => {
        mocks.reserve.mockResolvedValue({ state: 'pending', shouldEnqueue: false, generation: 1, dispatchGeneration: 1, dispatchToken: null });
        const response = await POST(request(), context);
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: 'BETA_ADMISSION_PENDING' }));
        expect(mocks.admit).not.toHaveBeenCalled();
    });
});
