import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deliver: vi.fn(),
    reconcile: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('@/lib/services/identity/kakao-signup-discord', () => ({
    deliverKakaoSignupDiscordNotifications: mocks.deliver,
    reconcileStaleKakaoSignupDiscordClaims: mocks.reconcile,
    recoverUnstagedKakaoSignupDiscordNotifications: mocks.recover,
}));

import { GET } from '@/app/api/internal/kakao-signup-discord-outbox/route';

describe('Kakao signup Discord cron route', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('CRON_SECRET', 'cron-test-secret');
        mocks.reconcile.mockResolvedValue(2);
        mocks.recover.mockResolvedValue(1);
        mocks.deliver.mockResolvedValue(3);
    });
    afterEach(() => vi.unstubAllEnvs());

    it('rejects a missing or invalid Vercel CRON_SECRET authorization header', async () => {
        expect((await GET(new Request('https://example.test/api/internal/kakao-signup-discord-outbox'))).status).toBe(401);
        expect((await GET(new Request('https://example.test/api/internal/kakao-signup-discord-outbox', {
            headers: { authorization: 'Bearer wrong' },
        }))).status).toBe(401);
        expect(mocks.deliver).not.toHaveBeenCalled();
    });

    it('accepts the Vercel CRON_SECRET header and reconciles before delivery', async () => {
        const response = await GET(new Request('https://example.test/api/internal/kakao-signup-discord-outbox', {
            headers: { authorization: 'Bearer cron-test-secret' },
        }));
        expect(await response.json()).toEqual({ claimed: 3, reconciled: 2, recovered: 1 });
        expect(mocks.recover).toHaveBeenCalledOnce();
        expect(mocks.reconcile).toHaveBeenCalledOnce();
        expect(mocks.deliver).toHaveBeenCalledWith({ limit: 10 });
    });
});
