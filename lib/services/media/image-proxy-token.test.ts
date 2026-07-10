import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    canonicalizeImageProxyUrl,
    createImageProxyPath,
    verifyImageProxyToken,
} from './image-proxy-token';

const SECRET = 'test-image-proxy-signing-secret-at-least-32-characters';
const NOW_MS = Date.UTC(2026, 6, 11, 3, 4, 5);

afterEach(() => {
    vi.unstubAllEnvs();
});

function parseProxyPath(path: string) {
    const parsed = new URL(path, 'https://baram-detector.example');
    return {
        url: parsed.searchParams.get('url') || '',
        expires: parsed.searchParams.get('expires') || '',
        signature: parsed.searchParams.get('signature') || '',
    };
}

describe('image proxy URL canonicalization', () => {
    it('removes fragments and tracking parameters while retaining CDN signatures', () => {
        expect(canonicalizeImageProxyUrl(
            'https://SCONTENT.cdninstagram.com/photo.jpg?utm_source=test&oe=abc&_nc_cat=1&fbclid=junk#fragment'
        )).toBe(
            'https://scontent.cdninstagram.com/photo.jpg?_nc_cat=1&oe=abc'
        );
    });

    it('rejects non-Instagram, credentialed, and non-HTTPS URLs', () => {
        expect(() => canonicalizeImageProxyUrl('https://example.com/photo.jpg')).toThrow('host');
        expect(() => canonicalizeImageProxyUrl('https://user:pass@cdninstagram.com/a.jpg')).toThrow('allowed');
        expect(() => canonicalizeImageProxyUrl('http://cdninstagram.com/a.jpg')).toThrow('allowed');
    });
});

describe('image proxy tokens', () => {
    it('creates a stable bucketed token and verifies its canonical URL', () => {
        const first = createImageProxyPath(
            'https://cdninstagram.com/a.jpg?oe=123&utm_medium=social#ignored',
            { nowMs: NOW_MS, secret: SECRET }
        );
        const second = createImageProxyPath(
            'https://cdninstagram.com/a.jpg?utm_medium=social&oe=123',
            { nowMs: NOW_MS + 30_000, secret: SECRET }
        );
        expect(first).toBe(second);

        const token = parseProxyPath(first!);
        expect(verifyImageProxyToken(
            token.url,
            token.expires,
            token.signature,
            { nowMs: NOW_MS, secret: SECRET }
        )).toBe('https://cdninstagram.com/a.jpg?oe=123');
    });

    it('rejects tampering, noncanonical URLs, expired tokens, and excessive lifetimes', () => {
        const token = parseProxyPath(createImageProxyPath(
            'https://cdninstagram.com/a.jpg?oe=123',
            { nowMs: NOW_MS, secret: SECRET }
        )!);

        expect(verifyImageProxyToken(
            'https://cdninstagram.com/b.jpg?oe=123',
            token.expires,
            token.signature,
            { nowMs: NOW_MS, secret: SECRET }
        )).toBeNull();
        expect(verifyImageProxyToken(
            `${token.url}#cache-bust`,
            token.expires,
            token.signature,
            { nowMs: NOW_MS, secret: SECRET }
        )).toBeNull();
        expect(verifyImageProxyToken(
            token.url,
            token.expires,
            token.signature,
            { nowMs: NOW_MS + 3_600_000, secret: SECRET }
        )).toBeNull();
        expect(verifyImageProxyToken(
            token.url,
            String(Math.floor(NOW_MS / 1_000) + 10_000),
            token.signature,
            { nowMs: NOW_MS, secret: SECRET }
        )).toBeNull();
    });

    it('omits invalid stored URLs instead of exposing an unsigned fallback', () => {
        expect(createImageProxyPath('https://example.com/a.jpg', {
            nowMs: NOW_MS,
            secret: SECRET,
        })).toBeUndefined();
        expect(createImageProxyPath(undefined, {
            nowMs: NOW_MS,
            secret: SECRET,
        })).toBeUndefined();
    });

    it('requires a dedicated environment secret and never reuses the service-role key', () => {
        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', '');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET);
        expect(() => createImageProxyPath('https://cdninstagram.com/a.jpg'))
            .toThrow('IMAGE_PROXY_SIGNING_SECRET');

        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', SECRET);
        expect(createImageProxyPath('https://cdninstagram.com/a.jpg'))
            .toMatch(/^\/api\/image-proxy\?/);
    });
});
