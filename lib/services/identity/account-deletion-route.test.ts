import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(async () => ({
        auth: { getUser: mocks.getUser, signOut: mocks.signOut },
    })),
}));
vi.mock('@/lib/services/identity/account-deletion', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./account-deletion')>()),
    deleteAccountPermanently: mocks.deleteAccount,
}));

import { POST } from '@/app/api/account/delete/route';

function request(body: unknown, origin = 'https://example.test') {
    return new Request('https://example.test/api/account/delete', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('account deletion route', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.getUser.mockResolvedValue({
            data: { user: { id: '6d809496-1cb8-4e4f-a081-8efc14a7a64c' } },
            error: null,
        });
        mocks.deleteAccount.mockResolvedValue(undefined);
        mocks.signOut.mockResolvedValue({ error: null });
    });

    it('rejects cross-origin and unconfirmed mutations', async () => {
        expect((await POST(request({ confirmation: '탈퇴' }, 'https://evil.test'))).status).toBe(403);
        expect((await POST(request({ confirmation: '삭제' }))).status).toBe(400);
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it('requires an authenticated user', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        expect((await POST(request({ confirmation: '탈퇴' }))).status).toBe(401);
    });

    it('deletes the authenticated account and clears the local session', async () => {
        const response = await POST(request({ confirmation: '탈퇴' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ deleted: true });
        expect(mocks.deleteAccount).toHaveBeenCalledWith('6d809496-1cb8-4e4f-a081-8efc14a7a64c');
        expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });
});
