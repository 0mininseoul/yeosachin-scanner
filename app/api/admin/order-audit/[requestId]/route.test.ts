import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const routeMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    getAnalysisAuditOperatorDecision: vi.fn(),
    parseOrderAuditQuery: vi.fn(),
    loadAnalysisOrderAuditBundle: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: routeMocks.createClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: vi.fn() },
}));
vi.mock('@/lib/services/analysis/score-audit', async () => {
    const actual = await vi.importActual<typeof import('@/lib/services/analysis/score-audit')>(
        '@/lib/services/analysis/score-audit',
    );
    return {
        ...actual,
        getAnalysisAuditOperatorDecision: routeMocks.getAnalysisAuditOperatorDecision,
    };
});
vi.mock('@/lib/services/analysis/order-audit-query', () => ({
    parseOrderAuditQuery: routeMocks.parseOrderAuditQuery,
    loadAnalysisOrderAuditBundle: routeMocks.loadAnalysisOrderAuditBundle,
}));

import { GET } from './route';

const route = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

describe('operator order-audit route contract', () => {
    it('uses cookie session authentication and an environment operator allowlist', () => {
        expect(route).toContain('createClient');
        expect(route).toContain('supabase.auth.getUser()');
        expect(route).toContain('getAnalysisAuditOperatorDecision(user.id)');
        expect(route).toContain("privateJson({ error: 'Unauthorized' }, 401)");
        expect(route).toContain("privateJson({ error: 'Forbidden' }, 403)");
        expect(route).toContain("privateJson({ error: 'Not found' }, 404)");
        expect(route).toContain("'Cache-Control': 'private, no-store'");
    });

    it('parses bounded section/filter pagination and only calls the redacted loader', () => {
        expect(route).toContain('loadAnalysisOrderAuditBundle');
        expect(route).toContain('parseOrderAuditQuery');
        expect(route).toContain('supabaseAdmin');
        expect(route).toContain('section');
        expect(route).toContain('pageSize');
        expect(route).toContain('filter');
        expect(route).not.toContain('analysis_v2_result_summaries');
        expect(route).not.toContain('providerToken');
        expect(route).not.toContain('userId');
    });
});

describe('operator order-audit route responses', () => {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    const query = {
        section: 'summary',
        cursor: 0,
        pageSize: 25,
        filter: 'all',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        routeMocks.createClient.mockResolvedValue({
            auth: { getUser: routeMocks.getUser },
        });
        routeMocks.getUser.mockResolvedValue({
            data: { user: { id: '423e4567-e89b-42d3-a456-426614174001' } },
            error: null,
        });
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('authorized');
        routeMocks.parseOrderAuditQuery.mockReturnValue(query);
        routeMocks.loadAnalysisOrderAuditBundle.mockResolvedValue({
            summary: { status: 'complete' },
            section: 'summary',
            rows: [],
            total: 0,
            nextCursor: null,
        });
    });

    function request() {
        return new Request(`https://example.test/api/admin/order-audit/${requestId}`);
    }

    it('returns 401 for an unauthenticated session', async () => {
        routeMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisOrderAuditBundle).not.toHaveBeenCalled();
    });

    it('returns 401 for an invalid or expired session error', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 401, code: 'invalid_token' },
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 for a returned invalid JWT code', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 400, code: 'invalid_jwt' },
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 for an authentication service error returned by Supabase', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 503, code: 'service_unavailable' },
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
    });

    it('returns 401 when the auth client throws an expired-session error', async () => {
        routeMocks.getUser.mockRejectedValue({
            name: 'AuthApiError',
            status: 401,
            code: 'session_expired',
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 when Supabase throws its typed missing-session error', async () => {
        routeMocks.getUser.mockRejectedValue({
            name: 'AuthSessionMissingError',
            status: 400,
            message: 'Auth session missing!',
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 for a generic authentication client throw', async () => {
        routeMocks.getUser.mockRejectedValue(new Error('invalid token from auth infrastructure'));

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
    });

    it('does not downgrade an infrastructure status that mentions an invalid token', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 500, code: 'invalid_token' },
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
    });

    it('returns 503 for an unknown returned auth error despite a deceptive token message', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: {
                status: 400,
                code: 'unknown_auth_failure',
                message: 'invalid token endpoint unavailable',
            },
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 401 for an authenticated user with a malformed id', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: { id: 'not-a-uuid' } },
            error: null,
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.getAnalysisAuditOperatorDecision).not.toHaveBeenCalled();
    });

    it('returns 403 for an authenticated non-operator', async () => {
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('forbidden');

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 503 when the operator allowlist is unavailable', async () => {
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('unavailable');

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisOrderAuditBundle).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid input without leaking parser details', async () => {
        routeMocks.parseOrderAuditQuery.mockImplementation(() => {
            throw new Error('ZOD_PRIVATE_DETAILS');
        });

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(400);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: 'Invalid audit request' });
        expect(body).not.toContain('ZOD_PRIVATE_DETAILS');
    });

    it('returns 400 for an invalid request UUID before persistence access', async () => {
        const response = await GET(request(), {
            params: Promise.resolve({ requestId: 'not-a-uuid' }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid audit request' });
        expect(routeMocks.loadAnalysisOrderAuditBundle).not.toHaveBeenCalled();
    });

    it('returns 404 for an absent bundle', async () => {
        routeMocks.loadAnalysisOrderAuditBundle.mockResolvedValue(null);

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns a stable 503 for persistence and contract failures', async () => {
        routeMocks.loadAnalysisOrderAuditBundle.mockRejectedValue(
            new Error('ANALYSIS_ORDER_AUDIT_LOAD_FAILED: secret details'),
        );

        const response = await GET(request(), { params: Promise.resolve({ requestId }) });
        const body = await response.json();

        expect(response.status).toBe(503);
        expect(body).toEqual({ error: 'Audit service unavailable' });
        expect(JSON.stringify(body)).not.toContain('secret details');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns the bounded payload with private no-store headers', async () => {
        const response = await GET(request(), { params: Promise.resolve({ requestId }) });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            summary: { status: 'complete' },
            section: 'summary',
            rows: [],
            total: 0,
            nextCursor: null,
        });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
});
