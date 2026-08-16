import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    resolve: vi.fn(),
    read: vi.fn(),
    isResultAuthoritativelyPublished: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));
vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolve,
    readAnalysisV2ResultImageObject: mocks.read,
}));
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));

import { GET } from '@/app/api/share/[token]/image/route';
import { createV2ShareImagePath } from './v2-result-share';

const token = 'a'.repeat(64);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const privacySecret = 'share-test-secret-'.repeat(3);
const sourceImage = await sharp({
    create: {
        width: 160,
        height: 160,
        channels: 3,
        background: { r: 160, g: 80, b: 40 },
    },
}).webp({ quality: 90 }).toBuffer();
const locator = {
    source: 'r2' as const,
    objectKey: `v1/${'b'.repeat(32)}/female/${'c'.repeat(32)}.webp`,
    sha256: 'd'.repeat(64),
    byteSize: sourceImage.byteLength,
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
        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', privacySecret);
        mocks.from.mockReturnValue(record({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'completed',
            share_enabled: true,
        }));
        mocks.resolve.mockResolvedValue(locator);
        mocks.read.mockResolvedValue(sourceImage);
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
    });

    it('serves an irreversibly downsampled token-bound image from private R2', async () => {
        const imagePath = createV2ShareImagePath(token, {
            requestId,
            kind: 'female',
            candidateId: 'candidate:one',
        });
        const response = await GET(
            new Request(
                `https://example.com${imagePath}`
            ),
            context()
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        expect(response.headers.get('cache-control')).toContain('no-store');
        const output = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(output).metadata();
        expect(output).not.toEqual(sourceImage);
        expect(output.byteLength).toBeLessThan(sourceImage.byteLength);
        expect(metadata.width).toBeLessThanOrEqual(24);
        expect(metadata.height).toBeLessThanOrEqual(24);
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

    it('leaves the analysis target undegraded', async () => {
        /* The target is who the owner set out to share: their name heads the
           page and their face fills the card image. Degrading them here bought
           no privacy and only made the header look broken. */
        const response = await GET(
            new Request(`https://example.com/api/share/${token}/image?kind=target`),
            context()
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        const output = Buffer.from(await response.arrayBuffer());
        expect(output).toEqual(sourceImage);
    });

    it('rejects raw candidate ids in the public image URL', async () => {
        const response = await GET(
            new Request(
                `https://example.com/api/share/${token}/image`
                + '?kind=female&candidateId=candidate%3Aone'
            ),
            context()
        );

        expect(response.status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
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
