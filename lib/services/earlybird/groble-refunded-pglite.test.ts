import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260803193000_finalize_groble_refunded_webhooks.sql',
        import.meta.url
    ),
    'utf8'
);

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '223e4567-e89b-42d3-a456-426614174000';

type Finalization = {
    disposition: string;
    order_id: string | null;
    status: string | null;
    plan_sequence: number | null;
};

let db: PGlite;

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function refund(overrides: Partial<{
    eventId: string;
    idempotencyKey: string;
    paymentId: string;
    productId: string;
    amountKrw: number;
    refundAmountKrw: number;
    partialRefund: boolean;
}> = {}): Promise<Finalization> {
    return (await asService<Finalization>(
        `SELECT * FROM public.finalize_earlybird_groble_refund(
            $1, $2, 'payment.refunded', '2026-08-03T12:00:00Z',
            $3, $4, $5, $6, $7, '2026-08-03T12:00:00Z'
        )`,
        [
            overrides.eventId ?? 'evt_refund_1',
            overrides.idempotencyKey ?? 'delivery_refund_1',
            overrides.paymentId ?? 'merchant_0001',
            overrides.productId ?? 'basic_product-01',
            overrides.amountKrw ?? 9_900,
            overrides.refundAmountKrw ?? 9_900,
            overrides.partialRefund ?? false,
        ]
    )).rows[0];
}

describe('Groble payment.refunded database finalization', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE TABLE public.earlybird_orders (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL,
                status TEXT NOT NULL,
                payment_id TEXT UNIQUE,
                expected_groble_product_id TEXT NOT NULL,
                expected_amount_krw INTEGER NOT NULL,
                actual_groble_product_id TEXT,
                actual_amount_krw INTEGER,
                plan_sequence SMALLINT,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp()
            );
            CREATE TABLE public.earlybird_webhook_events (
                event_id VARCHAR(256) PRIMARY KEY,
                idempotency_key VARCHAR(256) NOT NULL UNIQUE,
                event_type VARCHAR(64) NOT NULL,
                occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
                payment_id VARCHAR(256) NOT NULL,
                product_id VARCHAR(128) NOT NULL,
                amount_krw INTEGER NOT NULL,
                disposition TEXT NOT NULL,
                order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL,
                processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
                CONSTRAINT earlybird_webhook_events_type_check CHECK (
                    event_type IN ('payment.completed', 'payment.cancel_requested')
                ),
                CONSTRAINT earlybird_webhook_events_amount_check CHECK (amount_krw >= 0),
                CONSTRAINT earlybird_webhook_events_disposition_check CHECK (disposition IN (
                    'accepted', 'duplicate_event', 'duplicate_payment', 'unmatched',
                    'ambiguous_buyer', 'mismatch', 'overflow_refund_required',
                    'cancel_requested', 'cancel_duplicate_event', 'cancel_unmatched',
                    'cancel_mismatch', 'cancel_before_payment', 'late_cancelled_payment'
                ))
            );
            GRANT SELECT, INSERT, UPDATE ON public.earlybird_orders TO service_role;
            GRANT SELECT, INSERT ON public.earlybird_webhook_events TO service_role;
        `);
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec('TRUNCATE public.earlybird_webhook_events, public.earlybird_orders');
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, status, payment_id, expected_groble_product_id,
                expected_amount_krw, actual_groble_product_id, actual_amount_krw,
                plan_sequence
            ) VALUES ($1, $2, 'paid', 'merchant_0001', 'basic_product-01',
                13_900, 'basic_product-01', 9_900, 1)`,
            [ORDER_ID, USER_ID]
        );
    });

    afterAll(async () => {
        await db.close();
    });

    it('marks a paid order refunded from a full refund without a cancel-request event', async () => {
        await expect(refund()).resolves.toMatchObject({
            disposition: 'refunded', order_id: ORDER_ID, status: 'refunded', plan_sequence: 1,
        });
        await expect(db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1', [ORDER_ID]
        )).resolves.toMatchObject({ rows: [{ status: 'refunded' }] });
        expect((await db.query<{
            refund_amount_krw: number;
            partial_refund: boolean;
            refunded_at: Date;
        }>(
            `SELECT refund_amount_krw, partial_refund, refunded_at
             FROM public.earlybird_webhook_events
             WHERE event_id = 'evt_refund_1'`
        )).rows[0]).toEqual({
            refund_amount_krw: 9_900,
            partial_refund: false,
            refunded_at: new Date('2026-08-03T12:00:00.000Z'),
        });
    });

    it('finalizes a full refund from refund_pending or completed without re-matching an order', async () => {
        for (const [status, eventId] of [
            ['refund_pending', 'evt_refund_pending'],
            ['completed', 'evt_refund_completed'],
        ]) {
            await db.query(
                'UPDATE public.earlybird_orders SET status = $1 WHERE id = $2',
                [status, ORDER_ID]
            );
            await expect(refund({
                eventId,
                idempotencyKey: `${eventId}_delivery`,
            })).resolves.toMatchObject({
                disposition: 'refunded', order_id: ORDER_ID, status: 'refunded',
            });
            await db.query(
                'UPDATE public.earlybird_orders SET status = \'paid\' WHERE id = $1',
                [ORDER_ID]
            );
        }
    });

    it('records a partial refund without revoking the order', async () => {
        await expect(refund({
            refundAmountKrw: 3_000,
            partialRefund: true,
        })).resolves.toMatchObject({
            disposition: 'partial_refund_recorded', order_id: ORDER_ID, status: 'paid',
        });
        await expect(db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1', [ORDER_ID]
        )).resolves.toMatchObject({ rows: [{ status: 'paid' }] });
    });

    it('retains each partial refund amount and timestamp while the order stays paid', async () => {
        await refund({
            eventId: 'evt_partial_1',
            idempotencyKey: 'delivery_partial_1',
            refundAmountKrw: 3_000,
            partialRefund: true,
        });
        await asService(
            `SELECT * FROM public.finalize_earlybird_groble_refund(
                'evt_partial_2', 'delivery_partial_2', 'payment.refunded',
                '2026-08-03T13:00:00Z', 'merchant_0001', 'basic_product-01',
                9900, 1000, TRUE, '2026-08-03T13:00:00Z'
            )`
        );

        expect((await db.query<{
            event_id: string;
            refund_amount_krw: number;
            partial_refund: boolean;
            refunded_at: Date;
        }>(
            `SELECT event_id, refund_amount_krw, partial_refund, refunded_at
             FROM public.earlybird_webhook_events
             ORDER BY refunded_at`
        )).rows).toEqual([{
            event_id: 'evt_partial_1',
            refund_amount_krw: 3_000,
            partial_refund: true,
            refunded_at: new Date('2026-08-03T12:00:00.000Z'),
        }, {
            event_id: 'evt_partial_2',
            refund_amount_krw: 1_000,
            partial_refund: true,
            refunded_at: new Date('2026-08-03T13:00:00.000Z'),
        }]);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [ORDER_ID]
        )).rows[0].status).toBe('paid');
    });

    it('keeps product and original-payment amount mismatches on the existing order', async () => {
        await expect(refund({ productId: 'standard_product-01' })).resolves.toMatchObject({
            disposition: 'refund_mismatch', order_id: ORDER_ID, status: 'paid',
        });
        await expect(refund({
            eventId: 'evt_refund_2',
            idempotencyKey: 'delivery_refund_2',
            amountKrw: 9_899,
            refundAmountKrw: 9_899,
        })).resolves.toMatchObject({
            disposition: 'refund_mismatch', order_id: ORDER_ID, status: 'paid',
        });
    });

    it('deduplicates a replayed full-refund envelope', async () => {
        await refund();
        await expect(refund()).resolves.toMatchObject({
            disposition: 'refund_duplicate_event', order_id: ORDER_ID, status: 'refunded',
        });
        await expect(db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_webhook_events'
        )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    });
});
