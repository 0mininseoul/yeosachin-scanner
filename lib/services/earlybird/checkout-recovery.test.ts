import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findCheckoutForRecovery: vi.fn(),
    getGrobleCheckoutUrl: vi.fn(() => 'https://provider.example/checkout'),
}));

vi.mock('./store', () => ({
    earlybirdStore: {
        findCheckoutForRecovery: mocks.findCheckoutForRecovery,
    },
    EarlybirdPersistenceError: class EarlybirdPersistenceError extends Error {},
}));
vi.mock('@/lib/services/groble/config', () => ({
    readGrobleConfig: vi.fn(() => ({
        productIds: { basic: 'basic-product', standard: 'standard-product' },
    })),
    getGrobleCheckoutUrl: mocks.getGrobleCheckoutUrl,
}));

import { recoverEarlybirdCheckout } from './checkout';

const ids = {
    userId: '123e4567-e89b-42d3-a456-426614174000',
    preflightId: '123e4567-e89b-42d3-a456-426614174001',
    orderId: '123e4567-e89b-42d3-a456-426614174002',
};

function pendingRecord(createdAt: string) {
    return {
        orderId: ids.orderId,
        userId: ids.userId,
        preflightId: ids.preflightId,
        targetInstagramId: 'target.account',
        planId: 'standard' as const,
        pricingVersion: 'earlybird-2026-07-v1',
        expectedAmountKrw: 19_900,
        expectedProductId: 'standard-product',
        buyerMatchPolicy: 'verified_kakao_phone',
        expectedBuyerPhoneNumberNormalized: '+821012345678',
        expectedBuyerPhoneVerificationSource: 'kakao_rest_api',
        disclosureVersion: 'earlybird-24h-v1',
        disclosureText:
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.',
        disclosureAcceptedAt: new Date().toISOString(),
        sellerReference: 'ord.0123456789abcdef0123456789abcdef',
        status: 'payment_pending' as const,
        paymentId: null,
        actualAmountKrw: null,
        paidAt: null,
        createdAt,
    };
}

const currentPhone = {
    normalizedPhone: '+821012345678',
    verificationSource: 'kakao_rest_api' as const,
};

describe('earlybird checkout recovery boundary', () => {
    it('returns only server-side order metadata and allows recovery before 24 hours', async () => {
        mocks.findCheckoutForRecovery.mockResolvedValueOnce(
            pendingRecord(new Date(Date.now() - 23 * 60 * 60 * 1_000).toISOString())
        );

        const result = await recoverEarlybirdCheckout({
            ...ids,
            planId: 'standard',
            targetInstagramId: 'target.account',
            currentPhone,
        });

        expect(result).toEqual({
            orderId: ids.orderId,
            planId: 'standard',
            expectedAmountKrw: 19_900,
        });
        expect(result).not.toHaveProperty('checkoutUrl');
        expect(mocks.getGrobleCheckoutUrl).not.toHaveBeenCalled();
    });

    it.each([24, 25])('denies recovery at or after %s hours', async hours => {
        mocks.findCheckoutForRecovery.mockResolvedValueOnce(
            pendingRecord(new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString())
        );

        await expect(recoverEarlybirdCheckout({
            ...ids,
            planId: 'standard',
            targetInstagramId: 'target.account',
            currentPhone,
        })).rejects.toMatchObject({ message: 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE' });
    });

    it.each([
        ['at the application clock', 0, true],
        ['with a small future skew', 2 * 60 * 1_000, true],
        ['with a material future skew', 6 * 60 * 1_000, false],
    ])('handles a checkout createdAt %s', async (_label, offsetMs, recoverable) => {
        const now = new Date('2026-08-28T00:00:00.000Z');
        mocks.findCheckoutForRecovery.mockResolvedValueOnce(
            pendingRecord(new Date(now.getTime() + offsetMs).toISOString())
        );

        const attempt = recoverEarlybirdCheckout({
            ...ids,
            planId: 'standard' as const,
            targetInstagramId: 'target.account',
            currentPhone,
            now,
        });
        if (recoverable) {
            await expect(attempt).resolves.toMatchObject({ orderId: ids.orderId });
        } else {
            await expect(attempt).rejects.toMatchObject({
                message: 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE',
            });
        }
    });
});
