import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (file: string): string =>
    readFileSync(new URL(file, migrationsDirectory), 'utf8');

const prePricingMigrations = [
    '20260717140000_add_groble_earlybird_presale.sql',
    '20260719131000_add_groble_phone_matching.sql',
    '20260719131100_activate_groble_phone_checkout.sql',
    '20260719131200_backfill_groble_phone_matching.sql',
    '20260719131300_validate_groble_phone_matching.sql',
    '20260719131400_activate_groble_phone_finalization.sql',
    '20260719131500_stop_persisting_groble_buyer_contacts.sql',
    '20260719170000_restore_groble_phone_normalizer_service_role_execute.sql',
    '20260719180000_accept_groble_discounted_earlybird_payments.sql',
    '20260720100000_shorten_earlybird_delivery_window.sql',
].map(migration);
const pricingV2Migration = migration(
    '20260724230000_update_earlybird_pricing_v2.sql'
);
const checkoutLineageMigration = migration(
    '20260728130000_classify_earlybird_checkout_lineage.sql'
);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.gen_random_uuid() $$;

CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    provider VARCHAR(50) NOT NULL,
    phone_number VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO service_role;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id VARCHAR(30) NOT NULL,
    status TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id VARCHAR(30),
    access_mode TEXT NOT NULL,
    plan_cards_snapshot JSONB NOT NULL,
    pricing_version VARCHAR(64) NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    required_plan_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
`;

const V1 = 'earlybird-2026-07-v1';
const V2 = 'earlybird-2026-07-v2';
const DISCLOSURE_VERSION = 'earlybird-24h-v1';
const DISCLOSURE_TEXT =
    '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.';
const BASIC_PRODUCT_ID = 'basic_product-01';
const STANDARD_PRODUCT_ID = 'standard_product-01';
const databases: PGlite[] = [];

type PaidPlanId = 'basic' | 'standard';

interface Seed {
    userId: string;
    preflightId: string;
    email: string;
    phone: string;
    rawPhone: string;
}

interface CheckoutRow {
    order_id: string;
    created: boolean;
}

interface FinalizeRow {
    disposition: string;
    order_id: string | null;
    status: string | null;
}

function uuid(prefix: '1' | '2', index: number): string {
    return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function amount(planId: PaidPlanId, version: typeof V1 | typeof V2): number {
    if (version === V1) return planId === 'basic' ? 14_900 : 19_900;
    return planId === 'basic' ? 6_900 : 9_900;
}

function productId(planId: PaidPlanId): string {
    return planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID;
}

function pricingSnapshot(version: typeof V1 | typeof V2) {
    return {
        basic: { currency: 'KRW', status: 'quoted', amountKrw: amount('basic', version) },
        standard: {
            currency: 'KRW',
            status: 'quoted',
            amountKrw: amount('standard', version),
        },
        plus: { currency: 'KRW', status: 'deferred', amountKrw: null },
    };
}

function planCards(planId: PaidPlanId) {
    return {
        basic: {
            selectionState: planId === 'basic' ? 'required' : 'unavailable',
        },
        standard: {
            selectionState: planId === 'standard' ? 'required' : 'available_upgrade',
        },
        plus: { selectionState: 'available_upgrade' },
    };
}

async function createDatabase(includePricingV2: boolean): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    for (const source of prePricingMigrations) await db.exec(source);
    if (includePricingV2) {
        await db.exec(pricingV2Migration);
    }
    return db;
}

async function asService<T>(
    db: PGlite,
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

async function seedPreflight(
    db: PGlite,
    index: number,
    planId: PaidPlanId,
    version: typeof V1 | typeof V2
): Promise<Seed> {
    const suffix = String(index).padStart(8, '0');
    const seed = {
        userId: uuid('1', index),
        preflightId: uuid('2', index),
        email: `pricing-v2-${index}@example.com`,
        rawPhone: `010-${suffix.slice(0, 4)}-${suffix.slice(4)}`,
        phone: `+8210${suffix}`,
    };
    await asService(
        db,
        `INSERT INTO public.users (
            id, email, provider, phone_number, phone_number_normalized,
            phone_number_verification_source, phone_number_verified_at
        ) VALUES (
            $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
            pg_catalog.clock_timestamp()
        )`,
        [seed.userId, seed.email, seed.rawPhone, seed.phone]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            access_mode, plan_cards_snapshot, pricing_version, pricing_snapshot,
            target_followers_count, target_following_count, required_plan_id,
            expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', 'production', $4, $5, $6,
            $7, 100, $8, pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            seed.preflightId,
            seed.userId,
            `pricing_target_${index}`,
            planCards(planId),
            version,
            pricingSnapshot(version),
            planId === 'basic' ? 300 : 700,
            planId,
        ]
    );
    return seed;
}

async function seedNewerPreflightForUser(
    db: PGlite,
    seed: Seed,
    index: number,
    planId: PaidPlanId,
    version: typeof V1 | typeof V2
): Promise<Seed> {
    const newer = {
        ...seed,
        preflightId: uuid('2', index),
    };
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            access_mode, plan_cards_snapshot, pricing_version, pricing_snapshot,
            target_followers_count, target_following_count, required_plan_id,
            created_at, expires_at
        )
        SELECT
            $1, user_id, target_instagram_id, 'ready', exclusion_decision,
            access_mode, $2, $3, $4, $5, target_following_count, $6,
            created_at + INTERVAL '1 second',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        FROM public.analysis_preflights
        WHERE id = $7`,
        [
            newer.preflightId,
            planCards(planId),
            version,
            pricingSnapshot(version),
            planId === 'basic' ? 300 : 700,
            planId,
            seed.preflightId,
        ]
    );
    return newer;
}

async function checkout(
    db: PGlite,
    seed: Seed,
    planId: PaidPlanId,
    version: typeof V1 | typeof V2,
    expectedAmount = amount(planId, version)
): Promise<CheckoutRow> {
    const result = await asService<CheckoutRow>(
        db,
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, $3, $4, $5, $6, $7, $8,
            pg_catalog.clock_timestamp()
        )`,
        [
            seed.userId,
            seed.preflightId,
            planId,
            productId(planId),
            expectedAmount,
            version,
            DISCLOSURE_VERSION,
            DISCLOSURE_TEXT,
        ]
    );
    return result.rows[0];
}

async function finalize(
    db: PGlite,
    seed: Seed,
    planId: PaidPlanId,
    index: number,
    paidAmount: number
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        db,
        `SELECT * FROM public.finalize_earlybird_groble_payment(
            $1, $2, 'payment.completed', pg_catalog.clock_timestamp(),
            $3, $4, $5, $6, $7, $8, $9, pg_catalog.clock_timestamp()
        )`,
        [
            `pricing_event_${index}`,
            `pricing_idem_${index}`,
            `pricing_payment_${index}`,
            seed.email,
            seed.phone,
            seed.rawPhone,
            `Pricing Buyer ${index}`,
            productId(planId),
            paidAmount,
        ]
    );
    return result.rows[0];
}

afterEach(async () => {
    while (databases.length > 0) {
        await databases.pop()?.close();
    }
});

describe('earlybird pricing v2 database behavior', () => {
    it('atomically stores the exact v2 snapshot amount for Basic and Standard', async () => {
        const db = await createDatabase(true);
        const basic = await seedPreflight(db, 1, 'basic', V2);
        const standard = await seedPreflight(db, 2, 'standard', V2);

        await expect(checkout(db, basic, 'basic', V2)).resolves.toMatchObject({
            created: true,
        });
        await expect(checkout(db, standard, 'standard', V2)).resolves.toMatchObject({
            created: true,
        });

        const orders = (await db.query<{
            plan_id: string;
            pricing_version: string;
            expected_amount_krw: number;
        }>(
            `SELECT plan_id, pricing_version, expected_amount_krw
             FROM public.earlybird_orders ORDER BY expected_amount_krw`
        )).rows;
        expect(orders).toEqual([
            {
                plan_id: 'basic',
                pricing_version: V2,
                expected_amount_krw: 6_900,
            },
            {
                plan_id: 'standard',
                pricing_version: V2,
                expected_amount_krw: 9_900,
            },
        ]);
        expect((await db.query<{
            plan_id: string;
            sale_limit: number;
        }>(
            'SELECT plan_id, sale_limit FROM public.earlybird_plan_inventory ORDER BY plan_id'
        )).rows).toEqual([
            { plan_id: 'basic', sale_limit: 10 },
            { plan_id: 'standard', sale_limit: 10 },
        ]);
    }, 30_000);

    it('rejects caller amount/version drift and requires old preflights to refresh', async () => {
        const db = await createDatabase(true);
        const v2 = await seedPreflight(db, 3, 'basic', V2);
        const v1 = await seedPreflight(db, 4, 'basic', V1);

        await expect(checkout(db, v2, 'basic', V2, 9_900)).rejects.toThrow(
            /EARLYBIRD_PRICE_INVALID/
        );
        await expect(checkout(db, v2, 'basic', V1)).rejects.toThrow(
            /EARLYBIRD_PRICE_SNAPSHOT_INVALID/
        );
        await expect(checkout(db, v1, 'basic', V2)).rejects.toThrow(
            /EARLYBIRD_PRICING_REFRESH_REQUIRED/
        );
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(0);
    }, 30_000);

    it('lets a draining v1 instance finish an exact v1 preflight during rollout', async () => {
        const db = await createDatabase(true);
        const seed = await seedPreflight(db, 5, 'standard', V1);

        await expect(checkout(db, seed, 'standard', V1)).resolves.toMatchObject({
            created: true,
        });
        expect((await db.query<{
            pricing_version: string;
            expected_amount_krw: number;
        }>(
            'SELECT pricing_version, expected_amount_krw FROM public.earlybird_orders'
        )).rows[0]).toEqual({
            pricing_version: V1,
            expected_amount_krw: 19_900,
        });
    }, 30_000);

    it('replays a pending v1 order to a v2 caller without changing its audit snapshot', async () => {
        const db = await createDatabase(false);
        const seed = await seedPreflight(db, 6, 'basic', V1);
        const original = await checkout(db, seed, 'basic', V1);
        const before = (await db.query<{
            pricing_version: string;
            expected_amount_krw: number;
            status: string;
            updated_at: string;
        }>(
            `SELECT pricing_version, expected_amount_krw, status, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];

        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);
        await expect(checkout(db, seed, 'basic', V2)).resolves.toEqual({
            order_id: original.order_id,
            created: false,
        });
        const after = (await db.query<typeof before>(
            `SELECT pricing_version, expected_amount_krw, status, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];
        expect(after).toEqual(before);
    }, 30_000);

    it('replays the exact pending P1 order and classifies a new same-product lineage without mutation', async () => {
        const db = await createDatabase(false);
        const p1 = await seedPreflight(db, 11, 'basic', V1);
        const original = await checkout(db, p1, 'basic', V1);
        const before = (await db.query<{
            id: string;
            pricing_version: string;
            expected_amount_krw: number;
            status: string;
            updated_at: string;
        }>(
            `SELECT id, pricing_version, expected_amount_krw, status, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];

        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);
        const p2 = await seedNewerPreflightForUser(db, p1, 12, 'basic', V2);

        await expect(checkout(db, p1, 'basic', V2)).resolves.toEqual({
            order_id: original.order_id,
            created: false,
        });
        expect((await db.query<typeof before>(
            `SELECT id, pricing_version, expected_amount_krw, status, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual(before);
        await expect(checkout(db, p2, 'basic', V2)).rejects.toThrow(
            /EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE:STALE_PRICING_LINEAGE/
        );
        expect((await db.query<typeof before>(
            `SELECT id, pricing_version, expected_amount_krw, status, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual(before);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('classifies a cancelled unresolved same-product lineage without replacing its snapshot', async () => {
        const db = await createDatabase(false);
        const p1 = await seedPreflight(db, 13, 'basic', V1);
        const original = await checkout(db, p1, 'basic', V1);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'cancelled', updated_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [original.order_id]
        );
        const before = (await db.query<{
            id: string;
            pricing_version: string;
            expected_amount_krw: number;
            status: string;
            payment_id: string | null;
            updated_at: string;
        }>(
            `SELECT id, pricing_version, expected_amount_krw, status, payment_id, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];

        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);
        const p2 = await seedNewerPreflightForUser(db, p1, 14, 'basic', V2);

        await expect(checkout(db, p2, 'basic', V2)).rejects.toThrow(
            /EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE:STALE_PRICING_LINEAGE/
        );
        expect((await db.query<typeof before>(
            `SELECT id, pricing_version, expected_amount_krw, status, payment_id, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual(before);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('does not cancel or replace a live different-product checkout lineage', async () => {
        const db = await createDatabase(false);
        const p1 = await seedPreflight(db, 15, 'basic', V1);
        const original = await checkout(db, p1, 'basic', V1);
        const before = (await db.query<{
            id: string;
            plan_id: string;
            status: string;
            payment_id: string | null;
            updated_at: string;
        }>(
            `SELECT id, plan_id, status, payment_id, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];

        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);
        const p2 = await seedNewerPreflightForUser(db, p1, 16, 'standard', V2);

        await expect(checkout(db, p2, 'standard', V2)).rejects.toThrow(
            /EARLYBIRD_ORDER_CONFLICT/
        );
        expect((await db.query<typeof before>(
            `SELECT id, plan_id, status, payment_id, updated_at
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual(before);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('preserves paid/cancelled orders and webhook audit rows across the migration', async () => {
        const db = await createDatabase(false);
        const paidSeed = await seedPreflight(db, 7, 'basic', V1);
        const cancelledSeed = await seedPreflight(db, 8, 'standard', V1);
        await checkout(db, paidSeed, 'basic', V1);
        await checkout(db, cancelledSeed, 'standard', V1);
        await finalize(db, paidSeed, 'basic', 7, 6_900);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'cancelled', updated_at = pg_catalog.clock_timestamp()
             WHERE preflight_id = $1`,
            [cancelledSeed.preflightId]
        );
        const before = (await db.query(
            `SELECT id, preflight_id, plan_id, pricing_version,
                expected_amount_krw, actual_amount_krw, status, payment_id
             FROM public.earlybird_orders ORDER BY preflight_id`
        )).rows;
        const eventsBefore = (await db.query(
            `SELECT event_id, idempotency_key, amount_krw, disposition
             FROM public.earlybird_webhook_events ORDER BY event_id`
        )).rows;

        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);

        expect((await db.query(
            `SELECT id, preflight_id, plan_id, pricing_version,
                expected_amount_krw, actual_amount_krw, status, payment_id
             FROM public.earlybird_orders ORDER BY preflight_id`
        )).rows).toEqual(before);
        expect((await db.query(
            `SELECT event_id, idempotency_key, amount_krw, disposition
             FROM public.earlybird_webhook_events ORDER BY event_id`
        )).rows).toEqual(eventsBefore);
        await expect(checkout(db, paidSeed, 'basic', V2)).rejects.toThrow(
            /EARLYBIRD_ORDER_CONFLICT/
        );
        await expect(checkout(db, cancelledSeed, 'standard', V2)).rejects.toThrow(
            /EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE:STALE_PRICING_LINEAGE/
        );
    }, 30_000);

    it('keeps webhook discount acceptance bounded to zero through expected amount', async () => {
        const db = await createDatabase(true);
        const discountedSeed = await seedPreflight(db, 9, 'basic', V2);
        const overSeed = await seedPreflight(db, 10, 'standard', V2);
        const discountedOrder = await checkout(db, discountedSeed, 'basic', V2);
        await checkout(db, overSeed, 'standard', V2);

        await expect(finalize(db, discountedSeed, 'basic', 9, 0)).resolves.toMatchObject({
            disposition: 'accepted',
            order_id: discountedOrder.order_id,
            status: 'paid',
        });
        await expect(finalize(db, overSeed, 'standard', 10, 9_901)).resolves.toMatchObject({
            disposition: 'mismatch',
            status: 'payment_failed',
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE preflight_id = $1',
            [overSeed.preflightId]
        )).rows[0].status).toBe('payment_failed');
    }, 30_000);
});
