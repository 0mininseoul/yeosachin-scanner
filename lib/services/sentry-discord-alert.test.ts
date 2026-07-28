import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import {
    buildSentryDiscordPayload,
    deliverSentryDiscordAlerts,
    isAuthenticSentryServiceHookPath,
    parseProductionSentryIssueAlert,
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
        event: 'event.alert',
        data: {
            event: {
                environment: 'production',
                dateCreated: '2026-07-28T00:00:00.000Z',
                project: { slug: 'web-app' },
                web_url: 'https://sentry.io/organizations/acme/issues/1234/',
                message: 'private exception message',
                request: { data: { email: 'person@example.test' } },
                user: { ip_address: '203.0.113.10' },
            },
        },
        ...overrides,
    });
}

describe('Sentry Service Hook Discord bridge', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configured();
    });
    afterEach(() => vi.unstubAllEnvs());

    it('fails closed unless both independent, high-entropy URL capabilities match', () => {
        expect(isAuthenticSentryServiceHookPath(SERVICE_SECRET, PATH_SECRET)).toBe(true);
        expect(isAuthenticSentryServiceHookPath(`${SERVICE_SECRET}x`, PATH_SECRET)).toBe(false);
        expect(isAuthenticSentryServiceHookPath(SERVICE_SECRET, 'wrong')).toBe(false);
        vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_PATH_SECRET', 'short');
        expect(isAuthenticSentryServiceHookPath(SERVICE_SECRET, 'short')).toBe(false);
    });

    it('accepts only explicit production event.alert payloads with a trustworthy occurrence time', () => {
        const request = new Request('https://example.test', { headers: { 'sentry-hook-resource': 'event_alert' } });
        expect(parseProductionSentryIssueAlert(productionAlert(), request)).toMatchObject({ projectSlug: 'web-app' });
        expect(parseProductionSentryIssueAlert(productionAlert({ event: 'event.created' }), request)).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ event: 'event.alert', data: { event: { environment: 'staging' } } }), request)).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ event: 'event.alert', data: { event: { environment: 'production' } } }), request)).toBeNull();
        expect(parseProductionSentryIssueAlert(productionAlert(), new Request('https://example.test', {
            headers: { 'sentry-hook-resource': 'issue' },
        }))).toBeNull();
    });

    it('builds a PII-safe minimal Discord embed', () => {
        const parsed = parseProductionSentryIssueAlert(productionAlert(), new Request('https://example.test'));
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

    it.each([
        ['429', () => Promise.resolve(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 })), 'DISCORD_RATE_LIMITED'],
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 })), 'DISCORD_5XX'],
        ['timeout', () => Promise.reject(new Error('timeout')), 'DISCORD_TIMEOUT_OR_NETWORK'],
    ])('records and retries a transient Discord %s without throwing to the hook caller', async (_kind, response, code) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation(response);
        await expect(deliverSentryDiscordAlerts({ fetcher })).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'retry', p_failure_code: code,
        }));
    });

    it('keeps raw payloads, Discord credentials, and response details out of logs', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
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
});
