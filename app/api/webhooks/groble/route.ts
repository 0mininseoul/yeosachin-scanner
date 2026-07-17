import { z } from 'zod';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isJsonRequest } from '@/lib/services/earlybird/contracts';
import { readGrobleConfig } from '@/lib/services/groble/config';
import {
    parseGrobleEventEnvelope,
    parseGroblePaymentCancelRequestedEvent,
    parseGroblePaymentCompletedEvent,
    verifyGrobleWebhookSignature,
} from '@/lib/services/groble/webhook';

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

export async function POST(request: Request): Promise<NextResponse> {
    if (!isJsonRequest(request)) {
        return response(415, { received: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
        return response(413, { received: false, code: 'PAYLOAD_TOO_LARGE' });
    }

    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return response(400, { received: false, code: 'INVALID_BODY' });
    }
    if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
        return response(413, { received: false, code: 'PAYLOAD_TOO_LARGE' });
    }

    let config;
    try {
        config = readGrobleConfig();
    } catch {
        return response(503, {
            received: false,
            code: 'WEBHOOK_CONFIGURATION_UNAVAILABLE',
        });
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
        return response(401, { received: false, code: 'INVALID_SIGNATURE' });
    }

    const idempotencyKey = request.headers.get('x-groble-idempotency-key')?.trim();
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return response(400, { received: false, code: 'INVALID_IDEMPOTENCY_KEY' });
    }

    let envelope;
    try {
        envelope = parseGrobleEventEnvelope(rawBody);
    } catch {
        return response(400, { received: false, code: 'INVALID_PAYLOAD' });
    }
    if (envelope.type !== 'payment.completed'
        && envelope.type !== 'payment.cancel_requested') {
        return response(200, { received: true, disposition: 'ignored' });
    }

    let persistence;
    if (envelope.type === 'payment.completed') {
        let payment;
        try {
            payment = parseGroblePaymentCompletedEvent(rawBody);
        } catch {
            return response(400, { received: false, code: 'INVALID_PAYMENT_PAYLOAD' });
        }
        try {
            persistence = await supabaseAdmin.rpc('finalize_earlybird_groble_payment', {
                p_event_id: payment.eventId,
                p_idempotency_key: idempotencyKey,
                p_event_type: 'payment.completed',
                p_occurred_at: payment.occurredAt,
                p_payment_id: payment.paymentId,
                p_buyer_email: payment.buyerEmail,
                p_product_id: payment.productId,
                p_amount_krw: payment.amountKrw,
                p_paid_at: payment.paidAt,
            });
        } catch {
            return response(500, { received: false, code: 'PERSISTENCE_FAILED' });
        }
    } else {
        let cancellation;
        try {
            cancellation = parseGroblePaymentCancelRequestedEvent(rawBody);
        } catch {
            return response(400, { received: false, code: 'INVALID_PAYMENT_PAYLOAD' });
        }
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
            return response(500, { received: false, code: 'PERSISTENCE_FAILED' });
        }
    }

    const { data, error } = persistence;
    if (error) {
        return response(500, { received: false, code: 'PERSISTENCE_FAILED' });
    }
    const parsed = finalizationResultSchema.safeParse(data);
    if (!parsed.success) {
        return response(500, { received: false, code: 'INVALID_PERSISTENCE_RESULT' });
    }

    return response(200, {
        received: true,
        disposition: parsed.data[0].disposition,
    });
}
