import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730130000_reconcile_earlybird_inventory_sequence_high_water.sql',
        import.meta.url
    ),
    'utf8'
);

const PAID_ORDER = '123e4567-e89b-42d3-a456-426614174001';
const PENDING_ORDER = '123e4567-e89b-42d3-a456-426614174002';
const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);

    await db.exec(`
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            status TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            payment_id TEXT,
            plan_sequence SMALLINT
        );
        CREATE UNIQUE INDEX earlybird_orders_plan_sequence_unique
            ON public.earlybird_orders(plan_id, plan_sequence)
            WHERE plan_sequence IS NOT NULL;

        CREATE TABLE public.earlybird_plan_inventory (
            plan_id TEXT PRIMARY KEY,
            sale_limit SMALLINT NOT NULL,
            sold_count SMALLINT NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp(),
            CONSTRAINT earlybird_plan_inventory_count_check CHECK (
                sold_count BETWEEN 0 AND sale_limit
            )
        );

        CREATE OR REPLACE FUNCTION public.test_finalize_pending_order(
            p_order_id UUID
        )
        RETURNS SMALLINT
        LANGUAGE plpgsql
        AS $$
        DECLARE
            v_plan_id TEXT;
            v_sequence SMALLINT;
        BEGIN
            SELECT earlybird_order.plan_id
            INTO v_plan_id
            FROM public.earlybird_orders AS earlybird_order
            WHERE earlybird_order.id = p_order_id
              AND earlybird_order.status = 'payment_pending'
            FOR UPDATE;

            IF v_plan_id IS NULL THEN
                RAISE EXCEPTION 'PENDING_ORDER_NOT_FOUND';
            END IF;

            UPDATE public.earlybird_plan_inventory AS inventory
            SET sold_count = inventory.sold_count + 1
            WHERE inventory.plan_id = v_plan_id
              AND inventory.sold_count < inventory.sale_limit
            RETURNING inventory.sold_count INTO v_sequence;

            IF v_sequence IS NULL THEN
                RAISE EXCEPTION 'EARLYBIRD_PLAN_SOLD_OUT';
            END IF;

            UPDATE public.earlybird_orders AS earlybird_order
            SET status = 'paid',
                payment_id = 'synthetic-payment',
                plan_sequence = v_sequence
            WHERE earlybird_order.id = p_order_id;

            RETURN v_sequence;
        END;
        $$;
    `);

    return db;
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('earlybird inventory sequence high-water migration', () => {
    it('repairs a stale counter so the next finalization allocates a non-colliding sequence', async () => {
        const db = await createDatabase();
        await db.exec(`
            INSERT INTO public.earlybird_plan_inventory(
                plan_id, sale_limit, sold_count
            ) VALUES ('standard', 10, 0);
            INSERT INTO public.earlybird_orders(
                id, status, plan_id, payment_id, plan_sequence
            ) VALUES
                ('${PAID_ORDER}', 'paid', 'standard', 'existing-payment', 1),
                ('${PENDING_ORDER}', 'payment_pending', 'standard', NULL, NULL);
        `);

        await db.exec(migration);

        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count
             FROM public.earlybird_plan_inventory
             WHERE plan_id = 'standard'`
        )).rows).toEqual([{ sold_count: 1 }]);

        expect((await db.query<{ sequence: number }>(
            'SELECT public.test_finalize_pending_order($1) AS sequence',
            [PENDING_ORDER]
        )).rows).toEqual([{ sequence: 2 }]);

        expect((await db.query<{ plan_sequence: number }>(
            'SELECT plan_sequence FROM public.earlybird_orders WHERE id = $1',
            [PENDING_ORDER]
        )).rows).toEqual([{ plan_sequence: 2 }]);
    });

    it('preserves a counter that is already higher than allocated sequences', async () => {
        const db = await createDatabase();
        await db.exec(`
            INSERT INTO public.earlybird_plan_inventory(
                plan_id, sale_limit, sold_count
            ) VALUES ('standard', 10, 4);
            INSERT INTO public.earlybird_orders(
                id, status, plan_id, payment_id, plan_sequence
            ) VALUES ('${PAID_ORDER}', 'paid', 'standard', 'existing-payment', 1);
        `);

        await db.exec(migration);

        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count
             FROM public.earlybird_plan_inventory
             WHERE plan_id = 'standard'`
        )).rows).toEqual([{ sold_count: 4 }]);
    });

    it('fails closed when an allocated sequence exceeds the inventory limit', async () => {
        const db = await createDatabase();
        await db.exec(`
            INSERT INTO public.earlybird_plan_inventory(
                plan_id, sale_limit, sold_count
            ) VALUES ('standard', 1, 0);
            INSERT INTO public.earlybird_orders(
                id, status, plan_id, payment_id, plan_sequence
            ) VALUES ('${PAID_ORDER}', 'paid', 'standard', 'existing-payment', 2);
        `);

        await expect(db.exec(migration)).rejects.toThrow(
            'EARLYBIRD_INVENTORY_SEQUENCE_EXCEEDS_SALE_LIMIT'
        );
        // The migration deliberately has an explicit transaction. PGlite
        // leaves its test connection in the aborted transaction until the
        // client issues the rollback that the migration runner would issue.
        await db.exec('ROLLBACK');
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count
             FROM public.earlybird_plan_inventory
             WHERE plan_id = 'standard'`
        )).rows).toEqual([{ sold_count: 0 }]);
    });

    it('keeps the inventory allocation lock in the migration contract', () => {
        expect(migration).toContain(
            'LOCK TABLE public.earlybird_plan_inventory IN SHARE ROW EXCLUSIVE MODE;'
        );
    });
});
