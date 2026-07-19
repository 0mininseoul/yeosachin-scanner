import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const FIVE_MINUTES_SECONDS = 300;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const boundedIdentifier = z.string().trim().min(1).max(256);
const eventIdentifier = z.string().min(1).max(256).refine(
    value => value === value.trim(),
    'Invalid event identifier.'
);
const isoTimestamp = z.string().regex(ISO_TIMESTAMP_PATTERN).refine(
    value => Number.isFinite(Date.parse(value)),
    'Invalid timestamp.'
);

function acceptsGroblePaymentInputMode(eventId: string, inputMode: string): boolean {
    return inputMode === 'PAYMENT_WINDOW'
        || (eventId.startsWith('evt_test_')
            && (inputMode === 'NORMAL' || inputMode === 'SIMPLE'));
}

const paymentCompletedSchema = z.object({
    id: eventIdentifier,
    type: z.literal('payment.completed'),
    version: z.string().trim().min(1).max(64),
    occurredAt: isoTimestamp,
    data: z.object({
        object: z.object({
            merchantUid: boundedIdentifier,
            buyer: z.object({
                email: z.string().trim().email().max(320),
                phoneNumber: z.string().trim().min(1).max(64).optional(),
            }),
            content: z.object({
                id: boundedIdentifier,
                paymentType: z.literal('ONE_TIME'),
                inputMode: z.enum(['PAYMENT_WINDOW', 'NORMAL', 'SIMPLE']),
            }),
            pricing: z.object({
                currency: z.literal('KRW'),
                finalAmount: z.number().int().positive().max(1_000_000_000),
            }),
            payment: z.object({
                purchasedAt: isoTimestamp,
            }),
        }),
    }),
}).refine(
    event => acceptsGroblePaymentInputMode(event.id, event.data.object.content.inputMode),
    { path: ['data', 'object', 'content', 'inputMode'] }
);

const paymentCancelRequestedSchema = z.object({
    id: eventIdentifier,
    type: z.literal('payment.cancel_requested'),
    version: z.string().trim().min(1).max(64),
    occurredAt: isoTimestamp,
    data: z.object({
        object: z.object({
            merchantUid: boundedIdentifier,
            content: z.object({
                id: boundedIdentifier,
                paymentType: z.literal('ONE_TIME'),
                inputMode: z.enum(['PAYMENT_WINDOW', 'NORMAL', 'SIMPLE']),
            }),
            pricing: z.object({
                currency: z.literal('KRW'),
                finalAmount: z.number().int().positive().max(1_000_000_000),
            }),
            cancelRequest: z.object({
                requestedBy: z.literal('BUYER'),
                requestedAt: isoTimestamp,
            }),
        }),
    }),
}).refine(
    event => acceptsGroblePaymentInputMode(event.id, event.data.object.content.inputMode),
    { path: ['data', 'object', 'content', 'inputMode'] }
);

const eventEnvelopeSchema = z.object({
    id: eventIdentifier,
    type: z.string().trim().min(1).max(64),
});

export interface VerifyGrobleWebhookSignatureInput {
    rawBody: string;
    timestamp: string | null;
    signature: string | null;
    previousSignature: string | null;
    secret: string;
    previousSecret: string | null;
    nowMs?: number;
}

export interface GroblePaymentCompletedEvent {
    eventId: string;
    occurredAt: string;
    paymentId: string;
    buyerEmail: string;
    buyerPhoneNumber: string | null;
    productId: string;
    amountKrw: number;
    paidAt: string;
}

export interface GroblePaymentCancelRequestedEvent {
    eventId: string;
    occurredAt: string;
    paymentId: string;
    productId: string;
    amountKrw: number;
    requestedAt: string;
}

export interface GrobleEventEnvelope {
    eventId: string;
    type: string;
}

function calculateSignature(secret: string, timestamp: string, rawBody: string): Buffer {
    return createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest();
}

function matchesSignature(candidate: string | null, expected: Buffer): boolean {
    if (!candidate || !HEX_SHA256_PATTERN.test(candidate)) return false;
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyGrobleWebhookSignature(
    input: VerifyGrobleWebhookSignatureInput
): void {
    if (!input.timestamp || !/^\d{1,16}$/.test(input.timestamp)) {
        throw new Error('Invalid Groble webhook timestamp.');
    }

    const timestampSeconds = Number(input.timestamp);
    const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
    if (!Number.isSafeInteger(timestampSeconds)
        || Math.abs(nowSeconds - timestampSeconds) > FIVE_MINUTES_SECONDS) {
        throw new Error('Stale Groble webhook timestamp.');
    }

    const currentMatches = matchesSignature(
        input.signature,
        calculateSignature(input.secret, input.timestamp, input.rawBody)
    );
    const previousMatches = input.previousSecret !== null && matchesSignature(
        input.previousSignature,
        calculateSignature(input.previousSecret, input.timestamp, input.rawBody)
    );

    if (!currentMatches && !previousMatches) {
        throw new Error('Invalid Groble webhook signature.');
    }
}

export function parseGroblePaymentCompletedEvent(
    rawBody: string
): GroblePaymentCompletedEvent {
    const parsedJson: unknown = JSON.parse(rawBody);
    const event = paymentCompletedSchema.parse(parsedJson);
    const payment = event.data.object;

    return Object.freeze({
        eventId: event.id,
        occurredAt: event.occurredAt,
        paymentId: payment.merchantUid,
        buyerEmail: payment.buyer.email.trim().toLowerCase(),
        buyerPhoneNumber: payment.buyer.phoneNumber ?? null,
        productId: payment.content.id,
        amountKrw: payment.pricing.finalAmount,
        paidAt: payment.payment.purchasedAt,
    });
}

export function parseGroblePaymentCancelRequestedEvent(
    rawBody: string
): GroblePaymentCancelRequestedEvent {
    const parsedJson: unknown = JSON.parse(rawBody);
    const event = paymentCancelRequestedSchema.parse(parsedJson);
    const cancellation = event.data.object;

    return Object.freeze({
        eventId: event.id,
        occurredAt: event.occurredAt,
        paymentId: cancellation.merchantUid,
        productId: cancellation.content.id,
        amountKrw: cancellation.pricing.finalAmount,
        requestedAt: cancellation.cancelRequest.requestedAt,
    });
}

export function parseGrobleEventEnvelope(rawBody: string): GrobleEventEnvelope {
    const parsedJson: unknown = JSON.parse(rawBody);
    const event = eventEnvelopeSchema.parse(parsedJson);
    return Object.freeze({ eventId: event.id, type: event.type });
}
