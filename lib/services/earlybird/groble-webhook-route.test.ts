import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc },
}));

import { POST } from '@/app/api/webhooks/groble/route';

const SECRET = 'webhook-secret';

function payload(overrides: Record<string, unknown> = {}) {
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
                    displayName: '민감한 이름',
                    email: 'buyer@example.com',
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
                payment: { purchasedAt: '2026-07-17T21:00:00+09:00' },
                ...overrides,
            },
        },
    };
}

function request(body: string, options: {
    contentType?: string;
    secret?: string;
    timestamp?: string;
    signature?: string;
    idempotencyKey?: string;
} = {}): Request {
    const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
    const signature = options.signature ?? createHmac('sha256', options.secret ?? SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return new Request('https://example.com/api/webhooks/groble', {
        method: 'POST',
        headers: {
            'content-type': options.contentType ?? 'application/json',
            'x-groble-signature': signature,
            'x-groble-timestamp': timestamp,
            'x-groble-idempotency-key': options.idempotencyKey ?? 'delivery_0001',
        },
        body,
    });
}

describe('signed Groble webhook route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GROBLE_BASIC_PRODUCT_ID = 'basic_product-01';
        process.env.GROBLE_STANDARD_PRODUCT_ID = 'standard_product-01';
        process.env.GROBLE_BASIC_PAYMENT_ADDRESS = 'basic-checkout-a1';
        process.env.GROBLE_STANDARD_PAYMENT_ADDRESS = 'standard-checkout-b2';
        process.env.GROBLE_WEBHOOK_SECRET = SECRET;
        delete process.env.GROBLE_WEBHOOK_PREVIOUS_SECRET;
        mocks.rpc.mockResolvedValue({
            data: [{
                disposition: 'accepted',
                order_id: '123e4567-e89b-42d3-a456-426614174000',
                status: 'paid',
                plan_sequence: 1,
            }],
            error: null,
        });
    });

    it('rejects non-JSON, invalid signatures, stale timestamps, and malformed payloads', async () => {
        expect((await POST(request('{}', { contentType: 'text/plain' }))).status).toBe(415);
        expect((await POST(request('{}', { signature: '0'.repeat(64) }))).status).toBe(401);
        expect((await POST(request('{}', {
            timestamp: String(Math.floor(Date.now() / 1_000) - 301),
        }))).status).toBe(401);
        expect((await POST(request('{'))).status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('returns a retryable response when webhook server configuration is unavailable', async () => {
        delete process.env.GROBLE_WEBHOOK_SECRET;

        const response = await POST(request(JSON.stringify(payload())));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            received: false,
            code: 'WEBHOOK_CONFIGURATION_UNAVAILABLE',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('moves a paid order to refund review for an official cancellation request', async () => {
        const completed = payload();
        const body = JSON.stringify({
            ...completed,
            type: 'payment.cancel_requested',
            data: {
                object: {
                    ...completed.data.object,
                    cancelRequest: {
                        reason: { code: 'CHANGED_MIND', label: '마음이 바뀌었어요' },
                        requestedBy: 'BUYER',
                        requestedAt: '2026-07-18T09:00:00+09:00',
                    },
                },
            },
        });
        mocks.rpc.mockResolvedValue({
            data: [{
                disposition: 'cancel_requested',
                order_id: '123e4567-e89b-42d3-a456-426614174000',
                status: 'refund_pending',
                plan_sequence: 1,
            }],
            error: null,
        });
        const response = await POST(request(body));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            received: true,
            disposition: 'cancel_requested',
        });
        expect(mocks.rpc).toHaveBeenCalledWith(
            'finalize_earlybird_groble_cancel_request',
            {
                p_event_id: 'evt_test_a1b2c3d4e5f60718293a4b5c',
                p_idempotency_key: 'delivery_0001',
                p_event_type: 'payment.cancel_requested',
                p_occurred_at: '2026-07-17T21:00:00+09:00',
                p_payment_id: 'merchant_0001',
                p_product_id: 'basic_product-01',
                p_amount_krw: 14_900,
                p_requested_at: '2026-07-18T09:00:00+09:00',
            }
        );
    });

    it('acknowledges a signed unsupported event without mutating payment state', async () => {
        const body = JSON.stringify({ ...payload(), type: 'payment.purchased' });
        const response = await POST(request(body));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ received: true, disposition: 'ignored' });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('passes only normalized official payment evidence to the atomic finalizer', async () => {
        const body = JSON.stringify(payload());
        const response = await POST(request(body));

        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('finalize_earlybird_groble_payment', {
            p_event_id: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            p_idempotency_key: 'delivery_0001',
            p_event_type: 'payment.completed',
            p_occurred_at: '2026-07-17T21:00:00+09:00',
            p_payment_id: 'merchant_0001',
            p_buyer_email: 'buyer@example.com',
            p_product_id: 'basic_product-01',
            p_amount_krw: 14_900,
            p_paid_at: '2026-07-17T21:00:00+09:00',
        });
        const responseText = await response.text();
        expect(responseText).toContain('accepted');
        expect(responseText).not.toMatch(/buyer@example|01000000000|merchant_0001|basic_product-01/);
    });

    it.each([
        ['mismatch', 'payment_failed'],
        ['duplicate_event', 'paid'],
        ['overflow_refund_required', 'overflow_refund_required'],
        ['cancel_before_payment', 'refund_pending'],
        ['late_cancelled_payment', 'refund_pending'],
    ])('acknowledges the %s disposition without asking Groble to retry', async (disposition, status) => {
        mocks.rpc.mockResolvedValue({
            data: [{
                disposition,
                order_id: '123e4567-e89b-42d3-a456-426614174000',
                status,
                plan_sequence: disposition === 'duplicate_event' ? 1 : null,
            }],
            error: null,
        });
        const response = await POST(request(JSON.stringify(payload({
            content: {
                ...payload().data.object.content,
                id: disposition === 'mismatch' ? 'wrong_product' : 'basic_product-01',
            },
        }))));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ received: true, disposition });
    });

    it('returns retryable 500 for a persistence failure without leaking its detail', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'database detail buyer@example.com' },
        });
        const response = await POST(request(JSON.stringify(payload())));
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('buyer@example.com');
    });

    it('does not import or invoke automatic analysis dispatchers', () => {
        const source = readFileSync(
            new URL('../../../app/api/webhooks/groble/route.ts', import.meta.url),
            'utf8'
        );
        expect(source).not.toMatch(/analysis_requests|Cloud Tasks|dispatchAnalysis|enqueue/i);
    });
});
