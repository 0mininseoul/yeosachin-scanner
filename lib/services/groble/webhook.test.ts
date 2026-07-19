import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    parseGrobleEventEnvelope,
    parseGroblePaymentCancelRequestedEvent,
    parseGroblePaymentCompletedEvent,
    verifyGrobleWebhookSignature,
} from './webhook';

const NOW_MS = Date.parse('2026-07-17T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW_MS / 1_000));
const SECRET = 'current-secret';
const PREVIOUS_SECRET = 'previous-secret';
const WHITESPACE_TEST_EVENT_IDS = [
    ['leading', ' evt_test_a1b2c3d4e5f60718293a4b5c'],
    ['trailing', 'evt_test_a1b2c3d4e5f60718293a4b5c\t'],
] as const;

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
                    displayName: '  구매자  ',
                    email: 'BUYER@Example.com ',
                    phoneNumber: '  010-1234-5678  ',
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

function cancelRequestedPayload(overrides: Record<string, unknown> = {}) {
    const completed = paymentPayload();
    return {
        ...completed,
        type: 'payment.cancel_requested',
        data: {
            object: {
                ...completed.data.object,
                cancelRequest: {
                    requestedBy: 'BUYER',
                    requestedAt: '2026-07-18T09:00:00+09:00',
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

describe('Groble event envelope parser', () => {
    it.each(WHITESPACE_TEST_EVENT_IDS)(
        'rejects a test-looking event ID with %s whitespace',
        (_, eventId) => {
            expect(() => parseGrobleEventEnvelope(JSON.stringify({
                id: eventId,
                type: 'payment.completed',
            }))).toThrow();
        }
    );
});

describe('Groble payment.completed parser', () => {
    it('projects only the payment evidence needed by the server', () => {
        expect(parseGroblePaymentCompletedEvent(JSON.stringify(paymentPayload()))).toEqual({
            eventId: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            occurredAt: '2026-07-17T21:00:00+09:00',
            paymentId: 'merchant_0001',
            buyerEmail: 'buyer@example.com',
            buyerPhoneNumber: '010-1234-5678',
            productId: 'basic_product-01',
            amountKrw: 14_900,
            paidAt: '2026-07-17T21:00:00+09:00',
        });
    });

    it('returns a null buyer phone for legacy completed events', () => {
        const event = paymentPayload({
            buyer: {
                type: 'MEMBER',
                email: 'legacy-buyer@example.com',
            },
        });

        expect(parseGroblePaymentCompletedEvent(JSON.stringify(event))).toMatchObject({
            buyerEmail: 'legacy-buyer@example.com',
            buyerPhoneNumber: null,
        });
    });

    it.each([
        ['phoneNumber', ''],
        ['phoneNumber', '   '],
        ['phoneNumber', '1'.repeat(65)],
        ['phoneNumber', 10_1234_5678],
        ['phoneNumber', null],
    ])('rejects an invalid completed buyer %s value', (field, invalidValue) => {
        const buyer = {
            ...paymentPayload().data.object.buyer,
            [field]: invalidValue,
        };

        expect(() => parseGroblePaymentCompletedEvent(JSON.stringify(
            paymentPayload({ buyer })
        ))).toThrow();
    });

    it.each([
        ['absent', undefined],
        ['empty', ''],
        ['long', 'a'.repeat(101)],
        ['non-string', { unexpected: true }],
    ])('ignores an irrelevant %s displayName', (_, displayName) => {
        const buyer: Record<string, unknown> = {
            ...paymentPayload().data.object.buyer,
        };
        if (displayName === undefined) delete buyer.displayName;
        else buyer.displayName = displayName;

        const parsed = parseGroblePaymentCompletedEvent(JSON.stringify(
            paymentPayload({ buyer })
        ));

        expect(parsed).toMatchObject({
            buyerEmail: 'buyer@example.com',
            buyerPhoneNumber: '010-1234-5678',
        });
        expect(parsed).not.toHaveProperty('buyerDisplayName');
    });

    it('does not return or log unprojected raw payment fields', () => {
        const consoleSpies = [
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
            vi.spyOn(console, 'info').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
        ];

        try {
            const parsed = parseGroblePaymentCompletedEvent(JSON.stringify(paymentPayload()));

            expect(JSON.stringify(parsed)).not.toMatch(/maskedCardNumber|1234-\*\*\*\*/);
            for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
        } finally {
            for (const spy of consoleSpies) spy.mockRestore();
        }
    });

    it.each(['NORMAL', 'SIMPLE'])(
        'accepts %s input mode for a synthetic test event',
        inputMode => {
            const event = paymentPayload({
                content: { ...paymentPayload().data.object.content, inputMode },
            });

            expect(parseGroblePaymentCompletedEvent(JSON.stringify(event))).toMatchObject({
                eventId: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            });
        }
    );

    it.each(['NORMAL', 'SIMPLE'])(
        'rejects %s input mode for a non-test event',
        inputMode => {
            const event = paymentPayload({
                content: { ...paymentPayload().data.object.content, inputMode },
            });
            event.id = 'evt_live_a1b2c3d4e5f60718293a4b5c';

            expect(() => parseGroblePaymentCompletedEvent(JSON.stringify(event))).toThrow();
        }
    );

    it.each(WHITESPACE_TEST_EVENT_IDS)(
        'rejects a NORMAL test event ID with %s whitespace',
        (_, eventId) => {
            const event = paymentPayload({
                content: { ...paymentPayload().data.object.content, inputMode: 'NORMAL' },
            });
            event.id = eventId;

            expect(() => parseGroblePaymentCompletedEvent(JSON.stringify(event))).toThrow();
        }
    );

    it('rejects unsupported modes, recurring, non-KRW, malformed, and non-completed events', () => {
        const invalidObjects = [
            { content: { ...paymentPayload().data.object.content, inputMode: 'EMBEDDED' } },
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

    it.each(['NORMAL', 'SIMPLE'])(
        'accepts %s input mode for a synthetic test event',
        inputMode => {
            const event = cancelRequestedPayload({
                content: { ...paymentPayload().data.object.content, inputMode },
            });

            expect(parseGroblePaymentCancelRequestedEvent(JSON.stringify(event))).toMatchObject({
                eventId: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            });
        }
    );

    it.each(['NORMAL', 'SIMPLE'])(
        'rejects %s input mode for a non-test event',
        inputMode => {
            const event = cancelRequestedPayload({
                content: { ...paymentPayload().data.object.content, inputMode },
            });
            event.id = 'evt_live_a1b2c3d4e5f60718293a4b5c';

            expect(() => parseGroblePaymentCancelRequestedEvent(JSON.stringify(event))).toThrow();
        }
    );

    it.each(WHITESPACE_TEST_EVENT_IDS)(
        'rejects a SIMPLE test event ID with %s whitespace',
        (_, eventId) => {
            const event = cancelRequestedPayload({
                content: { ...paymentPayload().data.object.content, inputMode: 'SIMPLE' },
            });
            event.id = eventId;

            expect(() => parseGroblePaymentCancelRequestedEvent(JSON.stringify(event))).toThrow();
        }
    );

    it('keeps unsupported modes, recurring payments, and non-KRW pricing invalid', () => {
        const invalidObjects = [
            { content: { ...paymentPayload().data.object.content, inputMode: 'EMBEDDED' } },
            { content: { ...paymentPayload().data.object.content, paymentType: 'SUBSCRIPTION' } },
            { pricing: { ...paymentPayload().data.object.pricing, currency: 'USD' } },
        ];

        for (const invalidObject of invalidObjects) {
            expect(() => parseGroblePaymentCancelRequestedEvent(
                JSON.stringify(cancelRequestedPayload(invalidObject))
            )).toThrow();
        }
    });
});
