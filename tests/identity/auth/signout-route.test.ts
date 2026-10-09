import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/config/dev-ui-deployment.json', () => ({
    default: { version: 1, deployments: [{ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' }] },
}));

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
        vi.unstubAllEnvs();
    });

    it('keeps signout in the verified Dev environment', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_dev_ui_test');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://devuitestproject.supabase.co');
        const response = await POST(new Request('https://dev.yeosachin.com/api/auth/signout', { method: 'POST' }));
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://dev.yeosachin.com/');
    });

    it('rejects a Dev mismatch before creating the auth client', async () => {
        vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
        vi.stubEnv('VERCEL_PROJECT_ID', 'prj_production_test');
        const response = await POST(new Request('https://dev.yeosachin.com/api/auth/signout', { method: 'POST' }));
        expect(response.status).toBe(503);
        expect(mocks.createClient).not.toHaveBeenCalled();
    });

    it('redirects after Supabase confirms server sign out', async () => {
        const response = await POST(new Request('https://preview.example/api/auth/signout', {
            method: 'POST',
        }));

        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://yeosachin.com/');
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
