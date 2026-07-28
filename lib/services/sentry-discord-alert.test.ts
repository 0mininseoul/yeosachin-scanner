import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import {
    buildSentryDiscordPayload,
    deliverSentryDiscordAlerts,
    isAuthenticSentryServiceHook,
    parseProductionSentryIssueAlert,
    reconcileStaleSentryDiscordAlertClaims,
} from './sentry-discord-alert';

const SERVICE_SECRET = 'a'.repeat(48);
const PATH_SECRET = 'b'.repeat(48);
const ITEM = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    claim_token: '223e4567-e89b-42d3-a456-426614174000',
    project_slug: 'web-app',
    occurred_at: '2026-07-28T00:00:00.000Z',
    issue_url: 'https://sentry.io/organizations/acme/issues/1234/',
    attempts: 1,
};

function configured() {
    vi.stubEnv('SENTRY_DISCORD_ALERTS_ENABLED', 'true');
    vi.stubEnv('SENTRY_DISCORD_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('SENTRY_DISCORD_CHANNEL_ID', '1525023310675710092');
    vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_SECRET', SERVICE_SECRET);
    vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_PATH_SECRET', PATH_SECRET);
}

function productionAlert(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        // Official Service Hook v0 shape from sentry_apps/tasks/service_hooks.py:
        // top-level project, group, event; the event environment is an event tag.
        project: { slug: 'web-app', name: 'Private project name' },
        group: { id: '1234', url: 'https://sentry.io/organizations/acme/issues/1234/' },
        event: {
            id: 'a'.repeat(32),
            eventID: 'a'.repeat(32),
            groupID: '1234',
            dateCreated: '2026-07-28T00:00:00.000Z',
            tags: [{ key: 'environment', value: 'production' }],
            message: 'private exception message',
            entries: [{ data: { values: [{ stacktrace: 'private stacktrace' }] } }],
            user: { email: 'person@example.test', ip_address: '203.0.113.10' },
        },
        ...overrides,
    });
}

function signedRequest(body: string, signature = createHmac('sha256', SERVICE_SECRET).update(body).digest('hex')) {
    return new Request('https://example.test', {
        headers: {
            'x-servicehook-timestamp': '1785196800',
            'x-servicehook-guid': '123e4567-e89b-42d3-a456-426614174000',
            'x-servicehook-signature': signature,
        },
    });
}

describe('Sentry Service Hook Discord bridge', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configured();
    });
    afterEach(() => vi.unstubAllEnvs());

    it('verifies the official v0 raw-body HMAC and both URL capabilities', () => {
        const body = productionAlert();
        expect(isAuthenticSentryServiceHook(signedRequest(body), body, PATH_SECRET)).toBe(true);
        expect(isAuthenticSentryServiceHook(signedRequest(body, '0'.repeat(64)), body, PATH_SECRET)).toBe(false);
        expect(isAuthenticSentryServiceHook(signedRequest(body), body, 'wrong')).toBe(false);
        vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_PATH_SECRET', 'short');
        expect(isAuthenticSentryServiceHook(signedRequest(body), body, 'short')).toBe(false);
    });

    it('accepts the actual v0 production payload contract and rejects non-production or non-v0 payloads', () => {
        expect(parseProductionSentryIssueAlert(productionAlert())).toMatchObject({ projectSlug: 'web-app' });
        expect(parseProductionSentryIssueAlert(productionAlert({ event: { tags: [{ key: 'environment', value: 'staging' }] } }))).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ event: 'event.alert', data: { event: { environment: 'production' } } }))).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ project: { slug: 'web-app' }, group: {}, event: { tags: [] } }))).toBeNull();
    });

    it('builds a PII-safe minimal Discord embed', () => {
        const parsed = parseProductionSentryIssueAlert(productionAlert());
        expect(parsed).not.toBeNull();
        const embed = buildSentryDiscordPayload({
            project_slug: parsed!.projectSlug,
            occurred_at: parsed!.occurredAt.toISOString(),
            issue_url: parsed!.issueUrl,
        });
        const rendered = JSON.stringify(embed);
        expect(embed.embeds[0].title).toBe('🚨 Sentry 오류 알림');
        expect(embed.allowed_mentions).toEqual({ parse: [] });
        expect(rendered).not.toContain('private exception message');
        expect(rendered).not.toContain('person@example.test');
        expect(rendered).not.toContain('203.0.113.10');
        expect(rendered).not.toContain('request');
    });

    it('claims once across concurrent dispatchers and records a successful send', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        await Promise.all([deliverSentryDiscordAlerts({ fetcher }), deliverSentryDiscordAlerts({ fetcher })]);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
            nonce: '123e4567e89b42d3a45642661', enforce_nonce: true,
        });
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'sent', p_outbox_id: ITEM.id,
        }));
    });

    it('claims a specific freshly-enqueued fingerprint for immediate dispatch instead of queue head', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        await deliverSentryDiscordAlerts({ dedupeKey: 'f'.repeat(64), fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) });
        expect(mocks.rpc).toHaveBeenCalledWith('claim_sentry_discord_alert_outbox', {
            p_limit: 10,
            p_dedupe_key: 'f'.repeat(64),
        });
    });

    it.each([
        ['429', () => Promise.resolve(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 })), 'DISCORD_RATE_LIMITED'],
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 })), 'DISCORD_5XX'],
        ['timeout', () => Promise.reject(new Error('timeout')), 'DISCORD_TIMEOUT_OR_NETWORK'],
    ])('records and retries a transient Discord %s without throwing to the hook caller', async (_kind, response, code) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation(response);
        await expect(deliverSentryDiscordAlerts({ fetcher })).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'retry', p_failure_code: code,
        }));
    });

    it.each([
        ['429', () => Promise.resolve(new Response(JSON.stringify({ retry_after: 1 }), { status: 429 }))],
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 }))],
        ['timeout', () => Promise.reject(new Error('timeout'))],
    ])('performs one bounded immediate %s retry before preserving later durable retry state', async (_kind, firstAttempt) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn()
            .mockImplementationOnce(firstAttempt)
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(deliverSentryDiscordAlerts({ fetcher, immediateRetry: true })).resolves.toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'sent', p_failure_code: null,
        }));
    });

    it('keeps raw payloads, Discord credentials, and response details out of logs', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const privatePayload = productionAlert();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await deliverSentryDiscordAlerts({ fetcher: vi.fn().mockResolvedValue(new Response(privatePayload, { status: 403 })) });
        const logged = JSON.stringify(errorSpy.mock.calls);
        expect(logged).not.toContain('test-bot-token');
        expect(logged).not.toContain('person@example.test');
        expect(logged).not.toContain('private exception message');
        expect(logged).not.toContain('https://discord.com');
    });

    it('does not POST when the durable pre-send fence cannot be recorded', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: false, error: null });
        const fetcher = vi.fn();
        await expect(deliverSentryDiscordAlerts({ fetcher })).resolves.toBe(1);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('reconciles a stale sending lease through the durable RPC without sending', async () => {
        mocks.rpc.mockResolvedValueOnce({ data: 1, error: null });
        await expect(reconcileStaleSentryDiscordAlertClaims()).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('reconcile_stale_sentry_discord_alert_claims');
    });
});
