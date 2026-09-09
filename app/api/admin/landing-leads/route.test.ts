import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    getAnalysisAuditOperatorDecision: vi.fn(),
    loadLandingLeadAdminProjection: vi.fn(),
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
vi.mock('@/lib/services/landing/landing-lead-journey', async () => {
    const actual = await vi.importActual<typeof import('@/lib/services/landing/landing-lead-journey')>(
        '@/lib/services/landing/landing-lead-journey',
    );
    return {
        ...actual,
        loadLandingLeadAdminProjection: routeMocks.loadLandingLeadAdminProjection,
    };
});

import { GET } from './route';

const userId = '423e4567-e89b-42d3-a456-426614174001';
const internalId = '523e4567-e89b-42d3-a456-426614174002';
const safeRow = {
    instagramId: 'target.account',
    inputContext: 'target' as const,
    mappingStatus: 'anonymous_device' as const,
    rowCountInJourney: 2,
    firstSeenAt: '2026-09-05T08:00:00.000Z',
    lastSeenAt: '2026-09-05T08:01:00.000Z',
};

function request(search = ''): Request {
    return new Request(`https://example.test/api/admin/landing-leads${search}`);
}

describe('operator landing-lead list route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routeMocks.createClient.mockResolvedValue({ auth: { getUser: routeMocks.getUser } });
        routeMocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('authorized');
        routeMocks.loadLandingLeadAdminProjection.mockResolvedValue({
            rows: [safeRow],
            nextCursor: 'opaque-signed-cursor',
        });
    });

    it('uses cookie auth, operator authorization, server projection, and private no-store', async () => {
        const response = await GET(request('?context=target&mappingStatus=anonymous_device&instagramId=%40Target.Account&pageSize=10'));

        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(await response.json()).toEqual({ rows: [safeRow], nextCursor: 'opaque-signed-cursor' });
        expect(routeMocks.getAnalysisAuditOperatorDecision).toHaveBeenCalledWith(userId);
        expect(routeMocks.loadLandingLeadAdminProjection).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                context: 'target',
                mappingStatus: 'anonymous_device',
                instagramId: 'target.account',
                pageSize: 10,
            }),
        );
    });

    it.each([
        ['no session', () => routeMocks.getUser.mockResolvedValue({ data: { user: null }, error: null }), 401],
        ['forbidden', () => routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('forbidden'), 403],
        ['allowlist unavailable', () => routeMocks.getAnalysisAuditOperatorDecision.mockReturnValue('unavailable'), 503],
    ])('returns the stable %s status', async (_label, arrange, expectedStatus) => {
        arrange();
        const response = await GET(request());
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(routeMocks.loadLandingLeadAdminProjection).not.toHaveBeenCalled();
    });

    it('maps auth failures to 401 or 503 without leaking auth details', async () => {
        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 401, code: 'invalid_token' },
        });
        expect((await GET(request())).status).toBe(401);

        routeMocks.getUser.mockResolvedValue({
            data: { user: null },
            error: { name: 'AuthApiError', status: 503, code: 'service_unavailable' },
        });
        const response = await GET(request());
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
    });

    it('rejects unknown, duplicate, invalid, and oversized query values before persistence', async () => {
        for (const search of [
            '?raw_input=secret',
            '?pageSize=51',
            '?pageSize=1&pageSize=2',
            '?context=invalid',
            '?from=2026-09-05',
            '?from=2026-09-06T00:00:00.000Z&to=2026-09-05T00:00:00.000Z',
        ]) {
            const response = await GET(request(search));
            expect(response.status, search).toBe(400);
            expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        }
        expect(routeMocks.loadLandingLeadAdminProjection).not.toHaveBeenCalled();
    });

    it('returns a stable 503 when the projection service fails', async () => {
        routeMocks.loadLandingLeadAdminProjection.mockRejectedValue(
            new Error('LANDING_LEAD_PERSISTENCE_ERROR:secret_internal_details'),
        );
        const response = await GET(request());
        const body = await response.text();
        expect(response.status).toBe(503);
        expect(JSON.parse(body)).toEqual({ error: 'Landing lead service unavailable' });
        expect(body).not.toContain('secret_internal_details');
    });

    it('maps a tampered signed cursor to a client error instead of service unavailable', async () => {
        routeMocks.loadLandingLeadAdminProjection.mockRejectedValue(
            new Error('LANDING_LEAD_CURSOR_INVALID'),
        );

        const response = await GET(request('?cursor=tampered'));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid landing lead request' });
    });

    it('strips projection extras and never returns raw input, hashes, ids, or claim fields', async () => {
        routeMocks.loadLandingLeadAdminProjection.mockResolvedValue({
            rows: [{
                ...safeRow,
                raw_input: 'raw-device-input',
                referrer: 'https://secret.example',
                user_agent: 'secret-agent',
                anonymous_principal_hash: 'a'.repeat(64),
                capture_token_hash: 'b'.repeat(64),
                auth_user_id: userId,
                journey_id: internalId,
                claim: 'authenticated',
                ip: '192.0.2.10',
            }],
            nextCursor: 'opaque-signed-cursor',
        });
        const response = await GET(request());
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(JSON.parse(body)).toEqual({ rows: [safeRow], nextCursor: 'opaque-signed-cursor' });
        for (const forbidden of [
            'raw-device-input', 'https://secret.example', 'secret-agent',
            'anonymous_principal_hash', 'capture_token_hash', internalId,
            userId, 'journey_id', 'claim', '192.0.2.10',
        ]) expect(body).not.toContain(forbidden);
    });
});
