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

const operatorId = '423e4567-e89b-42d3-a456-426614174001';
const requestId = '623e4567-e89b-42d3-a456-426614174003';
const leadRow = {
    inputAt: '2026-11-19T05:05:00.000+00:00',
    mappingStatus: 'authenticated_user',
    userName: '김민연',
    attributionLabel: 'UTM: 인스타그램',
    targetInstagramId: 'target.account',
    excludedInstagramId: 'excluded.account',
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
        expect(body.rows).toEqual([{
            inputAt: leadRow.inputAt, mappingStatus: 'authenticated_user', userName: '김민연',
            attributionLabel: 'UTM: 인스타그램', targetInstagramId: 'target.account', excludedInstagramId: 'excluded.account',
        }]);
        expect(typeof body.nextCursor).toBe('string');
        expect(mocks.rpc).toHaveBeenCalledWith('load_admin_lead_inputs', expect.objectContaining({
            p_instagram_id: 'excluded.account', p_page_size: 2,
        }));
    });

    it('rejects unknown lead query keys and tampered cursors', async () => {
        expect((await getLeadInputs(new Request('https://example.test/api/admin/lead-inputs?context=target'))).status).toBe(400);
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
});
