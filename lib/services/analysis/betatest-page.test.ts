import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    enabled: vi.fn(),
    ensureAccess: vi.fn(),
    requireActiveAccountSession: vi.fn(),
    redirect: vi.fn(),
    admin: { rpc: vi.fn() },
    authButtons: vi.fn(() => 'AUTH_BUTTONS'),
    landingPage: vi.fn(() => 'SHARED_LANDING'),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/services/analysis/betatest-access', () => ({
    betaTestFreePoolEnabled: mocks.enabled,
    ensureBetaTestAccess: mocks.ensureAccess,
}));
vi.mock('@/lib/services/identity/account-principal-store', () => ({
    requireActiveAccountSession: mocks.requireActiveAccountSession,
}));
vi.mock('@/components/auth-buttons', () => ({ AuthButtons: mocks.authButtons }));
vi.mock('@/components/landing-page', () => ({ default: mocks.landingPage }));
vi.mock('next/navigation', () => ({
    redirect: mocks.redirect,
    useRouter: () => ({ push: vi.fn() }),
}));

import BetaTestPage from '@/app/betatest/page';

describe('beta-test entry page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser }, rpc: vi.fn() });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: '123e4567-e89b-42d3-a456-426614174000' } },
            error: null,
        });
        mocks.enabled.mockReturnValue(true);
        mocks.ensureAccess.mockResolvedValue(true);
        mocks.requireActiveAccountSession.mockResolvedValue({
            userId: '123e4567-e89b-42d3-a456-426614174000',
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'runtime_default_v1',
        });
    });

    it('renders the shared homepage landing with a beta OAuth return path for an unauthenticated visitor', async () => {
        mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('SHARED_LANDING');
        expect(mocks.landingPage).toHaveBeenCalledWith(
            expect.objectContaining({ loginRedirectTo: '/betatest' }),
            undefined,
        );
        expect(mocks.enabled).not.toHaveBeenCalled();
        expect(mocks.ensureAccess).not.toHaveBeenCalled();
    });

    it('does not render an analysis form when the feature is disabled', async () => {
        mocks.enabled.mockReturnValue(false);

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('베타 테스트를 이용할 수 없습니다.');
        expect(markup).not.toContain('id="beta-target-instagram"');
        expect(mocks.ensureAccess).not.toHaveBeenCalled();
    });

    it('does not render an analysis form for an authenticated user without a self-grant', async () => {
        mocks.ensureAccess.mockResolvedValue(false);

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('베타 테스트를 이용할 수 없습니다.');
        expect(markup).not.toContain('id="beta-target-instagram"');
    });

    it('does not issue a beta entitlement or render the form for a retired account', async () => {
        mocks.requireActiveAccountSession.mockRejectedValue(
            new Error('ACCOUNT_ADMISSION_DENIED')
        );

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('베타 테스트를 이용할 수 없습니다.');
        expect(markup).not.toContain('id="beta-target-instagram"');
        expect(mocks.ensureAccess).not.toHaveBeenCalled();
    });

    it('renders the checkout-free form only after the enabled self-grant check passes', async () => {
        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('id="beta-target-instagram"');
        expect(markup).toContain('무료 판독 가능 여부 확인');
        expect(mocks.ensureAccess).toHaveBeenCalledWith(mocks.admin, '123e4567-e89b-42d3-a456-426614174000');
    });
});
