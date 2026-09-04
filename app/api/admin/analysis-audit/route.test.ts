import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    getAnalysisAuditOperatorDecision: vi.fn(),
    parseAnalysisAuditQuery: vi.fn(),
    loadAnalysisScoreAudit: vi.fn(),
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
        parseAnalysisAuditQuery: routeMocks.parseAnalysisAuditQuery,
        loadAnalysisScoreAudit: routeMocks.loadAnalysisScoreAudit,
    };
});

import { GET } from './route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '423e4567-e89b-42d3-a456-426614174001';
const query = { requestId, cursor: 0, pageSize: 25 };

function request(search = '') {
    return new Request(`https://example.test/api/admin/analysis-audit${search}`);
}

beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.createClient.mockResolvedValue({
        auth: { getUser: routeMocks.getUser },
    });
    routeMocks.getUser.mockResolvedValue({
        data: { user: { id: userId } },
        error: null,
    });
    routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('authorized');
    routeMocks.parseAnalysisAuditQuery.mockReturnValue(query);
    routeMocks.loadAnalysisScoreAudit.mockResolvedValue({
        request: { requestId, status: 'ready' },
        rows: [],
        nextCursor: null,
        officialGroupCount: 0,
    });
});

describe('legacy analysis-audit route auth and failure classification', () => {
    it('returns 401 for a missing session with private no-store headers', async () => {
        routeMocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisScoreAudit).not.toHaveBeenCalled();
    });

    it('returns 401 for a recognized invalid JWT auth error', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthInvalidJwtError', status: 400 },
        });

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 503 for an unknown auth error despite a deceptive token message', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: {
                status: 400,
                code: 'unknown_auth_failure',
                message: 'invalid token endpoint unavailable',
            },
        });

        const response = await GET(request());

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 503 for createClient or getUser infrastructure failures', async () => {
        routeMocks.createClient.mockRejectedValue(new Error('auth transport secret'));
        const clientFailure = await GET(request());
        expect(clientFailure.status).toBe(503);
        expect(await clientFailure.json()).toEqual({ error: 'Authentication unavailable' });

        routeMocks.createClient.mockResolvedValue({
            auth: { getUser: vi.fn().mockRejectedValue(new Error('auth transport secret')) },
        });
        const getUserFailure = await GET(request());
        expect(getUserFailure.status).toBe(503);
        expect(await getUserFailure.json()).toEqual({ error: 'Authentication unavailable' });
    });

    it('returns 401 for an authenticated user with a malformed id', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: { id: 'not-a-uuid' } },
            error: null,
        });

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.getAnalysisAuditOperatorDecision).not.toHaveBeenCalled();
    });

    it('returns 403 for an authenticated non-operator', async () => {
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('forbidden');

        const response = await GET(request());

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 503 when the operator allowlist is unavailable', async () => {
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('unavailable');

        const response = await GET(request());

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisScoreAudit).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid query without leaking parser details', async () => {
        routeMocks.parseAnalysisAuditQuery.mockImplementation(() => {
            throw new Error('ZOD_PRIVATE_DETAILS');
        });

        const response = await GET(request('?requestId=not-a-uuid'));
        const body = await response.text();

        expect(response.status).toBe(400);
        expect(JSON.parse(body)).toEqual({ error: 'Invalid audit request' });
        expect(body).not.toContain('ZOD_PRIVATE_DETAILS');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadAnalysisScoreAudit).not.toHaveBeenCalled();
    });

    it('returns 404 when the audit service has no matching request', async () => {
        routeMocks.loadAnalysisScoreAudit.mockResolvedValue(null);

        const response = await GET(request());

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns 503 for service or RPC failures without exposing details', async () => {
        routeMocks.loadAnalysisScoreAudit.mockRejectedValue(
            new Error('ANALYSIS_AUDIT_LOAD_FAILED: provider secret'),
        );

        const response = await GET(request());
        const body = await response.text();

        expect(response.status).toBe(503);
        expect(JSON.parse(body)).toEqual({ error: 'Audit service unavailable' });
        expect(body).not.toContain('provider secret');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns the bounded payload with private no-store headers', async () => {
        const response = await GET(request());

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            request: { requestId, status: 'ready' },
            rows: [],
            nextCursor: null,
            officialGroupCount: 0,
        });
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
});
