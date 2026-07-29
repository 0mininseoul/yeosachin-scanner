import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authentic: vi.fn(),
    parse: vi.fn(),
    enqueue: vi.fn(),
    dispatchImmediately: vi.fn(),
    enabled: vi.fn(),
}));

vi.mock('@/lib/services/sentry-discord-alert', () => ({
    isAuthenticSentryInternalIntegration: mocks.authentic,
    parseProductionSentryInternalIntegrationIssue: mocks.parse,
    enqueueSentryDiscordAlert: mocks.enqueue,
    dispatchSentryDiscordAlertImmediately: mocks.dispatchImmediately,
    sentryDiscordAlertsEnabled: mocks.enabled,
}));

import { POST } from '@/app/api/webhooks/sentry/internal-integration/route';

describe('Sentry Internal Integration Discord route', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.enabled.mockReturnValue(true);
    });

    it('rejects an invalid HMAC before parsing or persisting the webhook body', async () => {
        mocks.authentic.mockReturnValue(false);
        const response = await POST(new Request('https://example.test/api/webhooks/sentry/internal-integration', {
            method: 'POST', body: '{"user":{"email":"person@example.test"}}',
        }));
        expect(response.status).toBe(401);
        expect(mocks.parse).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('durably enqueues a valid issue.created alert and immediately dispatches its stable dedupe key', async () => {
        const alert = { dedupeKey: 'c'.repeat(64), projectSlug: 'ai-baram-detector-1', occurredAt: new Date(), issueUrl: null };
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(alert);
        mocks.enqueue.mockResolvedValue(true);
        mocks.dispatchImmediately.mockResolvedValue(1);
        const response = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: true });
        expect(mocks.enqueue).toHaveBeenCalledWith(alert);
        expect(mocks.dispatchImmediately).toHaveBeenCalledWith(alert.dedupeKey);
    });

    it('acknowledges authenticated wrong action, resource, project, or environment payloads without sending', async () => {
        mocks.authentic.mockReturnValue(true);
        mocks.parse.mockReturnValue(null);
        const response = await POST(new Request('https://example.test', { method: 'POST', body: '{"private":"value"}' }));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ accepted: false });
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.dispatchImmediately).not.toHaveBeenCalled();
    });
});
