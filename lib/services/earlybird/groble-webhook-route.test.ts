import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174003',
        trace_id: null,
        route: '/api/webhooks/groble',
        method: 'POST',
    })),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc },
}));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
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
        const rejected = mocks.emit.mock.calls
            .map(([entry]) => entry as {
                event?: string;
                fields?: { error_code?: string };
            })
            .filter(entry => entry.event === 'groble.webhook_rejected');
        expect(rejected).toHaveLength(4);
        expect(rejected.map(entry => entry.fields?.error_code)).toEqual([
            'VALIDATION_ERROR',
            'UNAUTHORIZED',
            'UNAUTHORIZED',
            'VALIDATION_ERROR',
        ]);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_rejected',
            severity: 'warn',
            fields: {
                request_id: '423e4567-e89b-42d3-a456-426614174003',
                trace_id: null,
                route: '/api/webhooks/groble',
                method: 'POST',
                provider: 'groble',
                operation: 'webhook',
                disposition: 'rejected',
                error_code: 'UNAUTHORIZED',
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain('delivery_0001');
    });

    it('returns only invalid field paths for a signed Groble test delivery', async () => {
        const body = JSON.stringify(payload({
            buyer: {
                ...payload().data.object.buyer,
                email: 'private-buyer@example.com',
            },
            pricing: {
                ...payload().data.object.pricing,
                finalAmount: '14900',
            },
        }));

        const response = await POST(request(body));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            received: false,
            code: 'INVALID_PAYMENT_PAYLOAD',
            invalidFields: ['data.object.pricing.finalAmount'],
        });
        expect(await POST(request(JSON.stringify(payload({
            pricing: {
                ...payload().data.object.pricing,
                finalAmount: 'private-value',
            },
        })))).then(result => result.text())).not.toContain('private-value');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('does not expose schema diagnostics for a non-test payment event', async () => {
        const event = payload({
            pricing: {
                ...payload().data.object.pricing,
                finalAmount: 'private-value',
            },
        });
        event.id = 'evt_live_a1b2c3d4e5f60718293a4b5c';

        const response = await POST(request(JSON.stringify(event)));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            received: false,
            code: 'INVALID_PAYMENT_PAYLOAD',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_rejected',
            severity: 'warn',
            fields: expect.objectContaining({
                provider: 'groble',
                operation: 'webhook',
                disposition: 'rejected',
                error_code: 'VALIDATION_ERROR',
            }),
        });
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_rejected',
            severity: 'error',
            fields: expect.objectContaining({
                provider: 'groble',
                operation: 'webhook',
                disposition: 'rejected',
                error_code: 'INTERNAL_ERROR',
            }),
        });
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

    it('matches with normalized contact inputs without forwarding raw buyer evidence', async () => {
        const body = JSON.stringify(payload({
            buyer: {
                ...payload().data.object.buyer,
                email: 'different-groble-buyer@example.net',
                phoneNumber: '  010-1234-5678  ',
                displayName: '  결제 구매자  ',
            },
        }));
        const response = await POST(request(body));

        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('finalize_earlybird_groble_payment', {
            p_event_id: 'evt_test_a1b2c3d4e5f60718293a4b5c',
            p_idempotency_key: 'delivery_0001',
            p_event_type: 'payment.completed',
            p_occurred_at: '2026-07-17T21:00:00+09:00',
            p_payment_id: 'merchant_0001',
            p_buyer_email: 'different-groble-buyer@example.net',
            p_buyer_phone_normalized: '+821012345678',
            p_buyer_phone_raw: null,
            p_buyer_display_name: null,
            p_product_id: 'basic_product-01',
            p_amount_krw: 14_900,
            p_paid_at: '2026-07-17T21:00:00+09:00',
        });
        const responseText = await response.text();
        expect(responseText).toContain('accepted');
        expect(responseText).not.toMatch(
            /different-groble-buyer|010-1234-5678|결제 구매자|merchant_0001|basic_product-01/
        );
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_received',
            severity: 'info',
            fields: {
                request_id: '423e4567-e89b-42d3-a456-426614174003',
                trace_id: null,
                route: '/api/webhooks/groble',
                method: 'POST',
                provider: 'groble',
                operation: 'webhook',
                webhook_event_type: 'payment.completed',
                disposition: 'accepted',
            },
        });
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_finalized',
            severity: 'info',
            fields: {
                request_id: '423e4567-e89b-42d3-a456-426614174003',
                trace_id: null,
                route: '/api/webhooks/groble',
                method: 'POST',
                provider: 'groble',
                operation: 'webhook',
                webhook_event_type: 'payment.completed',
                order_id: '123e4567-e89b-42d3-a456-426614174000',
                plan_id: 'basic',
                amount_krw: 14_900,
                disposition: 'accepted',
            },
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /different-groble-buyer|010-1234-5678|결제 구매자|merchant_0001|basic_product-01|delivery_0001|evt_test_/
        );
    });

    it.each([
        ['absent', undefined],
        ['empty', ''],
        ['long', `private-name-${'x'.repeat(101)}`],
    ])('finalizes a signed payment with %s displayName without forwarding or logging it', async (
        _,
        displayName
    ) => {
        const buyer: Record<string, unknown> = {
            ...payload().data.object.buyer,
        };
        if (displayName === undefined) delete buyer.displayName;
        else buyer.displayName = displayName;

        const response = await POST(request(JSON.stringify(payload({ buyer }))));

        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith(
            'finalize_earlybird_groble_payment',
            expect.objectContaining({ p_buyer_display_name: null })
        );
        const observedOutput = JSON.stringify({
            rpc: mocks.rpc.mock.calls,
            logs: mocks.emit.mock.calls,
            response: await response.text(),
        });
        if (typeof displayName === 'string' && displayName.length > 0) {
            expect(observedOutput).not.toContain(displayName);
        }
    });

    it.each([
        ['absent', undefined, null],
        ['invalid', 'not-a-korean-mobile', 'not-a-korean-mobile'],
    ])('uses a null normalized phone for %s phone evidence without forwarding it', async (
        _,
        phoneNumber,
        expectedRawPhone
    ) => {
        const buyer: Record<string, unknown> = {
            type: 'MEMBER',
            email: 'buyer@example.com',
        };
        if (phoneNumber !== undefined) buyer.phoneNumber = phoneNumber;

        const response = await POST(request(JSON.stringify(payload({ buyer }))));

        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith(
            'finalize_earlybird_groble_payment',
            expect.objectContaining({
                p_buyer_phone_normalized: null,
                p_buyer_phone_raw: null,
                p_buyer_display_name: null,
            })
        );
        if (expectedRawPhone) {
            expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(expectedRawPhone);
        }
        const responseText = await response.text();
        expect(responseText).not.toMatch(/buyer@example|not-a-korean-mobile/);
    });

    it.each([
        ['unmatched', null],
        ['ambiguous_buyer', null],
        ['mismatch', 'payment_failed'],
        ['duplicate_event', 'paid'],
        ['duplicate_payment', 'payment_failed'],
        ['overflow_refund_required', 'overflow_refund_required'],
        ['cancel_duplicate_event', 'refund_pending'],
        ['cancel_unmatched', null],
        ['cancel_mismatch', 'payment_failed'],
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'groble.webhook_rejected',
            severity: 'error',
            fields: expect.objectContaining({
                webhook_event_type: 'payment.completed',
                plan_id: 'basic',
                amount_krw: 14_900,
                disposition: 'rejected',
                error_code: 'INTERNAL_ERROR',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /database detail|buyer@example|merchant_0001|basic_product-01|delivery_0001|evt_test_/
        );
    });

    it('does not import or invoke automatic analysis dispatchers', () => {
        const source = readFileSync(
            new URL('../../../app/api/webhooks/groble/route.ts', import.meta.url),
            'utf8'
        );
        expect(source).not.toMatch(/analysis_requests|Cloud Tasks|dispatchAnalysis|enqueue/i);
    });
});
