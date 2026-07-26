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
const V2 = 'earlybird-2026-07-v2';
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

async function configureLineage(
    db: PGlite,
    overrides: Partial<Record<
        | 'legacyBasicProduct'
        | 'legacyBasicAddress'
        | 'legacyStandardProduct'
        | 'legacyStandardAddress'
        | 'v2BasicProduct'
        | 'v2BasicAddress'
        | 'v2StandardProduct'
        | 'v2StandardAddress',
        string
    >> = {}
): Promise<boolean> {
    const values = {
        legacyBasicProduct: 'legacy_basic_product',
        legacyBasicAddress: 'legacy-basic-address',
        legacyStandardProduct: 'legacy_standard_product',
        legacyStandardAddress: 'legacy-standard-address',
        v2BasicProduct: 'v2_basic_product',
        v2BasicAddress: 'v2-basic-address',
        v2StandardProduct: 'v2_standard_product',
        v2StandardAddress: 'v2-standard-address',
        ...overrides,
    };
    const configured = await db.query<{ configured: boolean }>(
        `SELECT public.configure_earlybird_groble_product_lineage(
            $1, $2, $3, $4, $5, $6, $7, $8
        ) AS configured`,
        Object.values(values)
    );
    return configured.rows[0].configured;
}

async function refreshLegacyCheckout(
    db: PGlite,
    legacy: Seed
): Promise<{
    order_id: string;
    seller_reference: string;
}> {
    const refreshed = await db.query<{
        order_id: string;
        seller_reference: string;
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
        [
            legacy.userId,
            legacy.orderId,
            DISCLOSURE_VERSION,
            DISCLOSURE_TEXT,
        ]
    );
    return refreshed.rows[0];
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
    options: {
        sellerReference?: boolean;
        status?: 'payment_pending' | 'paid';
        planId?: 'basic' | 'standard';
        pricingVersion?: typeof V1 | typeof V2;
        planSequence?: number;
    } = {}
): Promise<Seed> {
    const planId = options.planId ?? 'basic';
    const pricingVersion = options.pricingVersion ?? V1;
    const amount = pricingVersion === V1
        ? planId === 'basic' ? 14_900 : 19_900
        : planId === 'basic' ? 6_900 : 9_900;
    const productId = `legacy_${planId}_product`;
    const selectionState = planId === 'basic' ? 'required' : 'available_upgrade';
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
            pg_catalog.jsonb_build_object(
                $4::TEXT, pg_catalog.jsonb_build_object(
                    'selectionState', $5::TEXT
                )
            ),
            $6,
            pg_catalog.jsonb_build_object(
                $4::TEXT, pg_catalog.jsonb_build_object(
                    'status', 'quoted',
                    'currency', 'KRW',
                    'amountKrw', $7::INTEGER
                )
            ),
            100, 100, 'basic',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `buyer_${index}`,
            planId,
            selectionState,
            pricingVersion,
            amount,
        ]
    );
    const checkout = await db.query<{ order_id: string }>(
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, $3, $4, $5, $6, $7, $8,
            pg_catalog.clock_timestamp()
        )`,
        [
            userId,
            preflightId,
            planId,
            productId,
            amount,
            pricingVersion,
            DISCLOSURE_VERSION,
            DISCLOSURE_TEXT,
        ]
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
                 plan_sequence = $3
             WHERE id = $1`,
            [orderId, `paid-${index}`, options.planSequence ?? 1]
        );
    }
    return { userId, preflightId, orderId, sellerReference };
}

afterEach(async () => {
    while (databases.length > 0) await databases.pop()?.close();
});

describe('Groble v2 checkout lineage database behavior', () => {
    it('retires untouched pending old-product orders across v1 and v2 exactly once', async () => {
        const db = await baseDatabase();
        const noReference = await seedV1Order(db, 1);
        const withReference = await seedV1Order(db, 2, { sellerReference: true });
        const pendingV2Basic = await seedV1Order(db, 3, {
            pricingVersion: V2,
        });
        const pendingV2Standard = await seedV1Order(db, 4, {
            pricingVersion: V2,
            planId: 'standard',
        });
        const paid = await seedV1Order(db, 5, { status: 'paid' });
        const refundPending = await seedV1Order(db, 12, {
            status: 'paid',
            planSequence: 2,
        });
        const completed = await seedV1Order(db, 13, {
            status: 'paid',
            planSequence: 3,
        });
        const fulfilled = await seedV1Order(db, 14);
        const webhookObserved = await seedV1Order(db, 15);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'refund_pending'
             WHERE id = $1`,
            [refundPending.orderId]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'completed'
             WHERE id = $1`,
            [completed.orderId]
        );
        await db.query(
            'INSERT INTO public.earlybird_fulfillments (order_id) VALUES ($1)',
            [fulfilled.orderId]
        );
        await db.query(
            `INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                'event-observed', 'idem-observed', 'payment.completed',
                pg_catalog.clock_timestamp(), 'payment-observed',
                'legacy_basic_product', 14900, 'unmatched', $1
            )`,
            [webhookObserved.orderId]
        );
        await db.query(
            `UPDATE public.earlybird_plan_inventory
             SET sold_count = 3
             WHERE plan_id = 'basic'`
        );

        await applyLineageMigration(db);

        const rows = await db.query<{ id: string; status: string }>(
            `SELECT id, status
             FROM public.earlybird_orders
             WHERE id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ORDER BY id`,
            [
                noReference.orderId,
                withReference.orderId,
                pendingV2Basic.orderId,
                pendingV2Standard.orderId,
                paid.orderId,
                refundPending.orderId,
                completed.orderId,
                fulfilled.orderId,
                webhookObserved.orderId,
            ]
        );
        const statusById = new Map(rows.rows.map(row => [row.id, row.status]));
        expect(statusById.get(noReference.orderId)).toBe('cancelled');
        expect(statusById.get(withReference.orderId)).toBe('cancelled');
        expect(statusById.get(pendingV2Basic.orderId)).toBe('cancelled');
        expect(statusById.get(pendingV2Standard.orderId)).toBe('cancelled');
        expect(statusById.get(paid.orderId)).toBe('paid');
        expect(statusById.get(refundPending.orderId)).toBe('refund_pending');
        expect(statusById.get(completed.orderId)).toBe('completed');
        expect(statusById.get(fulfilled.orderId)).toBe('payment_pending');
        expect(statusById.get(webhookObserved.orderId)).toBe('payment_pending');
        expect((await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_checkout_retirements'
        )).rows[0].count).toBe(4);
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory
             WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(3);
    }, 30_000);

    it('attributes a late discounted payment directly to its retired reference as refund pending', async () => {
        const db = await baseDatabase();
        const legacy = await seedV1Order(db, 6, { sellerReference: true });
        await applyLineageMigration(db);
        await configureLineage(db);

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

    it('preserves a pending legacy candidate when compatible commercial webhook evidence is unassigned', async () => {
        const db = await baseDatabase();
        const pending = await seedV1Order(db, 20);
        await db.query(
            `UPDATE public.earlybird_plan_inventory
             SET sold_count = 4
             WHERE plan_id = 'basic'`
        );
        await db.query(
            `INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition, order_id
            ) VALUES (
                'event-unassigned-commercial',
                'idem-unassigned-commercial',
                'payment.completed',
                pg_catalog.clock_timestamp(),
                'payment-unassigned-commercial',
                'legacy_basic_product',
                6900,
                'unmatched',
                NULL
            )`
        );

        await applyLineageMigration(db);

        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [pending.orderId]
        )).rows[0].status).toBe('payment_pending');
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.earlybird_checkout_retirements`
        )).rows[0].count).toBe(0);
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory
             WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(4);
    }, 30_000);

    it('does not let cross-plan or over-amount unassigned evidence protect a pending order', async () => {
        const db = await baseDatabase();
        const pending = await seedV1Order(db, 21);
        await db.query(
            `INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition
            ) VALUES
                (
                    'event-cross-plan', 'idem-cross-plan',
                    'payment.completed', pg_catalog.clock_timestamp(),
                    'payment-cross-plan', 'legacy_standard_product',
                    9900, 'unmatched'
                ),
                (
                    'event-over-amount', 'idem-over-amount',
                    'payment.completed', pg_catalog.clock_timestamp(),
                    'payment-over-amount', 'legacy_basic_product',
                    14901, 'unmatched'
                )`
        );

        await applyLineageMigration(db);

        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [pending.orderId]
        )).rows[0].status).toBe('cancelled');
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.earlybird_checkout_retirements
             WHERE legacy_order_id = $1`,
            [pending.orderId]
        )).rows[0].count).toBe(1);
    }, 30_000);

    it('idempotently replaces an existing v2 Standard old-product checkout using the new DB binding', async () => {
        const db = await baseDatabase();
        const legacy = await seedV1Order(db, 7, {
            sellerReference: true,
            pricingVersion: V2,
            planId: 'standard',
        });
        await applyLineageMigration(db);
        await configureLineage(db);
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
            plan_id: 'standard',
            payment_address: 'v2-standard-address',
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

    it('configures all four bindings atomically and corrects a typo before evidence', async () => {
        const db = await baseDatabase();
        await applyLineageMigration(db);

        expect(await configureLineage(db, {
            v2BasicProduct: 'v2_basic_typo',
        })).toBe(true);
        expect(await configureLineage(db)).toBe(true);
        expect(await configureLineage(db)).toBe(false);

        const bindings = await db.query<{
            pricing_version: string;
            plan_id: string;
            product_id: string;
            checkout_active: boolean;
        }>(
            `SELECT pricing_version, plan_id, product_id, checkout_active
             FROM public.earlybird_groble_product_versions
             ORDER BY pricing_version, plan_id`
        );
        expect(bindings.rows).toHaveLength(4);
        expect(bindings.rows.filter(row => row.checkout_active)).toEqual([
            expect.objectContaining({
                pricing_version: V2,
                plan_id: 'basic',
                product_id: 'v2_basic_product',
            }),
            expect.objectContaining({
                pricing_version: V2,
                plan_id: 'standard',
                product_id: 'v2_standard_product',
            }),
        ]);
    }, 30_000);

    it('rejects partial configuration, globally reused identities, and correction after evidence', async () => {
        const db = await baseDatabase();
        await applyLineageMigration(db);

        await expect(db.query(
            `SELECT public.configure_earlybird_groble_product_version(
                'basic', $1, 'v2_basic_product',
                'v2-basic-address', 6900, TRUE
            )`,
            [V2]
        )).rejects.toThrow(/does not exist/i);
        await expect(configureLineage(db, {
            v2StandardAddress: 'legacy_basic_product',
        })).rejects.toThrow('GROBLE_IDENTIFIERS_MUST_BE_GLOBALLY_DISTINCT');

        await configureLineage(db);
        const legacy = await seedV1Order(db, 8, {
            pricingVersion: V2,
        });
        await db.query(
            `UPDATE public.earlybird_orders
             SET expected_groble_product_id = 'v2_basic_product'
             WHERE id = $1`,
            [legacy.orderId]
        );
        await expect(configureLineage(db, {
            v2BasicProduct: 'v2_basic_corrected_too_late',
        })).rejects.toThrow('EARLYBIRD_PRODUCT_LINEAGE_FROZEN');
    }, 30_000);

    it('rejects a wrong first legacy identity when v1 order evidence already exists', async () => {
        const db = await baseDatabase();
        await seedV1Order(db, 16);
        await applyLineageMigration(db);

        await expect(configureLineage(db, {
            legacyBasicProduct: 'legacy_basic_env_typo',
        })).rejects.toThrow(
            'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_MISMATCH'
        );
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.earlybird_groble_product_versions`
        )).rows[0].count).toBe(0);
    }, 30_000);

    it('freezes a legacy binding referenced only by retired pre-separation v2 evidence', async () => {
        const db = await baseDatabase();
        await seedV1Order(db, 17, { pricingVersion: V2 });
        await applyLineageMigration(db);
        await configureLineage(db);

        await expect(configureLineage(db, {
            legacyBasicProduct: 'legacy_basic_corrected_too_late',
        })).rejects.toThrow('EARLYBIRD_PRODUCT_LINEAGE_FROZEN');
    }, 30_000);

    it('reconciles webhook-only evidence on first configuration and freezes it later', async () => {
        const db = await baseDatabase();
        await db.query(
            `INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition
            ) VALUES (
                'event-webhook-only', 'idem-webhook-only',
                'payment.completed', pg_catalog.clock_timestamp(),
                'payment-webhook-only', 'legacy_basic_product',
                14900, 'unmatched'
            )`
        );
        await applyLineageMigration(db);

        await expect(configureLineage(db, {
            legacyBasicProduct: 'legacy_basic_env_typo',
        })).rejects.toThrow(
            'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_MISMATCH'
        );
        await configureLineage(db);
        await expect(configureLineage(db, {
            legacyBasicProduct: 'legacy_basic_corrected_too_late',
        })).rejects.toThrow('EARLYBIRD_PRODUCT_LINEAGE_FROZEN');
    }, 30_000);

    it('fails closed when one historical product is evidenced across both plans', async () => {
        const db = await baseDatabase();
        await seedV1Order(db, 18);
        const standard = await seedV1Order(db, 19, { planId: 'standard' });
        await db.query(
            `UPDATE public.earlybird_orders
             SET expected_groble_product_id = 'legacy_basic_product'
             WHERE id = $1`,
            [standard.orderId]
        );
        await applyLineageMigration(db);

        await expect(configureLineage(db)).rejects.toThrow(
            'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_AMBIGUOUS'
        );
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.earlybird_groble_product_versions`
        )).rows[0].count).toBe(0);
    }, 30_000);

    it('requires a seller reference for active v2 while preserving no-reference legacy refunds', async () => {
        const db = await baseDatabase();
        const activeLegacy = await seedV1Order(db, 9);
        const lateLegacy = await seedV1Order(db, 10, {
            sellerReference: true,
        });
        await applyLineageMigration(db);
        await configureLineage(db);
        const active = await refreshLegacyCheckout(db, activeLegacy);

        await expect(db.query(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'event-active-no-ref', 'idem-active-no-ref', 'payment.completed',
                pg_catalog.clock_timestamp(), 'payment-active-no-ref',
                'buyer-9@example.com', NULL, NULL, NULL,
                'v2_basic_product', 6900, pg_catalog.clock_timestamp()
            )`
        )).rejects.toThrow('GROBLE_SELLER_REFERENCE_REQUIRED');
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [active.order_id]
        )).rows[0].status).toBe('payment_pending');

        const late = await db.query<{ disposition: string; status: string }>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'event-legacy-no-ref', 'idem-legacy-no-ref', 'payment.completed',
                pg_catalog.clock_timestamp(), 'payment-legacy-no-ref',
                'buyer-10@example.com', '+821000000010', NULL, NULL,
                'legacy_basic_product', 6900, pg_catalog.clock_timestamp()
            )`
        );
        expect(late.rows[0]).toMatchObject({
            disposition: 'late_cancelled_payment',
            status: 'refund_pending',
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [lateLegacy.orderId]
        )).rows[0].status).toBe('refund_pending');
    }, 30_000);

    it('rejects active underpayment without mutation and accepts only exact duplicate evidence', async () => {
        const db = await baseDatabase();
        const legacy = await seedV1Order(db, 11);
        await applyLineageMigration(db);
        await configureLineage(db);
        const active = await refreshLegacyCheckout(db, legacy);
        const finalize = (
            eventId: string,
            idempotencyKey: string,
            paymentId: string,
            productId: string,
            amount: number
        ) => db.query<{ disposition: string; status: string }>(
            `SELECT * FROM public.finalize_earlybird_groble_payment_by_reference(
                $1, $2, $3, 'payment.completed',
                pg_catalog.clock_timestamp(), $4,
                'buyer-11@example.com', NULL, NULL, NULL,
                $5, $6, pg_catalog.clock_timestamp()
            )`,
            [
                active.seller_reference,
                eventId,
                idempotencyKey,
                paymentId,
                productId,
                amount,
            ]
        );

        await expect(finalize(
            'event-underpaid',
            'idem-underpaid',
            'payment-underpaid',
            'v2_basic_product',
            6_899
        )).rejects.toThrow('EARLYBIRD_PAYMENT_AMOUNT_MISMATCH');
        expect((await db.query<{
            status: string;
            payment_id: string | null;
        }>(
            'SELECT status, payment_id FROM public.earlybird_orders WHERE id = $1',
            [active.order_id]
        )).rows[0]).toEqual({
            status: 'payment_pending',
            payment_id: null,
        });
        expect((await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_webhook_events'
        )).rows[0].count).toBe(0);

        expect((await finalize(
            'event-paid',
            'idem-paid',
            'payment-paid',
            'v2_basic_product',
            6_900
        )).rows[0]).toMatchObject({
            disposition: 'accepted',
            status: 'paid',
        });
        expect((await finalize(
            'event-paid',
            'idem-paid',
            'payment-paid',
            'v2_basic_product',
            6_900
        )).rows[0].disposition).toBe('duplicate_event');

        await expect(finalize(
            'event-paid',
            'idem-paid',
            'payment-paid',
            'v2_basic_product',
            6_899
        )).rejects.toThrow('EARLYBIRD_SELLER_REFERENCE_CONFLICT');
        await expect(finalize(
            'event-payment-drift',
            'idem-payment-drift',
            'payment-paid',
            'v2_standard_product',
            9_900
        )).rejects.toThrow('EARLYBIRD_SELLER_REFERENCE_CONFLICT');

        expect((await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_webhook_events'
        )).rows[0].count).toBe(1);
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory
             WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(1);
    }, 30_000);
});
