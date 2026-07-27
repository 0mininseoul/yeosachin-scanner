import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock('@sentry/nextjs', () => ({
    captureMessage: mocks.captureMessage,
    addBreadcrumb: mocks.addBreadcrumb,
}));

import {
    buildKakaoSignupDiscordPayload,
    deliverKakaoSignupDiscordNotifications,
    formatKst,
    kakaoSignupProfileForOutbox,
    maskKakaoName,
} from './kakao-signup-discord';

const ITEM = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    claim_token: '223e4567-e89b-42d3-a456-426614174000',
    masked_name: '김**',
    birthyear: '1994',
    gender: '여성',
    signed_up_at: '2026-07-27T00:00:00.000Z',
    attempts: 1,
};

function configured() {
    vi.stubEnv('KAKAO_SIGNUP_DISCORD_ENABLED', 'true');
    vi.stubEnv('KAKAO_SIGNUP_DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/123/raw-webhook-secret');
    vi.stubEnv('KAKAO_SIGNUP_DISCORD_THREAD_ID', 'thread-env-only');
}

describe('Kakao signup Discord notification', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configured();
    });

    afterEach(() => vi.unstubAllEnvs());

    it.each([
        ['김', '*'],
        ['김민', '김*'],
        ['김민수', '김*수'],
        ['김민수영', '김**영'],
        ['  김-민 수  ', '김*수'],
        ['👩🏽‍💻-가', '👩🏽‍💻*'],
        ['e\u0301-가', 'é*'],
    ])('masks Unicode graphemes without exposing whitespace or hyphens: %s', (name, expected) => {
        expect(maskKakaoName(name)).toBe(expected);
    });

    it('uses only safe fields and renders the signup time in KST', () => {
        const payload = buildKakaoSignupDiscordPayload({
            masked_name: null,
            birthyear: null,
            gender: null,
            signed_up_at: '2026-01-01T00:01:00.000Z',
        });
        expect(payload.embeds[0].fields).toEqual([
            { name: '👤 이름', value: '미제공', inline: true },
            { name: '🎂 출생연도', value: '미제공', inline: true },
            { name: '⚧ 성별', value: '미제공', inline: true },
            { name: '📅 가입일시', value: '2026-01-01 09:01 (KST)', inline: false },
        ]);
        expect(formatKst(new Date('2026-12-31T15:59:00.000Z'))).toBe('2027-01-01 00:59 (KST)');
        expect(kakaoSignupProfileForOutbox({
            name: ' Private Kakao Name ', birthyear: 'not-a-year', gender: 'unknown', signedUpAt: new Date(),
        })).toMatchObject({ birthyear: null, gender: null });
        expect(kakaoSignupProfileForOutbox({
            name: ' Private Kakao Name ', birthyear: 'not-a-year', gender: 'unknown', signedUpAt: new Date(),
        }).masked_name).toMatch(/^P\*+e$/);
    });

    it('sends an initially claimed row exactly once and never puts recipient data in observability', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null })
            .mockResolvedValueOnce({ data: [], error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await deliverKakaoSignupDiscordNotifications({ userId: ITEM.id, fetcher });
        await deliverKakaoSignupDiscordNotifications({ userId: ITEM.id, fetcher });

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_kakao_signup_discord_outbox', expect.objectContaining({
            p_outcome: 'sent', p_outbox_id: ITEM.id,
        }));
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('raw-webhook-secret');
    });

    it('retries only a known rejected 429, with bounded durable backoff', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null })
            .mockResolvedValueOnce({ data: [{ ...ITEM, attempts: 2 }], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        await deliverKakaoSignupDiscordNotifications({ fetcher });
        await deliverKakaoSignupDiscordNotifications({ fetcher });

        expect(mocks.rpc).toHaveBeenCalledWith('complete_kakao_signup_discord_outbox', expect.objectContaining({
            p_outcome: 'retry', p_failure_code: 'RATE_LIMITED', p_retry_after_seconds: 2,
        }));
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 })), 'DISCORD_5XX_AMBIGUOUS'],
        ['timeout', () => Promise.reject(new Error('network timeout')), 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS'],
    ])('does not resend an ambiguous %s outcome or block the caller', async (_label, result, code) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation(result);

        await expect(deliverKakaoSignupDiscordNotifications({ fetcher })).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('complete_kakao_signup_discord_outbox', expect.objectContaining({
            p_outcome: 'ambiguous_failed', p_failure_code: code,
        }));
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent callers through the database claim', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

        await Promise.all([
            deliverKakaoSignupDiscordNotifications({ fetcher }),
            deliverKakaoSignupDiscordNotifications({ fetcher }),
        ]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('terminalizes a stale sending lease without attempting a Discord POST', async () => {
        mocks.rpc.mockResolvedValueOnce({ data: 1, error: null });
        const { reconcileStaleKakaoSignupDiscordClaims } = await import('./kakao-signup-discord');

        await expect(reconcileStaleKakaoSignupDiscordClaims()).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('reconcile_stale_kakao_signup_discord_claims');
    });

    it('recovers an unstaged callback failure as unavailable data before a later claim', async () => {
        mocks.rpc.mockResolvedValueOnce({ data: 1, error: null });
        const { recoverUnstagedKakaoSignupDiscordNotifications } = await import('./kakao-signup-discord');

        await expect(recoverUnstagedKakaoSignupDiscordNotifications()).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenCalledWith('recover_unstaged_kakao_signup_discord_outbox');
    });
});

describe('Kakao signup outbox migration contract', () => {
    const foundation = readFileSync(new URL(
        '../../../supabase/migrations/20260727140000_add_kakao_signup_discord_outbox.sql',
        import.meta.url,
    ), 'utf8');
    const source = readFileSync(new URL(
        '../../../supabase/migrations/20260727150000_harden_kakao_signup_discord_outbox.sql',
        import.meta.url,
    ), 'utf8');

    it('creates rows only from a first Kakao auth identity and provides a SKIP LOCKED claim', () => {
        expect(foundation).toContain("AFTER INSERT ON auth.users");
        expect(foundation).toContain("NEW.raw_app_meta_data ->> 'provider' = 'kakao'");
        expect(foundation).toContain('ON CONFLICT (user_id) DO NOTHING');
        expect(source).toContain('FOR UPDATE SKIP LOCKED');
        expect(source).toContain('profile_staged_at IS NOT NULL');
        expect(source).toContain('reconcile_stale_kakao_signup_discord_claims');
        expect(source).toContain("'ambiguous_failed'");
        expect(source).toContain("'ambiguous_failed'");
        expect(`${foundation}\n${source}`).not.toContain('last_sign_in_at');
    });
});
