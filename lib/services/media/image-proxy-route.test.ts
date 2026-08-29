import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    downloadSecureImage: vi.fn(),
    resolveResultImage: vi.fn(),
    readResultImageObject: vi.fn(),
    createClient: vi.fn(),
    getUser: vi.fn(),
    isResultAuthoritativelyPublished: vi.fn(),
    readImageProxyCacheObject: vi.fn(),
    writeImageProxyCacheObject: vi.fn(),
}));

vi.mock('@/lib/services/media/secure-image-fetch', async (importOriginal) => {
    const original = await importOriginal<
        typeof import('@/lib/services/media/secure-image-fetch')
    >();
    return {
        ...original,
        downloadSecureImage: mocks.downloadSecureImage,
    };
});

vi.mock('@/lib/services/media/result-image-resolver', () => ({
    resolveAnalysisV2ResultImageLocator: mocks.resolveResultImage,
    readAnalysisV2ResultImageObject: mocks.readResultImageObject,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));
vi.mock('@/lib/services/media/image-proxy-cache', async (importOriginal) => {
    const original = await importOriginal<
        typeof import('@/lib/services/media/image-proxy-cache')
    >();
    return {
        ...original,
        readImageProxyCacheObject: mocks.readImageProxyCacheObject,
        writeImageProxyCacheObject: mocks.writeImageProxyCacheObject,
    };
});

import { GET } from '@/app/api/image-proxy/route';
import {
    createAnalysisV2ResultImageProxyPath,
    createImageProxyPath,
} from './image-proxy-token';

const SECRET = 'test-image-proxy-signing-secret-at-least-32-characters';

function signedRequest(rawImageUrl = 'https://cdninstagram.com/photo.jpg?oe=abc') {
    const path = createImageProxyPath(rawImageUrl, { secret: SECRET });
    return new NextRequest(`https://baram-detector.example${path}`);
}

function signedResultRequest() {
    const path = createAnalysisV2ResultImageProxyPath({
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'female',
        candidateId: 'candidate-1',
    }, { secret: SECRET });
    return new NextRequest(`https://baram-detector.example${path}`);
}

describe('image proxy route authorization', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.IMAGE_PROXY_SIGNING_SECRET = SECRET;
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: '223e4567-e89b-42d3-a456-426614174000' } },
            error: null,
        });
        mocks.downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'image/jpeg',
            finalUrl: 'https://cdninstagram.com/photo.jpg?oe=abc',
        });
        mocks.resolveResultImage.mockResolvedValue({
            source: 'legacy_url',
            url: 'https://cdninstagram.com/result-photo.jpg?oe=abc',
        });
        mocks.readResultImageObject.mockResolvedValue(
            Buffer.from([7, 8, 9])
        );
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
        mocks.readImageProxyCacheObject.mockResolvedValue(null);
        mocks.writeImageProxyCacheObject.mockResolvedValue(undefined);
        delete process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED;
    });

    it('does not fetch unsigned or tampered URLs', async () => {
        const unsigned = await GET(new NextRequest(
            'https://baram-detector.example/api/image-proxy?url=https%3A%2F%2Fcdninstagram.com%2Fa.jpg'
        ));
        expect(unsigned.status).toBe(400);

        const signed = new URL(signedRequest().url);
        const token = signed.searchParams.get('token')!;
        signed.searchParams.set(
            'token',
            `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
        );
        const tampered = await GET(new NextRequest(signed));
        expect(tampered.status).toBe(403);
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('rejects query additions and alternate serialization before downloading', async () => {
        const extra = new URL(signedRequest().url);
        extra.searchParams.set('cacheBust', '1');
        expect((await GET(new NextRequest(extra))).status).toBe(400);

        const reordered = new URL(signedRequest().url);
        const entries = Array.from(reordered.searchParams.entries()).reverse();
        reordered.search = new URLSearchParams(entries).toString();
        expect((await GET(new NextRequest(reordered))).status).toBe(400);
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('downloads a signed stored URL with strict size, timeout, and cache limits', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        try {
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
            expect(mocks.downloadSecureImage).toHaveBeenCalled();
            const [downloadUrl, options] = mocks.downloadSecureImage.mock.calls[0];
            expect(downloadUrl).toBe('https://cdninstagram.com/photo.jpg?oe=abc');
            expect(options).toEqual(expect.objectContaining({
                maxBytes: 3 * 1024 * 1024,
            }));
            expect(options.timeoutMs).toBeGreaterThan(0);
            expect(options.timeoutMs).toBeLessThanOrEqual(4_000);
            expect(info.mock.calls.some(([, details]) => (
                (details as { source?: string } | undefined)?.source === 'direct'
            ))).toBe(true);
        } finally {
            info.mockRestore();
        }
    });

    it('resolves a compact result locator without exposing the stored CDN URL', async () => {
        const request = signedResultRequest();
        expect(request.url).not.toContain('cdninstagram.com');
        expect(request.url.length).toBeLessThan(512);

        const response = await GET(request);

        expect(response.status).toBe(200);
        expect(mocks.resolveResultImage).toHaveBeenCalledWith({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            kind: 'female',
            candidateId: 'candidate-1',
        }, '223e4567-e89b-42d3-a456-426614174000');
        expect(mocks.downloadSecureImage).toHaveBeenCalledWith(
            'https://cdninstagram.com/result-photo.jpg?oe=abc',
            expect.any(Object)
        );
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('vercel-cdn-cache-control')).toBe('private, no-store');
        expect(response.headers.get('vary')).toBe('Cookie');
    });

    it('requires an authenticated owner before resolving a result image', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(403);
        expect(mocks.resolveResultImage).not.toHaveBeenCalled();
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('rejects a result image token when the paid publication is still pending', async () => {
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(false);

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(403);
        expect(mocks.isResultAuthoritativelyPublished).toHaveBeenCalledWith(
            '123e4567-e89b-42d3-a456-426614174000'
        );
        expect(mocks.resolveResultImage).not.toHaveBeenCalled();
    });

    it('never sends an owner-scoped result CDN URL to the third-party fallback', async () => {
        mocks.downloadSecureImage.mockRejectedValueOnce(new Error('origin unavailable'));

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.downloadSecureImage).toHaveBeenCalledOnce();
        expect(mocks.downloadSecureImage.mock.calls[0]?.[0])
            .toBe('https://cdninstagram.com/result-photo.jpg?oe=abc');
    });

    it('serves an integrity-verified owner R2 object without any remote fallback', async () => {
        mocks.resolveResultImage.mockResolvedValueOnce({
            source: 'r2',
            objectKey:
                `v1/${'a'.repeat(32)}/female/${'b'.repeat(32)}.webp`,
            sha256: 'c'.repeat(64),
            byteSize: 3,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        expect(response.headers.get('cache-control'))
            .toMatch(/^private, max-age=\d+, must-revalidate$/);
        expect(response.headers.get('vercel-cdn-cache-control'))
            .toBe('private, no-store');
        expect(response.headers.get('vary')).toBe('Cookie');
        expect(mocks.readResultImageObject).toHaveBeenCalledOnce();
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('returns a retryable private error after an R2 read failure without raw fallback', async () => {
        mocks.resolveResultImage.mockResolvedValueOnce({
            source: 'r2',
            objectKey:
                `v1/${'a'.repeat(32)}/female/${'b'.repeat(32)}.webp`,
            sha256: 'c'.repeat(64),
            byteSize: 3,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        mocks.readResultImageObject.mockRejectedValueOnce(
            new Error('bucket and key must stay private')
        );

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(503);
        expect(response.headers.get('content-type'))
            .toContain('application/json');
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('retains the trusted compatibility fallback for generic signed images', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.downloadSecureImage
            .mockRejectedValueOnce(new Error('origin unavailable'))
            .mockResolvedValueOnce({
                bytes: Buffer.from([4, 5, 6]),
                contentType: 'image/jpeg',
                finalUrl: 'https://images.weserv.nl/proxied.jpg',
            });

        try {
            const response = await GET(signedRequest());

            expect(response.status).toBe(200);
            expect(mocks.createClient).not.toHaveBeenCalled();
            expect(mocks.downloadSecureImage).toHaveBeenCalledTimes(2);
            expect(mocks.downloadSecureImage.mock.calls[1]?.[0])
                .toContain('https://images.weserv.nl/?url=');
            const trustedProxyUrl = new URL(mocks.downloadSecureImage.mock.calls[1]?.[0]);
            expect(trustedProxyUrl.searchParams.has('default')).toBe(false);
            expect(info.mock.calls.some(([, details]) => (
                (details as { source?: string } | undefined)?.source === 'trusted_proxy'
            ))).toBe(true);
            expect(warning).not.toHaveBeenCalled();
        } finally {
            info.mockRestore();
            warning.mockRestore();
        }
    });

    it('recovers through the trusted proxy after the direct source times out', async () => {
        vi.useFakeTimers();
        mocks.downloadSecureImage.mockImplementation((url: string) => {
            if (url.startsWith('https://images.weserv.nl/')) {
                return new Promise(resolve => {
                    setTimeout(() => resolve({
                        bytes: Buffer.from([4, 5, 6]),
                        contentType: 'image/jpeg',
                        finalUrl: 'https://images.weserv.nl/proxied.jpg',
                    }), 4_500);
                });
            }
            return new Promise(() => undefined);
        });

        const responsePromise = GET(signedRequest());
        await vi.advanceTimersByTimeAsync(4_500);
        const response = await responsePromise;

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
        expect(mocks.downloadSecureImage).toHaveBeenCalledTimes(2);
    });

    it('rejects SVG payloads instead of treating placeholder art as a successful image', async () => {
        mocks.downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'),
            contentType: 'image/svg+xml',
            finalUrl: 'https://images.weserv.nl/placeholder.svg',
        });

        const response = await GET(signedRequest());

        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('cache-control')).toContain('no-store');
    });
});

describe('image proxy R2 cache (CONCIERGE_IMAGE_PROXY_CACHE_ENABLED)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.IMAGE_PROXY_SIGNING_SECRET = SECRET;
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: '223e4567-e89b-42d3-a456-426614174000' } },
            error: null,
        });
        mocks.resolveResultImage.mockResolvedValue({
            source: 'legacy_url',
            url: 'https://cdninstagram.com/result-photo.jpg?oe=abc',
        });
        mocks.readResultImageObject.mockResolvedValue(Buffer.from([7, 8, 9]));
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
        mocks.readImageProxyCacheObject.mockResolvedValue(null);
        mocks.writeImageProxyCacheObject.mockResolvedValue(undefined);
    });

    it('off (default): never touches the cache helper even on a direct-fetch failure', async () => {
        delete process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED;
        mocks.downloadSecureImage.mockRejectedValue(new Error('origin unavailable'));

        const response = await GET(signedRequest());

        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(mocks.readImageProxyCacheObject).not.toHaveBeenCalled();
        expect(mocks.writeImageProxyCacheObject).not.toHaveBeenCalled();
    });

    it('off (default): a successful direct fetch never triggers a cache write', async () => {
        delete process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED;
        mocks.downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'image/jpeg',
            finalUrl: 'https://cdninstagram.com/photo.jpg?oe=abc',
        });

        const response = await GET(signedRequest());

        expect(response.status).toBe(200);
        expect(mocks.writeImageProxyCacheObject).not.toHaveBeenCalled();
    });

    it('on: writes the fetched bytes to the cache (keyed by origin+pathname) after a successful direct fetch', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'image/jpeg',
            finalUrl: 'https://cdninstagram.com/photo.jpg?oe=abc',
        });

        const response = await GET(signedRequest('https://cdninstagram.com/photo.jpg?oe=abc'));
        // The write is fire-and-forget; let its microtask run before asserting.
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(response.status).toBe(200);
        expect(mocks.writeImageProxyCacheObject).toHaveBeenCalledOnce();
        const [cacheKey, bytes, contentType] = mocks.writeImageProxyCacheObject.mock.calls[0]!;
        expect(cacheKey).toEqual(expect.any(String));
        expect(bytes).toEqual(Buffer.from([1, 2, 3]));
        expect(contentType).toBe('image/jpeg');
    });

    it('on: serves the cached bytes when the direct fetch fails (e.g. an expired signed URL), instead of falling through to the third-party proxy', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage.mockRejectedValue(new Error('403 expired signature'));
        mocks.readImageProxyCacheObject.mockResolvedValue({
            bytes: Buffer.from([9, 9, 9]),
            contentType: 'image/webp',
        });

        const response = await GET(signedRequest());
        const body = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        expect(body).toEqual(Buffer.from([9, 9, 9]));
        // Cache hit takes priority - never touches either remote source.
        expect(mocks.downloadSecureImage).not.toHaveBeenCalled();
    });

    it('on: falls back to the trusted proxy chain on a cache miss', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage
            .mockRejectedValueOnce(new Error('403 expired signature'))
            .mockResolvedValueOnce({
                bytes: Buffer.from([4, 5, 6]),
                contentType: 'image/jpeg',
                finalUrl: 'https://images.weserv.nl/proxied.jpg',
            });
        mocks.readImageProxyCacheObject.mockResolvedValue(null);

        const response = await GET(signedRequest());

        expect(response.status).toBe(200);
        expect(mocks.readImageProxyCacheObject).toHaveBeenCalledOnce();
        expect(mocks.downloadSecureImage).toHaveBeenCalledTimes(2);
        expect(mocks.downloadSecureImage.mock.calls[1]?.[0])
            .toContain('https://images.weserv.nl/?url=');
    });

    it('never touches the cache for a V2 result-image request, even when enabled', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage.mockResolvedValue({
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'image/jpeg',
            finalUrl: 'https://cdninstagram.com/result-photo.jpg?oe=abc',
        });

        const response = await GET(signedResultRequest());
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(response.status).toBe(200);
        expect(mocks.readImageProxyCacheObject).not.toHaveBeenCalled();
        expect(mocks.writeImageProxyCacheObject).not.toHaveBeenCalled();
    });

    it('starts with a bounded cache read before the generic origin attempt', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        const order: string[] = [];
        mocks.readImageProxyCacheObject.mockImplementation(async () => {
            order.push('cache');
            return null;
        });
        mocks.downloadSecureImage.mockImplementation(async () => {
            order.push('direct');
            return {
                bytes: Buffer.from([1, 2, 3]),
                contentType: 'image/jpeg',
                finalUrl: 'https://cdninstagram.com/photo.jpg?oe=abc',
            };
        });

        await expect(GET(signedRequest())).resolves.toMatchObject({ status: 200 });
        expect(order[0]).toBe('cache');
    });

    it('caches a successful trusted-proxy response and leaves unavailability retryable', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage
            .mockRejectedValueOnce(new Error('origin timed out'))
            .mockResolvedValueOnce({
                bytes: Buffer.from([4, 5, 6]),
                contentType: 'image/jpeg',
                finalUrl: 'https://images.weserv.nl/proxied.jpg',
            });
        mocks.readImageProxyCacheObject.mockResolvedValue(null);

        const response = await GET(signedRequest());
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
        expect(mocks.writeImageProxyCacheObject).toHaveBeenCalledOnce();

        mocks.downloadSecureImage.mockRejectedValue(new Error('origin timed out'));
        mocks.readImageProxyCacheObject.mockResolvedValue(null);
        const unavailable = await GET(signedRequest());
        const body = await unavailable.json();

        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get('cache-control')).toContain('no-store');
        expect(body).toEqual(expect.objectContaining({
            code: 'IMAGE_UNAVAILABLE',
            retryable: true,
        }));
        expect(unavailable.headers.get('content-type')).toContain('application/json');
    });

    it('emits URL-free structured diagnostics for a generic image outage', async () => {
        process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED = 'true';
        mocks.downloadSecureImage.mockRejectedValue(new Error(
            'https://cdninstagram.com/secret.jpg?signature=private',
        ));
        mocks.readImageProxyCacheObject.mockResolvedValue(null);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const response = await GET(signedRequest());
            expect(response.status).toBe(503);
            expect(warning).toHaveBeenCalled();
            expect(JSON.stringify(warning.mock.calls)).not.toContain('cdninstagram.com');
            expect(JSON.stringify(warning.mock.calls)).not.toContain('signature=private');
        } finally {
            warning.mockRestore();
        }
    });
});
