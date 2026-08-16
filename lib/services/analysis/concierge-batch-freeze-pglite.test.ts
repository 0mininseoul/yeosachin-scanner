import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816154000_prepare_concierge_batch_order.sql', import.meta.url),
    'utf8',
);
const freezeMigration = `${migration.slice(0, migration.indexOf('CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order('))}\nCOMMIT;`;
const eligibilityMigration = readFileSync(
    new URL('../../../supabase/migrations/20260816155000_reconcile_exact_three_concierge_split_state.sql', import.meta.url),
    'utf8',
);

let db: PGlite;

async function seedCandidate(index: number, failedCode?: string): Promise<void> {
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
    if (failedCode) {
        const requestId = `40000000-0000-4000-8000-${suffix}`;
        await db.query(
            `INSERT INTO public.analysis_requests
                (id, user_id, preflight_id, target_instagram_id, pipeline_version,
                 status, current_step, error_message)
             VALUES ($1, $3, $4, $5, 'v2', 'failed', 'failed', $2)`,
            [requestId, failedCode, `30000000-0000-4000-8000-${suffix}`, preflightId, `target${index}`],
        );
        await db.query(
            "UPDATE public.earlybird_orders SET status = 'analysis_in_progress', result_request_id = $2 WHERE id = $1",
            [orderId, requestId],
        );
        await db.query(
            `INSERT INTO public.earlybird_fulfillments (order_id, status, request_id)
             VALUES ($1, 'analysis_in_progress', $2)`,
            [orderId, requestId],
        );
    } else {
        await db.query(
            "INSERT INTO public.earlybird_fulfillments (order_id, status) VALUES ($1, 'awaiting_operator')",
            [orderId],
        );
    }
}

async function manifestHash(): Promise<string> {
    const result = await db.query<{ manifest_hash: string }>(`
        SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.string_agg(
                pg_catalog.concat_ws('|', earlybird_order.id::TEXT, earlybird_order.user_id::TEXT,
                    pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                    earlybird_order.plan_id,
                    CASE WHEN earlybird_order.status = 'paid' THEN 'awaiting_operator' ELSE 'failed_canary' END,
                    earlybird_order.preflight_id::TEXT, COALESCE(earlybird_order.result_request_id::TEXT, ''),
                    earlybird_order.target_followers_count::TEXT, earlybird_order.target_following_count::TEXT,
                    earlybird_order.status, fulfillment.status, COALESCE(request.status, ''),
                    COALESCE(request.error_message, ''),
                    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(earlybird_order.payment_id, 'UTF8'), 'sha256'), 'hex'),
                    earlybird_order.expected_amount_krw::TEXT, earlybird_order.expected_groble_product_id,
                    COALESCE(earlybird_order.actual_amount_krw::TEXT, ''),
                    COALESCE(earlybird_order.actual_groble_product_id, ''), earlybird_order.paid_at::TEXT
                ), '||' ORDER BY earlybird_order.id
            ), 'UTF8'), 'sha256'), 'hex') AS manifest_hash
        FROM public.earlybird_orders AS earlybird_order
        JOIN public.earlybird_fulfillments AS fulfillment ON fulfillment.order_id = earlybird_order.id
        LEFT JOIN public.analysis_requests AS request ON request.id = earlybird_order.result_request_id
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
                id UUID PRIMARY KEY, user_id UUID, preflight_id UUID, target_instagram_id TEXT,
                pipeline_version TEXT, status TEXT, current_step TEXT, error_message TEXT,
                step_data JSONB NOT NULL DEFAULT '{}'::JSONB
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
            CREATE TABLE public.earlybird_fulfillments (
                order_id UUID PRIMARY KEY, status TEXT NOT NULL, request_id UUID
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_v2_provider_runs (
                request_id UUID NOT NULL, status TEXT NOT NULL, max_charge_usd NUMERIC NOT NULL,
                actual_usage_usd NUMERIC, usage_reconciled_at TIMESTAMPTZ
            );
        `);
        for (let index = 0; index < 27; index += 1) await seedCandidate(index);
        await seedCandidate(27, 'ANALYSIS_V2_JOB_HANDLER_FAILED');
        await seedCandidate(28, 'ANALYSIS_V2_JOB_HANDLER_FAILED');
        await seedCandidate(29, 'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR');
        await db.exec(freezeMigration);
        await db.exec(eligibilityMigration);
    });

    afterEach(async () => db.close());

    it('freezes and returns the exact 30 rows only for the matching operator hash', async () => {
        const expectedHash = await manifestHash();
        const result = await db.query<{
            cohort: { manifestHash: string; members: Array<{ cohort: string }> };
        }>(
            'SELECT public.freeze_concierge_batch_cohort($1) AS cohort',
            [expectedHash],
        );

        expect(result.rows[0].cohort.manifestHash).toBe(expectedHash);
        expect(result.rows[0].cohort.members).toHaveLength(30);
        expect(result.rows[0].cohort.members.filter(member => member.cohort === 'awaiting_operator')).toHaveLength(27);
        expect(result.rows[0].cohort.members.filter(member => member.cohort === 'failed_canary')).toHaveLength(3);
        expect(await frozenCount()).toBe(30);

        const rerun = await db.query<{ cohort: { manifestHash: string } }>(
            'SELECT public.freeze_concierge_batch_cohort($1) AS cohort',
            [expectedHash],
        );
        expect(rerun.rows[0].cohort.manifestHash).toBe(expectedHash);
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

    it('fails closed for active jobs and unreconciled charge-bearing terminal runs', async () => {
        const expectedHash = await manifestHash();
        const requestId = '40000000-0000-4000-8000-00000000001b';
        await db.query(
            "INSERT INTO public.analysis_pipeline_jobs VALUES ($1, 'pending')",
            [requestId],
        );
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [expectedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        await db.exec('DELETE FROM public.analysis_pipeline_jobs');

        await db.query(
            "INSERT INTO public.analysis_v2_provider_runs VALUES ($1, 'running', 1, NULL, NULL)",
            [requestId],
        );
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [expectedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        await db.exec('DELETE FROM public.analysis_v2_provider_runs');

        await db.query(
            "INSERT INTO public.analysis_v2_provider_runs VALUES ($1, 'failed', 1, NULL, NULL)",
            [requestId],
        );
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [expectedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        expect(await frozenCount()).toBe(0);
    });

    it('fails closed for retryable jobs', async () => {
        const expectedHash = await manifestHash();
        await db.query(
            "INSERT INTO public.analysis_pipeline_jobs VALUES ($1, 'retryable')",
            ['40000000-0000-4000-8000-00000000001b'],
        );
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [expectedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        expect(await frozenCount()).toBe(0);
    });

    it.each([
        ["UPDATE public.earlybird_fulfillments SET request_id = NULL WHERE order_id = '20000000-0000-4000-8000-00000000001b'"],
        ["UPDATE public.analysis_requests SET user_id = '30000000-0000-4000-8000-000000000099' WHERE id = '40000000-0000-4000-8000-00000000001b'"],
        ["UPDATE public.analysis_requests SET preflight_id = '10000000-0000-4000-8000-000000000099' WHERE id = '40000000-0000-4000-8000-00000000001b'"],
        ["UPDATE public.analysis_requests SET target_instagram_id = 'different' WHERE id = '40000000-0000-4000-8000-00000000001b'"],
    ])('rolls back a failed-canary lineage mismatch', async mismatchSql => {
        const expectedHash = await manifestHash();
        await db.exec(mismatchSql);
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [expectedHash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        expect(await frozenCount()).toBe(0);
    });

    it.each([0, 2, 4])('rejects a %i-row failed-terminal slice instead of widening the cohort', async count => {
        if (count < 3) {
            await db.query(
                'DELETE FROM public.earlybird_fulfillments WHERE order_id IN ($1, $2, $3)',
                [
                    count < 1 ? '20000000-0000-4000-8000-00000000001b' : null,
                    count < 2 ? '20000000-0000-4000-8000-00000000001c' : null,
                    '20000000-0000-4000-8000-00000000001d',
                ],
            );
        } else {
            await seedCandidate(30, 'ANALYSIS_V2_JOB_HANDLER_FAILED');
        }
        const hash = await manifestHash();
        await expect(
            db.query('SELECT public.freeze_concierge_batch_cohort($1)', [hash]),
        ).rejects.toThrow('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        expect(await frozenCount()).toBe(0);
    });
});
