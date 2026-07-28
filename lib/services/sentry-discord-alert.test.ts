import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import {
    buildSentryDiscordPayload,
    deliverSentryDiscordAlerts,
    isAuthenticSentryInternalIntegration,
    isAuthenticSentryServiceHook,
    parseProductionSentryInternalIntegrationIssue,
    parseProductionSentryIssueAlert,
    reconcileStaleSentryDiscordAlertClaims,
} from './sentry-discord-alert';

const SERVICE_SECRET = 'a'.repeat(48);
const PATH_SECRET = 'b'.repeat(48);
const INTERNAL_INTEGRATION_SECRET = 'c'.repeat(48);
const ITEM = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    claim_token: '223e4567-e89b-42d3-a456-426614174000',
    project_slug: 'web-app',
    occurred_at: '2026-07-28T00:00:00.000Z',
    issue_url: 'https://sentry.io/organizations/acme/issues/1234/',
    issue_short_id: 'WEB-1234', error_type: 'TypeError', release: 'v1.2.3',
    attempts: 1,
};

function configured() {
    vi.stubEnv('SENTRY_DISCORD_ALERTS_ENABLED', 'true');
    vi.stubEnv('SENTRY_DISCORD_BOT_TOKEN', 'test-bot-token');
    vi.stubEnv('SENTRY_DISCORD_CHANNEL_ID', '1525023310675710092');
    vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_SECRET', SERVICE_SECRET);
    vi.stubEnv('SENTRY_DISCORD_SERVICE_HOOK_PATH_SECRET', PATH_SECRET);
    vi.stubEnv('SENTRY_DISCORD_ALERTS_INTERNAL_INTEGRATION_CLIENT_SECRET', INTERNAL_INTEGRATION_SECRET);
}

function productionAlert(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        // Official Service Hook v0 shape from sentry_apps/tasks/service_hooks.py:
        // top-level project, group, event; the event environment is an event tag.
        project: { slug: 'web-app', name: 'Private project name' },
        group: { id: '1234', shortId: 'WEB-1234', url: 'https://sentry.io/organizations/acme/issues/1234/' },
        event: {
            id: 'a'.repeat(32),
            eventID: 'a'.repeat(32),
            groupID: '1234',
            dateCreated: '2026-07-28T00:00:00.000Z',
            tags: [{ key: 'environment', value: 'production' }],
            exception: { values: [{ type: 'TypeError' }] }, release: 'v1.2.3',
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

function internalIntegrationIssue(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        action: 'created',
        installation: { uuid: '123e4567-e89b-42d3-a456-426614174000' },
        data: {
            issue: {
                id: '987654321',
                title: 'private exception title',
                permalink: 'https://sentry.io/organizations/acme/issues/987654321/',
                project: { slug: 'ai-baram-detector' },
                firstSeen: '2026-07-28T00:00:00.000Z',
                environment: 'production',
                shortId: 'AI-1234', metadata: { type: 'TypeError', release: 'v1.2.3' },
                user: { email: 'person@example.test' },
                request: { headers: { authorization: 'private bearer token' } },
            },
        },
        actor: { id: 'sentry' },
        ...overrides,
    });
}

function signedInternalIntegrationRequest(body: string, signature?: string, resource = 'issue') {
    return new Request('https://example.test/api/webhooks/sentry/internal-integration', {
        headers: {
            'sentry-hook-resource': resource,
            'sentry-hook-signature': signature ?? createHmac('sha256', INTERNAL_INTEGRATION_SECRET)
                .update(body, 'utf8').digest('hex'),
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

    it('verifies the Internal Integration exact-body HMAC and issue resource in constant time', () => {
        const body = internalIntegrationIssue();
        expect(isAuthenticSentryInternalIntegration(signedInternalIntegrationRequest(body), body)).toBe(true);
        expect(isAuthenticSentryInternalIntegration(
            signedInternalIntegrationRequest(body, '0'.repeat(64)), body,
        )).toBe(false);
        expect(isAuthenticSentryInternalIntegration(
            signedInternalIntegrationRequest(body, undefined, 'event_alert'), body,
        )).toBe(false);
        expect(isAuthenticSentryInternalIntegration(new Request('https://example.test', {
            headers: { 'sentry-hook-resource': 'issue', 'sentry-hook-signature': '0'.repeat(64) },
        }), '{not-json')).toBe(false);
    });

    it('accepts escaped Unicode and noncanonical JSON only when signed as the exact raw body', () => {
        const body = '{  "data" : { "issue" : { "project" : { "slug" : "ai-baram-detector" }, "id" : "987654321", "firstSeen" : "2026-07-28T00:00:00.000Z", "environment" : "production", "title" : "\\uC548\\uB155" } }, "action" : "created" }';
        const normalizedSignature = createHmac('sha256', INTERNAL_INTEGRATION_SECRET)
            .update(JSON.stringify(JSON.parse(body)), 'utf8').digest('hex');
        expect(isAuthenticSentryInternalIntegration(signedInternalIntegrationRequest(body), body)).toBe(true);
        expect(isAuthenticSentryInternalIntegration(
            signedInternalIntegrationRequest(body, normalizedSignature), body,
        )).toBe(false);
    });

    it('accepts only a created production ai-baram-detector issue and uses a stable privacy-safe dedupe key', () => {
        const accepted = parseProductionSentryInternalIntegrationIssue(internalIntegrationIssue());
        const duplicate = parseProductionSentryInternalIntegrationIssue(internalIntegrationIssue({
            data: { issue: {
                id: '987654321', project: { slug: 'ai-baram-detector' },
                firstSeen: '2026-07-28T00:00:00.000Z', environment: 'production',
                title: 'different private exception title',
            } },
        }));
        expect(accepted).toMatchObject({ projectSlug: 'ai-baram-detector' });
        expect(duplicate?.dedupeKey).toBe(accepted?.dedupeKey);
        expect(parseProductionSentryInternalIntegrationIssue(internalIntegrationIssue({ action: 'resolved' }))).toBeNull();
        expect(parseProductionSentryInternalIntegrationIssue(internalIntegrationIssue({
            data: { issue: { id: '987654321', project: { slug: 'other-project' }, firstSeen: '2026-07-28T00:00:00Z', environment: 'production' } },
        }))).toBeNull();
        expect(parseProductionSentryInternalIntegrationIssue(internalIntegrationIssue({
            data: { issue: { id: '987654321', project: { slug: 'ai-baram-detector' }, firstSeen: '2026-07-28T00:00:00Z', environment: 'staging' } },
        }))).toBeNull();
        expect(JSON.stringify(accepted)).not.toContain('person@example.test');
        expect(JSON.stringify(accepted)).not.toContain('private exception title');
        expect(JSON.stringify(accepted)).not.toContain('private bearer token');
    });

    it('accepts the actual v0 production payload contract and rejects non-production or non-v0 payloads', () => {
        expect(parseProductionSentryIssueAlert(productionAlert())).toMatchObject({ projectSlug: 'web-app' });
        expect(parseProductionSentryIssueAlert(productionAlert({ event: { tags: [{ key: 'environment', value: 'staging' }] } }))).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ event: 'event.alert', data: { event: { environment: 'production' } } }))).toBeNull();
        expect(parseProductionSentryIssueAlert(JSON.stringify({ project: { slug: 'web-app' }, group: {}, event: { tags: [] } }))).toBeNull();
    });

    it('builds a PII-safe minimal Discord embed', () => {
        const parsed = parseProductionSentryIssueAlert(productionAlert());
        expect(parsed).toMatchObject({ issueShortId: 'WEB-1234', errorType: 'TypeError', release: 'v1.2.3' });
        const embed = buildSentryDiscordPayload({
            project_slug: parsed!.projectSlug,
            occurred_at: parsed!.occurredAt.toISOString(),
            issue_url: parsed!.issueUrl,
            issue_short_id: parsed!.issueShortId, error_type: parsed!.errorType, release: parsed!.release,
        });
        const rendered = JSON.stringify(embed);
        expect(embed.embeds[0].title).toBe('🚨 Sentry 오류 알림');
        expect(embed.allowed_mentions).toEqual({ parse: [] });
        expect(rendered).not.toContain('private exception message');
        expect(rendered).not.toContain('person@example.test');
        expect(rendered).not.toContain('203.0.113.10');
        expect(rendered).not.toContain('request');
        expect(rendered).toContain('WEB-1234');
        expect(rendered).toContain('TypeError');
        expect(rendered).toContain('v1.2.3');
    });

    it('drops malicious issue summary values and renders only safe defaults', () => {
        const parsed = parseProductionSentryIssueAlert(productionAlert({
            group: { shortId: 'WEB-1234?token=secret' },
            event: { dateCreated: '2026-07-28T00:00:00.000Z', tags: [{ key: 'environment', value: 'production' }, { key: 'release', value: 'person@example.test' }], exception: { values: [{ type: 'TypeError: person@example.test' }] } },
        }));
        expect(parsed).toMatchObject({ issueShortId: null, errorType: null, release: null });
        const rendered = JSON.stringify(buildSentryDiscordPayload({ project_slug: null, occurred_at: '2026-07-28T00:00:00Z', issue_url: null, issue_short_id: null, error_type: null, release: null }));
        expect(rendered).toContain('미제공');
        expect(rendered).not.toContain('person@example.test');
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

    it('records an explicit Discord 429 as the only durable retryable outcome', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }));
        await expect(deliverSentryDiscordAlerts({ fetcher })).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'retry', p_failure_code: 'DISCORD_RATE_LIMITED',
        }));
    });

    it('performs one bounded immediate retry only for an explicit Discord 429', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 1 }), { status: 429 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(deliverSentryDiscordAlerts({ fetcher, immediateRetry: true })).resolves.toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'sent', p_failure_code: null,
        }));
    });

    it.each([
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 })), 'DISCORD_5XX_AMBIGUOUS'],
        ['timeout', () => Promise.reject(new Error('timeout')), 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS'],
    ])('terminalizes ambiguous Discord %s without a later retry', async (_kind, result, code) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: true, error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation(result);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(deliverSentryDiscordAlerts({ fetcher, immediateRetry: true })).resolves.toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_sentry_discord_alert_outbox', expect.objectContaining({
            p_outcome: 'ambiguous_failed', p_failure_code: code,
        }));
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('timeout');
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
