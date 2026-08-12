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
const sellerReferenceMigration = migration(
    '20260724123000_add_groble_seller_reference.sql'
);
const discountedLateCancelledMigration = migration(
    '20260724123100_fix_discounted_late_cancelled_payment.sql'
);
const checkoutReconciliationMigration = migration(
    '20260730110000_add_earlybird_checkout_reconciliation.sql'
);
const autoStartCheckoutMigration = migration(
    '20260730160000_open_earlybird_auto_fulfillment_checkout.sql'
);
const pricingV3Migration = migration(
    '20260803200000_update_earlybird_pricing_v3.sql'
);
const pricingV4Migration = migration(
    '20260812120000_update_earlybird_pricing_v4.sql'
);
const refundedMigration = migration(
    '20260803193000_finalize_groble_refunded_webhooks.sql'
);
const refundBeforeCompletionMigration = migration(
    '20260803203000_reconcile_refund_before_groble_completion.sql'
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
const V3 = 'earlybird-2026-08-v3';
const V4 = 'earlybird-2026-08-v4';
const DISCLOSURE_VERSION = 'earlybird-24h-v1';
const DISCLOSURE_TEXT =
    '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.';
const AUTO_START_DISCLOSURE_VERSION = 'earlybird-auto-start-v2';
const AUTO_START_DISCLOSURE_TEXT = '결제 확인 후 판독이 자동으로 시작됩니다.';
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

function amount(planId: PaidPlanId, version: typeof V1 | typeof V2 | typeof V3 | typeof V4): number {
    if (version === V1) return planId === 'basic' ? 14_900 : 19_900;
    if (version === V2) return planId === 'basic' ? 6_900 : 9_900;
    if (version === V3) return planId === 'basic' ? 990 : 1_990;
    return planId === 'basic' ? 1_990 : 2_990;
}

function productId(planId: PaidPlanId): string {
    return planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID;
}

function pricingSnapshot(version: typeof V1 | typeof V2 | typeof V3 | typeof V4) {
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

async function createReconciliationDatabase(): Promise<PGlite> {
    const db = await createDatabase(false);
    await db.exec(sellerReferenceMigration);
    await db.exec(discountedLateCancelledMigration);
    await db.exec(pricingV2Migration);
    await db.exec(checkoutLineageMigration);
    await db.exec(checkoutReconciliationMigration);
    return db;
}

async function createAutoStartCheckoutDatabase(): Promise<PGlite> {
    const db = await createDatabase(true);
    await db.exec(checkoutLineageMigration);
    await db.exec(autoStartCheckoutMigration);
    return db;
}

async function createPricingV3Database(): Promise<PGlite> {
    const db = await createAutoStartCheckoutDatabase();
    await db.exec(pricingV3Migration);
    return db;
}

async function createPricingV4Database(): Promise<PGlite> {
    const db = await createPricingV3Database();
    await db.exec(pricingV4Migration);
    return db;
}

async function createRefundBeforeCompletionDatabase(): Promise<PGlite> {
    const db = await createReconciliationDatabase();
    await db.exec(pricingV3Migration);
    await db.exec(refundedMigration);
    await db.exec(refundBeforeCompletionMigration);
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
    version: typeof V1 | typeof V2 | typeof V3 | typeof V4
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
    version: typeof V1 | typeof V2 | typeof V3 | typeof V4
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
    version: typeof V1 | typeof V2 | typeof V3 | typeof V4,
    expectedAmount = amount(planId, version),
    disclosure: { version: string; text: string } = {
        version: DISCLOSURE_VERSION,
        text: DISCLOSURE_TEXT,
    }
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
            disclosure.version,
            disclosure.text,
        ]
    );
    return result.rows[0];
}

async function finalize(
    db: PGlite,
    seed: Seed,
    planId: PaidPlanId,
    index: number,
    paidAmount: number,
    paymentId = `pricing_payment_${index}`
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
            paymentId,
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

async function issueSellerReference(db: PGlite, orderId: string): Promise<string> {
    const result = await asService<{ issue_earlybird_groble_seller_reference: string }>(
        db,
        'SELECT public.issue_earlybird_groble_seller_reference($1)',
        [orderId]
    );
    return result.rows[0].issue_earlybird_groble_seller_reference;
}

async function finalizeByReference(
    db: PGlite,
    seed: Seed,
    planId: PaidPlanId,
    index: number,
    sellerReference: string,
    overrides: Partial<{
        email: string;
        phone: string;
        rawPhone: string;
        productId: string;
        amount: number;
        paymentId: string;
    }> = {}
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        db,
        `SELECT * FROM public.finalize_earlybird_groble_payment_by_reference(
            $1, $2, $3, 'payment.completed', pg_catalog.clock_timestamp(),
            $4, $5, $6, $7, $8, $9, $10, pg_catalog.clock_timestamp()
        )`,
        [
            sellerReference,
            `reference_event_${index}`,
            `reference_idem_${index}`,
            overrides.paymentId ?? `reference_payment_${index}`,
            overrides.email ?? seed.email,
            overrides.phone ?? seed.phone,
            overrides.rawPhone ?? seed.rawPhone,
            `Reference Buyer ${index}`,
            overrides.productId ?? productId(planId),
            overrides.amount ?? amount(planId, V2),
        ]
    );
    return result.rows[0];
}

async function finalizeLegacy(
    db: PGlite,
    seed: Seed,
    planId: PaidPlanId,
    index: number,
    paymentId = `legacy_payment_${index}`
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        db,
        `SELECT * FROM public.finalize_earlybird_groble_payment(
            $1, $2, 'payment.completed', pg_catalog.clock_timestamp(),
            $3, $4, $5, $6, pg_catalog.clock_timestamp()
        )`,
        [
            `legacy_event_${index}`,
            `legacy_idem_${index}`,
            paymentId,
            seed.email,
            productId(planId),
            amount(planId, V2),
        ]
    );
    return result.rows[0];
}

async function refundBeforeCompletion(
    db: PGlite,
    paymentId: string,
    index: number,
    paidAmount: number,
    partialRefund = false
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        db,
        `SELECT * FROM public.finalize_earlybird_groble_refund(
            $1, $2, 'payment.refunded', pg_catalog.clock_timestamp(),
            $3, $4, $5, $6, $7, pg_catalog.clock_timestamp()
        )`,
        [
            `refund_before_event_${index}`,
            `refund_before_idem_${index}`,
            paymentId,
            BASIC_PRODUCT_ID,
            paidAmount,
            partialRefund ? Math.max(1, paidAmount - 1) : paidAmount,
            partialRefund,
        ]
    );
    return result.rows[0];
}

async function reconcileNoSale(
    db: PGlite,
    orderId: string,
    providerCheckedAt = '2026-07-29T12:00:00.000Z',
    reason = 'provider_dashboard_no_sale',
    confirmed = true
) {
    return asService<{ disposition: string; status: string }>(
        db,
        `SELECT * FROM public.reconcile_earlybird_checkout_no_sale(
            $1, $2::TIMESTAMP WITH TIME ZONE, $3, $4
        )`,
        [orderId, providerCheckedAt, reason, confirmed]
    );
}

afterEach(async () => {
    while (databases.length > 0) {
        await databases.pop()?.close();
    }
});

describe('earlybird pricing v3 database behavior', () => {
    it('snapshots and finalizes the exact 990/1,990 KRW Groble prices', async () => {
        const db = await createPricingV3Database();
        const basic = await seedPreflight(db, 901, 'basic', V3);
        const standard = await seedPreflight(db, 902, 'standard', V3);
        const disclosure = {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        };

        const basicOrder = await checkout(db, basic, 'basic', V3, undefined, disclosure);
        const standardOrder = await checkout(db, standard, 'standard', V3, undefined, disclosure);

        expect((await db.query<{
            plan_id: string;
            pricing_version: string;
            expected_amount_krw: number;
        }>(`SELECT plan_id, pricing_version, expected_amount_krw
             FROM public.earlybird_orders ORDER BY expected_amount_krw`)).rows).toEqual([
            { plan_id: 'basic', pricing_version: V3, expected_amount_krw: 990 },
            { plan_id: 'standard', pricing_version: V3, expected_amount_krw: 1_990 },
        ]);
        await expect(finalize(db, basic, 'basic', 901, 990)).resolves.toMatchObject({
            disposition: 'accepted', order_id: basicOrder.order_id, status: 'paid',
        });
        await expect(finalize(db, standard, 'standard', 902, 1_990)).resolves.toMatchObject({
            disposition: 'accepted', order_id: standardOrder.order_id, status: 'paid',
        });
    }, 30_000);

    it('requires an unpurchased v2 preflight to refresh while replaying its pending snapshot unchanged', async () => {
        const legacyDb = await createAutoStartCheckoutDatabase();
        const pendingPreflight = await seedPreflight(legacyDb, 903, 'basic', V2);
        const pending = await checkout(legacyDb, pendingPreflight, 'basic', V2, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        });
        const untouchedPreflight = await seedPreflight(legacyDb, 904, 'standard', V2);
        await legacyDb.exec(pricingV3Migration);

        await expect(checkout(legacyDb, pendingPreflight, 'basic', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        })).resolves.toEqual({ order_id: pending.order_id, created: false });
        await expect(checkout(legacyDb, untouchedPreflight, 'standard', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        })).rejects.toThrow(/EARLYBIRD_PRICING_REFRESH_REQUIRED/);
        expect((await legacyDb.query<{
            pricing_version: string;
            expected_amount_krw: number;
        }>('SELECT pricing_version, expected_amount_krw FROM public.earlybird_orders')).rows).toEqual([
            { pricing_version: V2, expected_amount_krw: 6_900 },
        ]);
    }, 30_000);
});

describe('earlybird pricing v4 database behavior', () => {
    it('snapshots and finalizes the exact 1,990/2,990 KRW Groble prices', async () => {
        const db = await createPricingV4Database();
        const basic = await seedPreflight(db, 911, 'basic', V4);
        const standard = await seedPreflight(db, 912, 'standard', V4);
        const disclosure = {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        };

        const basicOrder = await checkout(db, basic, 'basic', V4, undefined, disclosure);
        const standardOrder = await checkout(db, standard, 'standard', V4, undefined, disclosure);

        expect((await db.query<{
            plan_id: string;
            pricing_version: string;
            expected_amount_krw: number;
        }>(`SELECT plan_id, pricing_version, expected_amount_krw
             FROM public.earlybird_orders ORDER BY expected_amount_krw`)).rows).toEqual([
            { plan_id: 'basic', pricing_version: V4, expected_amount_krw: 1_990 },
            { plan_id: 'standard', pricing_version: V4, expected_amount_krw: 2_990 },
        ]);
        await expect(finalize(db, basic, 'basic', 911, 1_990)).resolves.toMatchObject({
            disposition: 'accepted', order_id: basicOrder.order_id, status: 'paid',
        });
        await expect(finalize(db, standard, 'standard', 912, 2_990)).resolves.toMatchObject({
            disposition: 'accepted', order_id: standardOrder.order_id, status: 'paid',
        });
    }, 30_000);

    it('requires an unpurchased v3 preflight to refresh while replaying its pending snapshot unchanged', async () => {
        const db = await createPricingV3Database();
        const pendingPreflight = await seedPreflight(db, 913, 'basic', V3);
        const pending = await checkout(db, pendingPreflight, 'basic', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        });
        const untouchedPreflight = await seedPreflight(db, 914, 'standard', V3);
        await db.exec(pricingV4Migration);

        await expect(checkout(db, pendingPreflight, 'basic', V4, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        })).resolves.toEqual({ order_id: pending.order_id, created: false });
        await expect(checkout(db, untouchedPreflight, 'standard', V4, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        })).rejects.toThrow(/EARLYBIRD_PRICING_REFRESH_REQUIRED/);
        expect((await db.query<{
            pricing_version: string;
            expected_amount_krw: number;
        }>('SELECT pricing_version, expected_amount_krw FROM public.earlybird_orders')).rows).toEqual([
            { pricing_version: V3, expected_amount_krw: 990 },
        ]);
    }, 30_000);
});

describe('Groble refund-before-completion reconciliation', () => {
    it('keeps a full-refund-before-completion order terminally refunded and makes its replay safe', async () => {
        const db = await createRefundBeforeCompletionDatabase();
        const preflight = await seedPreflight(db, 930, 'basic', V3);
        const order = await checkout(db, preflight, 'basic', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        });
        const paymentId = 'refund_before_completion_930';

        await expect(refundBeforeCompletion(db, paymentId, 930, 990)).resolves.toMatchObject({
            disposition: 'refund_unmatched', order_id: null, status: null,
        });
        await expect(finalize(db, preflight, 'basic', 930, 990, paymentId)).resolves.toMatchObject({
            disposition: 'refunded', order_id: order.order_id, status: 'refunded',
        });
        await expect(refundBeforeCompletion(db, paymentId, 930, 990)).resolves.toMatchObject({
            disposition: 'refund_duplicate_event', order_id: order.order_id, status: 'refunded',
        });

        expect((await db.query<{ status: string; payment_id: string }>(
            'SELECT status, payment_id FROM public.earlybird_orders WHERE id = $1',
            [order.order_id]
        )).rows).toEqual([{ status: 'refunded', payment_id: paymentId }]);
        await expect(db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_orders
             WHERE id = $1 AND status IN ('paid', 'analysis_in_progress', 'completed')`,
            [order.order_id]
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        expect((await db.query<{ disposition: string; order_id: string }>(
            `SELECT disposition, order_id FROM public.earlybird_webhook_events
             WHERE event_id = 'refund_before_event_930'`
        )).rows).toEqual([{ disposition: 'refunded', order_id: order.order_id }]);
    }, 30_000);

    it('does not turn a partial-refund-before-completion into a terminal refund', async () => {
        const db = await createRefundBeforeCompletionDatabase();
        const preflight = await seedPreflight(db, 931, 'basic', V3);
        const order = await checkout(db, preflight, 'basic', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        });
        const paymentId = 'partial_before_completion_931';

        await expect(refundBeforeCompletion(db, paymentId, 931, 990, true)).resolves.toMatchObject({
            disposition: 'refund_unmatched', order_id: null, status: null,
        });
        await expect(finalize(db, preflight, 'basic', 931, 990, paymentId)).resolves.toMatchObject({
            disposition: 'accepted', order_id: order.order_id, status: 'paid',
        });
        await expect(db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1', [order.order_id]
        )).resolves.toMatchObject({ rows: [{ status: 'paid' }] });
    }, 30_000);

    it('applies the same full-refund fence through the seller-reference completion entry point', async () => {
        const db = await createRefundBeforeCompletionDatabase();
        const preflight = await seedPreflight(db, 932, 'basic', V3);
        const order = await checkout(db, preflight, 'basic', V3, undefined, {
            version: AUTO_START_DISCLOSURE_VERSION,
            text: AUTO_START_DISCLOSURE_TEXT,
        });
        const sellerReference = await issueSellerReference(db, order.order_id);
        const paymentId = 'reference_refund_before_completion_932';

        await refundBeforeCompletion(db, paymentId, 932, 990);
        await expect(finalizeByReference(
            db,
            preflight,
            'basic',
            932,
            sellerReference,
            { paymentId, amount: 990 }
        )).resolves.toMatchObject({
            disposition: 'refunded', order_id: order.order_id, status: 'refunded',
        });
    }, 30_000);
});

describe('earlybird pricing v2 database behavior', () => {
    it('keeps a terminal paid/manual-review order immutable while a fresh same-target preflight can checkout', async () => {
        const db = await createAutoStartCheckoutDatabase();
        const originalPreflight = await seedPreflight(db, 101, 'basic', V2);
        const original = await checkout(
            db,
            originalPreflight,
            'basic',
            V2,
            undefined,
            {
                version: AUTO_START_DISCLOSURE_VERSION,
                text: AUTO_START_DISCLOSURE_TEXT,
            }
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid', payment_id = 'confirmed_payment_101',
                 actual_amount_krw = 0, paid_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [original.order_id]
        );
        await db.exec(`
            CREATE TABLE public.earlybird_fulfillments (
                order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
                status TEXT NOT NULL
            );
        `);
        await db.query(
            `INSERT INTO public.earlybird_fulfillments (order_id, status)
             VALUES ($1, 'manual_review')`,
            [original.order_id]
        );

        const freshPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            102,
            'basic',
            V2
        );
        const fresh = await checkout(
            db,
            freshPreflight,
            'basic',
            V2,
            undefined,
            {
                version: AUTO_START_DISCLOSURE_VERSION,
                text: AUTO_START_DISCLOSURE_TEXT,
            }
        );

        expect(fresh).toMatchObject({ created: true });
        expect((await db.query<{
            id: string;
            status: string;
            payment_id: string | null;
            actual_amount_krw: number | null;
        }>(
            `SELECT id, status, payment_id, actual_amount_krw
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual({
            id: original.order_id,
            status: 'paid',
            payment_id: 'confirmed_payment_101',
            actual_amount_krw: 0,
        });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_fulfillments
             WHERE order_id = $1 AND status = 'manual_review'`,
            [original.order_id]
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('rejects a mixed disclosure version/text pair before creating an order', async () => {
        const db = await createAutoStartCheckoutDatabase();
        const preflight = await seedPreflight(db, 103, 'basic', V2);

        await expect(checkout(
            db,
            preflight,
            'basic',
            V2,
            undefined,
            {
                version: AUTO_START_DISCLOSURE_VERSION,
                text: DISCLOSURE_TEXT,
            }
        )).rejects.toThrow(/EARLYBIRD_CONSENT_INVALID/);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(0);
    }, 30_000);

    it('rejects a fresh legacy 24-hour checkout after the automatic-start rollout', async () => {
        const db = await createAutoStartCheckoutDatabase();
        const preflight = await seedPreflight(db, 104, 'basic', V2);

        await expect(checkout(db, preflight, 'basic', V2)).rejects.toThrow(
            /EARLYBIRD_CONSENT_INVALID/
        );
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(0);
    }, 30_000);

    it('allows an exact pending legacy order replay without rewriting its disclosure', async () => {
        const db = await createDatabase(true);
        await db.exec(checkoutLineageMigration);
        const preflight = await seedPreflight(db, 105, 'basic', V2);
        const original = await checkout(db, preflight, 'basic', V2);
        const before = (await db.query<{
            disclosure_version: string;
            disclosure_text: string;
            status: string;
        }>(
            `SELECT disclosure_version, disclosure_text, status
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0];

        await db.exec(autoStartCheckoutMigration);
        await expect(checkout(db, preflight, 'basic', V2)).resolves.toEqual({
            order_id: original.order_id,
            created: false,
        });
        expect((await db.query<typeof before>(
            `SELECT disclosure_version, disclosure_text, status
             FROM public.earlybird_orders WHERE id = $1`,
            [original.order_id]
        )).rows[0]).toEqual(before);
    }, 30_000);

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

    it('unblocks a new same-product checkout only after explicit no-sale reconciliation', async () => {
        const db = await createDatabase(false);
        const originalPreflight = await seedPreflight(db, 17, 'standard', V1);
        const original = await checkout(db, originalPreflight, 'standard', V1);
        await db.exec(pricingV2Migration);
        await db.exec(checkoutLineageMigration);
        await db.exec(sellerReferenceMigration);
        await db.exec(checkoutReconciliationMigration);
        const retryPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            18,
            'standard',
            V2
        );

        await expect(checkout(db, retryPreflight, 'standard', V2)).rejects.toThrow(
            /EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE:STALE_PRICING_LINEAGE/
        );
        await expect(reconcileNoSale(db, original.order_id, new Date().toISOString()))
            .resolves.toMatchObject({
                rows: [{ disposition: 'reconciled', status: 'payment_failed' }],
            });
        await expect(checkout(db, retryPreflight, 'standard', V2)).resolves.toMatchObject({
            created: true,
        });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_checkout_reconciliations
             WHERE order_id = $1`,
            [original.order_id]
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('fails closed for paid evidence, stale dashboard checks, and conflicting replay', async () => {
        const db = await createDatabase(true);
        const seed = await seedPreflight(db, 19, 'basic', V2);
        const original = await checkout(db, seed, 'basic', V2);
        await db.exec(checkoutLineageMigration);
        await db.exec(sellerReferenceMigration);
        await db.exec(checkoutReconciliationMigration);

        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid', payment_id = 'payment_evidence', actual_amount_krw = 0,
                 paid_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [original.order_id]
        );
        await expect(reconcileNoSale(db, original.order_id, new Date().toISOString()))
            .rejects.toThrow(/EARLYBIRD_RECONCILIATION_NOT_ELIGIBLE/);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'payment_pending', payment_id = NULL,
                 actual_amount_krw = NULL, paid_at = NULL
             WHERE id = $1`,
            [original.order_id]
        );
        await expect(reconcileNoSale(
            db,
            original.order_id,
            new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString()
        )).rejects.toThrow(/EARLYBIRD_RECONCILIATION_EVIDENCE_INVALID/);

        const checkedAt = new Date().toISOString();
        await reconcileNoSale(db, original.order_id, checkedAt);
        await expect(reconcileNoSale(db, original.order_id, checkedAt))
            .resolves.toMatchObject({
                rows: [{ disposition: 'already_reconciled', status: 'payment_failed' }],
            });
        await expect(reconcileNoSale(
            db,
            original.order_id,
            new Date(Date.now() - 1_000).toISOString()
        )).rejects.toThrow(/EARLYBIRD_RECONCILIATION_CONFLICT/);

        await expect(db.query(
            `UPDATE public.earlybird_checkout_reconciliations
             SET reason = 'provider_dashboard_no_sale'
             WHERE order_id = $1`,
            [original.order_id]
        )).rejects.toThrow(/EARLYBIRD_RECONCILIATION_AUDIT_IMMUTABLE/);
        await expect(db.query(
            `DELETE FROM public.earlybird_checkout_reconciliations
             WHERE order_id = $1`,
            [original.order_id]
        )).rejects.toThrow(/EARLYBIRD_RECONCILIATION_AUDIT_IMMUTABLE/);
    }, 30_000);

    it('serializes concurrent identical reconciliation attempts into one audit row', async () => {
        const db = await createDatabase(true);
        const seed = await seedPreflight(db, 20, 'basic', V2);
        const original = await checkout(db, seed, 'basic', V2);
        await db.exec(checkoutLineageMigration);
        await db.exec(sellerReferenceMigration);
        await db.exec(checkoutReconciliationMigration);
        const checkedAt = new Date().toISOString();

        const attempts = await Promise.all([
            reconcileNoSale(db, original.order_id, checkedAt),
            reconcileNoSale(db, original.order_id, checkedAt),
        ]);
        expect(attempts.map(attempt => attempt.rows[0].disposition).sort()).toEqual([
            'already_reconciled',
            'reconciled',
        ]);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_checkout_reconciliations'
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('keeps an unreferenced late payment ambiguous instead of crediting its replacement', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 21, 'standard', V2);
        const original = await checkout(db, originalPreflight, 'standard', V2);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());
        const replacementPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            22,
            'standard',
            V2
        );
        const replacement = await checkout(db, replacementPreflight, 'standard', V2);

        await expect(finalize(db, originalPreflight, 'standard', 21, 9_900))
            .resolves.toMatchObject({
                disposition: 'ambiguous_buyer',
                order_id: null,
                status: null,
            });
        expect((await db.query<{ id: string; status: string }>(
            `SELECT id, status FROM public.earlybird_orders
             WHERE id IN ($1, $2) ORDER BY id`,
            [original.order_id, replacement.order_id]
        )).rows.map(row => row.status).sort()).toEqual([
            'payment_failed',
            'payment_pending',
        ]);
        expect((await db.query<{ disposition: string }>(
            `SELECT disposition FROM public.earlybird_webhook_events
             WHERE event_id = 'pricing_event_21'`
        )).rows[0].disposition).toBe('ambiguous_buyer');
    }, 30_000);

    it('moves a sole matching reconciled lineage to refund review on late payment', async () => {
        const db = await createReconciliationDatabase();
        const preflight = await seedPreflight(db, 32, 'basic', V2);
        const original = await checkout(db, preflight, 'basic', V2);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());

        await expect(finalize(db, preflight, 'basic', 32, 6_900))
            .resolves.toMatchObject({
                disposition: 'late_cancelled_payment',
                order_id: original.order_id,
                status: 'refund_pending',
            });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'pricing_event_32'
               AND disposition = 'late_cancelled_payment'
               AND order_id = $1`,
            [original.order_id]
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('routes a referenced reconciled late payment to refund review without touching its replacement', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 23, 'standard', V2);
        const original = await checkout(db, originalPreflight, 'standard', V2);
        const sellerReference = await issueSellerReference(db, original.order_id);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());
        const replacementPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            24,
            'standard',
            V2
        );
        const replacement = await checkout(db, replacementPreflight, 'standard', V2);

        await expect(finalizeByReference(
            db,
            originalPreflight,
            'standard',
            23,
            sellerReference
        )).resolves.toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: original.order_id,
            status: 'refund_pending',
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [replacement.order_id]
        )).rows[0].status).toBe('payment_pending');
    }, 30_000);

    it('lets an explicit replacement reference distinguish a new payment from its reconciled ancestor', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 28, 'standard', V2);
        const original = await checkout(db, originalPreflight, 'standard', V2);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());
        const replacementPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            29,
            'standard',
            V2
        );
        const replacement = await checkout(db, replacementPreflight, 'standard', V2);
        const replacementReference = await issueSellerReference(
            db,
            replacement.order_id
        );

        await expect(finalizeByReference(
            db,
            replacementPreflight,
            'standard',
            29,
            replacementReference
        )).resolves.toMatchObject({
            disposition: 'accepted',
            order_id: replacement.order_id,
            status: 'paid',
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [original.order_id]
        )).rows[0].status).toBe('payment_failed');
    }, 30_000);

    it('durably records a seller-reference mismatch without mutating either lineage', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 25, 'standard', V2);
        const original = await checkout(db, originalPreflight, 'standard', V2);
        const sellerReference = await issueSellerReference(db, original.order_id);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());

        await expect(finalizeByReference(
            db,
            originalPreflight,
            'standard',
            25,
            sellerReference,
            { productId: BASIC_PRODUCT_ID, amount: 6_900 }
        )).resolves.toMatchObject({
            disposition: 'ambiguous_buyer',
            order_id: original.order_id,
            status: 'payment_failed',
        });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'reference_event_25'
               AND disposition = 'ambiguous_buyer'
               AND order_id = $1`,
            [original.order_id]
        )).rows[0].count).toBe(1);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [original.order_id]
        )).rows[0].status).toBe('payment_failed');
    }, 30_000);

    it('serializes concurrent referenced late-payment delivery into one durable payment attribution', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 26, 'basic', V2);
        const original = await checkout(db, originalPreflight, 'basic', V2);
        const sellerReference = await issueSellerReference(db, original.order_id);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());

        const attempts = await Promise.all([
            finalizeByReference(db, originalPreflight, 'basic', 26, sellerReference),
            finalizeByReference(db, originalPreflight, 'basic', 27, sellerReference, {
                paymentId: 'reference_payment_26',
            }),
        ]);
        expect(attempts.map(attempt => attempt.disposition).sort()).toEqual([
            'duplicate_payment',
            'late_cancelled_payment',
        ]);
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_orders
             WHERE id = $1 AND status = 'refund_pending'
               AND payment_id = 'reference_payment_26'`,
            [original.order_id]
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('keeps multiple matching reconciled lineages in durable manual review', async () => {
        const db = await createReconciliationDatabase();
        const firstPreflight = await seedPreflight(db, 30, 'basic', V2);
        const first = await checkout(db, firstPreflight, 'basic', V2);
        await reconcileNoSale(db, first.order_id, new Date().toISOString());
        const secondPreflight = await seedNewerPreflightForUser(
            db,
            firstPreflight,
            31,
            'basic',
            V2
        );
        const second = await checkout(db, secondPreflight, 'basic', V2);
        await reconcileNoSale(db, second.order_id, new Date().toISOString());

        await expect(finalize(db, firstPreflight, 'basic', 30, 6_900))
            .resolves.toMatchObject({
                disposition: 'ambiguous_buyer',
                order_id: null,
                status: null,
            });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'pricing_event_30'
               AND disposition = 'ambiguous_buyer'`
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('keeps a second unreferenced payment ambiguous after the reconciled order already entered refund review', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 33, 'standard', V2);
        const original = await checkout(db, originalPreflight, 'standard', V2);
        const originalReference = await issueSellerReference(db, original.order_id);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());
        await finalizeByReference(
            db,
            originalPreflight,
            'standard',
            33,
            originalReference
        );
        const replacementPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            34,
            'standard',
            V2
        );
        const replacement = await checkout(db, replacementPreflight, 'standard', V2);

        await expect(finalize(db, originalPreflight, 'standard', 34, 9_900))
            .resolves.toMatchObject({
                disposition: 'ambiguous_buyer',
                order_id: null,
                status: null,
            });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [replacement.order_id]
        )).rows[0].status).toBe('payment_pending');

        const replacementReference = await issueSellerReference(
            db,
            replacement.order_id
        );
        await expect(finalizeByReference(
            db,
            replacementPreflight,
            'standard',
            34,
            replacementReference,
            { paymentId: 'reference_payment_34_new' }
        )).resolves.toMatchObject({
            disposition: 'accepted',
            order_id: replacement.order_id,
            status: 'paid',
        });
    }, 30_000);

    it('routes the nine-argument rolling overload through durable reconciliation ambiguity', async () => {
        const db = await createReconciliationDatabase();
        const originalPreflight = await seedPreflight(db, 35, 'basic', V2);
        const original = await checkout(db, originalPreflight, 'basic', V2);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());
        const replacementPreflight = await seedNewerPreflightForUser(
            db,
            originalPreflight,
            36,
            'basic',
            V2
        );
        const replacement = await checkout(db, replacementPreflight, 'basic', V2);

        await expect(finalizeLegacy(db, originalPreflight, 'basic', 35))
            .resolves.toMatchObject({
                disposition: 'ambiguous_buyer',
                order_id: null,
                status: null,
            });
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'legacy_event_35'
               AND disposition = 'ambiguous_buyer'`
        )).rows[0].count).toBe(1);
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [replacement.order_id]
        )).rows[0].status).toBe('payment_pending');
    }, 30_000);

    it('serializes concurrent nine-argument reconciled payment delivery and keeps its ACL narrow', async () => {
        const db = await createReconciliationDatabase();
        const preflight = await seedPreflight(db, 37, 'basic', V2);
        const original = await checkout(db, preflight, 'basic', V2);
        await reconcileNoSale(db, original.order_id, new Date().toISOString());

        const attempts = await Promise.all([
            finalizeLegacy(db, preflight, 'basic', 37),
            finalizeLegacy(db, preflight, 'basic', 38, 'legacy_payment_37'),
        ]);
        expect(attempts.map(attempt => attempt.disposition).sort()).toEqual([
            'ambiguous_buyer',
            'duplicate_payment',
        ]);
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE payment_id = 'legacy_payment_37'`
        )).rows[0].count).toBe(1);

        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'denied_event', 'denied_idem', 'payment.completed',
                    pg_catalog.clock_timestamp(), 'denied_payment', $1, $2,
                    6900, pg_catalog.clock_timestamp()
                )`,
                [preflight.email, BASIC_PRODUCT_ID]
            )).rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('RESET ROLE');
        }
    }, 30_000);
});
