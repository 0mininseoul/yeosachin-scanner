import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const downloadSecureImage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/media/secure-image-fetch', async (importOriginal) => {
    const original = await importOriginal<
        typeof import('@/lib/services/media/secure-image-fetch')
    >();
    return {
        ...original,
        downloadSecureImage,
    };
});

import { GET } from '@/app/api/image-proxy/route';
import { createImageProxyPath } from './image-proxy-token';

const SECRET = 'test-image-proxy-signing-secret-at-least-32-characters';

function signedRequest(rawImageUrl = 'https://cdninstagram.com/photo.jpg?oe=abc') {
    const path = createImageProxyPath(rawImageUrl, { secret: SECRET });
    return new NextRequest(`https://baram-detector.example${path}`);
}

describe('image proxy route authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.IMAGE_PROXY_SIGNING_SECRET = SECRET;
        downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'image/jpeg',
            finalUrl: 'https://cdninstagram.com/photo.jpg?oe=abc',
        });
    });

    it('does not fetch unsigned or tampered URLs', async () => {
        const unsigned = await GET(new NextRequest(
            'https://baram-detector.example/api/image-proxy?url=https%3A%2F%2Fcdninstagram.com%2Fa.jpg'
        ));
        expect(unsigned.status).toBe(400);

        const signed = new URL(signedRequest().url);
        signed.searchParams.set('url', 'https://cdninstagram.com/other.jpg?oe=abc');
        const tampered = await GET(new NextRequest(signed));
        expect(tampered.status).toBe(403);
        expect(downloadSecureImage).not.toHaveBeenCalled();
    });

    it('rejects query additions and alternate serialization before downloading', async () => {
        const extra = new URL(signedRequest().url);
        extra.searchParams.set('cacheBust', '1');
        expect((await GET(new NextRequest(extra))).status).toBe(400);

        const reordered = new URL(signedRequest().url);
        const entries = Array.from(reordered.searchParams.entries()).reverse();
        reordered.search = new URLSearchParams(entries).toString();
        expect((await GET(new NextRequest(reordered))).status).toBe(400);
        expect(downloadSecureImage).not.toHaveBeenCalled();
    });

    it('downloads a signed stored URL with strict size, timeout, and cache limits', async () => {
        const response = await GET(signedRequest());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
        const cacheControl = response.headers.get('cache-control') ?? '';
        const cdnCacheControl = response.headers.get('vercel-cdn-cache-control') ?? '';
        const browserMaxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1]);
        const cdnMaxAge = Number(cdnCacheControl.match(/s-maxage=(\d+)/)?.[1]);
        expect(browserMaxAge).toBeGreaterThan(0);
        expect(browserMaxAge).toBeLessThanOrEqual(30 * 60);
        expect(cdnMaxAge).toBe(browserMaxAge);
        expect(cacheControl).not.toContain('stale-while-revalidate');
        expect(cdnCacheControl).not.toContain('stale-while-revalidate');
        expect(downloadSecureImage).toHaveBeenCalledOnce();
        const [downloadUrl, options] = downloadSecureImage.mock.calls[0];
        expect(downloadUrl).toBe('https://cdninstagram.com/photo.jpg?oe=abc');
        expect(options).toEqual(expect.objectContaining({
            maxBytes: 3 * 1024 * 1024,
        }));
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(4_000);
    });
});
