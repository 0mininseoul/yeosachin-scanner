import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifiedGender } from '@/lib/services/cherry/ai-summary';
import { decryptBillingKey, encryptBillingKey } from '@/lib/services/cherry/billing';
import { cherryImageKey, isCherryImageKey } from '@/lib/services/cherry/images';
import { buildCherryMessage, deliverCherryMessage, type CherryDeliveryDeps } from '@/lib/services/cherry/notifications';
import { localKoreanNumber, readSolapiConfig, sendSolapi, SolapiRejectedError, SolapiUnknownError } from '@/lib/services/cherry/solapi';
import { cancelTossPayment, chargeTossBillingKey, findTossPayment, TossRejectedError, TossUnknownError } from '@/lib/services/cherry/toss';

const solapi = { apiKey: 'key', apiSecret: 'secret', sender: '0212345678', channelId: 'pf', templates: { new_mutual: 'tpl' } };
const message = buildCherryMessage('new_mutual', 'target', { count: 5 }, { reportId: 'r1', accounts: ['a', 'b', 'c', 'd'] });
const input = { id: 'n1', kind: 'new_mutual' as const, phone: '+821012345678', email: 'me@example.com', message };
const deps = (overrides: Partial<CherryDeliveryDeps>): CherryDeliveryDeps => ({
    solapi, email: { apiKey: 'k', from: 'cherry@example.com' }, sendSolapi: vi.fn(async () => ({ groupId: 'G' })),
    sendEmail: vi.fn(async () => 'email-id'), ...overrides,
});
const json = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('cherry notices', () => {
    it('lists at most three accounts and links to the report', () => {
        expect(message.text).toContain('새 맞팔 5명');
        expect(message.variables.accounts).toBe('@a\n@b\n@c\n외 2명');
        expect(message.text).toContain('https://yeosachin.com/cherry/reports/r1');
    });

    it('uses the next channel only after a clear refusal', async () => {
        const refused = vi.fn().mockRejectedValueOnce(new SolapiRejectedError('3059')).mockResolvedValueOnce({ groupId: 'G2' });
        expect(await deliverCherryMessage(input, deps({ sendSolapi: refused }))).toEqual({ status: 'sent', channel: 'sms', messageId: 'G2' });
        const unknown = deps({ sendSolapi: vi.fn().mockRejectedValue(new SolapiUnknownError()) });
        expect(await deliverCherryMessage(input, unknown)).toMatchObject({ status: 'unconfirmed', channel: 'alimtalk' });
        expect(unknown.sendEmail).not.toHaveBeenCalled();
        const email = deps({ sendSolapi: vi.fn().mockRejectedValue(new SolapiRejectedError('x')) });
        expect(await deliverCherryMessage(input, email)).toMatchObject({ status: 'sent', channel: 'email' });
        expect(await deliverCherryMessage(input, deps({ solapi: null, email: null }))).toEqual({ status: 'failed', code: 'no_channel' });
    });

    it('sends Alimtalk with a text fallback, and reads refusals from the answer', async () => {
        const request = json(200, { groupInfo: { groupId: 'G1', count: { total: 1, registeredFailed: 0 } }, failedMessageList: [] });
        await expect(sendSolapi(solapi, { to: '+821012345678', subject: 's', text: 't', kakao: { templateId: 'tpl', variables: { target: '@x' } } }, request as never))
            .resolves.toEqual({ groupId: 'G1' });
        const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
        const body = JSON.parse(String(init.body)).messages[0];
        expect(url).toBe('https://api.solapi.com/messages/v4/send-many/fast');
        expect(body).toMatchObject({ to: '01012345678', from: '0212345678', type: 'ATA',
            kakaoOptions: { pfId: 'pf', templateId: 'tpl', disableSms: false, variables: { '#{target}': '@x' } } });
        expect((init.headers as Record<string, string>).Authorization).toMatch(/^HMAC-SHA256 apiKey=key, date=.+, salt=.+, signature=[0-9a-f]{64}$/);
        await expect(sendSolapi(solapi, { to: '1', subject: 's', text: 't' }, json(400, { errorCode: 'ValidationError' }) as never)).rejects.toBeInstanceOf(SolapiRejectedError);
        await expect(sendSolapi(solapi, { to: '1', subject: 's', text: 't' }, json(200, {
            groupInfo: { groupId: 'G', count: { total: 1, registeredFailed: 1 } }, failedMessageList: [{ statusCode: '1062' }],
        }) as never)).rejects.toMatchObject({ code: '1062' });
        await expect(sendSolapi(solapi, { to: '1', subject: 's', text: 't' }, json(502, {}) as never)).rejects.toBeInstanceOf(SolapiUnknownError);
        expect(localKoreanNumber('+821012345678')).toBe('01012345678');
        expect(readSolapiConfig({ CHERRY_SOLAPI_API_KEY: 'a', CHERRY_SOLAPI_API_SECRET: 'b' })).toBeNull();
    });
});

describe('cherry billing', () => {
    const config = { secretKey: 'test_sk', clientKey: 'test_ck' };
    const payment = { paymentKey: 'pk', orderId: 'chr_1', status: 'DONE', totalAmount: 9900, approvedAt: '2026-12-01T00:00:00+09:00' };

    it('keeps the billing key unreadable without the secret and the same member', () => {
        const key = randomBytes(32);
        const stored = encryptBillingKey('billing-key', 'chr_a', key);
        expect(stored).not.toContain('billing-key');
        expect(decryptBillingKey(stored, 'chr_a', key)).toBe('billing-key');
        expect(() => decryptBillingKey(stored, 'chr_b', key)).toThrow();
        expect(() => decryptBillingKey(stored, 'chr_a', randomBytes(32))).toThrow();
    });

    it('binds each charge and refund to one idempotency key', async () => {
        const request = json(200, payment);
        await chargeTossBillingKey(config, { billingKey: 'b', customerKey: 'chr_a', amount: 9900, orderId: 'chr_1', orderName: 'o', email: null }, request as never);
        await cancelTossPayment(config, { paymentKey: 'pk', amount: 100, reason: 'r', refundId: 'rf' }, request as never);
        const headers = request.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
        expect(headers.map(header => header['Idempotency-Key'])).toEqual(['charge-chr_1', 'refund-rf']);
        expect(headers[0].Authorization).toBe(`Basic ${Buffer.from('test_sk:').toString('base64')}`);
    });

    it('separates a decline from an unknown answer', async () => {
        const charge = (request: unknown) => chargeTossBillingKey(config, { billingKey: 'b', customerKey: 'c', amount: 1, orderId: 'o', orderName: 'n', email: null }, request as never);
        await expect(charge(json(403, { code: 'REJECT_CARD_PAYMENT' }))).rejects.toMatchObject({ code: 'REJECT_CARD_PAYMENT' });
        await expect(charge(json(409, { code: 'IDEMPOTENT_REQUEST_PROCESSING' }))).rejects.toBeInstanceOf(TossUnknownError);
        await expect(charge(json(500, {}))).rejects.toBeInstanceOf(TossUnknownError);
        await expect(charge(vi.fn().mockRejectedValue(new Error('timeout')))).rejects.toBeInstanceOf(TossUnknownError);
        expect(await findTossPayment(config, 'o', json(404, { code: 'NOT_FOUND_PAYMENT' }) as never)).toBeNull();
        await expect(findTossPayment(config, 'o', json(401, { code: 'UNAUTHORIZED_KEY' }) as never)).rejects.toBeInstanceOf(TossRejectedError);
    });
});

describe('cherry report safeguards', () => {
    it('shows a gender only when the account says so in its own words', () => {
        expect(verifiedGender('female', 'she/her', '안녕 she/her 입니다')).toBe('female');
        expect(verifiedGender('male', 'he/him', 'he/him')).toBe('male');
        expect(verifiedGender('female', '여자친구', '여자친구랑 여행')).toBe('unknown');
        expect(verifiedGender('female', 'she/her', '소개 없음')).toBe('unknown');
        expect(verifiedGender('male', 'she/her', 'she/her')).toBe('unknown');
        expect(verifiedGender('none', '', '')).toBe('unknown');
    });

    it('keeps report images under their own unguessable keys', () => {
        const key = cherryImageKey('sub', 'event', 'profile', 'x'.repeat(32));
        expect(isCherryImageKey(key)).toBe(true);
        expect(isCherryImageKey('v1/abc/target/def.webp')).toBe(false);
        expect(cherryImageKey('sub', 'event', 'post-0', 'x'.repeat(32))).not.toBe(key);
        expect(() => cherryImageKey('sub', 'event', 'profile', '')).toThrow();
    });
});
