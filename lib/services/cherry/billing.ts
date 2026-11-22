import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { loadCherrySubscription } from './store';
import {
    cancelTossPayment, chargeTossBillingKey, deleteTossBillingKey, findTossPayment, issueTossBillingKey, readTossConfig,
    TossRejectedError, TossUnknownError, type TossConfig,
} from './toss';

const ORDER_NAME = '체리 월 이용권';
const REFUND_REASONS: Record<string, string> = {
    target_private: '등록 계정 비공개 전환', target_not_found: '등록 계정 확인 불가', target_blocked: '등록 계정 확인 중단',
    baseline_failed: '첫 목록 준비 실패', operator: '고객센터 요청',
};

export interface CherryPayment {
    id: string;
    subscription_id: string;
    user_id: string;
    cycle: number;
    provider: 'groble' | 'toss';
    order_ref: string;
    amount_krw: number;
    status: string;
    provider_payment_id: string | null;
    updated_at: string;
}

function cipherKey(env: Record<string, string | undefined> = process.env): Buffer {
    const key = Buffer.from(env.CHERRY_BILLING_KEY_SECRET?.trim() ?? '', 'base64');
    if (key.length !== 32) throw new Error('CHERRY_BILLING_KEY_SECRET_INVALID');
    return key;
}

/** The customer key is bound as associated data, so a stored value cannot be moved to another member. */
export function encryptBillingKey(value: string, customerKey: string, key: Buffer = cipherKey()): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(customerKey));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptBillingKey(value: string, customerKey: string, key: Buffer = cipherKey()): string {
    const [version, iv, tag, body] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error('CHERRY_BILLING_KEY_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(customerKey));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export async function ensureCustomerKey(userId: string): Promise<string> {
    const { error } = await supabaseAdmin.from('cherry_billing_keys')
        .upsert({ user_id: userId, customer_key: `chr_${randomBytes(16).toString('hex')}` }, { onConflict: 'user_id', ignoreDuplicates: true });
    assertNoDatabaseError('customer_key', error);
    const { data, error: readError } = await supabaseAdmin.from('cherry_billing_keys').select('customer_key').eq('user_id', userId).single();
    assertNoDatabaseError('customer_key', readError);
    return (data as { customer_key: string }).customer_key;
}

async function loadBillingKey(userId: string): Promise<{ customerKey: string; billingKey: string } | null> {
    const { data, error } = await supabaseAdmin.from('cherry_billing_keys').select('customer_key, billing_key_ciphertext')
        .eq('user_id', userId).maybeSingle();
    assertNoDatabaseError('billing_key', error);
    if (!data?.billing_key_ciphertext) return null;
    return { customerKey: data.customer_key, billingKey: decryptBillingKey(data.billing_key_ciphertext, data.customer_key) };
}

export type ChargeOutcome = 'paid' | 'declined' | 'unknown' | 'no_billing_key';

async function failPayment(paymentId: string, code: string): Promise<void> {
    await cherryRpc('cherry_fail_payment', { p_payment: paymentId, p_code: code });
}

/** The payment row is already 'processing'; an unknown answer is settled later by order lookup. */
export async function chargeCherryPayment(payment: CherryPayment, config: TossConfig): Promise<ChargeOutcome> {
    const [key, subscription] = await Promise.all([loadBillingKey(payment.user_id), loadCherrySubscription(payment.subscription_id)]);
    if (!key) {
        await failPayment(payment.id, 'no_billing_key');
        return 'no_billing_key';
    }
    try {
        const result = await chargeTossBillingKey(config, {
            billingKey: key.billingKey, customerKey: key.customerKey, amount: payment.amount_krw, orderId: payment.order_ref,
            orderName: ORDER_NAME, email: subscription?.recipient_email ?? null,
        });
        if (result.status !== 'DONE') return 'unknown';
        await recordTossPayment(result.paymentKey, result.orderId, result.totalAmount, result.approvedAt);
        return 'paid';
    } catch (error) {
        if (error instanceof TossRejectedError) {
            await failPayment(payment.id, error.code);
            return 'declined';
        }
        if (error instanceof TossUnknownError) return 'unknown';
        throw error;
    }
}

async function recordTossPayment(paymentKey: string, orderId: string, amount: number, approvedAt: string | null): Promise<void> {
    await cherryRpc('cherry_record_payment', {
        p_event_id: `toss:${paymentKey}`, p_provider: 'toss', p_order_ref: orderId, p_provider_payment_id: paymentKey,
        p_product_id: null, p_amount_krw: amount, p_paid_at: approvedAt ?? new Date().toISOString(), p_buyer_phone: null,
    });
}

/** Stores a newly authorized card and makes the first charge of the member's open order. */
export async function completeTossBilling(input: { userId: string; authKey: string; customerKey: string }): Promise<ChargeOutcome | 'invalid' | 'no_order'> {
    const config = readTossConfig();
    if (!config) return 'invalid';
    if (await ensureCustomerKey(input.userId) !== input.customerKey) return 'invalid';
    let issued;
    try {
        issued = await issueTossBillingKey(config, input.authKey, input.customerKey);
    } catch {
        // A repeated return to this page uses the key that the first visit stored.
        if (!await loadBillingKey(input.userId)) return 'declined';
    }
    if (issued) {
        const label = [issued.card?.cardType, issued.card?.number?.slice(-4)].filter(Boolean).join(' ').slice(0, 60);
        const { error } = await supabaseAdmin.from('cherry_billing_keys').update({
            billing_key_ciphertext: encryptBillingKey(issued.billingKey, input.customerKey), card_label: label || null,
            updated_at: new Date().toISOString(),
        }).eq('user_id', input.userId);
        assertNoDatabaseError('billing_key_store', error);
    }
    const { data, error } = await supabaseAdmin.from('cherry_payments').update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('user_id', input.userId).eq('provider', 'toss').eq('status', 'ready').select('*');
    assertNoDatabaseError('open_payment', error);
    const payment = (data as CherryPayment[] | null)?.[0];
    return payment ? chargeCherryPayment(payment, config) : 'no_order';
}

export async function processDueBilling(limit: number): Promise<number> {
    const config = readTossConfig();
    if (!config) return 0;
    const payments = await cherryRpc<CherryPayment[]>('cherry_claim_billing', { p_limit: limit });
    for (const payment of payments) await chargeCherryPayment(payment, config);
    return payments.length;
}

/** Settles charges whose answer was lost. Toss is asked by order; nothing is charged here. */
export async function reconcileCherryPayments(limit: number): Promise<number> {
    const config = readTossConfig();
    if (!config) return 0;
    const { data, error } = await supabaseAdmin.from('cherry_payments').select('*').eq('status', 'processing').eq('provider', 'toss')
        .lt('updated_at', new Date(Date.now() - 5 * 60_000).toISOString()).order('updated_at').limit(limit);
    assertNoDatabaseError('processing_payments', error);
    for (const payment of (data ?? []) as CherryPayment[]) {
        let found;
        try {
            found = await findTossPayment(config, payment.order_ref);
        } catch {
            continue;
        }
        if (found?.status === 'DONE') {
            await recordTossPayment(found.paymentKey, found.orderId, found.totalAmount, found.approvedAt);
        } else if (!found || ['ABORTED', 'EXPIRED', 'CANCELED'].includes(found.status)) {
            await failPayment(payment.id, found ? found.status.toLowerCase() : 'not_charged');
        }
    }
    return data?.length ?? 0;
}

interface RefundRow { id: string; payment_id: string; subscription_id: string; amount_krw: number; reason: string }

export async function processCherryRefunds(limit: number): Promise<number> {
    const config = readTossConfig();
    if (!config) return 0;
    const refunds = await cherryRpc<RefundRow[]>('cherry_claim_refunds', { p_limit: limit });
    for (const refund of refunds) await refundWithToss(refund, config);
    return refunds.length;
}

/** The refund ID is the idempotency key, so a repeated request cannot refund twice. */
export async function refundWithToss(refund: RefundRow, config: TossConfig): Promise<void> {
    const { data, error } = await supabaseAdmin.from('cherry_payments').select('*').eq('id', refund.payment_id).single();
    assertNoDatabaseError('refund_payment', error);
    const payment = data as CherryPayment;
    const settle = async (patch: Record<string, unknown>) => {
        const { error: updateError } = await supabaseAdmin.from('cherry_refunds')
            .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', refund.id).in('status', ['processing', 'pending']);
        assertNoDatabaseError('refund_settle', updateError);
    };
    if (payment.provider !== 'toss' || !payment.provider_payment_id) {
        await settle({ status: 'manual_required' });
        return;
    }
    try {
        await cancelTossPayment(config, {
            paymentKey: payment.provider_payment_id, amount: refund.amount_krw,
            reason: REFUND_REASONS[refund.reason] ?? '고객센터 요청', refundId: refund.id,
        });
    } catch (caught) {
        if (caught instanceof TossRejectedError) await settle({ status: 'manual_required', failure_code: caught.code });
        // An unknown answer stays 'processing' and repeats with the same key.
        return;
    }
    await cherryRpc('cherry_record_refund', {
        p_event_id: `toss-refund:${refund.id}`, p_provider: 'toss', p_provider_payment_id: payment.provider_payment_id,
        p_amount_krw: refund.amount_krw, p_partial: true,
    });
    await cherryRpc('cherry_queue_notification', {
        p_subscription: refund.subscription_id, p_kind: 'refund_done', p_dedupe: `refund:${refund.id}`,
        p_payload: { refundKrw: refund.amount_krw }, p_report: null,
    });
}

/** Best effort: an ended member's card authorization is also removed at the provider. */
export async function forgetCherryBillingKey(userId: string): Promise<void> {
    const config = readTossConfig();
    if (!config) return;
    try {
        const key = await loadBillingKey(userId);
        if (key) await deleteTossBillingKey(config, key.billingKey);
    } catch {
        // The local key is deleted either way, so it can no longer be charged here.
    }
}
