import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    downloadSecureImage: vi.fn(),
    resolveResultImage: vi.fn(),
    createClient: vi.fn(),
    getUser: vi.fn(),
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
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

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
        mocks.resolveResultImage.mockResolvedValue(
            'https://cdninstagram.com/result-photo.jpg?oe=abc'
        );
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
        expect(mocks.downloadSecureImage).toHaveBeenCalledOnce();
        const [downloadUrl, options] = mocks.downloadSecureImage.mock.calls[0];
        expect(downloadUrl).toBe('https://cdninstagram.com/photo.jpg?oe=abc');
        expect(options).toEqual(expect.objectContaining({
            maxBytes: 3 * 1024 * 1024,
        }));
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(4_000);
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

    it('never sends an owner-scoped result CDN URL to the third-party fallback', async () => {
        mocks.downloadSecureImage.mockRejectedValueOnce(new Error('origin unavailable'));

        const response = await GET(signedResultRequest());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/svg+xml');
        expect(mocks.downloadSecureImage).toHaveBeenCalledOnce();
        expect(mocks.downloadSecureImage.mock.calls[0]?.[0])
            .toBe('https://cdninstagram.com/result-photo.jpg?oe=abc');
    });

    it('retains the trusted compatibility fallback for generic signed images', async () => {
        mocks.downloadSecureImage
            .mockRejectedValueOnce(new Error('origin unavailable'))
            .mockResolvedValueOnce({
                bytes: Buffer.from([4, 5, 6]),
                contentType: 'image/jpeg',
                finalUrl: 'https://images.weserv.nl/proxied.jpg',
            });

        const response = await GET(signedRequest());

        expect(response.status).toBe(200);
        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(mocks.downloadSecureImage).toHaveBeenCalledTimes(2);
        expect(mocks.downloadSecureImage.mock.calls[1]?.[0])
            .toContain('https://images.weserv.nl/?url=');
    });
});
