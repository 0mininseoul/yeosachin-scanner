import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    enabled: vi.fn(),
    hasAccess: vi.fn(),
    redirect: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/betatest-access', () => ({
    betaTestFreePoolEnabled: mocks.enabled,
    hasBetaTestAccess: mocks.hasAccess,
}));
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
        mocks.hasAccess.mockResolvedValue(true);
    });

    it('redirects an unauthenticated visitor to the exact safe beta-test return path', async () => {
        mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
        mocks.redirect.mockImplementation((path: string) => { throw new Error(path); });

        await expect(BetaTestPage()).rejects.toThrow('/login?redirectTo=%2Fbetatest');
    });

    it('does not render an analysis form when the feature is disabled', async () => {
        mocks.enabled.mockReturnValue(false);

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('베타 테스트를 이용할 수 없습니다.');
        expect(markup).not.toContain('id="beta-target-instagram"');
        expect(mocks.hasAccess).not.toHaveBeenCalled();
    });

    it('does not render an analysis form for an authenticated user without a self-grant', async () => {
        mocks.hasAccess.mockResolvedValue(false);

        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('베타 테스트를 이용할 수 없습니다.');
        expect(markup).not.toContain('id="beta-target-instagram"');
    });

    it('renders the checkout-free form only after the enabled self-grant check passes', async () => {
        const markup = renderToStaticMarkup(await BetaTestPage());

        expect(markup).toContain('id="beta-target-instagram"');
        expect(markup).toContain('무료 판독 가능 여부 확인');
        expect(mocks.hasAccess).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.any(Object) }));
    });
});
