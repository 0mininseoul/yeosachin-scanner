import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123000_add_groble_seller_reference.sql',
        import.meta.url
    ),
    'utf8'
);

const ORDER_ONE = '123e4567-e89b-42d3-a456-426614174001';
const ORDER_TWO = '123e4567-e89b-42d3-a456-426614174002';
const USER_ONE = '223e4567-e89b-42d3-a456-426614174001';
const USER_TWO = '223e4567-e89b-42d3-a456-426614174002';

type Finalization = {
    disposition: string;
    order_id: string | null;
    status: string | null;
    plan_sequence: number | null;
};

let db: PGlite;

async function asService<T>(
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function issue(orderId: string): Promise<string> {
    return (await asService<{ value: string }>(
        'SELECT public.issue_earlybird_groble_seller_reference($1) AS value',
        [orderId]
    )).rows[0].value;
}

async function finalize(input: {
    reference: string | null;
    event: string;
    payment: string;
    email: string;
    product?: string;
}): Promise<Finalization> {
    return (await asService<Finalization>(
        `SELECT * FROM public.finalize_earlybird_groble_payment_by_reference(
            $1, $2, $3, 'payment.completed',
            '2026-07-24T00:00:00Z', $4, $5, NULL, NULL, NULL,
            $6, 14900, '2026-07-24T00:00:00Z'
        )`,
        [
            input.reference,
            input.event,
            `${input.event}-idempotency`,
            input.payment,
            input.email,
            input.product ?? 'basic_product-01',
        ]
    )).rows[0];
}

describe('Groble seller-reference migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS UUID LANGUAGE sql VOLATILE
            AS $$ SELECT pg_catalog.gen_random_uuid() $$;

            CREATE TABLE public.users (
                id UUID PRIMARY KEY,
                email TEXT UNIQUE NOT NULL
            );
            CREATE TABLE public.earlybird_orders (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                status TEXT NOT NULL,
                plan_id TEXT NOT NULL DEFAULT 'basic',
                expected_groble_product_id TEXT NOT NULL,
                expected_amount_krw INTEGER NOT NULL,
                payment_id TEXT UNIQUE,
                actual_groble_product_id TEXT,
                actual_amount_krw INTEGER,
                paid_at TIMESTAMP WITH TIME ZONE,
                due_at TIMESTAMP WITH TIME ZONE,
                plan_sequence SMALLINT,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp()
            );
            CREATE TABLE public.earlybird_plan_inventory (
                plan_id TEXT PRIMARY KEY,
                sale_limit SMALLINT NOT NULL,
                sold_count SMALLINT NOT NULL
            );
            INSERT INTO public.earlybird_plan_inventory(
                plan_id, sale_limit, sold_count
            ) VALUES ('basic', 10, 0), ('standard', 10, 0);
            CREATE TABLE public.earlybird_waitlist (
                id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                plan_id TEXT NOT NULL DEFAULT 'plus',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp()
            );
            GRANT SELECT, INSERT, UPDATE, DELETE
                ON public.earlybird_orders TO service_role;
            GRANT SELECT ON public.users TO service_role;

            CREATE FUNCTION public.finalize_earlybird_groble_payment(
                p_event_id TEXT,
                p_idempotency_key TEXT,
                p_event_type TEXT,
                p_occurred_at TIMESTAMP WITH TIME ZONE,
                p_payment_id TEXT,
                p_buyer_email TEXT,
                p_buyer_phone_normalized TEXT,
                p_buyer_phone_raw TEXT,
                p_buyer_display_name TEXT,
                p_product_id TEXT,
                p_amount_krw INTEGER,
                p_paid_at TIMESTAMP WITH TIME ZONE
            )
            RETURNS TABLE(
                disposition TEXT,
                order_id UUID,
                status TEXT,
                plan_sequence SMALLINT
            )
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = ''
            AS $$
            DECLARE
                v_order public.earlybird_orders%ROWTYPE;
            BEGIN
                SELECT earlybird_order.*
                INTO v_order
                FROM public.earlybird_orders AS earlybird_order
                WHERE earlybird_order.payment_id = p_payment_id;
                IF FOUND THEN
                    RETURN QUERY SELECT
                        'duplicate_payment'::TEXT,
                        v_order.id,
                        v_order.status,
                        v_order.plan_sequence;
                    RETURN;
                END IF;

                SELECT earlybird_order.*
                INTO v_order
                FROM public.earlybird_orders AS earlybird_order
                JOIN public.users AS buyer
                  ON buyer.id = earlybird_order.user_id
                WHERE earlybird_order.status = 'payment_pending'
                  AND earlybird_order.expected_groble_product_id = p_product_id
                  AND buyer.email = p_buyer_email
                FOR UPDATE OF earlybird_order;
                IF NOT FOUND THEN
                    RETURN QUERY SELECT
                        'unmatched'::TEXT,
                        NULL::UUID,
                        NULL::TEXT,
                        NULL::SMALLINT;
                    RETURN;
                END IF;

                UPDATE public.earlybird_orders AS earlybird_order
                SET status = 'paid',
                    payment_id = p_payment_id,
                    actual_groble_product_id = p_product_id,
                    actual_amount_krw = p_amount_krw,
                    paid_at = p_paid_at,
                    updated_at = pg_catalog.clock_timestamp()
                WHERE earlybird_order.id = v_order.id
                RETURNING earlybird_order.* INTO v_order;
                RETURN QUERY SELECT
                    'accepted'::TEXT,
                    v_order.id,
                    v_order.status,
                    v_order.plan_sequence;
            END;
            $$;
        `);
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.earlybird_waitlist,
                public.earlybird_orders, public.users;
            UPDATE public.earlybird_plan_inventory SET sold_count = 0;
            INSERT INTO public.users(id, email) VALUES
                ('${USER_ONE}', 'one@example.com'),
                ('${USER_TWO}', 'two@example.com');
            INSERT INTO public.earlybird_orders(
                id, user_id, status, expected_groble_product_id,
                expected_amount_krw, plan_sequence
            ) VALUES
                ('${ORDER_ONE}', '${USER_ONE}', 'payment_pending',
                    'basic_product-01', 14900, 1),
                ('${ORDER_TWO}', '${USER_TWO}', 'payment_pending',
                    'basic_product-01', 14900, 2);
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('issues one stable opaque reference under concurrent replay', async () => {
        const references = await Promise.all(
            Array.from({ length: 8 }, () => issue(ORDER_ONE))
        );
        expect(new Set(references).size).toBe(1);
        expect(references[0]).toMatch(/^ord\.[a-f0-9]{32}$/);
        expect(await issue(ORDER_ONE)).toBe(references[0]);
    });

    it('confirms accepted and duplicate payment replays for the same order', async () => {
        const reference = await issue(ORDER_ONE);
        await expect(finalize({
            reference,
            event: 'event-one',
            payment: 'payment-one',
            email: 'one@example.com',
        })).resolves.toMatchObject({
            disposition: 'accepted',
            order_id: ORDER_ONE,
            status: 'paid',
        });
        await expect(finalize({
            reference,
            event: 'event-two',
            payment: 'payment-one',
            email: 'one@example.com',
        })).resolves.toMatchObject({
            disposition: 'duplicate_payment',
            order_id: ORDER_ONE,
            status: 'paid',
        });
        expect((await db.query<{ confirmed: boolean }>(
            `SELECT seller_reference_confirmed_at IS NOT NULL AS confirmed
             FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ONE]
        )).rows[0].confirmed).toBe(true);
    });

    it('rolls back wrong-order attribution and never falls through from a forged reference', async () => {
        const reference = await issue(ORDER_ONE);
        await expect(finalize({
            reference,
            event: 'wrong-order',
            payment: 'wrong-order-payment',
            email: 'two@example.com',
        })).rejects.toThrow('EARLYBIRD_SELLER_REFERENCE_CONFLICT');
        await expect(finalize({
            reference: `ord.${'f'.repeat(32)}`,
            event: 'forged',
            payment: 'forged-payment',
            email: 'one@example.com',
        })).rejects.toThrow('EARLYBIRD_SELLER_REFERENCE_UNMATCHED');
        await expect(finalize({
            reference: null,
            event: 'missing',
            payment: 'missing-payment',
            email: 'one@example.com',
        })).rejects.toThrow('EARLYBIRD_SELLER_REFERENCE_INVALID');

        const states = (await db.query<{ status: string; payment_id: string | null }>(
            `SELECT status, payment_id
             FROM public.earlybird_orders ORDER BY id`
        )).rows;
        expect(states).toEqual([
            { status: 'payment_pending', payment_id: null },
            { status: 'payment_pending', payment_id: null },
        ]);
    });

    it('does not consume inventory for a wrong product and preserves legacy finalization', async () => {
        const reference = await issue(ORDER_ONE);
        await expect(finalize({
            reference,
            event: 'wrong-product',
            payment: 'wrong-product-payment',
            email: 'one@example.com',
            product: 'standard_product-01',
        })).resolves.toMatchObject({
            disposition: 'unmatched',
            order_id: null,
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [ORDER_ONE]
        )).rows[0].status).toBe('payment_pending');

        const legacy = await asService<Finalization>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'legacy-event', 'legacy-idempotency', 'payment.completed',
                '2026-07-24T00:00:00Z', 'legacy-payment',
                'one@example.com', NULL, NULL, NULL,
                'basic_product-01', 14900, '2026-07-24T00:00:00Z'
            )`
        );
        expect(legacy.rows[0]).toMatchObject({
            disposition: 'accepted',
            order_id: ORDER_ONE,
        });
    });

    it('denies browser roles both mutation functions', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                'SELECT public.issue_earlybird_groble_seller_reference($1)',
                [ORDER_ONE]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('returns only aggregate reference-confirmed demand and review counts', async () => {
        const reference = await issue(ORDER_ONE);
        await finalize({
            reference,
            event: 'confirmed-demand-event',
            payment: 'confirmed-demand-payment',
            email: 'one@example.com',
        });
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'completed',
                 paid_at = '2026-07-25T00:00:00Z',
                 due_at = '2026-07-26T00:00:00Z'
             WHERE id = $1`,
            [ORDER_ONE]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid',
                 plan_id = 'standard',
                 payment_id = 'unconfirmed-payment',
                 actual_amount_krw = 19900,
                 paid_at = '2026-07-25T00:00:00Z',
                 due_at = '2000-01-01T00:00:00Z'
             WHERE id = $1`,
            [ORDER_TWO]
        );
        await db.exec(`
            INSERT INTO public.earlybird_orders(
                id, user_id, status, expected_groble_product_id,
                expected_amount_krw, payment_id, actual_amount_krw,
                paid_at, created_at
            ) VALUES
                ('123e4567-e89b-42d3-a456-426614174003', '${USER_ONE}',
                    'refund_pending', 'basic_product-01', 14900,
                    'refund-liability-payment', 9900,
                    '2026-07-25T00:00:00Z', '2026-07-24T12:00:00Z'),
                ('123e4567-e89b-42d3-a456-426614174004', '${USER_ONE}',
                    'payment_pending', 'basic_product-01', 14900,
                    NULL, NULL, NULL, '2026-07-24T12:00:00Z');
            INSERT INTO public.earlybird_waitlist(plan_id, created_at)
            VALUES ('plus', '2026-07-24T12:00:00Z');
            UPDATE public.earlybird_plan_inventory
            SET sold_count = CASE plan_id
                WHEN 'basic' THEN 2
                WHEN 'standard' THEN 1
            END;
        `);

        const report = (await asService<Record<string, unknown>>(
            `SELECT public.load_earlybird_demand_summary(
                '2026-07-24', '2026-08-01'
            ) AS report`
        )).rows[0].report;
        expect(report).toEqual({
            startDate: '2026-07-24',
            endDateExclusive: '2026-08-01',
            referenceConfirmedPaymentCount: 1,
            referenceConfirmedGrossKrw: 14_900,
            unconfirmedPaidOrderCount: 1,
            refundLiabilityCount: 1,
            overdueFulfillmentCount: 1,
            pendingCheckoutCount: 1,
            plusWaitlistCount: 1,
            plans: [
                {
                    planId: 'basic',
                    confirmedPaymentCount: 1,
                    confirmedGrossKrw: 14_900,
                    remainingSlots: 8,
                },
                {
                    planId: 'standard',
                    confirmedPaymentCount: 0,
                    confirmedGrossKrw: 0,
                    remainingSlots: 9,
                },
            ],
        });
        expect(JSON.stringify(report)).not.toMatch(
            /one@example|confirmed-demand-payment|refund-liability-payment|ord[.]|123e4567/i
        );
        await expect(asService(
            `SELECT public.load_earlybird_demand_summary(
                '2026-01-01', '2026-04-02'
            )`
        )).rejects.toThrow('EARLYBIRD_DEMAND_RANGE_INVALID');
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                `SELECT public.load_earlybird_demand_summary(
                    '2026-07-24', '2026-08-01'
                )`
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
