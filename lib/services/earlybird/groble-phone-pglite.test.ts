import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PRICING_VERSION,
} from '@/lib/domain/earlybird/catalog';

const presaleMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260717140000_add_groble_earlybird_presale.sql',
        import.meta.url
    ),
    'utf8'
);
const phoneMigrations = [
    '20260718104053_add_groble_phone_matching.sql',
    '20260718114650_activate_groble_phone_checkout.sql',
    '20260718114658_backfill_groble_phone_matching.sql',
    '20260718114707_validate_groble_phone_matching.sql',
    '20260718120345_activate_groble_phone_finalization.sql',
].map(file => readFileSync(
    new URL(`../../../supabase/migrations/${file}`, import.meta.url),
    'utf8'
));
const [
    phoneDdlMigration,
    phoneCheckoutMigration,
    phoneBackfillMigration,
    phoneValidationMigration,
    phoneFinalizationMigration,
] = phoneMigrations;

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

const USER_NAMESPACE = '30000000-0000-4000-8000-';
const PREFLIGHT_NAMESPACE = '40000000-0000-4000-8000-';
const BASIC_PRODUCT_ID = 'basic_product-01';
const STANDARD_PRODUCT_ID = 'standard_product-01';

type PaidPlanId = 'basic' | 'standard';
type Provider = 'google' | 'kakao';

interface Seed {
    index: number;
    userId: string;
    preflightId: string;
    email: string;
    phone: string | null;
    rawPhone: string | null;
}

interface CheckoutRow {
    order_id: string;
    created: boolean;
}

interface FinalizeRow {
    disposition: string;
    order_id: string | null;
    status: string | null;
    plan_sequence: number | null;
}

interface FinalizeOverrides {
    eventId?: string;
    idempotencyKey?: string;
    paymentId?: string;
    buyerEmail?: string;
    normalizedPhone?: string | null;
    rawPhone?: string | null;
    displayName?: string | null;
    productId?: string;
    amount?: number;
}

const pricingSnapshot = {
    basic: { currency: 'KRW', status: 'quoted', amountKrw: 14_900 },
    standard: { currency: 'KRW', status: 'quoted', amountKrw: 19_900 },
    plus: { currency: 'KRW', status: 'deferred', amountKrw: null },
};

let db: PGlite;

function uuid(namespace: string, index: number): string {
    return `${namespace}${String(index).padStart(12, '0')}`;
}

function normalizedPhone(index: number): string {
    return `+8210${String(index).padStart(8, '0')}`;
}

function rawPhone(index: number): string {
    const local = String(index).padStart(8, '0');
    return `010-${local.slice(0, 4)}-${local.slice(4)}`;
}

function planCards(planId: PaidPlanId): Record<string, object> {
    return {
        basic: { selectionState: planId === 'basic' ? 'required' : 'unavailable' },
        standard: {
            selectionState: planId === 'standard' ? 'required' : 'available_upgrade',
        },
        plus: { selectionState: 'available_upgrade' },
    };
}

async function createDatabaseBeforePhoneMigration(): Promise<PGlite> {
    const database = await PGlite.create();
    await database.exec(bootstrap);
    await database.exec(presaleMigration);
    return database;
}

async function applyPhoneMigrations(database: PGlite): Promise<void> {
    for (const migration of phoneMigrations) {
        await database.exec(migration);
    }
}

async function asServiceOn<T>(
    database: PGlite,
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await database.exec('SET ROLE service_role');
    try {
        return await database.query<T>(sql, params);
    } finally {
        await database.exec('RESET ROLE');
    }
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    return asServiceOn<T>(db, sql, params);
}

async function seedPreflight(
    index: number,
    planId: PaidPlanId = 'basic',
    options: {
        provider?: Provider;
        phone?: string | null;
        rawPhone?: string | null;
        email?: string;
    } = {}
): Promise<Seed> {
    const provider = options.provider ?? 'kakao';
    const phone = options.phone === undefined
        ? (provider === 'kakao' ? normalizedPhone(index) : null)
        : options.phone;
    const unnormalized = options.rawPhone === undefined
        ? (phone ? rawPhone(index) : null)
        : options.rawPhone;
    const seed = {
        index,
        userId: uuid(USER_NAMESPACE, index),
        preflightId: uuid(PREFLIGHT_NAMESPACE, index),
        email: options.email ?? `phone-buyer-${index}@example.com`,
        phone,
        rawPhone: unnormalized,
    };
    await db.query(
        `INSERT INTO public.users (
            id, email, provider, phone_number, phone_number_normalized
        ) VALUES ($1, $2, $3, $4, $5)`,
        [seed.userId, seed.email, provider, seed.rawPhone, seed.phone]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', NULL, 'production', $4,
            $5, $6, $7, 100, $8,
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            seed.preflightId,
            seed.userId,
            `target_${index}`,
            planCards(planId),
            EARLYBIRD_PRICING_VERSION,
            pricingSnapshot,
            planId === 'basic' ? 300 : 700,
            planId,
        ]
    );
    return seed;
}

async function seedNewPreflight(
    index: number,
    userId: string,
    planId: PaidPlanId
): Promise<string> {
    const preflightId = uuid(PREFLIGHT_NAMESPACE, index);
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, created_at, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', NULL, 'production', $4,
            $5, $6, $7, 100, $8,
            pg_catalog.clock_timestamp() + INTERVAL '1 second',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `target_${index}`,
            planCards(planId),
            EARLYBIRD_PRICING_VERSION,
            pricingSnapshot,
            planId === 'basic' ? 300 : 700,
            planId,
        ]
    );
    return preflightId;
}

async function createCheckout(
    seed: Pick<Seed, 'userId' | 'preflightId'>,
    planId: PaidPlanId = 'basic'
): Promise<CheckoutRow> {
    const result = await asService<CheckoutRow>(
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, $3, $4, $5, $6, $7, $8, pg_catalog.clock_timestamp()
        )`,
        [
            seed.userId,
            seed.preflightId,
            planId,
            planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID,
            planId === 'basic' ? 14_900 : 19_900,
            EARLYBIRD_PRICING_VERSION,
            EARLYBIRD_DISCLOSURE_VERSION,
            EARLYBIRD_DISCLOSURE_TEXT,
        ]
    );
    return result.rows[0];
}

async function finalize(
    seed: Seed,
    planId: PaidPlanId,
    index: number,
    overrides: FinalizeOverrides = {}
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        `SELECT * FROM public.finalize_earlybird_groble_payment(
            $1, $2, 'payment.completed', $3, $4, $5, $6, $7, $8, $9, $10, $11
        )`,
        [
            overrides.eventId ?? `phone_event_${index}`,
            overrides.idempotencyKey ?? `phone_idem_${index}`,
            '2026-07-18T21:00:00+09:00',
            overrides.paymentId ?? `phone_payment_${index}`,
            overrides.buyerEmail ?? seed.email,
            overrides.normalizedPhone === undefined ? seed.phone : overrides.normalizedPhone,
            overrides.rawPhone === undefined ? seed.rawPhone : overrides.rawPhone,
            overrides.displayName === undefined ? `Buyer ${index}` : overrides.displayName,
            overrides.productId ?? (planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID),
            overrides.amount ?? (planId === 'basic' ? 14_900 : 19_900),
            '2026-07-18T21:00:00+09:00',
        ]
    );
    return result.rows[0];
}

async function requestCancellation(
    paymentId: string,
    planId: PaidPlanId,
    index: number
): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        `SELECT * FROM public.finalize_earlybird_groble_cancel_request(
            $1, $2, 'payment.cancel_requested', $3, $4, $5, $6, $7
        )`,
        [
            `phone_cancel_event_${index}`,
            `phone_cancel_idem_${index}`,
            '2026-07-18T20:00:00+09:00',
            paymentId,
            planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID,
            planId === 'basic' ? 14_900 : 19_900,
            '2026-07-18T20:00:00+09:00',
        ]
    );
    return result.rows[0];
}

describe('Groble phone migration upgrade behavior', () => {
    it('backfills domestic and +82 mobile numbers while leaving invalid numbers null', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number) VALUES
                    ($1, 'domestic@example.com', 'kakao', '010-1234-5678'),
                    ($2, 'international@example.com', 'kakao', '+82 10 8765 4321'),
                    ($3, 'invalid@example.com', 'google', '02-123-4567')`,
                [
                    uuid(USER_NAMESPACE, 901),
                    uuid(USER_NAMESPACE, 902),
                    uuid(USER_NAMESPACE, 903),
                ]
            );
            await applyPhoneMigrations(database);

            const rows = (await database.query<{
                email: string;
                phone_number_normalized: string | null;
            }>(
                `SELECT email, phone_number_normalized
                 FROM public.users ORDER BY email`
            )).rows;
            expect(rows).toEqual([
                { email: 'domestic@example.com', phone_number_normalized: '+821012345678' },
                { email: 'international@example.com', phone_number_normalized: '+821087654321' },
                { email: 'invalid@example.com', phone_number_normalized: null },
            ]);
            await expect(database.query(
                `UPDATE public.users SET phone_number_normalized = '+8210123' WHERE email = $1`,
                ['invalid@example.com']
            )).rejects.toThrow(/users_phone_number_normalized_check/);
        } finally {
            await database.close();
        }
    }, 30_000);

    it('aborts rather than choosing between duplicate normalized users', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number) VALUES
                    ($1, 'duplicate-one@example.com', 'kakao', '010-1234-5678'),
                    ($2, 'duplicate-two@example.com', 'kakao', '+82 10 1234 5678')`,
                [uuid(USER_NAMESPACE, 904), uuid(USER_NAMESPACE, 905)]
            );
            await expect(applyPhoneMigrations(database)).rejects.toThrow(
                /DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW/
            );
            expect((await database.query<{
                phone_number_normalized: string | null;
            }>(
                `SELECT phone_number_normalized
                 FROM public.users
                 ORDER BY email`
            )).rows).toEqual([
                { phone_number_normalized: null },
                { phone_number_normalized: null },
            ]);
        } finally {
            await database.close();
        }
    }, 30_000);

    it('backfills phone snapshots for existing pending and unresolved cancelled orders', async () => {
        for (const scenario of [
            {
                index: 906,
                expectedPhone: '+821011112222',
                rawPhone: '010-1111-2222',
                status: 'payment_pending',
            },
            {
                index: 907,
                expectedPhone: '+821033334444',
                rawPhone: '010-3333-4444',
                status: 'cancelled',
            },
        ] as const) {
            const database = await createDatabaseBeforePhoneMigration();
            try {
                const userId = uuid(USER_NAMESPACE, scenario.index);
                const preflightId = uuid(PREFLIGHT_NAMESPACE, scenario.index);
                await database.query(
                    `INSERT INTO public.users (id, email, provider, phone_number)
                     VALUES ($1, $2, 'kakao', $3)`,
                    [userId, `existing-order-${scenario.index}@example.com`, scenario.rawPhone]
                );
                await database.query(
                    `INSERT INTO public.analysis_preflights (
                        id, user_id, target_instagram_id, status, exclusion_decision,
                        access_mode, plan_cards_snapshot, pricing_version, pricing_snapshot,
                        target_followers_count, target_following_count, required_plan_id, expires_at
                    ) VALUES (
                        $1, $2, $3, 'ready', 'skip', 'production', $4,
                        $5, $6, 300, 100, 'basic',
                        pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
                    )`,
                    [
                        preflightId,
                        userId,
                        `existing_target_${scenario.index}`,
                        planCards('basic'),
                        EARLYBIRD_PRICING_VERSION,
                        pricingSnapshot,
                    ]
                );
                await asServiceOn(
                    database,
                    `SELECT * FROM public.create_earlybird_checkout(
                        $1, $2, 'basic', $3, 14900, $4, $5, $6,
                        pg_catalog.clock_timestamp()
                    )`,
                    [
                        userId,
                        preflightId,
                        BASIC_PRODUCT_ID,
                        EARLYBIRD_PRICING_VERSION,
                        EARLYBIRD_DISCLOSURE_VERSION,
                        EARLYBIRD_DISCLOSURE_TEXT,
                    ]
                );
                if (scenario.status === 'cancelled') {
                    await asServiceOn(
                        database,
                        `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
                        [(await database.query<{ id: string }>(
                            `SELECT id FROM public.earlybird_orders WHERE user_id = $1`,
                            [userId]
                        )).rows[0].id]
                    );
                }

                await applyPhoneMigrations(database);
                const order = (await database.query<{
                    expected_buyer_phone_number_normalized: string | null;
                    status: string;
                }>(
                    `SELECT expected_buyer_phone_number_normalized, status
                     FROM public.earlybird_orders`
                )).rows[0];
                expect(order).toEqual({
                    expected_buyer_phone_number_normalized: scenario.expectedPhone,
                    status: scenario.status,
                });
            } finally {
                await database.close();
            }
        }
    }, 30_000);

    it('closes the legacy checkout gap before backfill and finalizer activation', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.exec(phoneDdlMigration);

            const createTransitionCheckout = async (
                index: number,
                phone: string,
                normalizedPhoneValue: string | null = null,
                functionName:
                    | 'create_earlybird_checkout'
                    | 'create_earlybird_checkout_legacy_test' = 'create_earlybird_checkout'
            ): Promise<CheckoutRow> => {
                const userId = uuid(USER_NAMESPACE, index);
                const preflightId = uuid(PREFLIGHT_NAMESPACE, index);
                await database.query(
                    `INSERT INTO public.users (
                        id, email, provider, phone_number, phone_number_normalized
                     ) VALUES ($1, $2, 'kakao', $3, $4)`,
                    [
                        userId,
                        `transition-${index}@example.com`,
                        phone,
                        normalizedPhoneValue,
                    ]
                );
                await database.query(
                    `INSERT INTO public.analysis_preflights (
                        id, user_id, target_instagram_id, status, exclusion_decision,
                        access_mode, plan_cards_snapshot, pricing_version, pricing_snapshot,
                        target_followers_count, target_following_count, required_plan_id, expires_at
                    ) VALUES (
                        $1, $2, $3, 'ready', 'skip', 'production', $4,
                        $5, $6, 300, 100, 'basic',
                        pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
                    )`,
                    [
                        preflightId,
                        userId,
                        `transition_target_${index}`,
                        planCards('basic'),
                        EARLYBIRD_PRICING_VERSION,
                        pricingSnapshot,
                    ]
                );
                return (await asServiceOn<CheckoutRow>(
                    database,
                    `SELECT * FROM public.${functionName}(
                        $1, $2, 'basic', $3, 14900, $4, $5, $6,
                        pg_catalog.clock_timestamp()
                    )`,
                    [
                        userId,
                        preflightId,
                        BASIC_PRODUCT_ID,
                        EARLYBIRD_PRICING_VERSION,
                        EARLYBIRD_DISCLOSURE_VERSION,
                        EARLYBIRD_DISCLOSURE_TEXT,
                    ]
                )).rows[0];
            };

            expect((await database.query<{
                anon_can_execute: boolean;
                authenticated_can_execute: boolean;
                service_can_execute: boolean;
            }>(
                `SELECT
                    pg_catalog.has_function_privilege(
                        'anon',
                        'public.set_earlybird_order_phone_snapshot()',
                        'EXECUTE'
                    ) AS anon_can_execute,
                    pg_catalog.has_function_privilege(
                        'authenticated',
                        'public.set_earlybird_order_phone_snapshot()',
                        'EXECUTE'
                    ) AS authenticated_can_execute,
                    pg_catalog.has_function_privilege(
                        'service_role',
                        'public.set_earlybird_order_phone_snapshot()',
                        'EXECUTE'
                    ) AS service_can_execute`
            )).rows[0]).toEqual({
                anon_can_execute: false,
                authenticated_can_execute: false,
                service_can_execute: false,
            });

            const legacyCheckout = await createTransitionCheckout(908, '010-5555-6666');
            expect((await database.query<{
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [legacyCheckout.order_id]
            )).rows[0].expected_buyer_phone_number_normalized).toBe('+821055556666');

            await database.exec(`
                ALTER FUNCTION public.create_earlybird_checkout(
                    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT,
                    TIMESTAMP WITH TIME ZONE
                ) RENAME TO create_earlybird_checkout_legacy_test
            `);

            await database.exec(phoneCheckoutMigration);
            const transitionCheckout = await createTransitionCheckout(909, '010-7777-8888');
            expect((await database.query<{
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [transitionCheckout.order_id]
            )).rows[0].expected_buyer_phone_number_normalized).toBe('+821077778888');
            const normalizedFallbackCheckout = await createTransitionCheckout(
                910,
                '02-123-4567',
                '+821099991111'
            );

            await database.exec(phoneBackfillMigration);
            const straddlingLegacyCheckout = await createTransitionCheckout(
                911,
                '010-2222-3333',
                null,
                'create_earlybird_checkout_legacy_test'
            );
            expect((await database.query<{
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [straddlingLegacyCheckout.order_id]
            )).rows[0].expected_buyer_phone_number_normalized).toBe('+821022223333');
            const straddlingFallbackCheckout = await createTransitionCheckout(
                912,
                '02-123-4567',
                '+821088887777',
                'create_earlybird_checkout_legacy_test'
            );
            expect((await database.query<{
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [straddlingFallbackCheckout.order_id]
            )).rows[0].expected_buyer_phone_number_normalized).toBe('+821088887777');

            await database.query(
                `UPDATE public.users
                 SET phone_number = '010-9999-0000',
                     phone_number_normalized = '+821099990000'
                 WHERE id = $1`,
                [uuid(USER_NAMESPACE, 911)]
            );
            await database.query(
                `UPDATE public.earlybird_orders
                 SET updated_at = pg_catalog.clock_timestamp()
                 WHERE id = $1`,
                [straddlingLegacyCheckout.order_id]
            );
            expect((await database.query<{
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [straddlingLegacyCheckout.order_id]
            )).rows[0].expected_buyer_phone_number_normalized).toBe('+821022223333');

            await database.exec(phoneValidationMigration);
            await database.exec(phoneFinalizationMigration);

            expect((await database.query<{
                id: string;
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT id, expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id IN ($1, $2, $3)`,
                [
                    legacyCheckout.order_id,
                    transitionCheckout.order_id,
                    normalizedFallbackCheckout.order_id,
                ]
            )).rows).toEqual(expect.arrayContaining([
                {
                    id: legacyCheckout.order_id,
                    expected_buyer_phone_number_normalized: '+821055556666',
                },
                {
                    id: transitionCheckout.order_id,
                    expected_buyer_phone_number_normalized: '+821077778888',
                },
                {
                    id: normalizedFallbackCheckout.order_id,
                    expected_buyer_phone_number_normalized: '+821099991111',
                },
            ]));
            expect((await database.query<{
                phone_number_normalized: string | null;
            }>(
                `SELECT phone_number_normalized
                 FROM public.users
                 WHERE id = $1`,
                [uuid(USER_NAMESPACE, 910)]
            )).rows[0].phone_number_normalized).toBe('+821099991111');

            const finalized = (await asServiceOn<FinalizeRow>(
                database,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'straddling-event', 'straddling-idem', 'payment.completed',
                    '2026-07-18T21:00:00+09:00', 'straddling-payment',
                    'different-straddling-buyer@example.com', '+821022223333',
                    '010-2222-3333', 'Straddling Buyer', $1, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [BASIC_PRODUCT_ID]
            )).rows[0];
            expect(finalized).toMatchObject({
                disposition: 'accepted',
                order_id: straddlingLegacyCheckout.order_id,
                status: 'paid',
            });
        } finally {
            await database.close();
        }
    }, 30_000);
});

describe('Groble phone checkout and finalizer behavior', () => {
    beforeAll(async () => {
        db = await createDatabaseBeforePhoneMigration();
        await applyPhoneMigrations(db);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.earlybird_webhook_events,
                public.earlybird_waitlist,
                public.earlybird_orders,
                public.analysis_preflights,
                public.pipeline_jobs,
                public.analysis_requests,
                public.users CASCADE;
            UPDATE public.earlybird_plan_inventory SET sold_count = 0;
        `);
    });

    afterAll(async () => {
        await db?.close();
    });

    it('prefers a valid raw Kakao phone and verifies it on idempotent replay', async () => {
        const seed = await seedPreflight(1);
        const created = await createCheckout(seed);
        const replay = await createCheckout(seed);
        expect(created.created).toBe(true);
        expect(replay).toEqual({ order_id: created.order_id, created: false });
        expect((await db.query<{
            expected_buyer_phone_number_normalized: string | null;
        }>(
            `SELECT expected_buyer_phone_number_normalized
             FROM public.earlybird_orders WHERE id = $1`,
            [created.order_id]
        )).rows[0].expected_buyer_phone_number_normalized).toBe(seed.phone);

        await db.query(
            `UPDATE public.users SET phone_number_normalized = $1 WHERE id = $2`,
            [normalizedPhone(101), seed.userId]
        );
        expect(await createCheckout(seed)).toEqual({
            order_id: created.order_id,
            created: false,
        });
        await db.query(
            `UPDATE public.users SET phone_number = $1 WHERE id = $2`,
            [rawPhone(101), seed.userId]
        );
        await expect(createCheckout(seed)).rejects.toThrow(/EARLYBIRD_ORDER_CONFLICT/);
    });

    it('rejects Kakao without a phone but allows a legacy Google null snapshot', async () => {
        const kakao = await seedPreflight(2, 'basic', { phone: null, rawPhone: null });
        await expect(createCheckout(kakao)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);

        const google = await seedPreflight(3, 'basic', {
            provider: 'google',
            phone: null,
            rawPhone: null,
        });
        const order = await createCheckout(google);
        expect(order.created).toBe(true);
        expect((await db.query<{
            expected_buyer_phone_number_normalized: string | null;
        }>(
            `SELECT expected_buyer_phone_number_normalized
             FROM public.earlybird_orders WHERE id = $1`,
            [order.order_id]
        )).rows[0].expected_buyer_phone_number_normalized).toBeNull();

        const normalizedFallback = await seedPreflight(103, 'basic', {
            phone: normalizedPhone(103),
            rawPhone: '02-123-4567',
        });
        const fallbackOrder = await createCheckout(normalizedFallback);
        expect((await db.query<{
            expected_buyer_phone_number_normalized: string | null;
        }>(
            `SELECT expected_buyer_phone_number_normalized
             FROM public.earlybird_orders WHERE id = $1`,
            [fallbackOrder.order_id]
        )).rows[0].expected_buyer_phone_number_normalized).toBe(normalizedFallback.phone);
    });

    it('accepts a unique phone match even when the buyer email differs', async () => {
        const seed = await seedPreflight(4);
        const checkout = await createCheckout(seed);
        const result = await finalize(seed, 'basic', 4, {
            buyerEmail: 'different-groble-email@example.com',
        });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
            status: 'paid',
            plan_sequence: 1,
        });
        expect((await db.query<{ seconds: number }>(
            `SELECT EXTRACT(EPOCH FROM (due_at - paid_at))::INTEGER AS seconds
             FROM public.earlybird_orders WHERE id = $1`,
            [checkout.order_id]
        )).rows[0].seconds).toBe(172_800);
    });

    it('falls back to email when normalized phone is absent or invalid upstream', async () => {
        const google = await seedPreflight(5, 'basic', {
            provider: 'google',
            phone: null,
            rawPhone: null,
        });
        const checkout = await createCheckout(google);
        const result = await finalize(google, 'basic', 5, {
            normalizedPhone: null,
            rawPhone: 'not-a-mobile-number',
        });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
            status: 'paid',
        });
    });

    it('falls back to email when a valid phone has no pending candidate', async () => {
        const seed = await seedPreflight(105);
        const checkout = await createCheckout(seed);
        const result = await finalize(seed, 'basic', 105, {
            normalizedPhone: normalizedPhone(905),
            rawPhone: '010-0000-0905',
        });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
            status: 'paid',
        });
    });

    it('stores bounded buyer evidence on accepted orders and unmatched events', async () => {
        const acceptedSeed = await seedPreflight(6);
        const acceptedOrder = await createCheckout(acceptedSeed);
        await finalize(acceptedSeed, 'basic', 6, {
            buyerEmail: 'groble-accepted@example.com',
            rawPhone: '010-0000-0006',
            displayName: 'Accepted Buyer',
        });
        const orderEvidence = (await db.query<{
            groble_buyer_email: string | null;
            groble_buyer_phone_number: string | null;
            groble_buyer_display_name: string | null;
        }>(
            `SELECT groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
             FROM public.earlybird_orders WHERE id = $1`,
            [acceptedOrder.order_id]
        )).rows[0];
        expect(orderEvidence).toEqual({
            groble_buyer_email: 'groble-accepted@example.com',
            groble_buyer_phone_number: '010-0000-0006',
            groble_buyer_display_name: 'Accepted Buyer',
        });
        expect((await db.query<{
            groble_buyer_email: string | null;
            groble_buyer_phone_number: string | null;
            groble_buyer_display_name: string | null;
        }>(
            `SELECT groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
             FROM public.earlybird_webhook_events
             WHERE event_id = 'phone_event_6'`
        )).rows[0]).toEqual(orderEvidence);

        const unmatchedSeed = await seedPreflight(7);
        await createCheckout(unmatchedSeed);
        const unmatched = await finalize(unmatchedSeed, 'basic', 7, {
            buyerEmail: 'unknown@example.com',
            normalizedPhone: normalizedPhone(707),
            rawPhone: '+82 10 0000 0707',
            displayName: 'Unknown Buyer',
        });
        expect(unmatched.disposition).toBe('unmatched');
        const eventEvidence = (await db.query<{
            groble_buyer_email: string | null;
            groble_buyer_phone_number: string | null;
            groble_buyer_display_name: string | null;
        }>(
            `SELECT groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
             FROM public.earlybird_webhook_events
             WHERE event_id = 'phone_event_7'`
        )).rows[0];
        expect(eventEvidence).toEqual({
            groble_buyer_email: 'unknown@example.com',
            groble_buyer_phone_number: '+82 10 0000 0707',
            groble_buyer_display_name: 'Unknown Buyer',
        });
    });

    it('does not consume inventory for zero phone and email candidates', async () => {
        const seed = await seedPreflight(8);
        await createCheckout(seed);
        const result = await finalize(seed, 'basic', 8, {
            buyerEmail: 'no-match@example.com',
            normalizedPhone: normalizedPhone(808),
        });
        expect(result).toMatchObject({ disposition: 'unmatched', order_id: null });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it('does not fall back to email or inventory for multiple phone candidates', async () => {
        const first = await seedPreflight(9);
        const second = await seedPreflight(10);
        await createCheckout(first);
        await createCheckout(second);
        await db.query(
            `UPDATE public.earlybird_orders
             SET expected_buyer_phone_number_normalized = $1
             WHERE user_id = $2`,
            [first.phone, second.userId]
        );

        const result = await finalize(first, 'basic', 9, { buyerEmail: first.email });
        expect(result).toMatchObject({ disposition: 'ambiguous_buyer', order_id: null });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders
             WHERE status = 'payment_pending'`
        )).rows[0].count).toBe(2);
    });

    it('never uses display name as a matching identity', async () => {
        const seed = await seedPreflight(11);
        await createCheckout(seed);
        const result = await finalize(seed, 'basic', 11, {
            buyerEmail: 'unmatched-name@example.com',
            normalizedPhone: null,
            rawPhone: null,
            displayName: seed.email,
        });
        expect(result).toMatchObject({ disposition: 'unmatched', order_id: null });
    });

    it('keeps the checkout snapshot authoritative after the user phone changes', async () => {
        const seed = await seedPreflight(12);
        const checkout = await createCheckout(seed);
        const changedPhone = normalizedPhone(112);
        await db.query(
            `UPDATE public.users SET phone_number_normalized = $1 WHERE id = $2`,
            [changedPhone, seed.userId]
        );

        const result = await finalize(seed, 'basic', 12, {
            buyerEmail: 'different-after-change@example.com',
            normalizedPhone: seed.phone,
        });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
            status: 'paid',
        });
        expect((await db.query<{
            expected_buyer_phone_number_normalized: string;
        }>(
            `SELECT expected_buyer_phone_number_normalized
             FROM public.earlybird_orders WHERE id = $1`,
            [checkout.order_id]
        )).rows[0].expected_buyer_phone_number_normalized).toBe(seed.phone);
    });

    it('preserves amount mismatch without consuming inventory', async () => {
        const seed = await seedPreflight(13);
        const checkout = await createCheckout(seed);
        const result = await finalize(seed, 'basic', 13, { amount: 14_901 });
        expect(result).toMatchObject({
            disposition: 'mismatch',
            order_id: checkout.order_id,
            status: 'payment_failed',
        });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it('preserves duplicate event and duplicate payment idempotency with original evidence', async () => {
        const seed = await seedPreflight(14);
        const checkout = await createCheckout(seed);
        const first = await finalize(seed, 'basic', 14, { displayName: 'Original Buyer' });
        const replay = await finalize(seed, 'basic', 14, {
            paymentId: 'different-replay-payment',
            buyerEmail: 'different-replay@example.com',
            normalizedPhone: normalizedPhone(914),
            productId: 'different_replay_product',
            displayName: 'Replay Buyer',
        });
        const duplicatePayment = await finalize(seed, 'basic', 114, {
            paymentId: 'phone_payment_14',
            buyerEmail: 'different-duplicate@example.com',
            normalizedPhone: normalizedPhone(814),
            productId: 'different_duplicate_product',
            amount: 1,
            displayName: 'Duplicate Payment Buyer',
        });

        expect(first).toMatchObject({ disposition: 'accepted', order_id: checkout.order_id });
        expect(replay).toMatchObject({ disposition: 'duplicate_event', order_id: checkout.order_id });
        expect(duplicatePayment).toMatchObject({
            disposition: 'duplicate_payment',
            order_id: checkout.order_id,
        });
        const events = (await db.query<{
            disposition: string;
            groble_buyer_display_name: string | null;
        }>(
            `SELECT disposition, groble_buyer_display_name
             FROM public.earlybird_webhook_events ORDER BY processed_at, event_id`
        )).rows;
        expect(events).toEqual([
            { disposition: 'accepted', groble_buyer_display_name: 'Original Buyer' },
            {
                disposition: 'duplicate_payment',
                groble_buyer_display_name: 'Duplicate Payment Buyer',
            },
        ]);
    });

    it('preserves cancellation-before-payment without selling inventory', async () => {
        const seed = await seedPreflight(15);
        const checkout = await createCheckout(seed);
        await requestCancellation('phone_payment_15', 'basic', 15);
        const result = await finalize(seed, 'basic', 15);
        expect(result).toMatchObject({
            disposition: 'cancel_before_payment',
            order_id: checkout.order_id,
            status: 'refund_pending',
        });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it('preserves late cancelled payments and leaves the replacement pending', async () => {
        const seed = await seedPreflight(16);
        const oldCheckout = await createCheckout(seed);
        const replacementPreflightId = await seedNewPreflight(116, seed.userId, 'standard');
        const replacement = await createCheckout({
            userId: seed.userId,
            preflightId: replacementPreflightId,
        }, 'standard');

        const result = await finalize(seed, 'basic', 16);
        expect(result).toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: oldCheckout.order_id,
            status: 'refund_pending',
        });
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.earlybird_orders WHERE id = $1`,
            [replacement.order_id]
        )).rows[0].status).toBe('payment_pending');
    });

    it('matches an unresolved cancelled snapshot by phone when buyer email differs', async () => {
        const seed = await seedPreflight(106);
        const checkout = await createCheckout(seed);
        await asService(
            `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
            [checkout.order_id]
        );

        const result = await finalize(seed, 'basic', 106, {
            buyerEmail: 'different-late-buyer@example.com',
        });
        expect(result).toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: checkout.order_id,
            status: 'refund_pending',
        });
        const expectedEvidence = {
            groble_buyer_email: 'different-late-buyer@example.com',
            groble_buyer_phone_number: seed.rawPhone,
            groble_buyer_display_name: 'Buyer 106',
        };
        expect((await db.query(
            `SELECT groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
             FROM public.earlybird_orders
             WHERE id = $1`,
            [checkout.order_id]
        )).rows[0]).toEqual(expectedEvidence);
        expect((await db.query(
            `SELECT groble_buyer_email, groble_buyer_phone_number,
                groble_buyer_display_name
             FROM public.earlybird_webhook_events
             WHERE event_id = 'phone_event_106'`
        )).rows[0]).toEqual(expectedEvidence);
    });

    it('rejects multiple unresolved cancelled phone snapshots as ambiguous', async () => {
        const firstSeed = await seedPreflight(109);
        const secondSeed = await seedPreflight(110);
        const firstCheckout = await createCheckout(firstSeed);
        const secondCheckout = await createCheckout(secondSeed);

        await asService(
            `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
            [firstCheckout.order_id]
        );
        await asService(
            `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
            [secondCheckout.order_id]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET expected_buyer_phone_number_normalized = $1
             WHERE id = $2`,
            [firstSeed.phone, secondCheckout.order_id]
        );

        const result = await finalize(firstSeed, 'basic', 109, {
            buyerEmail: 'ambiguous-late-buyer@example.com',
        });
        expect(result).toMatchObject({
            disposition: 'ambiguous_buyer',
            order_id: null,
            status: null,
        });
        expect((await db.query<{ status: string }>(
            `SELECT status
             FROM public.earlybird_orders
             WHERE id IN ($1, $2)
             ORDER BY id`,
            [firstCheckout.order_id, secondCheckout.order_id]
        )).rows.map(order => order.status)).toEqual(['cancelled', 'cancelled']);
    });

    it('accepts both canonical and rolling-deploy named finalizer calls', async () => {
        const canonicalSeed = await seedPreflight(107);
        const canonicalOrder = await createCheckout(canonicalSeed);
        const canonical = await asService<FinalizeRow>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                p_event_id => 'canonical-named-event',
                p_idempotency_key => 'canonical-named-idem',
                p_event_type => 'payment.completed',
                p_occurred_at => '2026-07-18T21:00:00+09:00',
                p_payment_id => 'canonical-named-payment',
                p_buyer_email => $1,
                p_buyer_phone_normalized => $2,
                p_buyer_phone_raw => $3,
                p_buyer_display_name => 'Canonical Buyer',
                p_product_id => $4,
                p_amount_krw => 14900,
                p_paid_at => '2026-07-18T21:00:00+09:00'
            )`,
            [canonicalSeed.email, canonicalSeed.phone, canonicalSeed.rawPhone, BASIC_PRODUCT_ID]
        );
        expect(canonical.rows[0]).toMatchObject({
            disposition: 'accepted',
            order_id: canonicalOrder.order_id,
        });

        const compatibilitySeed = await seedPreflight(108);
        const compatibilityOrder = await createCheckout(compatibilitySeed);
        const compatibility = await asService<FinalizeRow>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                p_event_id => 'compatibility-named-event',
                p_idempotency_key => 'compatibility-named-idem',
                p_event_type => 'payment.completed',
                p_occurred_at => '2026-07-18T21:00:00+09:00',
                p_payment_id => 'compatibility-named-payment',
                p_buyer_email => $1,
                p_product_id => $2,
                p_amount_krw => 14900,
                p_paid_at => '2026-07-18T21:00:00+09:00'
            )`,
            [compatibilitySeed.email, BASIC_PRODUCT_ID]
        );
        expect(compatibility.rows[0]).toMatchObject({
            disposition: 'accepted',
            order_id: compatibilityOrder.order_id,
        });
    });

    it('preserves overflow isolation and stores selected-order evidence', async () => {
        const seed = await seedPreflight(17);
        const checkout = await createCheckout(seed);
        await db.query(
            `UPDATE public.earlybird_plan_inventory SET sold_count = 10 WHERE plan_id = 'basic'`
        );
        const result = await finalize(seed, 'basic', 17, { displayName: 'Overflow Buyer' });
        expect(result).toMatchObject({
            disposition: 'overflow_refund_required',
            order_id: checkout.order_id,
            status: 'overflow_refund_required',
            plan_sequence: null,
        });
        expect((await db.query<{
            sold_count: number;
        }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(10);
        expect((await db.query<{
            groble_buyer_display_name: string | null;
        }>(
            `SELECT groble_buyer_display_name FROM public.earlybird_orders WHERE id = $1`,
            [checkout.order_id]
        )).rows[0].groble_buyer_display_name).toBe('Overflow Buyer');
    });

    it('keeps both replaced RPCs executable only by service_role', async () => {
        const seed = await seedPreflight(18);
        const checkout = await createCheckout(seed);
        const signatures = (await db.query<{
            old_signature: string | null;
            new_signature: string | null;
        }>(
            `SELECT
                pg_catalog.to_regprocedure(
                    'public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,integer,timestamp with time zone)'
                )::TEXT AS old_signature,
                pg_catalog.to_regprocedure(
                    'public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'
                )::TEXT AS new_signature`
        )).rows[0];
        expect(signatures.old_signature).not.toBeNull();
        expect(signatures.new_signature).not.toBeNull();

        await db.query(
            `SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, FALSE)`,
            [seed.userId]
        );
        await db.exec('SET ROLE authenticated');
        try {
            expect((await db.query<{ user_id: string }>(
                `SELECT user_id FROM public.earlybird_orders`
            )).rows).toEqual([{ user_id: seed.userId }]);
            await expect(db.query(
                `SELECT expected_buyer_phone_number_normalized,
                    groble_buyer_email, groble_buyer_phone_number,
                    groble_buyer_display_name
                 FROM public.earlybird_orders`
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT * FROM public.create_earlybird_checkout(
                    $1, $2, 'basic', $3, 14900, $4, $5, $6,
                    pg_catalog.clock_timestamp()
                )`,
                [
                    seed.userId,
                    seed.preflightId,
                    BASIC_PRODUCT_ID,
                    EARLYBIRD_PRICING_VERSION,
                    EARLYBIRD_DISCLOSURE_VERSION,
                    EARLYBIRD_DISCLOSURE_TEXT,
                ]
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
                [checkout.order_id]
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'unauthorized-event', 'unauthorized-idem', 'payment.completed',
                    pg_catalog.clock_timestamp(), 'unauthorized-payment', $1, $2, $3,
                    'Unauthorized Buyer', $4, 14900, pg_catalog.clock_timestamp()
                )`,
                [seed.email, seed.phone, seed.rawPhone, BASIC_PRODUCT_ID]
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'unauthorized-compat-event', 'unauthorized-compat-idem',
                    'payment.completed', pg_catalog.clock_timestamp(),
                    'unauthorized-compat-payment', $1, $2, 14900,
                    pg_catalog.clock_timestamp()
                )`,
                [seed.email, BASIC_PRODUCT_ID]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
