import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { encodeURIPath } from 'next/dist/shared/lib/encode-uri-path';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
    createServerClient: mocks.createServerClient,
}));

vi.mock('@/config/dev-ui-deployment.json', () => ({
    default: { version: 1, deployments: [{ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' }] },
}));

import { config, proxy } from '@/proxy';

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
        vi.stubEnv('DEPLOYMENT_ROLE', '');
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', '');
        vi.stubEnv('VERCEL_PROJECT_ID', '');
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
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

    it('pins an anonymous protected-page redirect to the configured origin when the request host is unknown', async () => {
        mockAuthenticatedUser(null);
        const response = await proxy(new NextRequest('https://attacker.example/progress/example?autostart=1'));
        expect(response.headers.get('location'))
            .toBe('https://yeosachin.com/login?redirectTo=%2Fprogress%2Fexample%3Fautostart%3D1');
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

describe('Dev UI proxy boundary', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174001';
    const fetchSpy = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_dev_ui_test');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://devuitestproject.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it.each(['/api/webhooks/sentry/synthetic.png', '/api/analysis/preflight/synthetic.jpg', '/auth/callback.png', '/result/synthetic.jpg', '/admin/synthetic.png'])
    ('matches dynamic processing and protected paths even when their suffix resembles a static image: %s', pathname => {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://dev.yeosachin.com${pathname}` })).toBe(true);
    });

    it.each(['progress', 'result'])('keeps Next-generated encoded %s page chunks outside the proxy', page => {
        const pathname = encodeURIPath(`/_next/static/chunks/app/${page}/[requestId]/page-review.js`);
        expect(unstable_doesMiddlewareMatch({ config, url: `https://dev.yeosachin.com${pathname}` })).toBe(false);
    });

    it.each([
        '/%61pi/analysis/v2/worker', '/a%70i/analysis/v2/worker',
        '/%2561pi/analysis/v2/worker', '/api%2fanalysis/v2/worker',
        '/api%252fanalysis/v2/worker', '/%2fapi/analysis/v2/worker',
        '/api//analysis/v2/worker', '/%61pi/webhooks/sentry/synthetic.png',
    ])('rejects noncanonical Dev paths before a decoded Next route can run: %s', async pathname => {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://dev.yeosachin.com${pathname}` })).toBe(true);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`, { method: 'POST' }));
        expect(response.status).toBe(403);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('matches an encoded dynamic API path even when its suffix resembles a static image', () => {
        expect(unstable_doesMiddlewareMatch({ config, url: 'https://dev.yeosachin.com/%61pi/webhooks/sentry/synthetic.png' })).toBe(true);
    });

    it.each(['/%61pi/image-proxy', '/a%70i/image-proxy'])('blocks an encoded image-proxy GET before any provider call: %s', async pathname => {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://dev.yeosachin.com${pathname}` })).toBe(true);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`));
        expect(response.status).toBe(403);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        '/api/analysis/v2/worker', '/api/analysis/preflight/worker', '/api/analysis/start',
        '/api/analysis/run', '/api/analysis/step', '/api/analysis/preflight/recover',
        '/api/analysis/preflight/retention', `/api/analysis/preflight/${uuid}/entitle`,
        `/api/analysis/betatest/preflight/${uuid}/admit`, '/api/webhooks/groble',
        '/api/internal/earlybird-payment-discord-outbox', '/api/earlybird/checkout/redirect',
        '/api/image-proxy', '/api/admin/apify-accounts', '/api/account/delete',
    ])('blocks production processing before clients or fetch for %s', async pathname => {
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`, { method: 'POST' }));
        expect(response.status).toBe(403);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
    });

    it.each([
        ['POST', '/api/analysis/preflight'], ['GET', `/api/analysis/preflight/${uuid}`],
        ['POST', '/api/earlybird/checkout'], ['GET', `/api/analysis/v2/progress/${uuid}`],
        ['GET', `/api/analysis/v2/result/${uuid}`], ['POST', `/api/dev-ui/checkout/${uuid}`],
        ['GET', '/api/dev-ui/orders'], ['GET', '/api/user/me'], ['POST', '/api/auth/signout'],
        ['GET', '/api/admin/order-audit'], ['GET', '/api/admin/analysis-audit'],
    ])('allows only the planned authenticated/read or synthetic route: %s %s', async (method, pathname) => {
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['POST', '/api/admin/order-audit'], ['GET', '/api/analysis/preflight/worker'],
        ['DELETE', `/api/dev-ui/checkout/${uuid}`], ['GET', '/api/dev-ui/checkout/not-a-uuid'],
    ])('rejects wrong methods or wildcard lookalikes: %s %s', async (method, pathname) => {
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`, { method }));
        expect(response.status).toBe(403);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['VERCEL_PROJECT_ID', 'prj_production_test'],
        ['NEXT_PUBLIC_SUPABASE_URL', 'https://productiontest.supabase.co'],
        ['NEXT_PUBLIC_SUPABASE_URL', 'https://user:pass@devuitestproject.supabase.co'],
        ['NEXT_PUBLIC_SUPABASE_URL', 'https://devuitestproject.supabase.co/rest/v1'],
        ['DEPLOYMENT_ROLE', ''],
    ])('fails closed before even an allowed API when %s is mismatched', async (name, value) => {
        vi.stubEnv(name, value);
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/api/analysis/preflight', { method: 'POST' }));
        expect(response.status).toBe(503);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects an unknown host even when a forwarded host names Dev', async () => {
        const response = await proxy(new NextRequest('https://attacker.example/api/analysis/preflight', {
            method: 'POST', headers: { 'x-forwarded-host': 'dev.yeosachin.com' },
        }));
        expect(response.status).toBe(503);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps authenticated Dev login redirects and refreshed cookies on the host without a parent cookie domain', async () => {
        mockAuthenticatedUser(uuid, true);
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/login?redirectTo=%2Fresult%2Fexample'));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/result/example');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
        expect(response.headers.get('set-cookie')).not.toMatch(/Domain=/i);
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
    });
});
