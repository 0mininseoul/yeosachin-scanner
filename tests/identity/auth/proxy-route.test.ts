import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
    createServerClient: mocks.createServerClient,
}));

import { proxy } from '@/proxy';

interface ProxyCookieAdapter {
    setAll(cookies: Array<{
        name: string;
        value: string;
        options: { path: string; httpOnly: boolean };
    }>): void;
}

function mockAuthenticatedUser(userId: string | null, refreshCookie = false) {
    mocks.createServerClient.mockImplementation((...args: unknown[]) => {
        const options = args[2] as { cookies: ProxyCookieAdapter };
        return {
            auth: {
                getUser: async () => {
                    if (refreshCookie) {
                        options.cookies.setAll([{
                            name: 'sb-test-auth',
                            value: 'refreshed',
                            options: { path: '/', httpOnly: true },
                        }]);
                    }
                    return { data: { user: userId ? { id: userId } : null } };
                },
            },
        };
    });
}

describe('authentication proxy redirects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    });

    it('preserves a protected path query through the login redirect', async () => {
        mockAuthenticatedUser(null);

        const response = await proxy(new NextRequest(
            'http://localhost:3000/progress/request-1?autostart=1'
        ));

        expect(response.headers.get('location')).toBe(
            'http://localhost:3000/login?redirectTo=%2Fprogress%2Frequest-1%3Fautostart%3D1'
        );
    });

    it('keeps the beta-test landing public for an anonymous visitor', async () => {
        mockAuthenticatedUser(null);

        const response = await proxy(new NextRequest('http://localhost:3000/betatest'));

        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
    });

    it('keeps the anonymous preflight page public', async () => {
        mockAuthenticatedUser(null);

        const response = await proxy(new NextRequest('http://localhost:3000/analyze'));

        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
    });

    it.each(['/progress/example', '/result/example', '/earlybird'])('continues to protect %s for anonymous visitors', async path => {
        mockAuthenticatedUser(null);

        const response = await proxy(new NextRequest(`http://localhost:3000${path}`));

        expect(response.headers.get('location')).toBe(
            `http://localhost:3000/login?redirectTo=${encodeURIComponent(path)}`
        );
    });

    it('does not accept an external beta-test return destination after authentication', async () => {
        mockAuthenticatedUser('123e4567-e89b-42d3-a456-426614174000');

        const response = await proxy(new NextRequest(
            'http://localhost:3000/login?redirectTo=https%3A%2F%2Fattacker.example%2Fbetatest'
        ));

        expect(response.headers.get('location')).toBe('http://localhost:3000/analyze');
    });

    it('captures the first landing as an HttpOnly bounded label and preserves it', async () => {
        mockAuthenticatedUser(null);
        const first = await proxy(new NextRequest('https://yeosachin.com/?utm_source=instagram&token=secret'));
        const cookie = first.headers.get('set-cookie') ?? '';
        expect(cookie).toContain('kakao_signup_attribution=UTM%3A%20%EC%9D%B8%EC%8A%A4%ED%83%80%EA%B7%B8%EB%9E%A8');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).not.toContain('token=secret');
        const later = await proxy(new NextRequest('https://yeosachin.com/?utm_source=google', { headers: { cookie: 'kakao_signup_attribution=UTM%3A%20%EC%9D%B8%EC%8A%A4%ED%83%80%EA%B7%B8%EB%9E%A8' } }));
        expect(later.headers.get('set-cookie') ?? '').not.toContain('kakao_signup_attribution=');
    });

    it('permanently redirects browser requests from legacy public domains', async () => {
        const response = await proxy(new NextRequest(
            'https://www.yeosachin.com/analyze?autostart=1'
        ));

        expect(response.status).toBe(308);
        expect(response.headers.get('location'))
            .toBe('https://yeosachin.com/analyze?autostart=1');
        expect(mocks.createServerClient).not.toHaveBeenCalled();
    });

    it('keeps old non-GET API endpoints available during external cutover', async () => {
        const response = await proxy(new NextRequest(
            'https://yeosachin.vercel.app/api/webhooks/groble',
            { method: 'POST' }
        ));

        expect(response.status).toBe(200);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
    });

    it('sends an authenticated user to the validated destination with refreshed cookies', async () => {
        mockAuthenticatedUser('123e4567-e89b-42d3-a456-426614174000', true);

        const response = await proxy(new NextRequest(
            'http://localhost:3000/login?redirectTo=%2Fanalyze%3Fautostart%3D1'
        ));

        expect(response.headers.get('location'))
            .toBe('http://localhost:3000/analyze?autostart=1');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
    });

    it('retains first-touch attribution when Supabase refreshes response cookies', async () => {
        mockAuthenticatedUser(null, true);
        const response = await proxy(new NextRequest('https://yeosachin.com/?utm_source=kakao'));
        expect(response.headers.get('set-cookie')).toContain('kakao_signup_attribution=UTM%3A%20%EC%B9%B4%EC%B9%B4%EC%98%A4');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
    });

    it.each(['/auth/callback?utm_source=kakao', '/api/user/me?utm_source=kakao', '/share/token?utm_source=kakao', '/_next/static/app.js?utm_source=kakao', '/static/file?utm_source=kakao'])('does not capture attribution on bypass path %s', async path => {
        const response = await proxy(new NextRequest(`https://yeosachin.com${path}`));
        expect(response.headers.get('set-cookie') ?? '').not.toContain('kakao_signup_attribution=');
    });

    it('rejects an external authenticated redirect destination', async () => {
        mockAuthenticatedUser('123e4567-e89b-42d3-a456-426614174000');

        const response = await proxy(new NextRequest(
            'http://localhost:3000/login?redirectTo=https%3A%2F%2Fattacker.example'
        ));

        expect(response.headers.get('location')).toBe('http://localhost:3000/analyze');
    });
});
