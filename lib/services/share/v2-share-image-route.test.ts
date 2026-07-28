import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    resolve: vi.fn(),
    read: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));
vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolve,
    readAnalysisV2ResultImageObject: mocks.read,
}));

import { GET } from '@/app/api/share/[token]/image/route';

const token = 'a'.repeat(64);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const locator = {
    source: 'r2' as const,
    objectKey: `v1/${'b'.repeat(32)}/female/${'c'.repeat(32)}.webp`,
    sha256: 'd'.repeat(64),
    byteSize: 4,
    expiresAt: '2026-08-28T00:00:00.000Z',
};

function record(value: Record<string, unknown> | null) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: value, error: null });
    return chain;
}

function context(rawToken = token) {
    return { params: Promise.resolve({ token: rawToken }) };
}

describe('V2 shared result image route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.from.mockReturnValue(record({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_enabled: true,
        }));
        mocks.resolve.mockResolvedValue(locator);
        mocks.read.mockResolvedValue(Buffer.from([1, 2, 3, 4]));
    });

    it('reads an exact token-bound result image from private R2', async () => {
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/image`
                + '?kind=female&candidateId=candidate%3Aone'
            ),
            context()
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.arrayBuffer()).toEqual(
            Uint8Array.from([1, 2, 3, 4]).buffer
        );
        expect(mocks.resolve).toHaveBeenCalledWith(
            {
                requestId,
                kind: 'female',
                candidateId: 'candidate:one',
            },
            userId
        );
        expect(mocks.read).toHaveBeenCalledWith(locator);
    });

    it('fails closed before storage for inactive and future-pipeline tokens', async () => {
        for (const value of [
            null,
            {
                id: requestId,
                user_id: userId,
                pipeline_version: 'v3',
                status: 'completed',
                share_enabled: true,
            },
        ]) {
            mocks.from.mockReturnValueOnce(record(value));
            const response = await GET(
                new Request(
                    `https://example.com/api/share/${token}/image?kind=target`
                ),
                context()
            );
            expect(response.status).toBe(404);
        }
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it.each([
        '?kind=female',
        '?kind=target&candidateId=unexpected',
        '?kind=unknown',
        '?kind=target&extra=1',
    ])('rejects a malformed locator: %s', async query => {
        const response = await GET(
            new Request(`https://example.com/api/share/${token}/image${query}`),
            context()
        );
        expect(response.status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('returns a text-free placeholder with status 200 when R2 is unavailable', async () => {
        mocks.read.mockRejectedValue(new Error('unavailable'));
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/image?kind=target`
            ),
            context()
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('image/svg+xml');
        expect(await response.text()).not.toContain(token);
    });
});
