import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    parseGroblePaymentCancelRequestedEvent,
    parseGroblePaymentCompletedEvent,
    verifyGrobleWebhookSignature,
} from './webhook';

const NOW_MS = Date.parse('2026-07-17T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW_MS / 1_000));
const SECRET = 'current-secret';
const PREVIOUS_SECRET = 'previous-secret';

function signature(secret: string, timestamp: string, rawBody: string): string {
    return createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
}

function paymentPayload(overrides: Record<string, unknown> = {}) {
    return {
        id: 'evt_test_a1b2c3d4e5f60718293a4b5c',
        type: 'payment.completed',
        version: '2026-04-21',
        occurredAt: '2026-07-17T21:00:00+09:00',
        data: {
            object: {
                merchantUid: 'merchant_0001',
                buyer: {
                    type: 'MEMBER',
                    displayName: '구매자',
                    email: 'BUYER@Example.com ',
                    phoneNumber: '01000000000',
                },
                content: {
                    id: 'basic_product-01',
                    title: 'Basic 얼리버드',
                    type: 'SERVICE',
                    paymentType: 'ONE_TIME',
                    inputMode: 'PAYMENT_WINDOW',
                },
                pricing: {
                    currency: 'KRW',
                    originalAmount: 39_900,
                    optionDiscountAmount: 25_000,
                    finalAmount: 14_900,
                    couponDiscountAmount: 0,
                },
                paymentMethod: {
                    type: 'CARD',
                    maskedCardNumber: '1234-****-****-5678',
                },
                payment: {
                    purchasedAt: '2026-07-17T21:00:00+09:00',
                },
                ...overrides,
            },
        },
    };
}

describe('Groble webhook signature verification', () => {
    it('verifies the raw body with the current secret', () => {
        const rawBody = JSON.stringify(paymentPayload());
        expect(() => verifyGrobleWebhookSignature({
            rawBody,
            timestamp: TIMESTAMP,
            signature: signature(SECRET, TIMESTAMP, rawBody),
            previousSignature: null,
            secret: SECRET,
            previousSecret: PREVIOUS_SECRET,
            nowMs: NOW_MS,
        })).not.toThrow();
    });

    it('accepts the previous signature only with the configured previous secret', () => {
        const rawBody = JSON.stringify(paymentPayload());
        expect(() => verifyGrobleWebhookSignature({
            rawBody,
            timestamp: TIMESTAMP,
            signature: '0'.repeat(64),
            previousSignature: signature(PREVIOUS_SECRET, TIMESTAMP, rawBody),
            secret: SECRET,
            previousSecret: PREVIOUS_SECRET,
            nowMs: NOW_MS,
        })).not.toThrow();
    });

    it('rejects malformed, invalid, and stale signatures', () => {
        const rawBody = JSON.stringify(paymentPayload());
        const validSignature = signature(SECRET, TIMESTAMP, rawBody);

        for (const input of [
            { timestamp: TIMESTAMP, signature: 'not-hex' },
            { timestamp: TIMESTAMP, signature: '0'.repeat(64) },
            { timestamp: String(Number(TIMESTAMP) - 301), signature: validSignature },
        ]) {
            expect(() => verifyGrobleWebhookSignature({
                rawBody,
                timestamp: input.timestamp,
                signature: input.signature,
                previousSignature: null,
                secret: SECRET,
                previousSecret: null,
                nowMs: NOW_MS,
            })).toThrow();
        }
    });
});

describe('Groble payment.completed parser', () => {
    it('projects only the payment evidence needed by the server', () => {
        expect(parseGroblePaymentCompletedEvent(JSON.stringify(paymentPayload()))).toEqual({
            eventId: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            occurredAt: '2026-07-17T21:00:00+09:00',
            paymentId: 'merchant_0001',
            buyerEmail: 'buyer@example.com',
            productId: 'basic_product-01',
            amountKrw: 14_900,
            paidAt: '2026-07-17T21:00:00+09:00',
        });
    });

    it('rejects non-window, recurring, non-KRW, malformed, and non-completed events', () => {
        const invalidObjects = [
            { content: { ...paymentPayload().data.object.content, inputMode: 'NORMAL' } },
            { content: { ...paymentPayload().data.object.content, paymentType: 'SUBSCRIPTION' } },
            { pricing: { ...paymentPayload().data.object.pricing, currency: 'USD' } },
        ];

        for (const invalidObject of invalidObjects) {
            expect(() => parseGroblePaymentCompletedEvent(
                JSON.stringify(paymentPayload(invalidObject))
            )).toThrow();
        }
        expect(() => parseGroblePaymentCompletedEvent('{')).toThrow();
        expect(() => parseGroblePaymentCompletedEvent(JSON.stringify({
            ...paymentPayload(),
            type: 'payment.cancel_requested',
        }))).toThrow();
    });
});

describe('Groble payment.cancel_requested parser', () => {
    it('projects only the original payment identity and request timestamp', () => {
        const completed = paymentPayload();
        const cancelRequested = {
            ...completed,
            id: 'evt_cancel_a1b2c3d4e5f60718293a4b5c',
            type: 'payment.cancel_requested',
            data: {
                object: {
                    ...completed.data.object,
                    cancelRequest: {
                        reason: { code: 'CHANGED_MIND', label: '마음이 바뀌었어요' },
                        requestedBy: 'BUYER',
                        requestedAt: '2026-07-18T09:00:00+09:00',
                        detailReason: '브라우저에 노출하거나 저장하지 않을 사유',
                    },
                },
            },
        };

        expect(parseGroblePaymentCancelRequestedEvent(JSON.stringify(cancelRequested))).toEqual({
            eventId: 'evt_cancel_a1b2c3d4e5f60718293a4b5c',
            occurredAt: '2026-07-17T21:00:00+09:00',
            paymentId: 'merchant_0001',
            productId: 'basic_product-01',
            amountKrw: 14_900,
            requestedAt: '2026-07-18T09:00:00+09:00',
        });
    });
});
