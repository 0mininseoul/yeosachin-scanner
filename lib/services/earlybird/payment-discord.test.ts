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
    buildPaymentDiscordPayload,
    deliverEarlybirdPaymentDiscordNotifications,
    reconcileStaleEarlybirdPaymentDiscordClaims,
} from './payment-discord';

const ITEM = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    order_id: '223e4567-e89b-42d3-a456-426614174000',
    claim_token: '323e4567-e89b-42d3-a456-426614174000',
    plan_id: 'basic',
    actual_amount_krw: 14_900,
    buyer_name: '김민수',
    gender: 'male',
    paid_at: '2026-08-13T00:01:00.000Z',
    attempts: 1,
};

function configured() {
    vi.stubEnv('PAYMENT_DISCORD_ENABLED', 'true');
    vi.stubEnv('PAYMENT_DISCORD_THREAD_ID', '1537327100254486611');
    vi.stubEnv('KAKAO_SIGNUP_DISCORD_BOT_TOKEN', 'test-bot-token');
}

describe('earlybird payment Discord notification', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        configured();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('builds the four privacy-safe payment fields in KST', () => {
        expect(buildPaymentDiscordPayload(ITEM)).toEqual({
            embeds: [{
                title: '💳 결제가 완료됐어요!',
                color: 0x57F287,
                fields: [
                    { name: '🛍️ 상품명', value: 'Basic', inline: true },
                    { name: '💰 결제금액', value: '₩14,900', inline: true },
                    { name: '👤 결제자', value: '김*수', inline: true },
                    { name: '⚧ 성별', value: '남성', inline: true },
                    { name: '📅 결제일시', value: '2026-08-13 09:01 (KST)', inline: false },
                ],
            }],
            allowed_mentions: { parse: [] },
        });
    });

    it('maps Standard and unavailable profile values without leaking raw values', () => {
        const payload = buildPaymentDiscordPayload({
            ...ITEM,
            plan_id: 'standard',
            actual_amount_krw: 123_456,
            buyer_name: null,
            gender: 'unknown-private-gender',
        });
        expect(payload.embeds[0].fields).toEqual([
            { name: '🛍️ 상품명', value: 'Standard', inline: true },
            { name: '💰 결제금액', value: '₩123,456', inline: true },
            { name: '👤 결제자', value: '미제공', inline: true },
            { name: '⚧ 성별', value: '미제공', inline: true },
            { name: '📅 결제일시', value: '2026-08-13 09:01 (KST)', inline: false },
        ]);
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain('unknown-private-gender');
        expect(serialized).not.toMatch(/email|phone|payment_id|claim_token/i);
    });

    it.each([
        ['김', '*'],
        ['김민', '김*'],
        ['é-가', 'é*'],
    ])('uses the existing grapheme-safe name masking for %s', (name, expected) => {
        const payload = buildPaymentDiscordPayload({ ...ITEM, buyer_name: name });
        expect(payload.embeds[0].fields[2]).toEqual({
            name: '👤 결제자',
            value: expected,
            inline: true,
        });
    });

    it('claims once, posts to the configured payment thread, and completes sent', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

        await expect(deliverEarlybirdPaymentDiscordNotifications({ fetcher })).resolves.toBe(1);

        expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'claim_earlybird_payment_discord_outbox_v2', {
            p_limit: 1,
        });
        expect(fetcher).toHaveBeenCalledWith(
            'https://discord.com/api/v10/channels/1537327100254486611/messages',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    Authorization: 'Bot test-bot-token',
                    'content-type': 'application/json',
                },
            }),
        );
        expect(mocks.rpc).toHaveBeenLastCalledWith(
            'complete_earlybird_payment_discord_outbox',
            expect.objectContaining({ p_outcome: 'sent', p_outbox_id: ITEM.id }),
        );
        expect(JSON.parse(fetcher.mock.calls[0][1].body).allowed_mentions).toEqual({ parse: [] });
    });

    it('does not call Supabase or Discord when payment notifications are disabled or incomplete', async () => {
        vi.stubEnv('PAYMENT_DISCORD_ENABLED', 'false');
        const fetcher = vi.fn();

        await expect(deliverEarlybirdPaymentDiscordNotifications({ fetcher })).resolves.toBe(0);

        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('retries only a bounded Discord 429', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ retry_after: 2.2 }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
        }));

        await deliverEarlybirdPaymentDiscordNotifications({ fetcher });

        expect(mocks.rpc).toHaveBeenLastCalledWith(
            'complete_earlybird_payment_discord_outbox',
            expect.objectContaining({
                p_outcome: 'retry',
                p_failure_code: 'RATE_LIMITED',
                p_retry_after_seconds: 3,
            }),
        );
    });

    it.each([
        ['5xx', () => Promise.resolve(new Response(null, { status: 503 })), 'DISCORD_5XX_AMBIGUOUS'],
        ['network', () => Promise.reject(new Error('network timeout')), 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS'],
    ])('terminalizes ambiguous %s delivery without resending', async (_label, result, code) => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation(result);

        await expect(deliverEarlybirdPaymentDiscordNotifications({ fetcher })).resolves.toBe(1);

        expect(mocks.rpc).toHaveBeenLastCalledWith(
            'complete_earlybird_payment_discord_outbox',
            expect.objectContaining({ p_outcome: 'ambiguous_failed', p_failure_code: code }),
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps buyer data, bot credentials, and Discord response details out of observability', async () => {
        const privateName = '민감한 구매자';
        mocks.rpc
            .mockResolvedValueOnce({ data: [{ ...ITEM, buyer_name: privateName }], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockResolvedValue(new Response('discord-private-response', { status: 403 }));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await deliverEarlybirdPaymentDiscordNotifications({ fetcher });

        const observability = JSON.stringify([
            errorSpy.mock.calls,
            mocks.addBreadcrumb.mock.calls,
            mocks.captureMessage.mock.calls,
        ]);
        expect(observability).not.toContain(privateName);
        expect(observability).not.toContain('test-bot-token');
        expect(observability).not.toContain('discord-private-response');
    });

    it('waits ten seconds before aborting a delivery and terminalizes it', async () => {
        vi.useFakeTimers();
        mocks.rpc
            .mockResolvedValueOnce({ data: [ITEM], error: null })
            .mockResolvedValueOnce({ error: null });
        const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            })
        ));

        const delivery = deliverEarlybirdPaymentDiscordNotifications({ fetcher });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(mocks.rpc).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(delivery).resolves.toBe(1);
        expect(mocks.rpc).toHaveBeenLastCalledWith(
            'complete_earlybird_payment_discord_outbox',
            expect.objectContaining({
                p_outcome: 'ambiguous_failed',
                p_failure_code: 'DISCORD_TIMEOUT_OR_NETWORK_AMBIGUOUS',
            }),
        );
    });

    it('reconciles stale claims through the service-role RPC', async () => {
        mocks.rpc.mockResolvedValueOnce({ data: 2, error: null });

        await expect(reconcileStaleEarlybirdPaymentDiscordClaims()).resolves.toBe(2);

        expect(mocks.rpc).toHaveBeenCalledWith(
            'reconcile_stale_earlybird_payment_discord_claims',
        );
    });
});
