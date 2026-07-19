import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ insertLandingLead: vi.fn() }));
vi.mock('@/lib/services/leads/store', () => ({
    insertLandingLead: mocks.insertLandingLead,
    LeadPersistenceError: class LeadPersistenceError extends Error {},
}));

import { POST } from '@/app/api/leads/route';

function request(body: unknown, {
    origin = 'https://example.com',
    contentType = 'application/json',
    userAgent = 'UA',
}: { origin?: string | null; contentType?: string | null; userAgent?: string } = {}): Request {
    const headers = new Headers();
    if (origin !== null) headers.set('origin', origin);
    if (contentType !== null) headers.set('content-type', contentType);
    headers.set('user-agent', userAgent);
    return new Request('https://example.com/api/leads', {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

beforeEach(() => {
    mocks.insertLandingLead.mockReset();
    mocks.insertLandingLead.mockResolvedValue(undefined);
});

describe('POST /api/leads', () => {
    it('rejects cross-origin requests with 403', async () => {
        const res = await POST(request({ instagramId: 'suzy' }, { origin: 'https://evil.com' }));
        expect(res.status).toBe(403);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('rejects non-JSON with 415', async () => {
        const res = await POST(request({ instagramId: 'suzy' }, { contentType: 'text/plain' }));
        expect(res.status).toBe(415);
    });

    it('rejects invalid body with 400', async () => {
        const res = await POST(request({}, {}));
        expect(res.status).toBe(400);
    });

    it('rejects an un-normalizable instagram id with 400', async () => {
        const res = await POST(request({ instagramId: 'bad name' }, {}));
        expect(res.status).toBe(400);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('stores a normalized lead with attribution + user agent and returns 201', async () => {
        const res = await POST(request({
            instagramId: '@Suzy_Kim.02',
            rawInput: '@Suzy_Kim.02',
            attribution: { source: 'instagram', medium: 'cpc' },
            referrer: 'https://ref',
        }, { userAgent: 'MyUA' }));
        expect(res.status).toBe(201);
        expect(mocks.insertLandingLead).toHaveBeenCalledWith(expect.objectContaining({
            instagramId: 'suzy_kim.02',
            rawInput: '@Suzy_Kim.02',
            utmSource: 'instagram',
            utmMedium: 'cpc',
            referrer: 'https://ref',
            userAgent: 'MyUA',
        }));
    });

    it('returns 503 when persistence fails', async () => {
        mocks.insertLandingLead.mockRejectedValue(new Error('down'));
        const res = await POST(request({ instagramId: 'suzy' }, {}));
        expect(res.status).toBe(503);
    });
});
