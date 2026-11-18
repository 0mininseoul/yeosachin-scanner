import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    createRlsClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getUser: vi.fn(),
    signOut: vi.fn(),
    accountRpc: vi.fn(),
    claimAnonymousPreflight: vi.fn(),
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '123e4567-e89b-42d3-a456-426614174010',
        trace_id: null,
        route: '/auth/callback',
        method: 'GET',
    })),
}));

vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createRlsClient }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.accountRpc },
}));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));
vi.mock('@/lib/services/analysis/anonymous-preflight', () => ({
    claimAnonymousAnalysisV2Preflight: mocks.claimAnonymousPreflight,
}));
vi.mock('@/config/dev-ui-deployment.json', () => ({
    default: { version: 1, deployments: [{ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' }] },
}));

import { GET } from '@/app/auth/callback/route';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';

const devEmail = 'allowed@example.invalid';
const devUserId = '123e4567-e89b-42d3-a456-426614174000';

function configureDevOAuth() {
    vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
    vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_dev_ui_test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://devuitestproject.supabase.co');
    vi.stubEnv('DEV_UI_ALLOWED_KAKAO_EMAIL', devEmail);
    vi.stubEnv('DEV_UI_TEST_USER_IDS', devUserId);
}

function devOAuthUser(email = devEmail, provider = 'kakao', verified = true) {
    return { id: devUserId, email, app_metadata: { provider }, identities: [{
        provider, identity_data: { email, email_verified: verified },
    }] };
}

describe('OAuth callback redirects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            getAll: vi.fn(() => []),
            set: vi.fn(),
        });
        mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
        mocks.signOut.mockResolvedValue({ error: null });
        mocks.accountRpc.mockResolvedValue({ data: [], error: null });
        mocks.claimAnonymousPreflight.mockResolvedValue({
            claimed: true,
            ownerPreflightId: null,
        });
        mocks.createServerClient.mockReturnValue({
            auth: {
                exchangeCodeForSession: mocks.exchangeCodeForSession,
                getUser: mocks.getUser,
                signOut: mocks.signOut,
            },
            rpc: vi.fn(),
        });
        mocks.createRlsClient.mockReturnValue({ rpc: vi.fn() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('accepts a verified Dev Kakao tester without claim, provider, or notification work', async () => {
        configureDevOAuth();
        const user = devOAuthUser('Allowed@example.invalid');
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: { access_token: 'synthetic-session-token', provider_token: 'synthetic-provider-token' }, user },
            error: null,
        });
        mocks.getUser.mockResolvedValue({ data: { user }, error: null });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const next = encodeURIComponent('/analyze?preflight=synthetic&claim=synthetic');
        const response = await GET(new Request(`https://dev.yeosachin.com/auth/callback?code=oauth-code&next=${next}`));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/analyze?preflight=synthetic&claim=synthetic&verified=true');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mocks.accountRpc.mock.calls.every(([name]) => name === 'load_account_classification_v1')).toBe(true);
        expect(mocks.createRlsClient).not.toHaveBeenCalled();
        expect(mocks.claimAnonymousPreflight).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it.each([
        devOAuthUser('another@example.invalid'),
        devOAuthUser(devEmail, 'google'),
        devOAuthUser(devEmail, 'kakao', false),
    ])('ends a rejected Dev callback before app-side account or claim work', async user => {
        configureDevOAuth();
        mocks.exchangeCodeForSession.mockResolvedValue({ data: { session: {}, user }, error: null });
        mocks.getUser.mockResolvedValue({ data: { user }, error: null });
        const response = await GET(new Request('https://dev.yeosachin.com/auth/callback?code=oauth-code&next=%2Fadmin0min'));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/login?redirectTo=%2Fadmin0min&error=dev_access_denied');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.signOut).toHaveBeenCalledOnce();
        expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(mocks.accountRpc).not.toHaveBeenCalled();
        expect(mocks.claimAnonymousPreflight).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('returns a Dev callback interruption to login with a bounded error and the intended page', async () => {
        configureDevOAuth();
        const response = await GET(new Request('https://dev.yeosachin.com/auth/callback?next=%2Fadmin0min&error_description=private'));
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/login?redirectTo=%2Fadmin0min&error=no_code');
        expect(mocks.createServerClient).not.toHaveBeenCalled();
    });

    it('rejects the wrong Dev identity before OAuth session exchange', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_production_test');
        const response = await GET(new Request('https://dev.yeosachin.com/auth/callback?code=oauth-code'));
        expect(response.status).toBe(503);
        expect(mocks.cookies).not.toHaveBeenCalled();
        expect(mocks.createServerClient).not.toHaveBeenCalled();
        expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    });

    it('uses the canonical origin and ignores a forwarded host in production', async () => {
        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=oauth-code&next=%2Fresult%2Frequest-1',
            { headers: { 'x-forwarded-host': 'attacker.example' } }
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/result/request-1?verified=true`
        );
    });

    it('preserves a loopback origin during local OAuth', async () => {
        const response = await GET(new Request(
            'http://localhost:3000/auth/callback?code=oauth-code&next=%2Fanalyze'
        ));

        expect(response.headers.get('location')).toBe(
            'http://localhost:3000/analyze?verified=true'
        );
    });

    it('recovers the intended destination when the provider returns the root path', async () => {
        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=oauth-code&next=%2F',
            {
                headers: {
                    cookie: 'auth_redirect_intent=%2Fanalyze%3Fautostart%3D1',
                },
            },
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?autostart=1&verified=true`
        );
        expect(response.headers.get('set-cookie')).toMatch(
            /auth_redirect_intent=;.*Expires=Thu, 01 Jan 1970 00:00:00 GMT/
        );
    });

    it('restores an anonymous preflight claim from the browser intent fallback', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'google' } } },
            error: null,
        });
        const claimToken = 'v1.signed-claim-value.signature-value';
        const intent = `/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=${claimToken}&plan=standard`;
        const response = await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=%2F`,
            {
                headers: {
                    cookie: `auth_redirect_intent=${encodeURIComponent(intent)}`,
                },
            },
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledWith(
            '223e4567-e89b-42d3-a456-426614174000',
            claimToken,
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&verified=true`
        );
    });

    it('claims the anonymous preflight from the OAuth next state before redirecting', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'google' } } },
            error: null,
        });
        const claimToken = 'v1.signed-claim-value.signature-value';
        const response = await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=${encodeURIComponent(
                `/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=${claimToken}&plan=standard`
            )}`,
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledWith(
            '223e4567-e89b-42d3-a456-426614174000',
            claimToken,
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&verified=true`
        );
    });

    it('uses the exchanged access token for the authenticated claim RPC client', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        const accessToken = 'oauth-access-token';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: {
                session: { access_token: accessToken },
                user: { id: userId, app_metadata: { provider: 'google' } },
            },
            error: null,
        });
        const claimToken = 'v1.signed-claim-value.signature-value';

        await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=${encodeURIComponent(
                `/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=${claimToken}`
            )}`,
        ));

        expect(mocks.createRlsClient).toHaveBeenCalledTimes(1);
        expect(mocks.createRlsClient.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            accessToken: expect.any(Function),
            global: expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: `Bearer ${accessToken}`,
                }),
            }),
        }));
        const accessTokenFactory = mocks.createRlsClient.mock.calls[0]?.[2]?.accessToken;
        await expect(accessTokenFactory()).resolves.toBe(accessToken);
        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledWith(
            expect.any(String),
            claimToken,
            userId,
            expect.objectContaining({
                client: expect.objectContaining({ rpc: expect.any(Function) }),
            }),
        );
    });

    it('claims when the OAuth callback carries the preflight continuation at top level', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'kakao' } } },
            error: null,
        });
        const claimToken = 'v1.signed-claim-value.signature-value';
        const response = await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=%2Fanalyze&preflight=223e4567-e89b-42d3-a456-426614174000&claim=${encodeURIComponent(claimToken)}&plan=standard&checkout=1`,
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledWith(
            '223e4567-e89b-42d3-a456-426614174000',
            claimToken,
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1&verified=true`
        );
    });

    it('claims when the provider returns a partial destination but the browser intent retains the claim', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'google' } } },
            error: null,
        });
        const claimToken = 'v1.signed-claim-value.signature-value';
        const intent = `/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=${claimToken}&plan=standard&checkout=1`;
        const response = await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=${encodeURIComponent(
                '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1'
            )}`,
            {
                headers: {
                    cookie: `auth_redirect_intent=${encodeURIComponent(intent)}`,
                },
            },
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledWith(
            '223e4567-e89b-42d3-a456-426614174000',
            claimToken,
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1&verified=true`
        );
    });

    it('retries the browser claim when a provider continuation claim cannot be restored', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'kakao' } } },
            error: null,
        });
        mocks.claimAnonymousPreflight
            .mockRejectedValueOnce(new Error('ANONYMOUS_PREFLIGHT_CLAIM_INVALID'))
            .mockResolvedValueOnce({ claimed: true, ownerPreflightId: null });
        const browserIntent = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=browser-claim&plan=standard&checkout=1';
        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=oauth-code&next=%2Fanalyze&preflight=223e4567-e89b-42d3-a456-426614174000&claim=provider-claim&plan=standard&checkout=1',
            {
                headers: {
                    cookie: `auth_redirect_intent=${encodeURIComponent(browserIntent)}`,
                },
            },
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenNthCalledWith(
            1,
            '223e4567-e89b-42d3-a456-426614174000',
            'provider-claim',
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(mocks.claimAnonymousPreflight).toHaveBeenNthCalledWith(
            2,
            '223e4567-e89b-42d3-a456-426614174000',
            'browser-claim',
            userId,
            expect.objectContaining({ client: expect.any(Object) }),
        );
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1&verified=true`
        );
    });

    it('does not retry a browser claim belonging to another preflight', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'kakao' } } },
            error: null,
        });
        mocks.claimAnonymousPreflight.mockRejectedValueOnce(
            new Error('ANONYMOUS_PREFLIGHT_CLAIM_INVALID')
        );
        const browserIntent = '/analyze?preflight=323e4567-e89b-42d3-a456-426614174000&claim=browser-claim&plan=standard&checkout=1';
        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=oauth-code&next=%2Fanalyze&preflight=223e4567-e89b-42d3-a456-426614174000&claim=provider-claim&plan=standard&checkout=1',
            {
                headers: {
                    cookie: `auth_redirect_intent=${encodeURIComponent(browserIntent)}`,
                },
            },
        ));

        expect(mocks.claimAnonymousPreflight).toHaveBeenCalledTimes(1);
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: expect.objectContaining({
                operation: 'callback',
                disposition: 'completed',
                error_code: 'UNAUTHORIZED',
            }),
        }));
        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?claim=restore_failed&verified=true`
        );
    });

    it('resumes checkout against an existing owner preflight after a retry', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        const ownerPreflightId = '323e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: { session: {}, user: { id: userId, app_metadata: { provider: 'kakao' } } },
            error: null,
        });
        mocks.claimAnonymousPreflight.mockResolvedValue({
            claimed: false,
            ownerPreflightId,
        });

        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=oauth-code&next=%2Fanalyze%3Fpreflight%3D223e4567-e89b-42d3-a456-426614174000%26claim%3Dclaim-token%26plan%3Dstandard%26checkout%3D1',
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?preflight=${ownerPreflightId}&plan=standard&checkout=1&verified=true`
        );
    });

    it('lands a missing-code callback on a bounded terminal error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const response = await GET(new Request(
            'https://preview.example/auth/callback?next=%2Fanalyze'
        ));
        const consoleErrorCalls = consoleError.mock.calls;
        consoleError.mockRestore();

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/login?error=no_code`
        );
        expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: expect.objectContaining({
                disposition: 'rejected',
                error_code: 'INVALID_REQUEST',
            }),
        }));
        expect(consoleErrorCalls).toHaveLength(0);
    });

    it.each(['/admin0min', '/admin/analysis-audit'])(
        'keeps an in-flight admin OAuth destination canonical after successful exchange from %s',
        async path => {
            const requestId = '20000000-0000-4000-8000-000000000001';
            const next = `${path}?requestId=${requestId}&other=private`;
            const response = await GET(new Request(
                `https://yeosachin.com/auth/callback?code=oauth-code&next=${encodeURIComponent(next)}`,
            ));
            expect(response.headers.get('location')).toBe(
                `https://yeosachin.com/admin0min?requestId=${requestId}&verified=true`,
            );
        },
    );

    it.each(['no_code', 'exchange_failed'])(
        'keeps a bounded admin detail target on the manual retry page for %s',
        async error => {
            const requestId = '20000000-0000-4000-8000-000000000001';
            mocks.exchangeCodeForSession.mockResolvedValue({ error: { message: 'private-provider-detail' } });
            const code = error === 'exchange_failed' ? '&code=bad-code' : '';
            const response = await GET(new Request(
                `https://yeosachin.com/auth/callback?next=%2F${code}&error_description=private-provider-detail`,
                { headers: { cookie: `auth_redirect_intent=${encodeURIComponent(`/admin/analysis-audit?requestId=${requestId}&extra=private`)}` } },
            ));
            expect(response.headers.get('location')).toBe(
                `https://yeosachin.com/admin0min?requestId=${requestId}&error=${error}`,
            );
            expect(response.headers.get('set-cookie')).toContain('auth_redirect_intent=;');
        },
    );

    it('keeps an explicit unrelated callback destination authoritative over a stale admin cookie', async () => {
        const response = await GET(new Request(
            'https://yeosachin.com/auth/callback?next=%2Fanalyze',
            { headers: { cookie: 'auth_redirect_intent=%2Fadmin0min' } },
        ));
        expect(response.headers.get('location')).toBe('https://yeosachin.com/login?error=no_code');
    });

    it('lands an exchange failure on a bounded code without reflecting provider details', async () => {
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: null,
            error: { message: 'private@example.com token=secret' },
        });

        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=bad-code&next=%2Fanalyze'
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/login?error=exchange_failed`
        );
        expect(response.headers.get('location')).not.toContain('private');
        expect(response.headers.get('location')).not.toContain('secret');
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: {
                request_id: '123e4567-e89b-42d3-a456-426614174010',
                trace_id: null,
                route: '/auth/callback',
                method: 'GET',
                operation: 'callback',
                disposition: 'rejected',
                error_code: 'PROVIDER_ERROR',
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private@example|token=secret|bad-code/
        );
    });

    it('records a bounded Kakao profile-sync failure without the provider token', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: {
                session: { provider_token: 'private-kakao-token' },
                user: {
                    id: userId,
                    email: 'private@example.com',
                    app_metadata: { provider: 'kakao' },
                },
            },
            error: null,
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=private-oauth-code'
        ));

        expect(response.status).toBe(307);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'auth.profile_sync_failed',
            severity: 'warn',
            fields: {
                request_id: '123e4567-e89b-42d3-a456-426614174010',
                trace_id: null,
                route: '/auth/callback',
                method: 'GET',
                user_id: userId,
                provider: 'kakao',
                operation: 'profile_sync',
                disposition: 'failed',
                error_code: 'PROVIDER_ERROR',
            },
        });
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'auth.callback_completed',
            severity: 'info',
            fields: {
                request_id: '123e4567-e89b-42d3-a456-426614174010',
                trace_id: null,
                route: '/auth/callback',
                method: 'GET',
                user_id: userId,
                provider: 'kakao',
                operation: 'callback',
                disposition: 'completed',
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private-kakao-token|private-oauth-code|private@example/
        );
    });

    it('records exactly one profile-sync failure when Kakao omits its provider token', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.exchangeCodeForSession.mockResolvedValue({
            data: {
                session: {},
                user: {
                    id: userId,
                    email: 'private@example.com',
                    app_metadata: { provider: 'kakao' },
                },
            },
            error: null,
        });

        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=private-oauth-code'
        ));

        expect(response.status).toBe(307);
        expect(mocks.emit.mock.calls.filter(([event]) => (
            event as { event?: string }).event === 'auth.profile_sync_failed'
        )).toEqual([[{
            event: 'auth.profile_sync_failed',
            severity: 'warn',
            fields: {
                request_id: '123e4567-e89b-42d3-a456-426614174010',
                trace_id: null,
                route: '/auth/callback',
                method: 'GET',
                user_id: userId,
                provider: 'kakao',
                operation: 'profile_sync',
                disposition: 'failed',
                error_code: 'PROVIDER_ERROR',
            },
        }]]);
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'auth.callback_completed',
            severity: 'info',
        }));
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private-oauth-code|private@example/
        );
    });

    it('bounds a rejected exchange without reflecting thrown details', async () => {
        mocks.exchangeCodeForSession.mockRejectedValue(
            new Error('private@example.com token=secret'),
        );

        const response = await GET(new Request(
            'https://preview.example/auth/callback?code=bad-code&next=%2Fanalyze'
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/login?error=exchange_failed`
        );
        expect(response.headers.get('location')).not.toContain('private');
        expect(response.headers.get('location')).not.toContain('secret');
    });

    it.each([
        '%2F%2Fattacker.example%2Fpath',
        '%2F%5Cattacker.example%2Fpath',
        '%2F%255cattacker.example%2Fpath',
        '%2F%252f%252fattacker.example%2Fpath',
    ])('falls back instead of redirecting an encoded hostile next value: %s', async next => {
        const response = await GET(new Request(
            `https://preview.example/auth/callback?code=oauth-code&next=${next}`
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/analyze?verified=true`
        );
    });
});
