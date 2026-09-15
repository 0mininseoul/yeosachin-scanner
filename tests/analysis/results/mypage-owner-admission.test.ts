import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    rpc: vi.fn(),
    requireActiveAccountSession: vi.fn(),
    redirect: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createClient,
}));
vi.mock('@/lib/services/identity/account-principal-store', () => ({
    requireActiveAccountSession: mocks.requireActiveAccountSession,
}));
vi.mock('next/navigation', () => ({
    redirect: mocks.redirect,
}));
vi.mock('@/components/case-ui', () => ({
    TopBar: () => null,
    Eyebrow: () => null,
}));
vi.mock('@/components/logout-button', () => ({
    LogoutButton: () => null,
}));
vi.mock('@/app/mypage/analysis-list', () => ({
    default: () => null,
}));
vi.mock('@/lib/services/demo-analysis/demo-analysis', () => ({
    isDemoOperator: vi.fn(() => false),
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { listForOwner: vi.fn() },
}));
vi.mock('@/lib/services/demo-analysis/archive', () => ({
    demoArchiveItems: vi.fn(() => []),
}));

import MyPage from '@/app/mypage/page';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('mypage owner admission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({
            auth: { getUser: mocks.getUser },
            rpc: mocks.rpc,
        });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: USER_ID, email: 'review@example.test' } },
            error: null,
        });
        mocks.requireActiveAccountSession.mockResolvedValue({
            userId: USER_ID,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'runtime_default_v1',
        });
        mocks.rpc.mockResolvedValue({
            data: { schemaVersion: 1, items: [] },
            error: null,
        });
    });

    it('does not load owner history for a retired account', async () => {
        const redirectError = new Error('NEXT_REDIRECT');
        mocks.requireActiveAccountSession.mockRejectedValue(
            new Error('ACCOUNT_ADMISSION_DENIED')
        );
        mocks.redirect.mockImplementation(() => {
            throw redirectError;
        });

        await expect(MyPage()).rejects.toBe(redirectError);

        expect(mocks.redirect).toHaveBeenCalledWith(
            '/login?error=account_unavailable'
        );
        expect(mocks.requireActiveAccountSession).toHaveBeenCalledWith(
            expect.objectContaining({ id: USER_ID }),
        );
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
