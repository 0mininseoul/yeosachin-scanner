import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authentic: vi.fn(),
    parse: vi.fn(),
    enqueue: vi.fn(),
}));

vi.mock('@/lib/services/sentry-discord-alert', () => ({
    isAuthenticSentryServiceHookPath: mocks.authentic,
    parseProductionSentryIssueAlert: mocks.parse,
    enqueueSentryDiscordAlert: mocks.enqueue,
}));

import { POST } from '@/app/api/webhooks/sentry/[serviceHookSecret]/[pathSecret]/route';

const context = (serviceHookSecret = 'service', pathSecret = 'path') => ({
    params: Promise.resolve({ serviceHookSecret, pathSecret }),
});

describe('Sentry Service Hook route', () => {
    beforeEach(() => vi.resetAllMocks());
    afterEach(() => vi.unstubAllEnvs());

    it('rejects unauthenticated requests before reading or parsing their body', async () => {
        mocks.authentic.mockReturnValue(false);
        const response = await POST(new Request('https://example.test/api/webhooks/sentry/wrong/wrong', {
            method: 'POST', body: '{"secret":"private"}',
        }), context('wrong', 'wrong'));
        expect(response.status).toBe(401);
        expect(mocks.parse).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('acknowledges non-production/non-issue signals without sending a notification', async () => {
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(null);
        const response = await POST(new Request('https://example.test', { method: 'POST', body: '{"event":"event.created"}' }), context());
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: false });
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('returns 202 after a durable enqueue and makes a pre-durable outage retryable without exposing payload', async () => {
        const alert = { dedupeKey: 'a'.repeat(64), projectSlug: null, occurredAt: new Date(), issueUrl: null };
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(alert);
        mocks.enqueue.mockResolvedValue(true);
        const accepted = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }), context());
        expect(accepted.status).toBe(202);
        expect(mocks.enqueue).toHaveBeenCalledWith(alert);

        mocks.enqueue.mockRejectedValueOnce(new Error('database unavailable private=value'));
        const retry = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }), context());
        expect(retry.status).toBe(503);
        expect(await retry.text()).not.toContain('private');
    });
});
