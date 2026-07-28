import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_DELIVERY_ATTEMPTS = 3;
const DISCORD_TIMEOUT_MS = 4_000;
const MIN_HOOK_SECRET_LENGTH = 32;

interface DiscordConfig {
    botToken: string;
    channelId: string;
}

interface ClaimedOutboxItem {
    id: string;
    claim_token: string;
    project_slug: string | null;
    occurred_at: string;
    issue_url: string | null;
    attempts: number;
}

type FinishOutcome = 'sent' | 'retry' | 'failed';

export interface SentryAlertForOutbox {
    dedupeKey: string;
    projectSlug: string | null;
    occurredAt: Date;
    issueUrl: string | null;
}

function configuredDiscord(): DiscordConfig | null {
    if (process.env.SENTRY_DISCORD_ALERTS_ENABLED !== 'true') return null;
    const botToken = process.env.SENTRY_DISCORD_BOT_TOKEN?.trim();
    const channelId = process.env.SENTRY_DISCORD_CHANNEL_ID?.trim();
    if (!botToken || !/^[0-9]{16,22}$/.test(channelId ?? '')) return null;
    return { botToken, channelId };
}

function configuredHookSecrets(): { serviceHookSecret: string; pathSecret: string } | null {
    const secret = process.env.SENTRY_DISCORD_SERVICE_HOOK_SECRET?.trim();
    const pathSecret = process.env.SENTRY_DISCORD_SERVICE_HOOK_PATH_SECRET?.trim();
    // Sentry Service Hook delivery signing is not documented for this hook type.
    // Require two independent capability secrets in its configured URL instead.
    return secret && pathSecret
        && secret.length >= MIN_HOOK_SECRET_LENGTH
        && pathSecret.length >= MIN_HOOK_SECRET_LENGTH
        ? { serviceHookSecret: secret, pathSecret }
        : null;
}

function constantTimeEqual(actual: string | null, expected: string): boolean {
    if (!actual) return false;
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length
        && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Sentry's Service Hook registration response has a generated secret, but its
 * delivery signature is not documented for this hook type. The configured URL
 * therefore has two independent high-entropy path segments and is fail-closed.
 */
export function isAuthenticSentryServiceHookPath(serviceHookSecret: string, pathSecret: string): boolean {
    const configured = configuredHookSecrets();
    return Boolean(configured
        && constantTimeEqual(serviceHookSecret, configured.serviceHookSecret)
        && constantTimeEqual(pathSecret, configured.pathSecret));
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stringAt(value: unknown, keys: string[]): string | null {
    let current: unknown = value;
    for (const key of keys) {
        const record = asRecord(current);
        if (!record) return null;
        current = record[key];
    }
    return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function isProduction(value: string | null): boolean {
    return value?.toLowerCase() === 'production';
}

function safeProjectSlug(value: string | null): string | null {
    return value && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(value) ? value : null;
}

function safeIssueUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || (url.hostname !== 'sentry.io' && !url.hostname.endsWith('.sentry.io')))
            return null;
        if (url.username || url.password || url.search || url.hash || !/^\/organizations\/[^/]+\/issues\/\d+\/?$/.test(url.pathname))
            return null;
        return url.toString();
    } catch {
        return null;
    }
}

function occurredAt(value: unknown): Date | null {
    const candidate = stringAt(value, ['data', 'event', 'dateCreated'])
        ?? stringAt(value, ['data', 'event', 'date_created'])
        ?? stringAt(value, ['data', 'event', 'datetime'])
        ?? stringAt(value, ['dateCreated']);
    if (!candidate) return null;
    const parsed = new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parse only a minimal, non-PII subset after authentication. */
export function parseProductionSentryIssueAlert(rawBody: string, request: Request): SentryAlertForOutbox | null {
    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return null;
    }

    // Service Hooks document event.alert and event.created. We accept an alert
    // only when the body explicitly identifies it; headers alone are not enough.
    const eventName = stringAt(payload, ['event']) ?? stringAt(payload, ['event_type']);
    const resource = request.headers.get('sentry-hook-resource')?.trim().toLowerCase();
    if (eventName !== 'event.alert' || (resource && resource !== 'event_alert' && resource !== 'event.alert'))
        return null;

    const environment = stringAt(payload, ['data', 'event', 'environment'])
        ?? stringAt(payload, ['environment']);
    if (!isProduction(environment)) return null;

    const when = occurredAt(payload);
    if (!when) return null;

    const projectSlug = safeProjectSlug(
        stringAt(payload, ['data', 'event', 'project', 'slug'])
        ?? stringAt(payload, ['data', 'project', 'slug']),
    );
    const issueUrl = safeIssueUrl(
        stringAt(payload, ['data', 'event', 'web_url'])
        ?? stringAt(payload, ['data', 'event', 'issue_url'])
        ?? stringAt(payload, ['data', 'issue_url']),
    );

    // Do not retain the received body: a one-way body fingerprint is sufficient
    // to make retries and concurrent Service Hook deliveries idempotent.
    return {
        dedupeKey: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
        projectSlug,
        occurredAt: when,
        issueUrl,
    };
}

export function formatSentryAlertKst(value: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '00';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (KST)`;
}

/** This deliberately has no Sentry text, exception title, request data, tags, or user data. */
export function buildSentryDiscordPayload(item: Pick<ClaimedOutboxItem, 'project_slug' | 'occurred_at' | 'issue_url'>) {
    const fields = [{ name: '발생 일시', value: formatSentryAlertKst(new Date(item.occurred_at)), inline: false }];
    if (item.project_slug) fields.unshift({ name: '프로젝트', value: item.project_slug, inline: true });
    return {
        embeds: [{
            title: '🚨 Sentry 오류 알림',
            color: 0xED4245,
            ...(item.issue_url ? { url: item.issue_url } : {}),
            fields,
        }],
        allowed_mentions: { parse: [] },
    };
}

function operationalFailure(code: string): void {
    // Codes are an allowlist; never log the hook body, secret, Discord URL, or response.
    console.error('[sentry-discord-alert] delivery failed', { code });
}

function retryDelay(attempts: number, retryAfter: number | null): number {
    if (retryAfter !== null) return Math.min(900, Math.max(1, Math.ceil(retryAfter)));
    return Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));
}

async function discordRetryAfter(response: Response): Promise<number | null> {
    try {
        const body: unknown = await response.json();
        const value = asRecord(body)?.retry_after;
        const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
        if (Number.isFinite(parsed)) return parsed;
    } catch {
        // Response bodies are not operationally safe to log or persist.
    }
    const parsed = Number(response.headers.get('retry-after'));
    return Number.isFinite(parsed) ? parsed : null;
}

async function finish(item: ClaimedOutboxItem, outcome: FinishOutcome, failureCode: string | null, retryAfterSeconds = 0) {
    try {
        const { error } = await supabaseAdmin.rpc('complete_sentry_discord_alert_outbox', {
            p_outbox_id: item.id,
            p_claim_token: item.claim_token,
            p_outcome: outcome,
            p_failure_code: failureCode,
            p_retry_after_seconds: retryAfterSeconds,
        });
        if (error) operationalFailure('OUTBOX_COMPLETE_FAILED');
    } catch {
        operationalFailure('OUTBOX_COMPLETE_FAILED');
    }
}

async function sendClaimedItem(item: ClaimedOutboxItem, config: DiscordConfig, fetcher: typeof fetch): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
    try {
        const response = await fetcher(`https://discord.com/api/v10/channels/${encodeURIComponent(config.channelId)}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${config.botToken}`, 'content-type': 'application/json' },
            // Discord's documented enforced nonce returns the original message
            // rather than creating a second one after an ambiguous timeout/5xx.
            body: JSON.stringify({
                ...buildSentryDiscordPayload(item),
                nonce: item.id.replace(/-/g, '').slice(0, 25),
                enforce_nonce: true,
            }),
            signal: controller.signal,
        });
        if (response.ok) return await finish(item, 'sent', null);

        const transient = response.status === 429 || response.status >= 500;
        if (transient && item.attempts < MAX_DELIVERY_ATTEMPTS) {
            const retryAfter = response.status === 429 ? await discordRetryAfter(response) : null;
            return await finish(item, 'retry', response.status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_5XX', retryDelay(item.attempts, retryAfter));
        }
        await finish(item, 'failed', transient ? 'DISCORD_RETRY_EXHAUSTED' : 'DISCORD_REJECTED');
        operationalFailure(transient ? 'DISCORD_RETRY_EXHAUSTED' : 'DISCORD_REJECTED');
    } catch {
        if (item.attempts < MAX_DELIVERY_ATTEMPTS) {
            await finish(item, 'retry', 'DISCORD_TIMEOUT_OR_NETWORK', retryDelay(item.attempts, null));
        } else {
            await finish(item, 'failed', 'DISCORD_RETRY_EXHAUSTED');
            operationalFailure('DISCORD_RETRY_EXHAUSTED');
        }
    } finally {
        clearTimeout(timeout);
    }
}

export async function enqueueSentryDiscordAlert(alert: SentryAlertForOutbox): Promise<boolean> {
    const { data, error } = await supabaseAdmin.rpc('enqueue_sentry_discord_alert_outbox', {
        p_dedupe_key: alert.dedupeKey,
        p_project_slug: alert.projectSlug,
        p_occurred_at: alert.occurredAt.toISOString(),
        p_issue_url: alert.issueUrl,
    });
    if (error) throw new Error('SENTRY_DISCORD_OUTBOX_ENQUEUE_FAILED');
    return data === true;
}

export async function deliverSentryDiscordAlerts(options: { limit?: number; fetcher?: typeof fetch } = {}): Promise<number> {
    const config = configuredDiscord();
    if (!config) return 0;
    let data: unknown;
    try {
        const result = await supabaseAdmin.rpc('claim_sentry_discord_alert_outbox', {
            p_limit: Math.max(1, Math.min(options.limit ?? 10, 10)),
        });
        if (result.error) {
            operationalFailure('OUTBOX_CLAIM_FAILED');
            return 0;
        }
        data = result.data;
    } catch {
        operationalFailure('OUTBOX_CLAIM_FAILED');
        return 0;
    }
    const claimed = (data ?? []) as ClaimedOutboxItem[];
    await Promise.all(claimed.map(item => sendClaimedItem(item, config, options.fetcher ?? fetch)));
    return claimed.length;
}
