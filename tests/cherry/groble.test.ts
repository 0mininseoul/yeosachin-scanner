import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rpc: vi.fn(), products: new Set<string>(), pastProducts: new Set<string>(), payments: new Set<string>(), lookups: 0, upsert: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {
    rpc: db.rpc,
    from: (table: string) => ({
        select: () => ({ eq: (column: string, value: string) => ({ limit: async () => {
            db.lookups += 1;
            const known = column === 'groble_product_id' ? (table === 'cherry_offers' ? db.products : db.pastProducts) : db.payments;
            return { data: known.has(value) ? [{ id: 'x' }] : [], error: null };
        } }) }),
        upsert: db.upsert,
    }),
} }));
import { handleCherryGrobleEvent } from '@/lib/services/cherry/groble';

const at = '2026-12-01T00:00:00Z';
const body = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${type}`, type, version: '1', occurredAt: at, data: { object } });
const content = (id: string) => ({ id, paymentType: 'ONE_TIME', inputMode: 'PAYMENT_WINDOW' });
const completed = (product: string, sellerReference?: string) => body('payment.completed', {
    merchantUid: 'pay', ...(sellerReference ? { sellerReference } : {}), buyer: { email: 'me@example.com', phoneNumber: '010-1234-5678' },
    content: content(product), pricing: { currency: 'KRW', finalAmount: 9900 }, payment: { purchasedAt: at },
});
const ref = `chr_${'a'.repeat(32)}`;

beforeEach(() => {
    db.rpc.mockReset().mockResolvedValue({ data: { disposition: 'activated' }, error: null });
    db.upsert.mockReset().mockResolvedValue({ error: null });
    db.products = new Set(['cherry_product']);
    db.pastProducts = new Set(['old_cherry_product']);
    db.payments = new Set();
    db.lookups = 0;
});

describe('cherry groble events', () => {
    it('leaves analyzer sales untouched without asking the database', async () => {
        expect(await handleCherryGrobleEvent('payment.completed', completed('basic', `ord.${'b'.repeat(32)}`), ['basic', 'standard'])).toBeNull();
        expect(await handleCherryGrobleEvent('payment.completed', completed('basic', ref), ['basic', 'standard'])).toBeNull();
        expect(await handleCherryGrobleEvent('payment.completed', completed('wrong_product', `ord.${'b'.repeat(32)}`), ['basic'])).toBeNull();
        expect(await handleCherryGrobleEvent('payment.completed', '{"broken":true}', ['basic'])).toBeNull();
        expect(db.lookups).toBe(0);
        expect(db.rpc).not.toHaveBeenCalled();
    });

    it('records a Cherry sale by order reference, or by product when the reference is lost', async () => {
        expect(await handleCherryGrobleEvent('payment.completed', completed('cherry_product', ref), ['basic'])).toBe('activated');
        expect(db.rpc).toHaveBeenLastCalledWith('cherry_record_payment', expect.objectContaining({ p_order_ref: ref, p_amount_krw: 9900, p_buyer_phone: '+821012345678' }));
        expect(await handleCherryGrobleEvent('payment.completed', completed('cherry_product'), ['basic'])).toBe('activated');
        expect(db.rpc).toHaveBeenLastCalledWith('cherry_record_payment', expect.objectContaining({ p_order_ref: null, p_product_id: 'cherry_product' }));
        expect(await handleCherryGrobleEvent('payment.completed', completed('someone_else'), ['basic'])).toBeNull();
    });

    it('records refunds and cancel requests of Cherry products only', async () => {
        const refund = (product: string) => body('payment.refunded', {
            merchantUid: 'pay', content: content(product), pricing: { currency: 'KRW', finalAmount: 9900 },
            refund: { amount: 4000, currency: 'KRW', partialRefund: true, cancelledBy: 'SELLER', refundedAt: at },
        });
        expect(await handleCherryGrobleEvent('payment.refunded', refund('basic'), ['basic'])).toBeNull();
        await handleCherryGrobleEvent('payment.refunded', refund('old_cherry_product'), ['basic']);
        expect(db.rpc).toHaveBeenLastCalledWith('cherry_record_refund', expect.objectContaining({ p_amount_krw: 4000, p_partial: true }));
        expect(await handleCherryGrobleEvent('payment.cancel_requested', body('payment.cancel_requested', {
            merchantUid: 'pay', content: content('cherry_product'), pricing: { currency: 'KRW', finalAmount: 9900 },
            cancelRequest: { requestedBy: 'BUYER', requestedAt: at },
        }), ['basic'])).toBe('cancel_requested');
    });

    it('fails loudly so Groble retries when the event cannot be stored', async () => {
        db.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'x' } });
        await expect(handleCherryGrobleEvent('payment.completed', completed('cherry_product', ref), ['basic'])).rejects.toThrow('CHERRY_DATABASE_ERROR');
    });
});
