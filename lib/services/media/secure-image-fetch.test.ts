import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    isPublicNetworkAddress,
    SecureImageFetchError,
    validateAllowedRemoteImageUrl,
    type ResolveHostname,
    type SecureImageRequest,
} from './secure-image-fetch';

const publicResolver: ResolveHostname = async () => [{
    address: '93.184.216.34',
    family: 4,
}];

describe('secure image URL validation', () => {
    it('accepts exact and subdomain suffixes but rejects lookalike suffixes', async () => {
        await expect(validateAllowedRemoteImageUrl(
            'https://scontent.cdninstagram.com/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).resolves.toBeInstanceOf(URL);
        await expect(validateAllowedRemoteImageUrl(
            'https://instagram.com.attacker.test/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).rejects.toThrow('host');
        await expect(validateAllowedRemoteImageUrl(
            'https://evilinstagram.com/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).rejects.toThrow('host');
    });

    it('rejects HTTP, credentials, IP literals, and private DNS answers', async () => {
        await expect(validateAllowedRemoteImageUrl(
            'http://cdninstagram.com/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).rejects.toThrow('HTTPS');
        await expect(validateAllowedRemoteImageUrl(
            'https://user:secret@cdninstagram.com/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).rejects.toThrow('Credentialed');
        await expect(validateAllowedRemoteImageUrl(
            'https://127.0.0.1/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            publicResolver
        )).rejects.toThrow('IP-literal');
        await expect(validateAllowedRemoteImageUrl(
            'https://cdninstagram.com/image.jpg',
            INSTAGRAM_MEDIA_HOST_SUFFIXES,
            async () => [{ address: '169.254.169.254', family: 4 }]
        )).rejects.toThrow('non-public');
    });

    it('recognizes private, link-local, mapped, and public network addresses', () => {
        expect(isPublicNetworkAddress('10.0.0.1')).toBe(false);
        expect(isPublicNetworkAddress('169.254.1.1')).toBe(false);
        expect(isPublicNetworkAddress('::1')).toBe(false);
        expect(isPublicNetworkAddress('fe80::1')).toBe(false);
        expect(isPublicNetworkAddress('::ffff:127.0.0.1')).toBe(false);
        expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
        expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
    });
});

describe('secure image downloads', () => {
    it('revalidates redirects and blocks a redirect to a malicious suffix', async () => {
        const requestImpl = vi.fn<SecureImageRequest>(async () => new Response(null, {
            status: 302,
            headers: { location: 'https://instagram.com.attacker.test/private' },
        }));

        await expect(downloadSecureImage('https://scontent.cdninstagram.com/image.jpg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        })).rejects.toThrow('host');
        expect(requestImpl).toHaveBeenCalledOnce();
    });

    it('follows an allowed redirect and returns a bounded raster response', async () => {
        const resolver = vi.fn<ResolveHostname>(publicResolver);
        const requestImpl = vi.fn<SecureImageRequest>()
            .mockResolvedValueOnce(new Response(null, {
                status: 302,
                headers: { location: 'https://scontent.fbcdn.net/final.jpg' },
            }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            }));

        const result = await downloadSecureImage(
            'https://scontent.cdninstagram.com/image.jpg',
            {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                requestImpl,
                resolveHostname: resolver,
                maxBytes: 100,
                timeoutMs: 1_000,
            }
        );

        expect(result.bytes).toEqual(Buffer.from([1, 2, 3]));
        expect(result.finalUrl).toBe('https://scontent.fbcdn.net/final.jpg');
        expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('pins each request to the exact public addresses validated before connecting', async () => {
        const resolver = vi.fn<ResolveHostname>(async hostname => hostname.includes('fbcdn')
            ? [{ address: '8.8.4.4', family: 4 }]
            : [
                { address: '93.184.216.34', family: 6 },
                { address: '2606:4700:4700::1111', family: 4 },
            ]);
        const requestImpl = vi.fn<SecureImageRequest>()
            .mockResolvedValueOnce(new Response(null, {
                status: 302,
                headers: { location: 'https://scontent.fbcdn.net/final.jpg' },
            }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            }));

        await downloadSecureImage('https://cdninstagram.com/image.jpg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl,
            resolveHostname: resolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        });

        expect(requestImpl.mock.calls[0]?.[2]).toEqual([
            { address: '93.184.216.34', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 },
        ]);
        expect(requestImpl.mock.calls[1]?.[2]).toEqual([
            { address: '8.8.4.4', family: 4 },
        ]);
        expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('rejects declared and streamed bodies over the byte ceiling', async () => {
        const declared = vi.fn<SecureImageRequest>(async () => new Response('large', {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '101' },
        }));
        await expect(downloadSecureImage('https://cdninstagram.com/a.jpg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl: declared,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        })).rejects.toThrow('byte download limit');

        const streamed = vi.fn<SecureImageRequest>(async () => new Response(new Uint8Array(101), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        }));
        await expect(downloadSecureImage('https://cdninstagram.com/b.jpg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl: streamed,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        })).rejects.toThrow('byte download limit');
    });

    it('preserves the permanent size failure when abort rejects a live response stream', async () => {
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'image/jpeg' });
            response.write(Buffer.alloc(60));
            setTimeout(() => response.end(Buffer.alloc(60)), 10);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });

        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind to a TCP port');
            }
            const requestImpl: SecureImageRequest = (_url, options) => fetch(
                `http://127.0.0.1:${address.port}`,
                { signal: options.signal }
            );

            await expect(downloadSecureImage('https://cdninstagram.com/live-stream.jpg', {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                requestImpl,
                resolveHostname: publicResolver,
                maxBytes: 100,
                timeoutMs: 1_000,
            })).rejects.toMatchObject({
                reason: 'response_too_large',
                disposition: 'permanent',
            });
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    it('rejects SVG payloads even when the host is trusted', async () => {
        const requestImpl = vi.fn<SecureImageRequest>(async () => new Response('<svg/>', {
            status: 200,
            headers: { 'content-type': 'image/svg+xml' },
        }));
        await expect(downloadSecureImage('https://cdninstagram.com/a.svg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        })).rejects.toThrow('content type');
    });

    it('aborts a stalled download at the overall timeout', async () => {
        const requestImpl = vi.fn<SecureImageRequest>((_input, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));

        await expect(downloadSecureImage('https://cdninstagram.com/stalled.jpg', {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 10,
        })).rejects.toThrow('timed out');
    });

    it('returns a bounded retry disposition without exposing the requested URL', async () => {
        const signedUrl = 'https://cdninstagram.com/private.jpg?signature=secret';
        const requestImpl = vi.fn<SecureImageRequest>(async () => new Response(null, { status: 503 }));
        const failure = await downloadSecureImage(signedUrl, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 100,
            timeoutMs: 1_000,
        }).catch(error => error);

        expect(failure).toBeInstanceOf(SecureImageFetchError);
        expect(failure).toMatchObject({
            reason: 'upstream_unavailable',
            disposition: 'transient',
        });
        expect(failure.message).not.toContain('private.jpg');
        expect(failure.message).not.toContain('signature');
    });
});
