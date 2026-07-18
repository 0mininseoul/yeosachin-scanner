import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getUser: vi.fn(),
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
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
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
        mocks.createServerClient.mockReturnValue({
            auth: {
                exchangeCodeForSession: mocks.exchangeCodeForSession,
                getUser: mocks.getUser,
            },
        });
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
