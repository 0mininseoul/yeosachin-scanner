import { z } from 'zod';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isJsonRequest } from '@/lib/services/earlybird/contracts';
import {
    readGrobleConfig,
    type GrobleConfig,
} from '@/lib/services/groble/config';
import type { PaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';
import { normalizeKoreanMobileNumber } from '@/lib/services/identity/phone-number';
import {
    parseGrobleEventEnvelope,
    parseGroblePaymentCancelRequestedEvent,
    parseGroblePaymentCompletedEvent,
    verifyGrobleWebhookSignature,
} from '@/lib/services/groble/webhook';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';

const MAX_WEBHOOK_BYTES = 256 * 1_024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

const finalizationResultSchema = z.array(z.object({
    disposition: z.enum([
        'accepted',
        'duplicate_event',
        'duplicate_payment',
        'unmatched',
        'ambiguous_buyer',
        'mismatch',
        'overflow_refund_required',
        'cancel_requested',
        'cancel_duplicate_event',
        'cancel_unmatched',
        'cancel_mismatch',
        'cancel_before_payment',
        'late_cancelled_payment',
    ]),
    order_id: z.string().uuid().nullable(),
    status: z.string().nullable(),
    plan_sequence: z.number().int().min(1).max(10).nullable(),
})).length(1);

function response(status: number, body: Record<string, unknown>): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store' },
    });
}

type WebhookEventType = 'payment.completed' | 'payment.cancel_requested' | 'other';

interface WebhookLogState {
    webhookEventType?: WebhookEventType;
    orderId?: string | null;
    planId?: PaidEarlybirdPlanId;
    amountKrw?: number;
}

function safeWebhookEventType(value: string): WebhookEventType {
    return value === 'payment.completed' || value === 'payment.cancel_requested'
        ? value
        : 'other';
}

function planForProduct(productId: string, config: GrobleConfig): PaidEarlybirdPlanId | undefined {
    if (productId === config.productIds.basic) return 'basic';
    if (productId === config.productIds.standard) return 'standard';
    return undefined;
}

function webhookFields(
    context: OperationalRequestContext,
    state: WebhookLogState,
): Record<string, unknown> {
    return {
        ...context,
        provider: 'groble',
        operation: 'webhook',
        ...(state.webhookEventType
            ? { webhook_event_type: state.webhookEventType }
            : {}),
        ...(state.orderId ? { order_id: state.orderId } : {}),
        ...(state.planId ? { plan_id: state.planId } : {}),
        ...(state.amountKrw === undefined ? {} : { amount_krw: state.amountKrw }),
    };
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const reject = (
        status: number,
        body: Record<string, unknown>,
        errorCode: string,
        state: WebhookLogState = {},
    ): NextResponse => {
        operationalLogger.emit({
            event: 'groble.webhook_rejected',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...webhookFields(context, state),
                disposition: 'rejected',
                error_code: errorCode,
            },
        });
        return response(status, body);
    };

    if (!isJsonRequest(request)) {
        return reject(
            415,
            { received: false, code: 'UNSUPPORTED_MEDIA_TYPE' },
            'VALIDATION_ERROR',
        );
    }

    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
        return reject(
            413,
            { received: false, code: 'PAYLOAD_TOO_LARGE' },
            'VALIDATION_ERROR',
        );
    }

    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return reject(400, { received: false, code: 'INVALID_BODY' }, 'INVALID_REQUEST');
    }
    if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
        return reject(
            413,
            { received: false, code: 'PAYLOAD_TOO_LARGE' },
            'VALIDATION_ERROR',
        );
    }

    let config;
    try {
        config = readGrobleConfig();
    } catch {
        return reject(
            503,
            {
                received: false,
                code: 'WEBHOOK_CONFIGURATION_UNAVAILABLE',
            },
            'INTERNAL_ERROR',
        );
    }

    try {
        verifyGrobleWebhookSignature({
            rawBody,
            timestamp: request.headers.get('x-groble-timestamp'),
            signature: request.headers.get('x-groble-signature'),
            previousSignature: request.headers.get('x-groble-signature-previous'),
            secret: config.webhookSecret,
            previousSecret: config.webhookPreviousSecret,
        });
    } catch {
        return reject(
            401,
            { received: false, code: 'INVALID_SIGNATURE' },
            'UNAUTHORIZED',
        );
    }

    const idempotencyKey = request.headers.get('x-groble-idempotency-key')?.trim();
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return reject(
            400,
            { received: false, code: 'INVALID_IDEMPOTENCY_KEY' },
            'VALIDATION_ERROR',
        );
    }

    let envelope;
    try {
        envelope = parseGrobleEventEnvelope(rawBody);
    } catch {
        return reject(
            400,
            { received: false, code: 'INVALID_PAYLOAD' },
            'VALIDATION_ERROR',
        );
    }
    const webhookEventType = safeWebhookEventType(envelope.type);
    operationalLogger.emit({
        event: 'groble.webhook_received',
        severity: 'info',
        fields: {
            ...webhookFields(context, { webhookEventType }),
            disposition: webhookEventType === 'other' ? 'ignored' : 'accepted',
        },
    });
    if (envelope.type !== 'payment.completed'
        && envelope.type !== 'payment.cancel_requested') {
        return response(200, { received: true, disposition: 'ignored' });
    }

    let persistence;
    let state: WebhookLogState = { webhookEventType };
    if (envelope.type === 'payment.completed') {
        let payment;
        try {
            payment = parseGroblePaymentCompletedEvent(rawBody);
        } catch (error) {
            if (envelope.eventId.startsWith('evt_test_') && error instanceof z.ZodError) {
                const invalidFields = Array.from(new Set(
                    error.issues.map(issue => issue.path.join('.')).filter(Boolean)
                )).sort();
                return reject(
                    400,
                    {
                        received: false,
                        code: 'INVALID_PAYMENT_PAYLOAD',
                        invalidFields,
                    },
                    'VALIDATION_ERROR',
                    state,
                );
            }
            return reject(
                400,
                { received: false, code: 'INVALID_PAYMENT_PAYLOAD' },
                'VALIDATION_ERROR',
                state,
            );
        }
        state = {
            ...state,
            planId: planForProduct(payment.productId, config),
            amountKrw: payment.amountKrw,
        };
        const buyerPhoneNormalized = normalizeKoreanMobileNumber(payment.buyerPhoneNumber);
        try {
            const params = {
                p_event_id: payment.eventId,
                p_idempotency_key: idempotencyKey,
                p_event_type: 'payment.completed',
                p_occurred_at: payment.occurredAt,
                p_payment_id: payment.paymentId,
                p_buyer_email: payment.buyerEmail,
                p_buyer_phone_normalized: buyerPhoneNormalized,
                // The canonical RPC keeps these compatibility arguments while old
                // application instances drain. Raw buyer contacts are not retained.
                p_buyer_phone_raw: null,
                p_buyer_display_name: null,
                p_product_id: payment.productId,
                p_amount_krw: payment.amountKrw,
                p_paid_at: payment.paidAt,
            };
            persistence = payment.sellerReference
                ? await supabaseAdmin.rpc(
                    'finalize_earlybird_groble_payment_by_reference',
                    {
                        p_seller_reference: payment.sellerReference,
                        ...params,
                    }
                )
                : await supabaseAdmin.rpc(
                    'finalize_earlybird_groble_payment',
                    params
                );
        } catch {
            return reject(
                500,
                { received: false, code: 'PERSISTENCE_FAILED' },
                'INTERNAL_ERROR',
                state,
            );
        }
    } else {
        let cancellation;
        try {
            cancellation = parseGroblePaymentCancelRequestedEvent(rawBody);
        } catch {
            return reject(
                400,
                { received: false, code: 'INVALID_PAYMENT_PAYLOAD' },
                'VALIDATION_ERROR',
                state,
            );
        }
        state = {
            ...state,
            planId: planForProduct(cancellation.productId, config),
            amountKrw: cancellation.amountKrw,
        };
        try {
            persistence = await supabaseAdmin.rpc(
                'finalize_earlybird_groble_cancel_request',
                {
                    p_event_id: cancellation.eventId,
                    p_idempotency_key: idempotencyKey,
                    p_event_type: 'payment.cancel_requested',
                    p_occurred_at: cancellation.occurredAt,
                    p_payment_id: cancellation.paymentId,
                    p_product_id: cancellation.productId,
                    p_amount_krw: cancellation.amountKrw,
                    p_requested_at: cancellation.requestedAt,
                }
            );
        } catch {
            return reject(
                500,
                { received: false, code: 'PERSISTENCE_FAILED' },
                'INTERNAL_ERROR',
                state,
            );
        }
    }

    const { data, error } = persistence;
    if (error) {
        return reject(
            500,
            { received: false, code: 'PERSISTENCE_FAILED' },
            'INTERNAL_ERROR',
            state,
        );
    }
    const parsed = finalizationResultSchema.safeParse(data);
    if (!parsed.success) {
        return reject(
            500,
            { received: false, code: 'INVALID_PERSISTENCE_RESULT' },
            'INTERNAL_ERROR',
            state,
        );
    }

    const finalization = parsed.data[0];
    operationalLogger.emit({
        event: 'groble.webhook_finalized',
        severity: finalization.disposition === 'accepted' ? 'info' : 'warn',
        fields: {
            ...webhookFields(context, {
                ...state,
                orderId: finalization.order_id,
            }),
            disposition: finalization.disposition,
        },
    });

    return response(200, {
        received: true,
        disposition: finalization.disposition,
    });
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/webhooks/groble',
        context => handlePOST(request, context),
    );
}
