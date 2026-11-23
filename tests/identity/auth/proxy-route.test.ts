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

const adminRequestId = '20000000-0000-4000-8000-000000000001';
const operatorId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const devEmail = 'allowed@example.invalid';

function devUser(id = operatorId, email = devEmail, provider = 'kakao', verified = true) {
    return { id, email, app_metadata: { provider }, identities: [{
        provider, identity_data: { email, email_verified: verified },
    }] };
}
const oauthStateError = 'error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+not+found+or+expired';

function adminIntentCookie(intent: string) {
    return { cookie: `auth_redirect_intent=${encodeURIComponent(intent)}` };
}

interface ProxyCookieAdapter {
    setAll(cookies: Array<{
        name: string;
        value: string;
        options: { path: string; httpOnly: boolean };
    }>): void;
}

function mockAuthenticatedUser(user: string | ReturnType<typeof devUser> | null, refreshCookie = false, error: unknown = null) {
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
                    return { data: { user: typeof user === 'string' ? { id: user } : user }, error };
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

    it.each([
        ['/privacy', 'GPTBot/1.4', 'GET'],
        ['/terms', 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)', 'HEAD'],
        ['/terms/?notice=1', 'perplexity-user/1.0', 'GET'],
        ['/privacy?_rsc=test', 'Claude-User/1.0', 'GET'],
        ['/privacy.rsc', 'OAI-SearchBot/1.4', 'GET'],
        ['/terms.prefetch.rsc', 'Claude-Agent/1.0', 'GET'],
        ['/terms.segments/__PAGE__.segment.rsc', 'CCBot/2.0', 'GET'],
        ['/%70rivacy', 'Claude-SearchBot/1.0', 'GET'],
    ])('withholds the legal document at %s from %s on %s', async (path, agent, method) => {
        const response = await proxy(new NextRequest(`https://yeosachin.com${path}`, {
            method, headers: { 'User-Agent': agent },
        }));
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.createServerClient).not.toHaveBeenCalled();
    });

    it.each([
        ['/privacy', 'Mozilla/5.0', 'nosnippet'],
        ['/terms', 'Googlebot/2.1', 'nosnippet'],
        ['/terms', 'Applebot/0.1', 'nosnippet'],
        ['/', 'GPTBot/1.4', null],
        ['/guide/wijang-yeosachin', 'ChatGPT-User/1.0', null],
        ['/terms-and-conditions', 'ClaudeBot/1.0', null],
    ])('passes through %s for %s with the expected snippet policy', async (path, agent, tag) => {
        mockAuthenticatedUser(null);
        const response = await proxy(new NextRequest(`https://yeosachin.com${path}`, {
            headers: { 'User-Agent': agent! },
        }));
        expect(response.headers.get('x-middleware-next')).toBe('1');
        expect(response.headers.get('x-robots-tag')).toBe(tag);
    });

    it('keeps the anonymous preflight page public', async () => {
        mockAuthenticatedUser(null);

        const response = await proxy(new NextRequest('http://localhost:3000/analyze'));

        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
    });

    it.each(['/admin0min', '/admin/analysis-audit'])(
        'recovers a lost OAuth state at the site root for the browser intent %s',
        async path => {
            const response = await proxy(new NextRequest(
                `https://yeosachin.com/?${oauthStateError}&next=https://untrusted.example`,
                { headers: adminIntentCookie(`${path}?requestId=${adminRequestId}&other=private`) },
            ));

            expect(response.headers.get('location')).toBe(
                `https://yeosachin.com/admin0min?requestId=${adminRequestId}&error=bad_oauth_state`,
            );
            expect(response.headers.get('set-cookie')).toMatch(/auth_redirect_intent=;.*Expires=Thu, 01 Jan 1970/);
            expect(response.headers.get('cache-control')).toContain('no-store');
            expect(mocks.createServerClient).not.toHaveBeenCalled();
        },
    );

    it.each([
        '/admin0min?requestId=unexpected',
        `/admin0min?requestId=${adminRequestId}&requestId=${adminRequestId}`,
    ])('recovers the admin login without an invalid or repeated requestId', async intent => {
        const response = await proxy(new NextRequest(
            `https://yeosachin.com/?${oauthStateError}`,
            { headers: adminIntentCookie(intent) },
        ));

        expect(response.headers.get('location')).toBe('https://yeosachin.com/admin0min?error=bad_oauth_state');
    });

    it('recovers an already authenticated operator after the successful callback consumed the intent cookie', async () => {
        vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
        mockAuthenticatedUser(operatorId, true);
        const response = await proxy(new NextRequest(
            `https://yeosachin.com/?${oauthStateError}&requestId=${adminRequestId}&next=https://untrusted.example`,
        ));
        expect(response.headers.get('location')).toBe('https://yeosachin.com/admin0min');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it.each([
        [null, null],
        [otherUserId, null],
        [operatorId, { status: 401, code: 'invalid_token' }],
        [operatorId, { status: 503 }],
    ])('keeps the root state error for a missing, non-operator, or errored session', async (userId, error) => {
        vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
        mockAuthenticatedUser(userId, false, error);
        const response = await proxy(new NextRequest(`https://yeosachin.com/?${oauthStateError}`));
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
    });

    it.each(['', 'invalid', `${operatorId},${operatorId}`])(
        'keeps the root state error when the operator configuration is unavailable',
        async configured => {
            vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', configured);
            mockAuthenticatedUser(operatorId);
            const response = await proxy(new NextRequest(`https://yeosachin.com/?${oauthStateError}`));
            expect(response.headers.get('location')).toBeNull();
        },
    );

    it('preserves an authenticated operator consumer intent while handling a root state error', async () => {
        vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
        mockAuthenticatedUser(operatorId);
        const response = await proxy(new NextRequest(
            `https://yeosachin.com/?${oauthStateError}`,
            { headers: adminIntentCookie('/analyze') },
        ));
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('set-cookie')).not.toContain('auth_redirect_intent=;');
    });

    it.each([
        ['GET', '/', ''],
        ['GET', '/', 'error=access_denied&error_code=bad_oauth_state'],
        ['GET', '/', `${oauthStateError}&error=invalid_request`],
        ['GET', '/', `${oauthStateError}&error_code=bad_oauth_state`],
        ['GET', '/', `${oauthStateError}&code=oauth-code`],
        ['POST', '/', oauthStateError],
        ['GET', '/analyze', oauthStateError],
    ])('keeps an operator on an unrelated %s %s navigation', async (method, path, query) => {
        vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
        mockAuthenticatedUser(operatorId);
        const response = await proxy(new NextRequest(`https://yeosachin.com${path}?${query}`, { method }));
        expect(response.headers.get('location')).toBeNull();
    });

    it.each([
        ['/', oauthStateError, null],
        ['/', oauthStateError, '/analyze'],
        ['/', oauthStateError, '/nested/../admin0min'],
        ['/', oauthStateError, '//untrusted.example/admin0min'],
        ['/', oauthStateError, '/admin0min/extra'],
        ['/analyze', oauthStateError, '/admin0min'],
        ['/', 'error=access_denied&error_code=bad_oauth_state', '/admin0min'],
        ['/', 'error=invalid_request&error_code=unexpected_failure', '/admin0min'],
        ['/', `${oauthStateError}&error=invalid_request`, '/admin0min'],
        ['/', `${oauthStateError}&error_code=bad_oauth_state`, '/admin0min'],
        ['/', `${oauthStateError}&code=oauth-code`, '/admin0min'],
    ])('keeps an unrelated navigation on %s with query %s', async (pathname, query, intent) => {
        mockAuthenticatedUser(null);
        const response = await proxy(new NextRequest(
            `https://yeosachin.com${pathname}?${query}`,
            { headers: intent ? adminIntentCookie(intent) : undefined },
        ));

        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('set-cookie')).not.toContain('auth_redirect_intent=;');
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
        vi.stubEnv('DEV_UI_ALLOWED_KAKAO_EMAIL', devEmail);
        vi.stubEnv('DEV_UI_TEST_USER_IDS', operatorId);
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('recovers a logged-out Dev administrator intent at the login gate', async () => {
        mockAuthenticatedUser(null);
        const response = await proxy(new NextRequest(
            `https://dev.yeosachin.com/?${oauthStateError}`,
            { headers: adminIntentCookie('/admin0min') },
        ));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/login?redirectTo=%2Fadmin0min&error=bad_oauth_state');
        expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
        expect(response.headers.get('set-cookie')).toMatch(/auth_redirect_intent=;.*Expires=/u);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('recovers a cookieless authenticated Dev administrator on the registered Dev origin', async () => {
        vi.stubEnv('DEV_UI_TEST_USER_IDS', operatorId);
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', operatorId);
        mockAuthenticatedUser(devUser(), true);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com/?${oauthStateError}`));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/admin0min');
        expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
        expect(response.headers.get('set-cookie')).not.toMatch(/Domain=/i);
    });

    it.each([
        ['', operatorId, null, 'dev_access_denied'],
        [operatorId, '', null, null],
        [otherUserId, operatorId, null, 'dev_access_denied'],
        [operatorId, otherUserId, null, null],
        ['invalid', operatorId, null, 'dev_access_denied'],
        [operatorId, operatorId, { status: 503 }, 'dev_auth_unavailable'],
    ])('checks site authorization before Dev administrator session recovery', async (testers, admins, error, loginError) => {
        vi.stubEnv('ANALYSIS_AUDIT_OPERATOR_USER_IDS', operatorId);
        vi.stubEnv('DEV_UI_TEST_USER_IDS', testers);
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', admins);
        mockAuthenticatedUser(devUser(), false, error);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com/?${oauthStateError}`));
        expect(response.status).toBe(loginError ? 307 : 200);
        expect(response.headers.get('location')).toBe(loginError
            ? `https://dev.yeosachin.com/login?redirectTo=%2Fanalyze&error=${loginError}` : null);
    });

    it('rejects a mismatched Dev deployment before checking a cookieless administrator session', async () => {
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_wrong');
        vi.stubEnv('DEV_UI_TEST_USER_IDS', operatorId);
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', operatorId);
        mockAuthenticatedUser(operatorId);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com/?${oauthStateError}`));
        expect(response.status).toBe(503);
        expect(response.headers.get('location')).toBeNull();
        expect(mocks.createServerClient).not.toHaveBeenCalled();
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
        '/api/analysis/precheckout-blite', '/api/analysis/precheckout-blite?devAnalysis=live&devAnalysis=live',
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
        ['POST', '/api/analysis/precheckout-blite?devAnalysis=live'],
    ])('allows only a verified tester on the planned route: %s %s', async (method, pathname) => {
        mockAuthenticatedUser(devUser());
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.createServerClient).toHaveBeenCalledOnce();
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
        mockAuthenticatedUser(devUser(), true);
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/login?redirectTo=%2Fresult%2Fexample'));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/result/example');
        expect(response.headers.get('set-cookie')).toContain('sb-test-auth=refreshed');
        expect(response.headers.get('set-cookie')).not.toMatch(/Domain=/i);
        expect(response.headers.get('x-robots-tag')).toContain('noindex');
    });
    it.each(['/', '/analyze?tab=standard', '/share/synthetic'])('requires Kakao login for Dev page %s', async pathname => {
        mockAuthenticatedUser(null);
        const response = await proxy(new NextRequest(`https://dev.yeosachin.com${pathname}`));
        const login = new URL(response.headers.get('location')!);
        expect(login.origin + login.pathname).toBe('https://dev.yeosachin.com/login');
        expect(login.searchParams.get('redirectTo')).toBe(pathname);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('allows the login screen and the exact OAuth callback to reach their handlers', async () => {
        mockAuthenticatedUser(null);
        const login = await proxy(new NextRequest('https://dev.yeosachin.com/login'));
        expect(login.status).toBe(200);
        expect(login.headers.get('cache-control')).toContain('no-store');
        mocks.createServerClient.mockClear();
        const callback = await proxy(new NextRequest('https://dev.yeosachin.com/auth/callback'));
        expect(callback.status).toBe(200);
        expect(mocks.createServerClient).not.toHaveBeenCalled();
    });

    it.each([
        [null, 401],
        [devUser(operatorId, 'another@example.invalid'), 403],
        [devUser(operatorId, devEmail, 'google'), 403],
        [devUser(operatorId, devEmail, 'kakao', false), 403],
        [devUser(otherUserId), 403],
    ])('fails closed at the Dev user endpoint for an ineligible session', async (user, status) => {
        mockAuthenticatedUser(user);
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/api/user/me'));
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('location')).toBeNull();
    });

    it('sends a verified different account back to the Kakao login page without a loop', async () => {
        mockAuthenticatedUser(devUser(operatorId, 'another@example.invalid'));
        const denied = await proxy(new NextRequest('https://dev.yeosachin.com/analyze'));
        const loginUrl = 'https://dev.yeosachin.com/login?redirectTo=%2Fanalyze&error=dev_access_denied';
        expect(denied.headers.get('location')).toBe(loginUrl);
        const login = await proxy(new NextRequest(loginUrl));
        expect(login.status).toBe(200);
        expect(login.headers.get('location')).toBeNull();
    });

    it('rejects a configured list in place of a single Dev Kakao email', async () => {
        vi.stubEnv('DEV_UI_ALLOWED_KAKAO_EMAIL', `${devEmail},another@example.invalid`);
        mockAuthenticatedUser(devUser());
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/api/user/me'));
        expect(response.status).toBe(503);
    });

    it('does not return an authenticated Dev account to its own login page', async () => {
        mockAuthenticatedUser(devUser());
        const response = await proxy(new NextRequest('https://dev.yeosachin.com/login?redirectTo=%2Flogin%2F'));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/analyze');
    });

});
