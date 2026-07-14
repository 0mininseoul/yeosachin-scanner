import { describe, expect, it } from 'vitest';

import {
    appOriginForRequest,
    appRedirectUrlForRequest,
    appOriginForServer,
    CANONICAL_APP_ORIGIN,
} from './app-url';

describe('canonical app origin', () => {
    it('pins the production origin', () => {
        expect(CANONICAL_APP_ORIGIN).toBe('https://yeosachin.vercel.app');
        expect(appOriginForRequest('https://ai-yeosachinscanner.vercel.app/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForRequest('https://attacker.example/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
    });

    it('preserves loopback origins for local requests', () => {
        expect(appOriginForRequest('http://localhost:3000/api/auth/signout'))
            .toBe('http://localhost:3000');
        expect(appOriginForRequest('http://127.0.0.1:3100/api/share/enable'))
            .toBe('http://127.0.0.1:3100');
    });

    it('resolves safe redirects against the canonical production origin', () => {
        expect(appRedirectUrlForRequest(
            'https://preview.example/auth/callback',
            '/result/request-1?tab=private#account'
        ).toString()).toBe(
            `${CANONICAL_APP_ORIGIN}/result/request-1?tab=private#account`
        );
    });

    it('preserves the request loopback origin for local redirects', () => {
        expect(appRedirectUrlForRequest(
            'http://127.0.0.1:3100/auth/callback',
            '/result/request-1'
        ).toString()).toBe('http://127.0.0.1:3100/result/request-1');
    });

    it('preserves an authenticated landing autostart query', () => {
        expect(appRedirectUrlForRequest(
            'http://127.0.0.1:3000/login?redirectTo=%2Fanalyze%3Fautostart%3D1',
            '/analyze?autostart=1'
        ).toString()).toBe('http://127.0.0.1:3000/analyze?autostart=1');
    });

    it.each([
        'https://attacker.example/path',
        '//attacker.example/path',
        '/\\attacker.example/path',
        '/%5cattacker.example/path',
        '/%255cattacker.example/path',
        '/%2f%2fattacker.example/path',
        '/%252f%252fattacker.example/path',
    ])('falls back for an unsafe redirect path: %s', rawPath => {
        expect(appRedirectUrlForRequest(
            'https://preview.example/auth/callback',
            rawPath
        ).toString()).toBe(`${CANONICAL_APP_ORIGIN}/analyze`);
    });

    it('uses local configuration only outside production', () => {
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000/path',
        })).toBe('http://localhost:3000');
        expect(appOriginForServer({
            NODE_ENV: 'production',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        })).toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'https://preview.example',
        })).toBe(CANONICAL_APP_ORIGIN);
    });
});
