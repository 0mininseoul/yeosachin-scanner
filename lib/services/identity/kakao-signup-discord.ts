import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_DELIVERY_ATTEMPTS = 3;
const DISCORD_TIMEOUT_MS = 4_000;

export interface KakaoSignupProfile {
    name: unknown;
    birthyear: unknown;
    gender: unknown;
    signedUpAt: Date;
}

interface ClaimedOutboxItem {
    id: string;
    claim_token: string;
    masked_name: string | null;
    birthyear: string | null;
    gender: string | null;
    signed_up_at: string;
    attempts: number;
}

interface DiscordConfig {
    webhookUrl: string;
    threadId: string;
}

type FinishOutcome = 'sent' | 'retry' | 'failed' | 'ambiguous_failed';

function configuredDiscord(): DiscordConfig | null {
    if (process.env.KAKAO_SIGNUP_DISCORD_ENABLED !== 'true') return null;
    const webhookUrl = process.env.KAKAO_SIGNUP_DISCORD_WEBHOOK_URL?.trim();
    const threadId = process.env.KAKAO_SIGNUP_DISCORD_THREAD_ID?.trim();
    if (!webhookUrl || !threadId) return null;
    return { webhookUrl, threadId };
}

function unavailable(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Never retain separators; preserve only the explicitly approved first/last graphemes. */
export function maskKakaoName(value: unknown): string | null {
    const name = unavailable(value);
    if (!name) return null;
    const visible = Array.from(
        new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(name),
        part => part.segment,
    ).filter(part => !/^[\s-]+$/u.test(part));
    if (visible.length === 0) return null;
    if (visible.length === 1) return '*';
    if (visible.length === 2) return `${visible[0]}*`;
    return `${visible[0]}${'*'.repeat(visible.length - 2)}${visible.at(-1)}`;
}

function safeBirthyear(value: unknown): string | null {
    const candidate = typeof value === 'number' ? String(value) : unavailable(value);
    if (!candidate || !/^(?:19\d{2}|20\d{2})$/.test(candidate)) return null;
    const year = Number(candidate);
    return year <= new Date().getUTCFullYear() ? candidate : null;
}

function safeGender(value: unknown): string | null {
    const candidate = unavailable(value)?.toLowerCase();
    if (candidate === 'female') return '여성';
    if (candidate === 'male') return '남성';
    return null;
}

export function formatKst(value: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find(item => item.type === type)?.value ?? '00';
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (KST)`;
}

export function buildKakaoSignupDiscordPayload(item: Pick<ClaimedOutboxItem,
    'masked_name' | 'birthyear' | 'gender' | 'signed_up_at'
>) {
    return {
        embeds: [{
            title: '🎉 신규 가입자가 생겼어요!',
            color: 0xFEE500,
            fields: [
                { name: '👤 이름', value: item.masked_name ?? '미제공', inline: true },
                { name: '🎂 출생연도', value: item.birthyear ?? '미제공', inline: true },
                { name: '⚧ 성별', value: item.gender ?? '미제공', inline: true },
                { name: '📅 가입일시', value: formatKst(new Date(item.signed_up_at)), inline: false },
            ],
        }],
        allowed_mentions: { parse: [] },
    };
}

function operationalFailure(code: string): void {
    // Never add user identity, raw Discord response, URLs, or profile data here.
    console.error('[kakao-signup-discord] delivery failed', { code });
    try {
        Sentry.addBreadcrumb({ category: 'kakao-signup-discord', level: 'error', data: { code } });
        Sentry.captureMessage('Kakao signup Discord delivery failed', {
            level: 'error',
            tags: { code },
        });
    } catch {
        // Monitoring must not alter auth or outbox behavior.
    }
}

function retryAfterSeconds(response: Response): number {
    const raw = Number(response.headers.get('retry-after'));
    return Number.isFinite(raw) ? Math.min(900, Math.max(1, Math.ceil(raw))) : 60;
}

async function finish(
    item: ClaimedOutboxItem,
    outcome: FinishOutcome,
    failureCode: string | null = null,
    retryAfter = 0,
): Promise<void> {
    try {
        const { error } = await supabaseAdmin.rpc('complete_kakao_signup_discord_outbox', {
            p_outbox_id: item.id,
            p_claim_token: item.claim_token,
            p_outcome: outcome,
            p_failure_code: failureCode,
            p_retry_after_seconds: retryAfter,
        });
        if (error) operationalFailure('OUTBOX_COMPLETE_FAILED');
    } catch {
        operationalFailure('OUTBOX_COMPLETE_FAILED');
    }
}

async function sendClaimedItem(
    item: ClaimedOutboxItem,
    config: DiscordConfig,
    fetcher: typeof fetch,
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
        timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
        const response = await fetcher(`${config.webhookUrl}?thread_id=${encodeURIComponent(config.threadId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildKakaoSignupDiscordPayload(item)),
            signal: controller.signal,
        });
        if (response.ok) {
            await finish(item, 'sent');
            return;
        }
        if (response.status === 429 && item.attempts < MAX_DELIVERY_ATTEMPTS) {
            await finish(item, 'retry', 'RATE_LIMITED', retryAfterSeconds(response));
            return;
        }
        // A 5xx can be emitted after Discord accepted the body. Never resend it.
        const outcome: FinishOutcome = response.status >= 500 ? 'ambiguous_failed' : 'failed';
        await finish(item, outcome, response.status >= 500 ? 'DISCORD_5XX_AMBIGUOUS' : 'DISCORD_REJECTED');
        operationalFailure(response.status >= 500 ? 'DISCORD_5XX_AMBIGUOUS' : 'DISCORD_REJECTED');
    } catch {
        // A network timeout/disconnect is likewise ambiguous: at-most-once beats eventual delivery.
        await finish(item, 'ambiguous_failed', 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS');
        operationalFailure('DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS');
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function deliverKakaoSignupDiscordNotifications(options: {
    userId?: string;
    limit?: number;
    fetcher?: typeof fetch;
} = {}): Promise<number> {
    const config = configuredDiscord();
    if (!config) return 0;
    let data: unknown;
    try {
        const result = await supabaseAdmin.rpc('claim_kakao_signup_discord_outbox', {
            p_user_id: options.userId ?? null,
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
    const claimed = (data ?? []) as ClaimedOutboxItem[];
    await Promise.all(claimed.map(item => sendClaimedItem(item, config, options.fetcher ?? fetch)));
    return claimed.length;
}

export function kakaoSignupProfileForOutbox(profile: KakaoSignupProfile) {
    return {
        masked_name: maskKakaoName(profile.name),
        birthyear: safeBirthyear(profile.birthyear),
        gender: safeGender(profile.gender),
        signed_up_at: profile.signedUpAt.toISOString(),
    };
}

/** Updates only a trigger-created first-signup row; it can never enqueue a relogin. */
export async function stageKakaoSignupDiscordProfile(
    userId: string,
    profile: KakaoSignupProfile,
): Promise<void> {
    const payload = kakaoSignupProfileForOutbox(profile);
    const { error } = await supabaseAdmin.rpc('set_kakao_signup_discord_outbox_profile', {
        p_user_id: userId,
        p_masked_name: payload.masked_name,
        p_birthyear: payload.birthyear,
        p_gender: payload.gender,
        p_signed_up_at: payload.signed_up_at,
    });
    if (error) operationalFailure('OUTBOX_PROFILE_STAGE_FAILED');
}
