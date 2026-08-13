import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql',
    import.meta.url,
), 'utf8');
const amountMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260814100000_add_actual_amount_to_payment_discord_claim.sql',
    import.meta.url,
), 'utf8');

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '223e4567-e89b-42d3-a456-426614174000';

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE FUNCTION public.uuid_generate_v4()
        RETURNS uuid
        LANGUAGE sql
        VOLATILE
        AS $$ SELECT pg_catalog.gen_random_uuid() $$;
        CREATE TABLE public.users (
            id uuid PRIMARY KEY,
            name varchar(255),
            gender varchar(20)
        );
        CREATE TABLE public.earlybird_orders (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
            plan_id text NOT NULL CHECK (plan_id IN ('basic', 'standard')),
            actual_amount_krw integer,
            status text NOT NULL,
            paid_at timestamptz
        );
    `);
    await db.exec(migration);
    await db.exec(amountMigration);
}, 30_000);

afterAll(async () => db.close());

describe('earlybird payment Discord outbox migration', () => {
    it('enqueues exactly once when an order enters paid and completes a claimed row', async () => {
        await db.exec(`
            INSERT INTO public.users (id, name, gender)
            VALUES ('${USER_ID}', '김민수', 'male');
            INSERT INTO public.earlybird_orders (id, user_id, plan_id, actual_amount_krw, status)
            VALUES ('${ORDER_ID}', '${USER_ID}', 'basic', 14900, 'payment_pending');
            UPDATE public.earlybird_orders
            SET status = 'paid', paid_at = '2026-08-13T00:00:00+09:00'
            WHERE id = '${ORDER_ID}';
        `);

        const firstOutbox = await db.query<{ order_id: string; status: string }>(
            'SELECT order_id, status FROM public.earlybird_payment_discord_outbox',
        );
        expect(firstOutbox.rows).toEqual([{ order_id: ORDER_ID, status: 'pending' }]);

        await db.exec(`
            UPDATE public.earlybird_orders
            SET status = 'paid'
            WHERE id = '${ORDER_ID}';
        `);

        const afterDuplicatePaid = await db.query<{ order_id: string; status: string }>(
            'SELECT order_id, status FROM public.earlybird_payment_discord_outbox',
        );
        expect(afterDuplicatePaid.rows).toEqual([{ order_id: ORDER_ID, status: 'pending' }]);

        await db.exec('SET ROLE service_role');
        const claimed = await db.query<{
            id: string;
            order_id: string;
            claim_token: string;
            plan_id: string;
            actual_amount_krw: number;
            paid_at: string;
            buyer_name: string;
            gender: string;
            attempts: number;
        }>('SELECT * FROM public.claim_earlybird_payment_discord_outbox($1)', [10]);
        expect(claimed.rows).toHaveLength(1);
        const claimedRow = claimed.rows[0];
        expect(Object.keys(claimedRow).sort()).toEqual([
            'actual_amount_krw',
            'attempts',
            'buyer_name',
            'claim_token',
            'gender',
            'id',
            'order_id',
            'paid_at',
            'plan_id',
        ]);
        expect(claimedRow).toMatchObject({
            order_id: ORDER_ID,
            plan_id: 'basic',
            actual_amount_krw: 14900,
            buyer_name: '김민수',
            gender: 'male',
            attempts: 1,
        });

        await db.query(
            'SELECT public.complete_earlybird_payment_discord_outbox($1, $2, $3)',
            [claimedRow.id, claimedRow.claim_token, 'sent'],
        );
        await db.exec('RESET ROLE');

        await db.exec(`
            UPDATE public.earlybird_orders
            SET status = 'cancelled'
            WHERE id = '${ORDER_ID}';
        `);

        const completed = await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_payment_discord_outbox WHERE order_id = $1',
            [ORDER_ID],
        );
        expect(completed.rows).toEqual([{ status: 'sent' }]);
    }, 30_000);

    it('terminalizes an expired sending claim without making it claimable again', async () => {
        const userId = '423e4567-e89b-42d3-a456-426614174000';
        const orderId = '523e4567-e89b-42d3-a456-426614174000';
        await db.exec(`
            INSERT INTO public.users (id, name, gender)
            VALUES ('${userId}', '김서연', 'female');
            INSERT INTO public.earlybird_orders (id, user_id, plan_id, actual_amount_krw, status, paid_at)
            VALUES ('${orderId}', '${userId}', 'standard', 19900, 'paid', '2026-08-13T00:00:00+09:00');
        `);

        await db.exec('SET ROLE service_role');
        const claimed = await db.query<{ id: string; claim_token: string }>(
            'SELECT id, claim_token FROM public.claim_earlybird_payment_discord_outbox($1)',
            [1],
        );
        expect(claimed.rows).toHaveLength(1);
        await db.exec('RESET ROLE');
        await db.query(
            `UPDATE public.earlybird_payment_discord_outbox
             SET claimed_at = clock_timestamp() - interval '20 minutes'
             WHERE id = $1`,
            [claimed.rows[0]?.id],
        );
        const beforeReconcile = await db.query<{ status: string; claimed_at: string }>(
            `SELECT status, claimed_at
             FROM public.earlybird_payment_discord_outbox
             WHERE order_id = $1`,
            [orderId],
        );
        const allOutbox = await db.query<{ order_id: string; status: string }>(
            'SELECT order_id, status FROM public.earlybird_payment_discord_outbox ORDER BY order_id',
        );
        expect(allOutbox.rows).toEqual([
            { order_id: ORDER_ID, status: 'sent' },
            { order_id: orderId, status: 'sending' },
        ]);
        expect(beforeReconcile.rows).toHaveLength(1);
        expect(beforeReconcile.rows[0]?.status).toBe('sending');
        await db.exec('SET ROLE service_role');
        const reconciled = await db.query<{ count: number }>(
            'SELECT public.reconcile_stale_earlybird_payment_discord_claims($1) AS count',
            [60],
        );
        const secondClaim = await db.query(
            'SELECT id FROM public.claim_earlybird_payment_discord_outbox($1)',
            [1],
        );
        await db.exec('RESET ROLE');

        expect(reconciled.rows).toEqual([{ count: 1 }]);
        expect(secondClaim.rows).toHaveLength(0);
        const state = await db.query<{ status: string; failure_code: string }>(
            `SELECT status, failure_code
             FROM public.earlybird_payment_discord_outbox
             WHERE order_id = $1`,
            [orderId],
        );
        expect(state.rows).toEqual([{
            status: 'ambiguous_failed',
            failure_code: 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS',
        }]);
    }, 30_000);
});
