import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    createRlsClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getUser: vi.fn(),
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
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));
vi.mock('@/lib/services/analysis/anonymous-preflight', () => ({
    claimAnonymousAnalysisV2Preflight: mocks.claimAnonymousPreflight,
}));

import { GET } from '@/app/auth/callback/route';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';

describe('OAuth callback redirects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cookies.mockResolvedValue({
            getAll: vi.fn(() => []),
            set: vi.fn(),
        });
        mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
        mocks.claimAnonymousPreflight.mockResolvedValue(true);
        mocks.createServerClient.mockReturnValue({
            auth: {
                exchangeCodeForSession: mocks.exchangeCodeForSession,
                getUser: mocks.getUser,
            },
            rpc: vi.fn(),
        });
        mocks.createRlsClient.mockReturnValue({ rpc: vi.fn() });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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
            .mockResolvedValueOnce(true);
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

    it('lands a missing-code callback on a bounded terminal error', async () => {
        const response = await GET(new Request(
            'https://preview.example/auth/callback?next=%2Fanalyze'
        ));

        expect(response.headers.get('location')).toBe(
            `${CANONICAL_APP_ORIGIN}/login?error=no_code`
        );
        expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
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
