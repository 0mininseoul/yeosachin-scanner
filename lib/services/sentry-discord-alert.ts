import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_DELIVERY_ATTEMPTS = 3;
const DISCORD_TIMEOUT_MS = 4_000;
const IMMEDIATE_RETRY_MAX_DELAY_MS = 2_000;
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
    if (!sentryDiscordAlertsEnabled()) return null;
    const botToken = process.env.SENTRY_DISCORD_BOT_TOKEN?.trim();
    const channelId = process.env.SENTRY_DISCORD_CHANNEL_ID?.trim();
    if (!botToken || !channelId || !/^[0-9]{16,22}$/.test(channelId)) return null;
    return { botToken, channelId };
}

/** Separate intake gate so disabled alerts are never persisted for later replay. */
export function sentryDiscordAlertsEnabled(): boolean {
    return process.env.SENTRY_DISCORD_ALERTS_ENABLED === 'true';
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
 * Service Hook v0 sends X-ServiceHook-Signature as an HMAC-SHA256 hex digest of
 * the raw JSON body, keyed with the generated Service Hook secret. A separate
 * URL path capability remains a defense in depth boundary; the HMAC key is
 * never placed in the URL.
 */
export function isAuthenticSentryServiceHook(
    request: Request,
    rawBody: string,
    pathSecret: string,
): boolean {
    const configured = configuredHookSecrets();
    if (!configured
        || !constantTimeEqual(pathSecret, configured.pathSecret)) return false;

    // These are the documented v0 Service Hook headers. There is no event-kind
    // header in v0; subscribe this hook to event.alert only (see .env.example).
    const timestamp = request.headers.get('x-servicehook-timestamp');
    const guid = request.headers.get('x-servicehook-guid');
    const signature = request.headers.get('x-servicehook-signature');
    if (!timestamp || !/^[0-9]{10,13}$/.test(timestamp) || !guid || !signature) return false;
    const expected = createHmac('sha256', configured.serviceHookSecret).update(rawBody, 'utf8').digest('hex');
    return constantTimeEqual(signature, expected);
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
    const candidate = stringAt(value, ['event', 'dateCreated']);
    if (!candidate) return null;
    const parsed = new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventEnvironment(value: unknown): string | null {
    const event = asRecord(value)?.event;
    const tags = asRecord(event)?.tags;
    if (!Array.isArray(tags)) return null;
    for (const tag of tags) {
        const record = asRecord(tag);
        if (record?.key === 'environment' && typeof record.value === 'string' && record.value.trim())
            return record.value.trim();
    }
    return null;
}

/** Parse the official v0 Service Hook shape: top-level project, group, event. */
export function parseProductionSentryIssueAlert(rawBody: string): SentryAlertForOutbox | null {
    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return null;
    }

    // v0 has no event-kind field/header. Authentication plus a hook configured
    // to subscribe only to event.alert is the event-kind boundary. Require the
    // actual top-level project/group/event delivery contract before proceeding.
    const root = asRecord(payload);
    if (!root || !asRecord(root.project) || !asRecord(root.group) || !asRecord(root.event)) return null;
    if (!isProduction(eventEnvironment(payload))) return null;

    const when = occurredAt(payload);
    if (!when) return null;

    const projectSlug = safeProjectSlug(
        stringAt(payload, ['project', 'slug']),
    );
    const issueUrl = safeIssueUrl(
        stringAt(payload, ['group', 'url']),
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

/** Never send unless the at-most-once fence is durable. */
async function markDeliveryStarted(item: ClaimedOutboxItem): Promise<boolean> {
    try {
        const { data, error } = await supabaseAdmin.rpc('mark_sentry_discord_alert_delivery_started', {
            p_outbox_id: item.id,
            p_claim_token: item.claim_token,
        });
        if (error || data !== true) {
            operationalFailure('OUTBOX_DELIVERY_START_MARK_FAILED');
            return false;
        }
        return true;
    } catch {
        operationalFailure('OUTBOX_DELIVERY_START_MARK_FAILED');
        return false;
    }
}

function boundedWait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function sendClaimedItem(
    item: ClaimedOutboxItem,
    config: DiscordConfig,
    fetcher: typeof fetch,
    immediateRetry: boolean,
): Promise<void> {
    if (!await markDeliveryStarted(item)) return;
    let oneImmediateRetryRemaining = immediateRetry;
    while (true) {
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
            const retryAfter = response.status === 429 ? await discordRetryAfter(response) : null;
            const immediateDelay = retryAfter === null ? 1_000 : Math.max(1_000, Math.ceil(retryAfter * 1_000));
            if (transient && oneImmediateRetryRemaining && immediateDelay <= IMMEDIATE_RETRY_MAX_DELAY_MS) {
                oneImmediateRetryRemaining = false;
                await boundedWait(immediateDelay);
                continue;
            }
            if (transient && item.attempts < MAX_DELIVERY_ATTEMPTS) {
                return await finish(item, 'retry', response.status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_5XX', retryDelay(item.attempts, retryAfter));
            }
            await finish(item, 'failed', transient ? 'DISCORD_RETRY_EXHAUSTED' : 'DISCORD_REJECTED');
            operationalFailure(transient ? 'DISCORD_RETRY_EXHAUSTED' : 'DISCORD_REJECTED');
            return;
        } catch {
            if (oneImmediateRetryRemaining) {
                oneImmediateRetryRemaining = false;
                await boundedWait(1_000);
                continue;
            }
            if (item.attempts < MAX_DELIVERY_ATTEMPTS) {
                await finish(item, 'retry', 'DISCORD_TIMEOUT_OR_NETWORK', retryDelay(item.attempts, null));
            } else {
                await finish(item, 'failed', 'DISCORD_RETRY_EXHAUSTED');
                operationalFailure('DISCORD_RETRY_EXHAUSTED');
            }
            return;
        } finally {
            clearTimeout(timeout);
        }
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

export async function deliverSentryDiscordAlerts(options: {
    limit?: number;
    dedupeKey?: string;
    fetcher?: typeof fetch;
    immediateRetry?: boolean;
} = {}): Promise<number> {
    const config = configuredDiscord();
    if (!config) return 0;
    let data: unknown;
    try {
        const result = await supabaseAdmin.rpc('claim_sentry_discord_alert_outbox', {
            p_limit: Math.max(1, Math.min(options.limit ?? 10, 10)),
            p_dedupe_key: options.dedupeKey ?? null,
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
    await Promise.all(claimed.map(item => sendClaimedItem(
        item, config, options.fetcher ?? fetch, options.immediateRetry === true,
    )));
    return claimed.length;
}

/** One bounded 1-2 second retry fits a Free-plan request; longer backoff stays durable. */
export async function dispatchSentryDiscordAlertImmediately(dedupeKey: string): Promise<number> {
    return deliverSentryDiscordAlerts({ limit: 1, dedupeKey, immediateRetry: true });
}

/** Requeue a worker/deploy/complete-RPC interrupted lease before the next claim. */
export async function reconcileStaleSentryDiscordAlertClaims(): Promise<number> {
    try {
        const { data, error } = await supabaseAdmin.rpc('reconcile_stale_sentry_discord_alert_claims');
        if (error) {
            operationalFailure('OUTBOX_STALE_CLAIM_RECONCILE_FAILED');
            return 0;
        }
        return typeof data === 'number' ? data : 0;
    } catch {
        operationalFailure('OUTBOX_STALE_CLAIM_RECONCILE_FAILED');
        return 0;
    }
}
