import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const routeMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    isAnalysisAuditOperator: vi.fn(),
    parseOrderAuditListQuery: vi.fn(),
    loadAnalysisOrderAuditList: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: routeMocks.createClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: vi.fn() },
}));
vi.mock('@/lib/services/analysis/score-audit', () => ({
    isAnalysisAuditOperator: routeMocks.isAnalysisAuditOperator,
}));
vi.mock('@/lib/services/analysis/order-audit-list', () => ({
    parseOrderAuditListQuery: routeMocks.parseOrderAuditListQuery,
    loadAnalysisOrderAuditList: routeMocks.loadAnalysisOrderAuditList,
}));

import { GET } from './route';

const route = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const query = {
    pageSize: 25,
    cursorAssembledAt: null,
    cursorRequestId: null,
};

describe('operator order-audit list route contract', () => {
    it('uses cookie session authentication, the operator allowlist, and private no-store responses', () => {
        expect(route).toContain('createClient');
        expect(route).toContain('supabase.auth.getUser()');
        expect(route).toContain('isAnalysisAuditOperator(user.id)');
        expect(route).toContain("privateJson({ error: 'Unauthorized' }, 401)");
        expect(route).toContain("privateJson({ error: 'Forbidden' }, 403)");
        expect(route).toContain("'Cache-Control': 'private, no-store'");
        expect(route).toContain('loadAnalysisOrderAuditList');
        expect(route).toContain('parseOrderAuditListQuery');
        expect(route).toContain('supabaseAdmin');
        expect(route).not.toContain('analysis_order_audit_bundles');
        expect(route).not.toContain('providerToken');
        expect(route).not.toContain('userId');
    });
});

describe('operator order-audit list route responses', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routeMocks.createClient.mockResolvedValue({
            auth: { getUser: routeMocks.getUser },
        });
        routeMocks.getUser.mockResolvedValue({
            data: { user: { id: '423e4567-e89b-42d3-a456-426614174001' } },
            error: null,
        });
        routeMocks.isAnalysisAuditOperator.mockReturnValue(true);
        routeMocks.parseOrderAuditListQuery.mockReturnValue(query);
        routeMocks.loadAnalysisOrderAuditList.mockResolvedValue({ rows: [], nextCursor: null });
    });

    function request(search = '') {
        return new Request(`https://example.test/api/admin/order-audit${search}`);
    }

    it('returns an empty bounded page', async () => {
        const response = await GET(request());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ rows: [], nextCursor: null });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisOrderAuditList).toHaveBeenCalledWith(
            expect.anything(),
            query,
        );
    });

    it('returns 401 for an unauthenticated session and does not call the list service', async () => {
        routeMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisOrderAuditList).not.toHaveBeenCalled();
    });

    it('classifies invalid sessions as 401 and auth infrastructure failures as 503', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 401, code: 'invalid_token' },
        });
        const invalid = await GET(request());
        expect(invalid.status).toBe(401);

        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 503, code: 'service_unavailable' },
        });
        const unavailable = await GET(request());
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toEqual({ error: 'Authentication unavailable' });
        expect(unavailable.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 403 for an authenticated non-operator', async () => {
        routeMocks.isAnalysisAuditOperator.mockReturnValue(false);

        const response = await GET(request());

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 400 for invalid input without leaking parser details', async () => {
        routeMocks.parseOrderAuditListQuery.mockImplementation(() => {
            throw new Error('ZOD_PRIVATE_DETAILS');
        });

        const response = await GET(request('?pageSize=51'));
        const body = await response.text();

        expect(response.status).toBe(400);
        expect(JSON.parse(body)).toEqual({ error: 'Invalid audit request' });
        expect(body).not.toContain('ZOD_PRIVATE_DETAILS');
        expect(routeMocks.loadAnalysisOrderAuditList).not.toHaveBeenCalled();
    });

    it('returns a stable 503 for persistence and payload failures', async () => {
        routeMocks.loadAnalysisOrderAuditList.mockRejectedValue(
            new Error('ANALYSIS_ORDER_AUDIT_LIST_PAYLOAD_INVALID: secret details'),
        );

        const response = await GET(request());
        const body = await response.text();

        expect(response.status).toBe(503);
        expect(JSON.parse(body)).toEqual({ error: 'Audit service unavailable' });
        expect(body).not.toContain('secret details');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('passes a bounded list response through without exposing route-level persistence fields', async () => {
        routeMocks.loadAnalysisOrderAuditList.mockResolvedValue({
            rows: [{ requestId, version: 1 }],
            nextCursor: null,
        });

        const response = await GET(request());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            rows: [{ requestId, version: 1 }],
            nextCursor: null,
        });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
});
