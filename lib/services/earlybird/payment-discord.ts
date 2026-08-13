import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { formatKst, maskKakaoName } from '@/lib/services/identity/kakao-signup-discord';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_DELIVERY_ATTEMPTS = 3;
const DISCORD_TIMEOUT_MS = 10_000;

export interface EarlybirdPaymentDiscordItem {
    id: string;
    order_id: string;
    claim_token: string;
    plan_id: string;
    actual_amount_krw: number | null;
    paid_at: string;
    buyer_name: string | null;
    gender: string | null;
    attempts: number;
}

interface DiscordConfig {
    botToken: string;
    threadId: string;
}

type FinishOutcome = 'sent' | 'retry' | 'failed' | 'ambiguous_failed';

function configuredDiscord(): DiscordConfig | null {
    if (process.env.PAYMENT_DISCORD_ENABLED !== 'true') return null;
    const botToken = process.env.KAKAO_SIGNUP_DISCORD_BOT_TOKEN?.trim();
    const threadId = process.env.PAYMENT_DISCORD_THREAD_ID?.trim();
    if (!botToken || !threadId) return null;
    return { botToken, threadId };
}

function displayGender(value: unknown): string {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (candidate === 'female') return '여성';
    if (candidate === 'male') return '남성';
    return '미제공';
}

function productName(value: unknown): string {
    if (value === 'basic') return 'Basic';
    if (value === 'standard') return 'Standard';
    return '미제공';
}

function paidAmount(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return '미제공';
    }
    return `₩${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value)}`;
}

export function buildPaymentDiscordPayload(
    item: Pick<EarlybirdPaymentDiscordItem, 'plan_id' | 'actual_amount_krw' | 'buyer_name' | 'gender' | 'paid_at'>,
) {
    return {
        embeds: [{
            title: '💳 결제가 완료됐어요!',
            color: 0x57F287,
            fields: [
                { name: '🛍️ 상품명', value: productName(item.plan_id), inline: true },
                { name: '💰 결제금액', value: paidAmount(item.actual_amount_krw), inline: true },
                {
                    name: '👤 결제자',
                    value: maskKakaoName(item.buyer_name) ?? '미제공',
                    inline: true,
                },
                { name: '⚧ 성별', value: displayGender(item.gender), inline: true },
                {
                    name: '📅 결제일시',
                    value: formatKst(new Date(item.paid_at)),
                    inline: false,
                },
            ],
        }],
        allowed_mentions: { parse: [] },
    };
}

function operationalFailure(code: string): void {
    // Never add buyer data, raw Discord responses, URLs, or credentials here.
    console.error('[earlybird-payment-discord] delivery failed', { code });
    try {
        Sentry.addBreadcrumb({
            category: 'earlybird-payment-discord',
            level: 'error',
            data: { code },
        });
        Sentry.captureMessage('Earlybird payment Discord delivery failed', {
            level: 'error',
            tags: { code },
        });
    } catch {
        // Monitoring must not alter payment or outbox behavior.
    }
}

function boundedRetryAfterSeconds(value: unknown): number | null {
    const seconds = typeof value === 'number' || typeof value === 'string'
        ? Number(value)
        : Number.NaN;
    return Number.isFinite(seconds) ? Math.min(900, Math.max(1, Math.ceil(seconds))) : null;
}

async function retryAfterSeconds(response: Response): Promise<number> {
    try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            const fromBody = boundedRetryAfterSeconds(
                (body as { retry_after?: unknown }).retry_after,
            );
            if (fromBody !== null) return fromBody;
        }
    } catch {
        // Never record Discord's response body.
    }
    return boundedRetryAfterSeconds(response.headers.get('retry-after')) ?? 60;
}

async function finish(
    item: EarlybirdPaymentDiscordItem,
    outcome: FinishOutcome,
    failureCode: string | null = null,
    retryAfter = 0,
): Promise<void> {
    try {
        const { error } = await supabaseAdmin.rpc(
            'complete_earlybird_payment_discord_outbox',
            {
                p_outbox_id: item.id,
                p_claim_token: item.claim_token,
                p_outcome: outcome,
                p_failure_code: failureCode,
                p_retry_after_seconds: retryAfter,
            },
        );
        if (error) operationalFailure('OUTBOX_COMPLETE_FAILED');
    } catch {
        operationalFailure('OUTBOX_COMPLETE_FAILED');
    }
}

async function sendClaimedItem(
    item: EarlybirdPaymentDiscordItem,
    config: DiscordConfig,
    fetcher: typeof fetch,
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
        timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
        const url = `https://discord.com/api/v10/channels/${encodeURIComponent(config.threadId)}/messages`;
        const response = await fetcher(url, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${config.botToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(buildPaymentDiscordPayload(item)),
            signal: controller.signal,
        });
        if (response.ok) {
            await finish(item, 'sent');
            return;
        }
        if (response.status === 429 && item.attempts < MAX_DELIVERY_ATTEMPTS) {
            await finish(item, 'retry', 'RATE_LIMITED', await retryAfterSeconds(response));
            return;
        }
        const outcome: FinishOutcome = response.status >= 500
            ? 'ambiguous_failed'
            : 'failed';
        await finish(
            item,
            outcome,
            response.status >= 500 ? 'DISCORD_5XX_AMBIGUOUS' : 'DISCORD_REJECTED',
        );
        operationalFailure(
            response.status >= 500 ? 'DISCORD_5XX_AMBIGUOUS' : 'DISCORD_REJECTED',
        );
    } catch {
        await finish(item, 'ambiguous_failed', 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS');
        operationalFailure('DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS');
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function deliverEarlybirdPaymentDiscordNotifications(options: {
    limit?: number;
    fetcher?: typeof fetch;
} = {}): Promise<number> {
    const config = configuredDiscord();
    if (!config) return 0;

    let data: unknown;
    try {
        const result = await supabaseAdmin.rpc('claim_earlybird_payment_discord_outbox', {
            p_limit: Math.max(1, Math.min(options.limit ?? 1, 10)),
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

    const claimed = (data ?? []) as EarlybirdPaymentDiscordItem[];
    await Promise.all(claimed.map(item => sendClaimedItem(
        item,
        config,
        options.fetcher ?? fetch,
    )));
    return claimed.length;
}

export async function reconcileStaleEarlybirdPaymentDiscordClaims(): Promise<number> {
    if (!configuredDiscord()) return 0;
    try {
        const { data, error } = await supabaseAdmin.rpc(
            'reconcile_stale_earlybird_payment_discord_claims',
        );
        if (error) {
            operationalFailure('OUTBOX_STALE_CLAIM_RECONCILE_FAILED');
            return 0;
        }
        const reconciled = typeof data === 'number' ? data : 0;
        if (reconciled > 0) operationalFailure('OUTBOX_STALE_CLAIM_AMBIGUOUS');
        return reconciled;
    } catch {
        operationalFailure('OUTBOX_STALE_CLAIM_RECONCILE_FAILED');
        return 0;
    }
}
