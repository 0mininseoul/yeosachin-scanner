import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), reconcile: vi.fn() }));
vi.mock('@/lib/services/sentry-discord-alert', () => ({
    deliverSentryDiscordAlerts: mocks.deliver,
    reconcileStaleSentryDiscordAlertClaims: mocks.reconcile,
}));

import { GET } from '@/app/api/internal/sentry-discord-alert-outbox/route';

describe('Sentry Discord outbox recovery cron', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('CRON_SECRET', 'cron-test-secret');
        mocks.reconcile.mockResolvedValue(2);
        mocks.deliver.mockResolvedValue(3);
    });
    afterEach(() => vi.unstubAllEnvs());

    it('requires the cron secret and recovers stale claims before dispatching', async () => {
        expect((await GET(new Request('https://example.test/api/internal/sentry-discord-alert-outbox'))).status).toBe(401);
        const response = await GET(new Request('https://example.test/api/internal/sentry-discord-alert-outbox', {
            headers: { authorization: 'Bearer cron-test-secret' },
        }));
        expect(await response.json()).toEqual({ claimed: 3, reconciled: 2 });
        expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.deliver.mock.invocationCallOrder[0]);
    });
});
