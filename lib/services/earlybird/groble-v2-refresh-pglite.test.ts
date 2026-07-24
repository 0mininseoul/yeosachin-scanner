import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (file: string): string =>
    readFileSync(new URL(file, migrationsDirectory), 'utf8');

const foundationalMigrations = [
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
    '20260724123000_add_groble_seller_reference.sql',
    '20260724123100_fix_discounted_late_cancelled_payment.sql',
    '20260724230000_update_earlybird_pricing_v2.sql',
].map(migration);
const v2LineageMigration = migration(
    '20260725023000_separate_groble_v2_checkout_lineage.sql'
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

CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    provider VARCHAR(50) NOT NULL,
    phone_number VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
GRANT ALL ON public.users TO service_role;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.pipeline_jobs (id UUID PRIMARY KEY);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    idempotency_key TEXT NOT NULL DEFAULT '0123456789abcdef',
    target_instagram_id VARCHAR(30) NOT NULL,
    status TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id VARCHAR(30),
    access_mode TEXT NOT NULL,
    launch_status_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    plan_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    plan_cards_snapshot JSONB NOT NULL,
    pricing_version VARCHAR(64) NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    policy_versions_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    target_is_private BOOLEAN NOT NULL DEFAULT FALSE,
    capacity_required_plan_id TEXT NOT NULL DEFAULT 'basic',
    required_plan_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ready_at TIMESTAMP WITH TIME ZONE,
    exclusion_decided_at TIMESTAMP WITH TIME ZONE,
    result_request_id UUID
);
`;

const V1 = 'earlybird-2026-07-v1';
const DISCLOSURE_VERSION = 'earlybird-24h-v1';
const DISCLOSURE_TEXT =
    '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.';
const databases: PGlite[] = [];

async function applyLineageMigration(db: PGlite): Promise<void> {
    try {
        await db.exec(v2LineageMigration);
    } catch (error) {
        const details = error && typeof error === 'object'
            ? JSON.stringify(error, Object.getOwnPropertyNames(error))
            : String(error);
        throw new Error(`lineage migration failed: ${details}`, { cause: error });
    }
}

interface Seed {
    userId: string;
    preflightId: string;
    orderId: string;
    sellerReference: string | null;
}

function uuid(prefix: number, index: number): string {
    return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function baseDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    for (const source of foundationalMigrations) await db.exec(source);
    await db.exec(`
        CREATE TABLE public.earlybird_fulfillments (
            order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        );
    `);
    return db;
}

async function seedV1Order(
    db: PGlite,
    index: number,
    options: { sellerReference?: boolean; status?: 'payment_pending' | 'paid' } = {}
): Promise<Seed> {
    const userId = uuid(1, index);
    const preflightId = uuid(2, index);
    const phone = `+8210${String(index).padStart(8, '0')}`;
    await db.query(
        `INSERT INTO public.users (
            id, email, provider, phone_number, phone_number_normalized,
            phone_number_verification_source, phone_number_verified_at
        ) VALUES (
            $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
            pg_catalog.clock_timestamp()
        )`,
        [userId, `buyer-${index}@example.com`, `010${String(index).padStart(8, '0')}`, phone]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            access_mode, plan_cards_snapshot, pricing_version, pricing_snapshot,
            target_followers_count, target_following_count, required_plan_id,
            expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', 'production',
            '{"basic":{"selectionState":"required"}}'::JSONB,
            $4,
            '{"basic":{"status":"quoted","currency":"KRW","amountKrw":14900}}'::JSONB,
            100, 100, 'basic',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [preflightId, userId, `buyer_${index}`, V1]
    );
    const checkout = await db.query<{ order_id: string }>(
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, 'basic', 'legacy_basic_product', 14900, $3, $4, $5,
            pg_catalog.clock_timestamp()
        )`,
        [userId, preflightId, V1, DISCLOSURE_VERSION, DISCLOSURE_TEXT]
    );
    const orderId = checkout.rows[0].order_id;
    let sellerReference: string | null = null;
    if (options.sellerReference) {
        const reference = await db.query<{ reference: string }>(
            'SELECT public.issue_earlybird_groble_seller_reference($1) AS reference',
            [orderId]
        );
        sellerReference = reference.rows[0].reference;
    }
    if (options.status === 'paid') {
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid',
                 payment_id = $2,
                 actual_groble_product_id = expected_groble_product_id,
                 actual_amount_krw = expected_amount_krw,
                 paid_at = pg_catalog.clock_timestamp(),
                 due_at = pg_catalog.clock_timestamp() + INTERVAL '24 hours',
                 plan_sequence = 1
             WHERE id = $1`,
            [orderId, `paid-${index}`]
        );
    }
    return { userId, preflightId, orderId, sellerReference };
}

afterEach(async () => {
    while (databases.length > 0) await databases.pop()?.close();
});

describe('Groble v2 checkout lineage database behavior', () => {
    it('retires only untouched v1 pending orders exactly once and preserves commercial states', async () => {
        const db = await baseDatabase();
        const noReference = await seedV1Order(db, 1);
        const withReference = await seedV1Order(db, 2, { sellerReference: true });
        const paid = await seedV1Order(db, 3, { status: 'paid' });

        await applyLineageMigration(db);

        const rows = await db.query<{ id: string; status: string }>(
            `SELECT id, status
             FROM public.earlybird_orders
             WHERE id IN ($1, $2, $3)
             ORDER BY id`,
            [noReference.orderId, withReference.orderId, paid.orderId]
        );
        const statusById = new Map(rows.rows.map(row => [row.id, row.status]));
        expect(statusById.get(noReference.orderId)).toBe('cancelled');
        expect(statusById.get(withReference.orderId)).toBe('cancelled');
        expect(statusById.get(paid.orderId)).toBe('paid');
        expect((await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_checkout_retirements'
        )).rows[0].count).toBe(2);
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory
             WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    }, 30_000);

    it('attributes a late discounted payment directly to its retired reference as refund pending', async () => {
        const db = await baseDatabase();
        const legacy = await seedV1Order(db, 4, { sellerReference: true });
        await applyLineageMigration(db);

        const finalized = await db.query<{
            disposition: string;
            order_id: string;
            status: string;
        }>(
            `SELECT * FROM public.finalize_earlybird_groble_payment_by_reference(
                $1, 'event-late', 'idem-late', 'payment.completed',
                pg_catalog.clock_timestamp(), 'payment-late',
                'changed@example.com', NULL, NULL, NULL,
                'legacy_basic_product', 6900, pg_catalog.clock_timestamp()
            )`,
            [legacy.sellerReference]
        );

        expect(finalized.rows[0]).toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: legacy.orderId,
            status: 'refund_pending',
        });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory
             WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    }, 30_000);

    it('idempotently replaces an eligible retired checkout using the DB-owned v2 binding', async () => {
        const db = await baseDatabase();
        const legacy = await seedV1Order(db, 5, { sellerReference: true });
        await applyLineageMigration(db);
        await db.query(
            `SELECT public.configure_earlybird_groble_product_version(
                'basic', 'earlybird-2026-07-v1', 'legacy_basic_product',
                'legacy-basic-address', 14900, FALSE
            )`
        );
        await db.query(
            `SELECT public.configure_earlybird_groble_product_version(
                'basic', 'earlybird-2026-07-v2', 'v2_basic_product',
                'v2-basic-address', 6900, TRUE
            )`
        );
        const args = [
            legacy.userId,
            legacy.orderId,
            DISCLOSURE_VERSION,
            DISCLOSURE_TEXT,
        ];
        const refresh = () => db.query<{
            order_id: string;
            preflight_id: string;
            created: boolean;
            seller_reference: string;
            plan_id: string;
            payment_address: string;
        }>(
            `SELECT * FROM public.refresh_legacy_earlybird_checkout(
                $1, $2, $3, $4, pg_catalog.clock_timestamp(),
                '{"basic":"production","standard":"production","plus":"production"}'::JSONB,
                '{
                    "basic":{"launchStatus":"production","relationshipCapacity":{"followers":400,"following":400},"detailedMutualLimit":300},
                    "standard":{"launchStatus":"production","relationshipCapacity":{"followers":800,"following":800},"detailedMutualLimit":600},
                    "plus":{"launchStatus":"production","relationshipCapacity":{"followers":1200,"following":1200},"detailedMutualLimit":900}
                }'::JSONB,
                '{
                    "basic":{"status":"quoted","currency":"KRW","amountKrw":6900},
                    "standard":{"status":"quoted","currency":"KRW","amountKrw":9900},
                    "plus":{"status":"deferred","currency":"KRW","amountKrw":null}
                }'::JSONB
            )`,
            args
        );

        const first = (await refresh()).rows[0];
        const replay = (await refresh()).rows[0];

        expect(first).toMatchObject({
            created: true,
            plan_id: 'basic',
            payment_address: 'v2-basic-address',
        });
        expect(first.order_id).not.toBe(legacy.orderId);
        expect(first.seller_reference).toMatch(/^ord\.[a-f0-9]{32}$/);
        expect(replay).toMatchObject({
            order_id: first.order_id,
            preflight_id: first.preflight_id,
            seller_reference: first.seller_reference,
            created: false,
        });
        expect((await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_checkout_refreshes'
        )).rows[0].count).toBe(1);
    }, 30_000);
});
