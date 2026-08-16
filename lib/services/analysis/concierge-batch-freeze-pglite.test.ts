import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816154000_prepare_concierge_batch_order.sql', import.meta.url),
    'utf8',
);
const freezeMigration = `${migration.slice(0, migration.indexOf('CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order('))}\nCOMMIT;`;

let db: PGlite;

async function seedCandidate(index: number): Promise<void> {
    const suffix = index.toString(16).padStart(12, '0');
    const preflightId = `10000000-0000-4000-8000-${suffix}`;
    const orderId = `20000000-0000-4000-8000-${suffix}`;
    await db.query('INSERT INTO public.analysis_preflights (id) VALUES ($1)', [preflightId]);
    await db.query(
        `INSERT INTO public.earlybird_orders (
             id, user_id, preflight_id, target_instagram_id, status, plan_id,
             target_followers_count, target_following_count, expected_amount_krw,
             expected_groble_product_id, actual_amount_krw, actual_groble_product_id,
             payment_id, paid_at
         ) VALUES ($2, $3, $1, $4, 'paid', 'basic', 100, 200, 3900, 'product-basic',
                   3900, 'product-basic', $5, '2026-08-16T00:00:00Z');
         `,
        [
            preflightId,
            orderId,
            `30000000-0000-4000-8000-${suffix}`,
            `target${index}`,
            `payment-${index}`,
        ],
    );
    await db.query(
        "INSERT INTO public.earlybird_fulfillments (order_id, status) VALUES ($1, 'awaiting_operator')",
        [orderId],
    );
}

async function manifestHash(): Promise<string> {
    const result = await db.query<{ manifest_hash: string }>(`
        SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.string_agg(
                pg_catalog.concat_ws('|', earlybird_order.id::TEXT, earlybird_order.user_id::TEXT,
                    pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                    earlybird_order.plan_id, 'awaiting_operator', earlybird_order.preflight_id::TEXT, '',
                    earlybird_order.target_followers_count::TEXT, earlybird_order.target_following_count::TEXT,
                    earlybird_order.status, fulfillment.status, '', '',
                    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(earlybird_order.payment_id, 'UTF8'), 'sha256'), 'hex'),
                    earlybird_order.expected_amount_krw::TEXT, earlybird_order.expected_groble_product_id,
                    COALESCE(earlybird_order.actual_amount_krw::TEXT, ''),
                    COALESCE(earlybird_order.actual_groble_product_id, ''), earlybird_order.paid_at::TEXT
                ), '||' ORDER BY earlybird_order.id
            ), 'UTF8'), 'sha256'), 'hex') AS manifest_hash
        FROM public.earlybird_orders AS earlybird_order
        JOIN public.earlybird_fulfillments AS fulfillment ON fulfillment.order_id = earlybird_order.id
        WHERE earlybird_order.status = 'paid' AND fulfillment.status = 'awaiting_operator'
          AND earlybird_order.result_request_id IS NULL
    `);
    return result.rows[0].manifest_hash;
}

async function frozenCount(): Promise<number> {
    const result = await db.query<{ count: number }>(
        'SELECT count(*)::INTEGER AS count FROM public.earlybird_concierge_batch_cohort_members',
    );
    return result.rows[0].count;
}

describe('freeze_concierge_batch_cohort executable regression', () => {
    beforeEach(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
            CREATE TABLE public.analysis_preflights (id UUID PRIMARY KEY);
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY, pipeline_version TEXT, status TEXT, current_step TEXT,
                error_message TEXT, step_data JSONB NOT NULL DEFAULT '{}'::JSONB
            );
            CREATE TABLE public.earlybird_orders (
                id UUID PRIMARY KEY, user_id UUID NOT NULL, preflight_id UUID NOT NULL,
                target_instagram_id TEXT NOT NULL, result_request_id UUID,
                status TEXT NOT NULL, plan_id TEXT NOT NULL,
                target_followers_count INTEGER NOT NULL, target_following_count INTEGER NOT NULL,
                expected_amount_krw INTEGER NOT NULL, expected_groble_product_id TEXT NOT NULL,
                actual_amount_krw INTEGER, actual_groble_product_id TEXT,
                payment_id TEXT, paid_at TIMESTAMPTZ
            );
            CREATE TABLE public.earlybird_fulfillments (order_id UUID PRIMARY KEY, status TEXT NOT NULL);
        `);
        for (let index = 0; index < 30; index += 1) await seedCandidate(index);
        await db.exec(freezeMigration);
    });

    afterEach(async () => db.close());

    it('freezes and returns the exact 30 rows only for the matching operator hash', async () => {
        const expectedHash = await manifestHash();
        const result = await db.query<{ cohort: { manifestHash: string; members: unknown[] } }>(
            'SELECT public.freeze_concierge_batch_cohort($1) AS cohort',
            [expectedHash],
        );

        expect(result.rows[0].cohort.manifestHash).toBe(expectedHash);
        expect(result.rows[0].cohort.members).toHaveLength(30);
        expect(await frozenCount()).toBe(30);
    });

    it('rejects a mismatched hash and a substituted/new-order cohort without inserting members', async () => {
        const approvedHash = await manifestHash();
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', ['f'.repeat(64)]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_EXPECTED_HASH_CONFLICT');
        expect(await frozenCount()).toBe(0);

        await db.exec(`
            DELETE FROM public.earlybird_fulfillments WHERE order_id = '20000000-0000-4000-8000-000000000000';
            DELETE FROM public.earlybird_orders WHERE id = '20000000-0000-4000-8000-000000000000';
            DELETE FROM public.analysis_preflights WHERE id = '10000000-0000-4000-8000-000000000000';
        `);
        await seedCandidate(30);

        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [approvedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_EXPECTED_HASH_CONFLICT');
        expect(await frozenCount()).toBe(0);
    });
});
