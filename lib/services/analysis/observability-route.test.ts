import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import { GET } from '@/app/api/admin/analysis-observability/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function request(query = `requestId=${requestId}`, authorization = 'Bearer admin-secret') {
    return new Request(`https://example.com/api/admin/analysis-observability?${query}`, {
        headers: { authorization },
    });
}

function installQueryMocks() {
    const summary = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    };
    summary.select.mockReturnValue(summary);
    summary.eq.mockReturnValue(summary);
    summary.maybeSingle.mockResolvedValue({
        data: { request_id: requestId, known_total_cost_usd: '1.25' },
        error: null,
    });

    const events = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
    };
    events.select.mockReturnValue(events);
    events.eq.mockReturnValue(events);
    events.order.mockReturnValue(events);
    events.limit.mockResolvedValue({
        data: [{ id: 'event-id', step: 'collect', event_type: 'completed' }],
        error: null,
    });

    mocks.from.mockImplementation((table: string) => (
        table === 'analysis_operational_cost_summary' ? summary : events
    ));
}

describe('analysis observability admin route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ADMIN_API_KEY = 'admin-secret';
    });

    afterEach(() => {
        delete process.env.ADMIN_API_KEY;
    });

    it('requires the admin bearer token', async () => {
        const response = await GET(request(undefined, 'Bearer wrong'));
        expect(response.status).toBe(401);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('rejects malformed request IDs before querying', async () => {
        const response = await GET(request('requestId=../../secret'));
        expect(response.status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('returns the cost rollup and PII-free step history', async () => {
        installQueryMocks();
        const response = await GET(request());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            summary: { request_id: requestId, known_total_cost_usd: '1.25' },
            events: [{ step: 'collect', event_type: 'completed' }],
            costPolicy: {
                scraperEstimateIsDiagnosticOnly: true,
                gcpInfrastructureIncluded: false,
            },
        });
    });
});

