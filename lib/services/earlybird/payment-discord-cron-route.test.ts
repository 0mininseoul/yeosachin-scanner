import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deliver: vi.fn(),
    reconcile: vi.fn(),
}));

vi.mock('@/lib/services/earlybird/payment-discord', () => ({
    deliverEarlybirdPaymentDiscordNotifications: mocks.deliver,
    reconcileStaleEarlybirdPaymentDiscordClaims: mocks.reconcile,
}));

import { GET } from '@/app/api/internal/earlybird-payment-discord-outbox/route';

describe('Earlybird payment Discord outbox recovery cron', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('CRON_SECRET', 'cron-test-secret');
        mocks.reconcile.mockResolvedValue(2);
        mocks.deliver.mockResolvedValue(3);
    });

    afterEach(() => vi.unstubAllEnvs());

    it('requires the cron secret', async () => {
        expect((await GET(new Request('https://example.test/api/internal/earlybird-payment-discord-outbox'))).status).toBe(401);
        expect((await GET(new Request('https://example.test/api/internal/earlybird-payment-discord-outbox', {
            headers: { authorization: 'Bearer wrong' },
        }))).status).toBe(401);
        expect(mocks.deliver).not.toHaveBeenCalled();
    });

    it('reconciles stale claims before dispatching due notifications', async () => {
        const response = await GET(new Request('https://example.test/api/internal/earlybird-payment-discord-outbox', {
            headers: { authorization: 'Bearer cron-test-secret' },
        }));

        expect(await response.json()).toEqual({ claimed: 3, reconciled: 2 });
        expect(mocks.reconcile).toHaveBeenCalledOnce();
        expect(mocks.deliver).toHaveBeenCalledWith({ limit: 10 });
        expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.deliver.mock.invocationCallOrder[0]
        );
    });
});
