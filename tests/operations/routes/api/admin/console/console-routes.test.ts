import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    decision: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock('@/lib/services/analysis/score-audit', async () => {
    const actual = await vi.importActual<typeof import('@/lib/services/analysis/score-audit')>(
        '@/lib/services/analysis/score-audit',
    );
    return { ...actual, getAnalysisAuditOperatorDecision: mocks.decision };
});

import { GET as getOverview } from '../../../../../../app/api/admin/overview/route';
import { GET as getLeadInputs } from '../../../../../../app/api/admin/lead-inputs/route';
import { GET as getOrderCustomers } from '../../../../../../app/api/admin/order-customers/route';
import { GET as getOrders } from '../../../../../../app/api/admin/orders/route';
import { GET as getUsers } from '../../../../../../app/api/admin/users/route';
import { GET as getUserStats } from '../../../../../../app/api/admin/user-stats/route';

const operatorId = '423e4567-e89b-42d3-a456-426614174001';
const requestId = '623e4567-e89b-42d3-a456-426614174003';
const leadRow = {
    inputAt: '2026-11-19T05:05:00.000+00:00',
    mappingStatus: 'authenticated_user',
    userName: '김민연',
    attributionLabel: 'UTM: 인스타그램',
    targetInstagramId: 'target.account',
    excludedInstagramId: 'excluded.account',
    preflightId: '923e4567-e89b-42d3-a456-426614174006',
    preflightStatus: 'failed',
    preflightStage: 'profile',
    preflightErrorCode: 'TARGET_PRIVATE',
    preflightOutcomeAt: '2026-11-19T05:06:00.000+00:00',
    preflightFollowersCount: null,
    preflightFollowingCount: null,
    preflightIsPrivate: null,
    preflightRequiredPlanId: null,
    preflightScreenAvailable: false,
    cursorCreatedAt: '2026-11-19T05:05:00.000+00:00',
    cursorId: '723e4567-e89b-42d3-a456-426614174004',
};

describe('operator console routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('AMPLITUDE_SECRET_KEY', '');
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: operatorId } }, error: null });
        mocks.decision.mockReturnValue('authorized');
    });

    it('rejects a missing session, a non-operator, and an unavailable allowlist before any RPC', async () => {
        mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
        expect((await getOverview()).status).toBe(401);
        mocks.decision.mockReturnValueOnce('forbidden');
        expect((await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs'))).status).toBe(403);
        mocks.decision.mockReturnValueOnce('unavailable');
        expect((await getOrderCustomers(new Request(`https://example.test/api/admin/order-customers?requestId=${requestId}`))).status).toBe(503);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('returns lead inputs with a next-page cursor and private caching', async () => {
        mocks.rpc.mockResolvedValue({ data: { rows: [leadRow, { ...leadRow, cursorId: '823e4567-e89b-42d3-a456-426614174005' }] }, error: null });
        const response = await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?pageSize=1&instagramId=%40Excluded.Account'));
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        const body = await response.json();
        expect(body.rows).toHaveLength(1);
        expect(body.rows[0]).toMatchObject({
            inputAt: leadRow.inputAt, mappingStatus: 'authenticated_user', userName: '김민연',
            attributionLabel: 'UTM: 인스타그램', targetInstagramId: 'target.account', excludedInstagramId: 'excluded.account',
            preflightStatus: 'failed', preflightErrorCode: 'TARGET_PRIVATE', preflightScreenAvailable: false,
        });
        expect(body.rows[0]).not.toHaveProperty('cursorId');
        expect(typeof body.nextCursor).toBe('string');
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_lead_inputs', expect.objectContaining({
            p_instagram_id: 'excluded.account', p_page_size: 2,
        }));
    });

    it('rejects unknown lead query keys and tampered cursors', async () => {
        expect((await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?context=target'))).status).toBe(400);
        expect((await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?preflightStatus=done'))).status).toBe(400);
        expect((await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?cursor=bogus'))).status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('validates order customer ids and normalizes gender', async () => {
        expect((await getOrderCustomers(new Request('https://example.test/api/admin/order-customers?requestId=nope'))).status).toBe(400);
        mocks.rpc.mockResolvedValue({ data: { rows: [{
            requestId, userName: '김민연', gender: 'female', birthyear: '1997', deviceLabel: 'iPhone · Safari',
            attributionLabel: '직접 방문', paidAmountKrw: 14900,
        }] }, error: null });
        const response = await getOrderCustomers(new Request(`https://example.test/api/admin/order-customers?requestId=${requestId}&requestId=${requestId}`));
        expect(response.status).toBe(200);
        expect((await response.json()).rows[0]).toMatchObject({ gender: '여성', paidAmountKrw: 14900 });
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_order_customers', { p_request_ids: [requestId] });
    });

    it('serves the overview with unknown visitors when Amplitude is not configured', async () => {
        const bucket = (start: string) => ({
            start, payers: 1, basicPayers: 0, standardPayers: 1, knownCostUsd: 1, conservativeCostUsd: 1.2,
            preflightCostUsd: 0.2, analysisCostUsd: 0.6, aiCostUsd: 0.2, unsettledCalls: 1,
        });
        mocks.rpc.mockResolvedValue({ data: {
            signups: { total: 10, today: 1, last7Days: 4 },
            payersSinceConversion: 2,
            daily: Array.from({ length: 14 }, (_, i) => bucket(`2026-11-${String(6 + i).padStart(2, '0')}`)),
            weekly: Array.from({ length: 8 }, (_, i) => bucket(`2026-10-${String(1 + i).padStart(2, '0')}`)),
        }, error: null });
        const response = await getOverview();
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.visitorSource).toBe('unavailable');
        expect(body.conversion).toEqual({ payers: 2, visitors: null, ratePercent: null });
        expect(body.today.start).toBe('2026-11-19');
    });

    it('fails closed when the overview RPC errors', async () => {
        mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
        expect((await getOverview()).status).toBe(503);
    });

    it('lists paid orders with a cursor and normalized gender', async () => {
        const order = (id: string) => ({
            orderId: id, requestId: null, orderStatus: 'completed', planId: 'basic', targetInstagramId: 't.one',
            excludedInstagramId: null, paidAt: '2026-08-30T10:00:00+00:00', paidAmountKrw: 14900, userName: '이현준',
            gender: 'male', birthyear: '1994', attributionLabel: null, deviceLabel: null, bundle: null,
            costSnapshot: { knownUsd: 0.8, conservativeUsd: 1, complete: false, usageUnknown: false },
            cursorPaidAt: '2026-08-30T10:00:00+00:00', cursorId: id,
        });
        mocks.rpc.mockResolvedValue({ data: { rows: [order('30000000-0000-4000-8000-000000000001'), order('30000000-0000-4000-8000-000000000002')] }, error: null });
        const response = await getOrders(new Request('https://example.test/api/admin/orders?pageSize=1'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows).toHaveLength(1);
        expect(body.rows[0]).toMatchObject({ gender: '남성', costSnapshot: { knownUsd: 0.8 } });
        expect(body.rows[0]).not.toHaveProperty('cursorId');
        expect(typeof body.nextCursor).toBe('string');
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_orders', { p_cursor_paid_at: null, p_cursor_id: null, p_page_size: 2 });
        expect((await getOrders(new Request('https://example.test/api/admin/orders?cursor=bogus'))).status).toBe(400);
        expect((await getOrders(new Request('https://example.test/api/admin/orders?status=paid'))).status).toBe(400);
    });

    it('returns every user column without the internal cursor field', async () => {
        mocks.rpc.mockResolvedValue({ data: { rows: [{
            id: '10000000-0000-4000-8000-000000000001', email: 'a@x.kr', name: '김민연', phone_number: '010-1111-2222',
            is_paid_user: true, paid_order_count: 2, cursor_created_at: '2026-11-19T01:00:00+00:00',
        }] }, error: null });
        const response = await getUsers(new Request('https://example.test/api/admin/users?search=%20%EA%B9%80%20'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.rows[0]).toEqual({ id: '10000000-0000-4000-8000-000000000001', email: 'a@x.kr', name: '김민연', phone_number: '010-1111-2222', is_paid_user: true, paid_order_count: 2 });
        expect(body.nextCursor).toBeNull();
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_users', expect.objectContaining({ p_search: '김', p_page_size: 26 }));
        mocks.decision.mockReturnValueOnce('forbidden');
        expect((await getUsers(new Request('https://example.test/api/admin/users'))).status).toBe(403);
    });

    it('forwards the preflight status filter to the lead RPC', async () => {
        mocks.rpc.mockResolvedValue({ data: { rows: [] }, error: null });
        const response = await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?preflightStatus=not_requested'));
        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_lead_inputs', expect.objectContaining({ p_preflight_status: 'not_requested' }));
    });

    it('serves user demographics and daily signups', async () => {
        mocks.rpc.mockResolvedValue({ data: {
            total: 3, paidUsers: 1,
            byGenderAge: [{ gender: 'female', ageBand: '25_29', users: 1, paidUsers: 1 }],
            bySource: [{ source: 'UTM: 인스타그램', users: 1, paidUsers: 1 }],
            daily: [{ day: '2026-11-19', signups: 1 }],
        }, error: null });
        const response = await getUserStats();
        expect(response.status).toBe(200);
        expect((await response.json()).byGenderAge[0]).toEqual({ gender: 'female', ageBand: '25_29', users: 1, paidUsers: 1 });
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_user_stats', expect.objectContaining({ p_days: 30 }));
        mocks.rpc.mockResolvedValue({ data: { total: 'x' }, error: null });
        expect((await getUserStats()).status).toBe(503);
    });
});
