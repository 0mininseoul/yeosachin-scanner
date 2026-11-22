import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    parseGroblePaymentCancelRequestedEvent, parseGroblePaymentCompletedEvent, parseGroblePaymentRefundedEvent,
} from '@/lib/services/groble/webhook';
import { normalizeKoreanMobileNumber } from '@/lib/services/identity/phone-number';
import { assertNoDatabaseError, cherryRpc } from './rpc';

const ORDER_REF = /^chr_[0-9a-f]{32}$/;

async function isCherryProduct(productId: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin.from('cherry_offers').select('code').eq('groble_product_id', productId).limit(1);
    assertNoDatabaseError('groble_product', error);
    return (data?.length ?? 0) > 0;
}

/**
 * Handles a verified Groble event that belongs to Cherry and returns its disposition. Null leaves the
 * event to the analyzer. The database is asked only about products the analyzer does not sell.
 */
export async function handleCherryGrobleEvent(
    type: string, rawBody: string, analyzerProductIds: readonly string[],
): Promise<string | null> {
    if (type === 'payment.completed') {
        let payment;
        try {
            payment = parseGroblePaymentCompletedEvent(rawBody);
        } catch {
            return null;
        }
        const orderRef = payment.sellerReference && ORDER_REF.test(payment.sellerReference) ? payment.sellerReference : null;
        if (!orderRef && (analyzerProductIds.includes(payment.productId) || !await isCherryProduct(payment.productId))) return null;
        const result = await cherryRpc<{ disposition: string }>('cherry_record_payment', {
            p_event_id: payment.eventId, p_provider: 'groble', p_order_ref: orderRef, p_provider_payment_id: payment.paymentId,
            p_product_id: payment.productId, p_amount_krw: payment.amountKrw, p_paid_at: payment.paidAt,
            p_buyer_phone: normalizeKoreanMobileNumber(payment.buyerPhoneNumber),
        });
        return result.disposition;
    }
    if (type === 'payment.refunded') {
        let refund;
        try {
            refund = parseGroblePaymentRefundedEvent(rawBody);
        } catch {
            return null;
        }
        if (analyzerProductIds.includes(refund.productId) || !await isCherryProduct(refund.productId)) return null;
        const result = await cherryRpc<{ disposition: string }>('cherry_record_refund', {
            p_event_id: refund.eventId, p_provider: 'groble', p_provider_payment_id: refund.paymentId,
            p_amount_krw: refund.refundAmountKrw, p_partial: refund.partialRefund,
        });
        return result.disposition;
    }
    if (type === 'payment.cancel_requested') {
        let request;
        try {
            request = parseGroblePaymentCancelRequestedEvent(rawBody);
        } catch {
            return null;
        }
        if (analyzerProductIds.includes(request.productId) || !await isCherryProduct(request.productId)) return null;
        const { error } = await supabaseAdmin.from('cherry_payment_events').upsert({
            event_id: request.eventId, provider: 'groble', event_type: 'payment.cancel_requested',
            provider_payment_id: request.paymentId, amount_krw: request.amountKrw, disposition: 'cancel_requested',
        }, { onConflict: 'event_id', ignoreDuplicates: true });
        assertNoDatabaseError('groble_cancel_request', error);
        return 'cancel_requested';
    }
    return null;
}
