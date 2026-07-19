import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { POST } from '@/app/api/auth/signout/route';

describe('server signout compatibility route', () => {
    beforeEach(() => {
        mocks.signOut.mockReset().mockResolvedValue({ error: null });
        mocks.createClient.mockReset().mockResolvedValue({
            auth: { signOut: mocks.signOut },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('redirects after Supabase confirms server sign out', async () => {
        const response = await POST(new Request('https://preview.example/api/auth/signout', {
            method: 'POST',
        }));

        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://yeosachin.vercel.app/');
    });

    it('returns only a bounded failure when Supabase rejects sign out', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.signOut.mockResolvedValue({
            error: new Error('private@example.com token=secret'),
        });

        const response = await POST(new Request('https://preview.example/api/auth/signout', {
            method: 'POST',
        }));
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({ error: 'Failed to sign out' });
        expect(JSON.stringify(body)).not.toContain('private@example.com');
        expect(JSON.stringify(body)).not.toContain('secret');
        expect(consoleError).toHaveBeenCalledWith('Sign out failed');
    });
});
