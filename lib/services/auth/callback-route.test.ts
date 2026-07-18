import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getUser: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

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
