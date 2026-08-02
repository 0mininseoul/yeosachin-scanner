import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(), getUser: vi.fn(), enabled: vi.fn(), ensureAccess: vi.fn(),
    reserve: vi.fn(), admit: vi.fn(), replayConsumed: vi.fn(), dispatch: vi.fn(),
    runtimeConfig: vi.fn(),
    admin: { from: vi.fn() }, query: { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/services/analysis/betatest-access', () => ({
    betaTestFreePoolEnabled: mocks.enabled, ensureBetaTestAccess: mocks.ensureAccess,
    BETA_TEST_ACCESS_UNAVAILABLE: 'BETA_ACCESS_UNAVAILABLE',
}));
vi.mock('@/lib/services/analysis/fresh-plan-admission', () => ({
    reserveAnalysisV2FreshAdmission: mocks.reserve,
    markAnalysisV2FreshAdmissionDispatched: vi.fn(),
}));
vi.mock('@/lib/services/analysis/beta-apify-plan-admission', () => ({
    admitBetaApifyPlan: mocks.admit,
    createBetaApifyPlanAdmissionStore: vi.fn(() => ({
        replayConsumed: mocks.replayConsumed,
    })),
    BETA_APIFY_PLAN_ACCESS_UNAVAILABLE:
        'ANALYSIS_BETA_PLAN_ACCESS_UNAVAILABLE',
    BETA_APIFY_PLAN_ADMISSION_ERROR: 'ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE',
    BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT:
        'ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT',
}));
vi.mock('@/lib/services/analysis/beta-apify-credit-runtime', () => ({
    createBetaApifyCreditPoolStore: vi.fn(() => ({})),
    getBetaApifyCreditPoolRuntimeConfig: mocks.runtimeConfig,
}));
vi.mock('@/lib/services/analysis/v2-tasks', () => ({ dispatchAnalysisV2Job: mocks.dispatch }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: vi.fn() },
}));

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
        mocks.enabled.mockReturnValue(true); mocks.ensureAccess.mockResolvedValue(true);
        mocks.runtimeConfig.mockReturnValue({
            enabled: true,
            maxSnapshotAgeSeconds: 300,
            refreshIntervalSeconds: 60,
        });
        mocks.replayConsumed.mockResolvedValue(null);
        mocks.admin.from.mockReturnValue(mocks.query); mocks.query.select.mockReturnValue(mocks.query);
        mocks.query.eq.mockReturnValue(mocks.query);
        mocks.query.maybeSingle.mockResolvedValue({ data: { id: preflightId, user_id: userId, analysis_entry_channel: 'betatest' }, error: null });
        mocks.reserve.mockResolvedValue({ state: 'ready', generation: 1, admissionToken: '423e4567-e89b-42d3-a456-426614174000', selectedPlanAllowed: true, snapshot: {} });
        mocks.admit.mockResolvedValue({ requestId, initialJobKey: 'coordinator:bootstrap', allocationId: '523e4567-e89b-42d3-a456-426614174000', replayed: false });
        mocks.dispatch.mockResolvedValue('enqueued');
    });

    it('rechecks flag, grant, ownership, and beta channel before admission mutations', async () => {
        mocks.ensureAccess.mockResolvedValue(false);
        expect((await POST(request(), context)).status).toBe(403);
        expect(mocks.reserve).not.toHaveBeenCalled();
        mocks.ensureAccess.mockResolvedValue(true);
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

    it('passes the configured non-default snapshot age to the final admission fence', async () => {
        mocks.runtimeConfig.mockReturnValue({
            enabled: true,
            maxSnapshotAgeSeconds: 127,
            refreshIntervalSeconds: 60,
        });

        const response = await POST(request(), context);

        expect(response.status).toBe(200);
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({
            maxSnapshotAgeSeconds: 127,
        }));
    });

    it('fails closed before mutation when the shared pool config is invalid', async () => {
        mocks.runtimeConfig.mockImplementation(() => {
            throw new Error('invalid config containing deployment detail');
        });

        const response = await POST(request(), context);

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'BETA_ADMISSION_PENDING',
        });
        expect(mocks.reserve).not.toHaveBeenCalled();
        expect(mocks.admit).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
    });

    it('returns a stable pending response without trying to admit a request', async () => {
        mocks.reserve.mockResolvedValue({ state: 'pending', shouldEnqueue: false, generation: 1, dispatchGeneration: 1, dispatchToken: null });
        const response = await POST(request(), context);
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: 'BETA_ADMISSION_PENDING' }));
        expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('replays consumed immutable identity before current gate, grant, owner, or fresh reserve checks', async () => {
        mocks.enabled.mockReturnValue(false);
        mocks.ensureAccess.mockResolvedValue(false);
        mocks.replayConsumed.mockResolvedValue({
            requestId,
            initialJobKey: 'coordinator:bootstrap',
            allocationId: '523e4567-e89b-42d3-a456-426614174000',
            replayed: true,
        });

        const response = await POST(request(), context);

        expect(response.status).toBe(200);
        expect(mocks.replayConsumed).toHaveBeenCalledWith({
            preflightId, userId, selectedPlanId: 'basic',
        });
        expect(mocks.enabled).not.toHaveBeenCalled();
        expect(mocks.ensureAccess).not.toHaveBeenCalled();
        expect(mocks.admin.from).not.toHaveBeenCalled();
        expect(mocks.reserve).not.toHaveBeenCalled();
        expect(mocks.admit).not.toHaveBeenCalled();
        expect(mocks.dispatch).toHaveBeenCalledWith(
            requestId, 'coordinator:bootstrap'
        );
    });

    it('rejects a consumed replay under a different selected plan without fresh reserve', async () => {
        mocks.replayConsumed.mockRejectedValue(
            new Error('ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT')
        );

        const response = await POST(request(), context);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual(expect.objectContaining({
            code: 'BETA_ADMISSION_IDENTITY_CONFLICT',
        }));
        expect(mocks.reserve).not.toHaveBeenCalled();
        expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('re-dispatches the same stored request identity after the first queue response is lost', async () => {
        const replay = {
            requestId,
            initialJobKey: 'coordinator:bootstrap' as const,
            allocationId: '523e4567-e89b-42d3-a456-426614174000',
            replayed: true,
        };
        mocks.replayConsumed
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(replay);
        mocks.dispatch
            .mockRejectedValueOnce(new Error('lost queue response'))
            .mockResolvedValueOnce('exists');

        const first = await POST(request(), context);
        const second = await POST(request(), context);

        expect(first.status).toBe(503);
        expect(second.status).toBe(200);
        expect(mocks.reserve).toHaveBeenCalledTimes(1);
        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.dispatch).toHaveBeenNthCalledWith(
            1, requestId, 'coordinator:bootstrap'
        );
        expect(mocks.dispatch).toHaveBeenNthCalledWith(
            2, requestId, 'coordinator:bootstrap'
        );
        await expect(second.json()).resolves.toEqual(expect.objectContaining({
            requestId, status: 'queued',
        }));
    });

    it('keeps a database gate race on the stable access-denied contract', async () => {
        mocks.admit.mockRejectedValueOnce(
            new Error('ANALYSIS_BETA_PLAN_ACCESS_UNAVAILABLE')
        );

        const response = await POST(request(), context);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            code: 'BETA_ACCESS_UNAVAILABLE',
        });
        expect(mocks.dispatch).not.toHaveBeenCalled();
    });
});
