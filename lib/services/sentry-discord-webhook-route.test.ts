import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authentic: vi.fn(),
    parse: vi.fn(),
    enqueue: vi.fn(),
    deliver: vi.fn(),
}));

vi.mock('@/lib/services/sentry-discord-alert', () => ({
    isAuthenticSentryServiceHook: mocks.authentic,
    parseProductionSentryIssueAlert: mocks.parse,
    enqueueSentryDiscordAlert: mocks.enqueue,
    deliverSentryDiscordAlerts: mocks.deliver,
}));

import { POST } from '@/app/api/webhooks/sentry/[pathSecret]/route';

const context = (pathSecret = 'path') => ({
    params: Promise.resolve({ pathSecret }),
});

describe('Sentry Service Hook route', () => {
    beforeEach(() => vi.resetAllMocks());
    afterEach(() => vi.unstubAllEnvs());

    it('rejects an invalid raw-body signature before parsing or enqueueing', async () => {
        mocks.authentic.mockReturnValue(false);
        const response = await POST(new Request('https://example.test/api/webhooks/sentry/wrong/wrong', {
            method: 'POST', body: '{"secret":"private"}',
        }), context('wrong'));
        expect(response.status).toBe(401);
        expect(mocks.authentic).toHaveBeenCalledWith(expect.any(Request), '{"secret":"private"}', 'wrong');
        expect(mocks.parse).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('acknowledges non-production/non-v0 signals without sending a notification', async () => {
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(null);
        const response = await POST(new Request('https://example.test', { method: 'POST', body: '{"event":"event.created"}' }), context());
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: false });
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.deliver).not.toHaveBeenCalled();
    });

    it('returns 202 after durable enqueue even when immediate dispatch fails, and keeps pre-durable outage retryable', async () => {
        const alert = { dedupeKey: 'a'.repeat(64), projectSlug: null, occurredAt: new Date(), issueUrl: null };
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(alert);
        mocks.enqueue.mockResolvedValue(true);
        mocks.deliver.mockResolvedValue(1);
        const accepted = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }), context());
        expect(accepted.status).toBe(202);
        expect(mocks.enqueue).toHaveBeenCalledWith(alert);
        expect(mocks.deliver).toHaveBeenCalledWith({ limit: 1 });

        mocks.deliver.mockRejectedValueOnce(new Error('Discord unreachable private=value'));
        const dispatchFailure = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }), context());
        expect(dispatchFailure.status).toBe(202);

        mocks.enqueue.mockRejectedValueOnce(new Error('database unavailable private=value'));
        const retry = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }), context());
        expect(retry.status).toBe(503);
        expect(await retry.text()).not.toContain('private');
    });
});
