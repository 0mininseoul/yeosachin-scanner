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
            'http://localhost:3000/analyze?autostart=1'
        ));

        expect(response.headers.get('location')).toBe(
            'http://localhost:3000/login?redirectTo=%2Fanalyze%3Fautostart%3D1'
        );
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

    it('rejects an external authenticated redirect destination', async () => {
        mockAuthenticatedUser('123e4567-e89b-42d3-a456-426614174000');

        const response = await proxy(new NextRequest(
            'http://localhost:3000/login?redirectTo=https%3A%2F%2Fattacker.example'
        ));

        expect(response.headers.get('location')).toBe('http://localhost:3000/analyze');
    });
});
