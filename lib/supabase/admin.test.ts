import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: mocks.createClient,
}));

describe('supabaseAdmin', () => {
    beforeEach(() => {
        vi.resetModules();
        mocks.createClient.mockReset();
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('does not initialize or require credentials when the module is imported', async () => {
        const { supabaseAdmin } = await import('./admin');

        expect(supabaseAdmin).toBeDefined();
        expect(mocks.createClient).not.toHaveBeenCalled();
    });

    it('reports missing credentials on first client use instead of import', async () => {
        const { supabaseAdmin } = await import('./admin');

        expect(() => supabaseAdmin.from('analysis_requests')).toThrow(
            'NEXT_PUBLIC_SUPABASE_URL is not configured'
        );
        expect(mocks.createClient).not.toHaveBeenCalled();
    });

    it('creates and reuses one client after credentials are available', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
        const from = vi.fn().mockReturnValue({ table: 'analysis_requests' });
        mocks.createClient.mockReturnValue({ from });

        const { supabaseAdmin } = await import('./admin');

        expect(mocks.createClient).not.toHaveBeenCalled();
        expect(supabaseAdmin.from('analysis_requests')).toEqual({
            table: 'analysis_requests',
        });
        expect(supabaseAdmin.from('analysis_results')).toEqual({
            table: 'analysis_requests',
        });
        expect(mocks.createClient).toHaveBeenCalledTimes(1);
        expect(mocks.createClient).toHaveBeenCalledWith(
            'https://project.supabase.co',
            'service-role-key',
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false,
                },
            }
        );
        expect(from).toHaveBeenNthCalledWith(1, 'analysis_requests');
        expect(from).toHaveBeenNthCalledWith(2, 'analysis_results');
    });
});
