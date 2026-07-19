import { readFileSync, readdirSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    '20260719131000_add_groble_phone_matching.sql',
    '20260719131100_activate_groble_phone_checkout.sql',
    '20260719131200_backfill_groble_phone_matching.sql',
    '20260719131300_validate_groble_phone_matching.sql',
    '20260719131400_activate_groble_phone_finalization.sql',
    '20260719131500_stop_persisting_groble_buyer_contacts.sql',
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
    contactRetentionMigration,
] = phoneMigrations;
// rollout 이후에 추가되는 복구 migration 이라 파일이 없을 때도 모듈 로드는 성공해야 한다.
// 그래야 누락이 suite crash 가 아니라 테스트 실패로 드러난다.
const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const normalizerGrantMigrationFile = readdirSync(migrationsDirectory)
    .filter(file => file.endsWith(
        '_restore_groble_phone_normalizer_service_role_execute.sql'
    ))
    .sort()
    .at(-1);
const normalizerGrantMigration = normalizerGrantMigrationFile
    ? readFileSync(
        new URL(normalizerGrantMigrationFile, migrationsDirectory),
        'utf8'
    )
    : '';

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

-- 운영 Supabase 는 public schema table 의 DML 을 service_role 에 부여하고,
-- 20260714020318 은 PUBLIC/anon/authenticated 에서만 회수했다. 시드를 superuser 로
-- 넣으면 invoker 권한으로 평가되는 CHECK 제약을 한 번도 밟지 않으므로 이 grant 를
-- 재현해 두고, 사용자 시드는 service_role 로 쓴다.
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

// 현행 production migration 집합 = 6개 rollout + normalizer EXECUTE 복구.
async function applyPhoneMigrations(database: PGlite): Promise<void> {
    for (const migration of [...phoneMigrations, normalizerGrantMigration]) {
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
        verified?: boolean;
    } = {}
): Promise<Seed> {
    const provider = options.provider ?? 'kakao';
    const phone = options.phone === undefined
        ? (provider === 'kakao' ? normalizedPhone(index) : null)
        : options.phone;
    const unnormalized = options.rawPhone === undefined
        ? (phone ? rawPhone(index) : null)
        : options.rawPhone;
    const verified = options.verified !== false
        && provider === 'kakao'
        && phone !== null
        && unnormalized !== null;
    const seed = {
        index,
        userId: uuid(USER_NAMESPACE, index),
        preflightId: uuid(PREFLIGHT_NAMESPACE, index),
        email: options.email ?? `phone-buyer-${index}@example.com`,
        phone,
        rawPhone: unnormalized,
    };
    // 운영과 같은 service-role 경로로 쓴다. superuser 로 넣으면 users 의
    // invoker-context CHECK 제약 회귀를 이 suite 가 다시 놓친다.
    await asService(
        `INSERT INTO public.users (
            id, email, provider, phone_number, phone_number_normalized,
            phone_number_verification_source, phone_number_verified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            seed.userId,
            seed.email,
            provider,
            seed.rawPhone,
            verified ? seed.phone : null,
            verified ? 'kakao_rest_api' : null,
            verified ? '2026-07-18T20:00:00+09:00' : null,
        ]
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

async function finalizeRolling(overrides: {
    eventId: string;
    idempotencyKey: string;
    paymentId: string;
    buyerEmail: string;
    productId?: string;
    amount?: number;
}): Promise<FinalizeRow> {
    const result = await asService<FinalizeRow>(
        `SELECT * FROM public.finalize_earlybird_groble_payment(
            $1, $2, 'payment.completed', '2026-07-18T21:00:00+09:00',
            $3, $4, $5, $6, '2026-07-18T21:00:00+09:00'
        )`,
        [
            overrides.eventId,
            overrides.idempotencyKey,
            overrides.paymentId,
            overrides.buyerEmail,
            overrides.productId ?? BASIC_PRODUCT_ID,
            overrides.amount ?? 14_900,
        ]
    );
    return result.rows[0];
}

async function forceLegacyOrder(orderId: string): Promise<void> {
    await db.exec(
        'ALTER TABLE public.earlybird_orders DISABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
    );
    try {
        await db.query(
            `UPDATE public.earlybird_orders
             SET buyer_match_policy = 'legacy_email',
                 expected_buyer_phone_number_normalized = NULL,
                 expected_buyer_phone_verification_source = NULL,
                 expected_buyer_phone_verified_at = NULL
             WHERE id = $1`,
            [orderId]
        );
    } finally {
        await db.exec(
            'ALTER TABLE public.earlybird_orders ENABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
    }
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
    it('purges historical buyer contacts and nulls contact writes from old instances', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            for (const migration of phoneMigrations.slice(0, -1)) {
                await database.exec(migration);
            }
            const userId = uuid(USER_NAMESPACE, 920);
            const preflightId = uuid(PREFLIGHT_NAMESPACE, 920);
            await database.query(
                `INSERT INTO public.users (
                    id, email, provider, phone_number, phone_number_normalized,
                    phone_number_verification_source, phone_number_verified_at
                ) VALUES (
                    $1, 'purge@example.com', 'kakao', '010-0000-0920',
                    '+821000000920', 'kakao_rest_api',
                    '2026-07-18T20:00:00+09:00'
                )`,
                [userId]
            );
            await database.query(
                `INSERT INTO public.analysis_preflights (
                    id, user_id, target_instagram_id, status, exclusion_decision,
                    access_mode, plan_cards_snapshot, pricing_version,
                    pricing_snapshot, target_followers_count, target_following_count,
                    required_plan_id, expires_at
                ) VALUES (
                    $1, $2, 'purge_target', 'ready', 'skip', 'production', $3,
                    $4, $5, 100, 100, 'basic',
                    pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
                )`,
                [
                    preflightId,
                    userId,
                    planCards('basic'),
                    EARLYBIRD_PRICING_VERSION,
                    pricingSnapshot,
                ]
            );
            const checkout = (await asServiceOn<CheckoutRow>(
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
            )).rows[0];
            await database.query(
                `UPDATE public.earlybird_orders
                 SET groble_buyer_email = 'historical@example.com',
                     groble_buyer_phone_number = '010-1111-2222',
                     groble_buyer_display_name = 'Historical Buyer'
                 WHERE id = $1`,
                [checkout.order_id]
            );
            await database.query(
                `INSERT INTO public.earlybird_webhook_events (
                    event_id, idempotency_key, event_type, occurred_at,
                    payment_id, product_id, amount_krw, disposition,
                    groble_buyer_email, groble_buyer_phone_number,
                    groble_buyer_display_name
                ) VALUES (
                    'historical-event', 'historical-idem', 'payment.completed',
                    pg_catalog.clock_timestamp(), 'historical-payment', $1,
                    14900, 'unmatched', 'historical@example.com',
                    '010-1111-2222', 'Historical Buyer'
                )`,
                [BASIC_PRODUCT_ID]
            );

            await database.exec(contactRetentionMigration);

            for (const table of ['earlybird_orders', 'earlybird_webhook_events']) {
                const rows = (await database.query<{
                    groble_buyer_email: string | null;
                    groble_buyer_phone_number: string | null;
                    groble_buyer_display_name: string | null;
                }>(`
                    UPDATE public.${table}
                    SET groble_buyer_email = 'old-writer@example.com',
                        groble_buyer_phone_number = '010-3333-4444',
                        groble_buyer_display_name = 'Old Writer'
                    RETURNING groble_buyer_email, groble_buyer_phone_number,
                        groble_buyer_display_name
                `)).rows;
                expect(rows.length).toBeGreaterThan(0);
                expect(rows).toEqual(rows.map(() => ({
                    groble_buyer_email: null,
                    groble_buyer_phone_number: null,
                    groble_buyer_display_name: null,
                })));
            }
        } finally {
            await database.close();
        }
    }, 30_000);

    it('does not promote legacy raw phones and preserves newly verified rollout values', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number) VALUES
                    ($1, 'domestic@example.com', 'kakao', '010-1234-5678'),
                    ($2, 'international@example.com', 'kakao', '+82 10 8765 4321'),
                    ($3, 'invalid@example.com', 'google', '02-123-4567'),
                    ($4, 'forged@example.com', 'kakao', 'not-a-phone')`,
                [
                    uuid(USER_NAMESPACE, 901),
                    uuid(USER_NAMESPACE, 902),
                    uuid(USER_NAMESPACE, 903),
                    uuid(USER_NAMESPACE, 906),
                ]
            );
            await database.exec(phoneDdlMigration);
            await database.query(
                `UPDATE public.users
                 SET phone_number_normalized = '+821087654321',
                     phone_number_verification_source = 'kakao_rest_api',
                     phone_number_verified_at = '2026-07-18T20:00:00+09:00'
                 WHERE email = 'international@example.com'`
            );
            await expect(database.query(
                `UPDATE public.users
                 SET phone_number_normalized = '+821011112222',
                     phone_number_verification_source = 'kakao_rest_api',
                     phone_number_verified_at = '2026-07-18T20:00:00+09:00'
                 WHERE email = 'forged@example.com'`
            )).rejects.toThrow(/users_phone_number_provenance_check/);
            for (const migration of phoneMigrations.slice(1)) {
                await database.exec(migration);
            }

            const rows = (await database.query<{
                email: string;
                phone_number_normalized: string | null;
                phone_number_verification_source: string | null;
            }>(
                `SELECT email, phone_number_normalized, phone_number_verification_source
                 FROM public.users ORDER BY email`
            )).rows;
            expect(rows).toEqual([
                {
                    email: 'domestic@example.com',
                    phone_number_normalized: null,
                    phone_number_verification_source: null,
                },
                {
                    email: 'forged@example.com',
                    phone_number_normalized: null,
                    phone_number_verification_source: null,
                },
                {
                    email: 'international@example.com',
                    phone_number_normalized: '+821087654321',
                    phone_number_verification_source: 'kakao_rest_api',
                },
                {
                    email: 'invalid@example.com',
                    phone_number_normalized: null,
                    phone_number_verification_source: null,
                },
            ]);
            await database.query(
                `UPDATE public.users
                 SET phone_number_normalized = '+821012345678'
                 WHERE email = 'domestic@example.com'`
            );
            expect((await database.query<{
                phone_number_normalized: string | null;
                phone_number_verification_source: string | null;
                phone_number_verified_at: string | null;
            }>(
                `SELECT phone_number_normalized,
                    phone_number_verification_source,
                    phone_number_verified_at
                 FROM public.users WHERE email = 'domestic@example.com'`
            )).rows[0]).toEqual({
                phone_number_normalized: null,
                phone_number_verification_source: null,
                phone_number_verified_at: null,
            });
        } finally {
            await database.close();
        }
    }, 30_000);

    it('clears source-null partial provenance during the Phase 3 backfill', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            const userId = uuid(USER_NAMESPACE, 921);
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number)
                 VALUES ($1, 'partial-backfill@example.com', 'kakao', '010-0000-0921')`,
                [userId]
            );
            await database.exec(phoneDdlMigration);
            await database.exec(
                `ALTER TABLE public.users
                 DROP CONSTRAINT users_phone_number_provenance_check`
            );
            await database.query(
                `UPDATE public.users
                 SET phone_number_normalized = '+821000000921',
                     phone_number_verification_source = NULL,
                     phone_number_verified_at = pg_catalog.clock_timestamp()
                 WHERE id = $1`,
                [userId]
            );
            await database.exec(
                `ALTER TABLE public.users
                 ADD CONSTRAINT users_phone_number_provenance_check CHECK (
                     (
                         phone_number_normalized IS NULL
                         AND phone_number_verification_source IS NULL
                         AND phone_number_verified_at IS NULL
                     )
                     OR (
                         provider = 'kakao'
                         AND phone_number IS NOT NULL
                         AND phone_number_normalized IS NOT NULL
                         AND phone_number_verification_source
                             IS NOT DISTINCT FROM 'kakao_rest_api'
                         AND phone_number_verified_at IS NOT NULL
                         AND public.normalize_kr_mobile_e164(phone_number)
                             IS NOT DISTINCT FROM phone_number_normalized
                     )
                 ) NOT VALID`
            );

            await database.exec(phoneCheckoutMigration);
            await database.exec(phoneBackfillMigration);

            expect((await database.query<{
                phone_number_normalized: string | null;
                phone_number_verification_source: string | null;
                phone_number_verified_at: string | null;
            }>(
                `SELECT phone_number_normalized,
                    phone_number_verification_source,
                    phone_number_verified_at
                 FROM public.users WHERE id = $1`,
                [userId]
            )).rows[0]).toEqual({
                phone_number_normalized: null,
                phone_number_verification_source: null,
                phone_number_verified_at: null,
            });
        } finally {
            await database.close();
        }
    }, 30_000);

    it('aborts rather than choosing between duplicate verified Kakao phones', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number) VALUES
                    ($1, 'duplicate-one@example.com', 'kakao', '010-1234-5678'),
                    ($2, 'duplicate-two@example.com', 'kakao', '+82 10 1234 5678')`,
                [uuid(USER_NAMESPACE, 904), uuid(USER_NAMESPACE, 905)]
            );
            await database.exec(phoneDdlMigration);
            await database.query(
                `UPDATE public.users
                 SET phone_number_normalized = '+821012345678',
                     phone_number_verification_source = 'kakao_rest_api',
                     phone_number_verified_at = '2026-07-18T20:00:00+09:00'
                 WHERE email IN ('duplicate-one@example.com', 'duplicate-two@example.com')`
            );
            await database.exec(phoneCheckoutMigration);
            await expect(database.exec(phoneBackfillMigration)).rejects.toThrow(
                /DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW/
            );
            expect((await database.query<{
                phone_number_normalized: string | null;
            }>(
                `SELECT phone_number_normalized
                 FROM public.users
                 ORDER BY email`
            )).rows).toEqual([
                { phone_number_normalized: '+821012345678' },
                { phone_number_normalized: '+821012345678' },
            ]);
        } finally {
            await database.close();
        }
    }, 30_000);

    it('classifies only pre-migration pending and cancelled orders as legacy email', async () => {
        for (const scenario of [
            {
                index: 906,
                rawPhone: '010-1111-2222',
                status: 'payment_pending',
                verified: true,
            },
            {
                index: 907,
                rawPhone: '010-3333-4444',
                status: 'cancelled',
                verified: false,
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

                await database.exec(phoneDdlMigration);
                if (scenario.verified) {
                    await database.query(
                        `UPDATE public.users
                         SET phone_number_normalized = public.normalize_kr_mobile_e164(phone_number),
                             phone_number_verification_source = 'kakao_rest_api',
                             phone_number_verified_at = '2026-07-18T20:00:00+09:00'
                         WHERE id = $1`,
                        [userId]
                    );
                }
                for (const migration of phoneMigrations.slice(1)) {
                    await database.exec(migration);
                }
                const order = (await database.query<{
                    buyer_match_policy: string;
                    expected_buyer_phone_number_normalized: string | null;
                    expected_buyer_phone_verification_source: string | null;
                    expected_buyer_phone_verified_at: string | null;
                    status: string;
                }>(
                    `SELECT buyer_match_policy,
                        expected_buyer_phone_number_normalized,
                        expected_buyer_phone_verification_source,
                        expected_buyer_phone_verified_at,
                        status
                     FROM public.earlybird_orders`
                )).rows[0];
                expect(order).toEqual({
                    buyer_match_policy: 'legacy_email',
                    expected_buyer_phone_number_normalized: null,
                    expected_buyer_phone_verification_source: null,
                    expected_buyer_phone_verified_at: null,
                    status: scenario.status,
                });
            } finally {
                await database.close();
            }
        }
    }, 30_000);

    it('keeps rollout snapshots fail closed until Kakao REST provenance exists', async () => {
        const database = await createDatabaseBeforePhoneMigration();
        try {
            await database.exec(phoneDdlMigration);

            const createTransitionCheckout = async (
                index: number,
                phone: string,
                normalizedPhoneValue: string | null = null,
                functionName:
                    | 'create_earlybird_checkout'
                    | 'create_earlybird_checkout_legacy_test' = 'create_earlybird_checkout',
                verified = false,
                provider: Provider = 'kakao'
            ): Promise<CheckoutRow> => {
                const userId = uuid(USER_NAMESPACE, index);
                const preflightId = uuid(PREFLIGHT_NAMESPACE, index);
                await database.query(
                    `INSERT INTO public.users (
                        id, email, provider, phone_number, phone_number_normalized,
                        phone_number_verification_source, phone_number_verified_at
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        userId,
                        `transition-${index}@example.com`,
                        provider,
                        phone,
                        verified ? normalizedPhoneValue : null,
                        verified ? 'kakao_rest_api' : null,
                        verified ? '2026-07-18T20:00:00+09:00' : null,
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

            expect((await database.query<{
                internal_exists: boolean;
                service_can_execute_internal: boolean;
                service_can_execute_bridge: boolean;
            }>(
                `SELECT
                    pg_catalog.to_regprocedure(
                        'public.create_earlybird_checkout_before_product_fence(uuid,uuid,text,text,integer,text,text,text,timestamp with time zone)'
                    ) IS NOT NULL AS internal_exists,
                    pg_catalog.has_function_privilege(
                        'service_role',
                        'public.create_earlybird_checkout_before_product_fence(uuid,uuid,text,text,integer,text,text,text,timestamp with time zone)',
                        'EXECUTE'
                    ) AS service_can_execute_internal,
                    pg_catalog.has_function_privilege(
                        'service_role',
                        'public.create_earlybird_checkout(uuid,uuid,text,text,integer,text,text,text,timestamp with time zone)',
                        'EXECUTE'
                    ) AS service_can_execute_bridge`
            )).rows[0]).toEqual({
                internal_exists: true,
                service_can_execute_internal: false,
                service_can_execute_bridge: true,
            });

            await expect(createTransitionCheckout(
                908,
                '010-5555-6666'
            )).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
            expect((await database.query<{ count: number }>(
                `SELECT pg_catalog.count(*)::INTEGER AS count
                 FROM public.earlybird_orders`
            )).rows[0].count).toBe(0);

            const verifiedLegacyCheckout = await createTransitionCheckout(
                909,
                '010-7777-8888',
                '+821077778888',
                'create_earlybird_checkout',
                true
            );
            expect((await database.query<{
                buyer_match_policy: string;
                expected_buyer_phone_number_normalized: string | null;
                expected_buyer_phone_verification_source: string | null;
                expected_buyer_phone_verified_at: string | null;
            }>(
                `SELECT buyer_match_policy,
                    expected_buyer_phone_number_normalized,
                    expected_buyer_phone_verification_source,
                    expected_buyer_phone_verified_at
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [verifiedLegacyCheckout.order_id]
            )).rows[0]).toMatchObject({
                buyer_match_policy: 'verified_kakao_phone',
                expected_buyer_phone_number_normalized: '+821077778888',
                expected_buyer_phone_verification_source: 'kakao_rest_api',
            });
            expect((await database.query<{ verified: boolean }>(
                `SELECT expected_buyer_phone_verified_at IS NOT NULL AS verified
                 FROM public.earlybird_orders WHERE id = $1`,
                [verifiedLegacyCheckout.order_id]
            )).rows[0].verified).toBe(true);

            await database.exec(`
                ALTER FUNCTION public.create_earlybird_checkout(
                    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT,
                    TIMESTAMP WITH TIME ZONE
                ) RENAME TO create_earlybird_checkout_legacy_test
            `);

            await database.exec(phoneCheckoutMigration);
            await expect(createTransitionCheckout(
                910,
                '010-9999-1111'
            )).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
            await expect(createTransitionCheckout(
                912,
                '',
                null,
                'create_earlybird_checkout',
                false,
                'google'
            )).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
            const verifiedTransitionCheckout = await createTransitionCheckout(
                911,
                '010-2222-3333',
                '+821022223333',
                'create_earlybird_checkout',
                true
            );

            await database.exec(phoneBackfillMigration);
            await expect(createTransitionCheckout(
                914,
                '010-4444-5555',
                null,
                'create_earlybird_checkout_legacy_test'
            )).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);

            await database.exec(phoneValidationMigration);
            await database.exec(phoneFinalizationMigration);
            await database.exec(contactRetentionMigration);

            expect((await database.query<{
                id: string;
                expected_buyer_phone_number_normalized: string | null;
            }>(
                `SELECT id, expected_buyer_phone_number_normalized
                 FROM public.earlybird_orders
                 WHERE id IN ($1, $2)`,
                [
                    verifiedLegacyCheckout.order_id,
                    verifiedTransitionCheckout.order_id,
                ]
            )).rows).toEqual(expect.arrayContaining([
                {
                    id: verifiedLegacyCheckout.order_id,
                    expected_buyer_phone_number_normalized: '+821077778888',
                },
                {
                    id: verifiedTransitionCheckout.order_id,
                    expected_buyer_phone_number_normalized: '+821022223333',
                },
            ]));
            expect((await database.query<{
                phone_number_normalized: string | null;
            }>(
                `SELECT phone_number_normalized
                 FROM public.users
                 WHERE id = $1`,
                [uuid(USER_NAMESPACE, 910)]
            )).rows[0].phone_number_normalized).toBeNull();

            const unverifiedFinalized = (await asServiceOn<FinalizeRow>(
                database,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'straddling-event', 'straddling-idem', 'payment.completed',
                    '2026-07-18T21:00:00+09:00', 'straddling-payment',
                    'different-straddling-buyer@example.com', '+821055556666',
                    '010-5555-6666', 'Straddling Buyer', $1, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [BASIC_PRODUCT_ID]
            )).rows[0];
            expect(unverifiedFinalized).toMatchObject({
                disposition: 'unmatched',
                order_id: null,
            });

            const verifiedFinalized = (await asServiceOn<FinalizeRow>(
                database,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'verified-event', 'verified-idem', 'payment.completed',
                    '2026-07-18T21:00:00+09:00', 'verified-payment',
                    'different-verified-buyer@example.com', '+821077778888',
                    '010-7777-8888', 'Verified Buyer', $1, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [BASIC_PRODUCT_ID]
            )).rows[0];
            expect(verifiedFinalized).toMatchObject({
                disposition: 'accepted',
                order_id: verifiedLegacyCheckout.order_id,
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

    afterEach(async () => {
        const persistedContacts = (await db.query<{
            source: string;
            groble_buyer_email: string | null;
            groble_buyer_phone_number: string | null;
            groble_buyer_display_name: string | null;
        }>(`
            SELECT 'order' AS source, groble_buyer_email,
                groble_buyer_phone_number, groble_buyer_display_name
            FROM public.earlybird_orders
            UNION ALL
            SELECT 'event' AS source, groble_buyer_email,
                groble_buyer_phone_number, groble_buyer_display_name
            FROM public.earlybird_webhook_events
        `)).rows;
        for (const row of persistedContacts) {
            expect(row).toEqual({
                source: row.source,
                groble_buyer_email: null,
                groble_buyer_phone_number: null,
                groble_buyer_display_name: null,
            });
        }
    });

    it('snapshots verified Kakao provenance and enforces atomic user phone changes', async () => {
        const seed = await seedPreflight(1);
        const created = await createCheckout(seed);
        const replay = await createCheckout(seed);
        expect(created.created).toBe(true);
        expect(replay).toEqual({ order_id: created.order_id, created: false });
        expect((await db.query<{
            buyer_match_policy: string;
            expected_buyer_phone_number_normalized: string | null;
            expected_buyer_phone_verification_source: string | null;
            verified: boolean;
        }>(
            `SELECT buyer_match_policy,
                expected_buyer_phone_number_normalized,
                expected_buyer_phone_verification_source,
                expected_buyer_phone_verified_at IS NOT NULL AS verified
             FROM public.earlybird_orders WHERE id = $1`,
            [created.order_id]
        )).rows[0]).toEqual({
            buyer_match_policy: 'verified_kakao_phone',
            expected_buyer_phone_number_normalized: seed.phone,
            expected_buyer_phone_verification_source: 'kakao_rest_api',
            verified: true,
        });

        await db.query(
            `UPDATE public.users
             SET phone_number_verified_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [seed.userId]
        );
        expect(await createCheckout(seed)).toEqual({
            order_id: created.order_id,
            created: false,
        });

        await db.query(
            `UPDATE public.users SET phone_number_normalized = $1 WHERE id = $2`,
            [normalizedPhone(101), seed.userId]
        );
        expect((await db.query<{
            phone_number_normalized: string | null;
            phone_number_verification_source: string | null;
            phone_number_verified_at: string | null;
        }>(
            `SELECT phone_number_normalized,
                phone_number_verification_source,
                phone_number_verified_at
             FROM public.users WHERE id = $1`,
            [seed.userId]
        )).rows[0]).toEqual({
            phone_number_normalized: null,
            phone_number_verification_source: null,
            phone_number_verified_at: null,
        });
        await db.query(
            `UPDATE public.users
             SET phone_number = $1,
                 phone_number_normalized = $2,
                 phone_number_verification_source = 'kakao_rest_api',
                 phone_number_verified_at = '2026-07-18T21:00:00+09:00'
             WHERE id = $3`,
            [rawPhone(101), normalizedPhone(101), seed.userId]
        );
        await expect(createCheckout(seed)).rejects.toThrow(/EARLYBIRD_ORDER_CONFLICT/);
    });

    it('rejects missing, unverified, and Google checkout identities', async () => {
        const kakao = await seedPreflight(2, 'basic', { phone: null, rawPhone: null });
        await expect(createCheckout(kakao)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);

        const unverified = await seedPreflight(102, 'basic', {
            phone: null,
            rawPhone: '010-0000-0102',
            verified: false,
        });
        await expect(createCheckout(unverified)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);

        const google = await seedPreflight(3, 'basic', {
            provider: 'google',
            phone: null,
            rawPhone: null,
        });
        await expect(createCheckout(google)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
    });

    it('rejects forged provenance when the raw phone cannot normalize', async () => {
        await expect(db.query(
            `INSERT INTO public.users (
                id, email, provider, phone_number, phone_number_normalized,
                phone_number_verification_source, phone_number_verified_at
            ) VALUES (
                $1, 'forged-runtime@example.com', 'kakao', 'not-a-phone',
                '+821011112222', 'kakao_rest_api', pg_catalog.clock_timestamp()
            )`,
            [uuid(USER_NAMESPACE, 999)]
        )).rejects.toThrow(/users_phone_number_provenance_check/);
    });

    it('rejects source-null partial user provenance on insert', async () => {
        await expect(db.query(
            `INSERT INTO public.users (
                id, email, provider, phone_number, phone_number_normalized,
                phone_number_verification_source, phone_number_verified_at
            ) VALUES (
                $1, 'partial-runtime@example.com', 'kakao', '010-0000-0997',
                '+821000000997', NULL, pg_catalog.clock_timestamp()
            )`,
            [uuid(USER_NAMESPACE, 997)]
        )).rejects.toThrow(/users_phone_number_provenance_check/);
    });

    it('rejects source-null verified order snapshots on insert', async () => {
        const seed = await seedPreflight(215);
        await db.exec(
            'ALTER TABLE public.earlybird_orders DISABLE TRIGGER set_earlybird_order_phone_snapshot_before_insert'
        );
        try {
            await expect(db.query(
                `INSERT INTO public.earlybird_orders (
                    user_id, preflight_id, target_instagram_id,
                    target_followers_count, target_following_count,
                    exclusion_decision, excluded_instagram_id, plan_id,
                    pricing_version, expected_amount_krw,
                    expected_groble_product_id, disclosure_version,
                    disclosure_text, disclosure_accepted_at,
                    buyer_match_policy,
                    expected_buyer_phone_number_normalized,
                    expected_buyer_phone_verification_source,
                    expected_buyer_phone_verified_at
                ) VALUES (
                    $1, $2, 'partial_order', 300, 100, 'skip', NULL,
                    'basic', $3, 14900, $4, $5, $6,
                    pg_catalog.clock_timestamp(), 'verified_kakao_phone',
                    $7, NULL, pg_catalog.clock_timestamp()
                )`,
                [
                    seed.userId,
                    seed.preflightId,
                    EARLYBIRD_PRICING_VERSION,
                    BASIC_PRODUCT_ID,
                    EARLYBIRD_DISCLOSURE_VERSION,
                    EARLYBIRD_DISCLOSURE_TEXT,
                    seed.phone,
                ]
            )).rejects.toThrow(/earlybird_orders_buyer_match_snapshot_check/);
        } finally {
            await db.exec(
                'ALTER TABLE public.earlybird_orders ENABLE TRIGGER set_earlybird_order_phone_snapshot_before_insert'
            );
        }
    });

    it('degrades provenance when an old writer changes only the raw phone', async () => {
        const seed = await seedPreflight(202);

        await db.query(
            `UPDATE public.users SET phone_number = $1 WHERE id = $2`,
            [rawPhone(302), seed.userId]
        );

        expect((await db.query<{
            phone_number_normalized: string | null;
            phone_number_verification_source: string | null;
            phone_number_verified_at: string | null;
        }>(
            `SELECT phone_number_normalized, phone_number_verification_source,
                phone_number_verified_at
             FROM public.users WHERE id = $1`,
            [seed.userId]
        )).rows[0]).toEqual({
            phone_number_normalized: null,
            phone_number_verification_source: null,
            phone_number_verified_at: null,
        });
        await expect(createCheckout(seed)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
    });

    it('does not refresh phone verification during unrelated profile updates', async () => {
        const seed = await seedPreflight(204);
        await db.exec(
            'ALTER TABLE public.users DISABLE TRIGGER enforce_user_phone_verification_provenance_before_write'
        );
        try {
            await db.query(
                `UPDATE public.users
                 SET phone_number_verified_at = pg_catalog.clock_timestamp() - INTERVAL '25 hours'
                 WHERE id = $1`,
                [seed.userId]
            );
        } finally {
            await db.exec(
                'ALTER TABLE public.users ENABLE TRIGGER enforce_user_phone_verification_provenance_before_write'
            );
        }

        await db.query(
            `UPDATE public.users SET email = 'profile-repair@example.com' WHERE id = $1`,
            [seed.userId]
        );
        expect((await db.query<{ remained_stale: boolean }>(
            `SELECT phone_number_verified_at
                    < pg_catalog.clock_timestamp() - INTERVAL '24 hours'
                    AS remained_stale
             FROM public.users WHERE id = $1`,
            [seed.userId]
        )).rows[0].remained_stale).toBe(true);
    });

    it('rejects verified Kakao provenance older than 24 hours', async () => {
        const seed = await seedPreflight(203);
        await db.exec(
            'ALTER TABLE public.users DISABLE TRIGGER enforce_user_phone_verification_provenance_before_write'
        );
        try {
            await db.query(
                `UPDATE public.users
                 SET phone_number_verified_at = pg_catalog.clock_timestamp() - INTERVAL '25 hours'
                 WHERE id = $1`,
                [seed.userId]
            );
        } finally {
            await db.exec(
                'ALTER TABLE public.users ENABLE TRIGGER enforce_user_phone_verification_provenance_before_write'
            );
        }

        await expect(createCheckout(seed)).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
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

    it('keeps email fallback available for unresolved legacy-email orders', async () => {
        const legacy = await seedPreflight(5);
        const checkout = await createCheckout(legacy);
        await db.exec(
            'ALTER TABLE public.earlybird_orders DISABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
        try {
            await db.query(
                `UPDATE public.earlybird_orders
                 SET buyer_match_policy = 'legacy_email',
                     expected_buyer_phone_number_normalized = NULL,
                     expected_buyer_phone_verification_source = NULL,
                     expected_buyer_phone_verified_at = NULL
                 WHERE id = $1`,
                [checkout.order_id]
            );
        } finally {
            await db.exec(
                'ALTER TABLE public.earlybird_orders ENABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
            );
        }
        const result = await finalize(legacy, 'basic', 5, {
            normalizedPhone: null,
            rawPhone: 'not-a-mobile-number',
        });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
            status: 'paid',
        });
    });

    it('never falls back to email for a verified-phone order with a mismatched phone', async () => {
        const seed = await seedPreflight(105);
        await createCheckout(seed);
        const result = await finalize(seed, 'basic', 105, {
            normalizedPhone: normalizedPhone(905),
            rawPhone: '010-0000-0905',
        });
        expect(result).toMatchObject({
            disposition: 'unmatched',
            order_id: null,
            status: null,
        });
    });

    it('never falls back to email for a verified-phone order when phone evidence is absent', async () => {
        const seed = await seedPreflight(205);
        await createCheckout(seed);

        const result = await finalize(seed, 'basic', 205, {
            normalizedPhone: null,
            rawPhone: null,
        });

        expect(result).toMatchObject({
            disposition: 'unmatched',
            order_id: null,
            status: null,
        });
    });

    it('keeps buyer contacts transient for accepted orders and unmatched events', async () => {
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
            groble_buyer_email: null,
            groble_buyer_phone_number: null,
            groble_buyer_display_name: null,
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
            groble_buyer_email: null,
            groble_buyer_phone_number: null,
            groble_buyer_display_name: null,
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

    it('prevents a second order snapshot from being changed into a phone candidate', async () => {
        const first = await seedPreflight(9);
        const second = await seedPreflight(10);
        const firstCheckout = await createCheckout(first);
        await createCheckout(second);
        await expect(db.query(
            `UPDATE public.earlybird_orders
             SET expected_buyer_phone_number_normalized = $1
             WHERE user_id = $2`,
            [first.phone, second.userId]
        )).rejects.toThrow(/EARLYBIRD_BUYER_MATCH_SNAPSHOT_IMMUTABLE/);

        const result = await finalize(first, 'basic', 9, { buyerEmail: first.email });
        expect(result).toMatchObject({
            disposition: 'accepted',
            order_id: firstCheckout.order_id,
        });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(1);
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders
             WHERE status = 'payment_pending'`
        )).rows[0].count).toBe(1);
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
            `UPDATE public.users
             SET phone_number = $1,
                 phone_number_normalized = $2,
                 phone_number_verified_at = '2026-07-18T22:00:00+09:00'
             WHERE id = $3`,
            [rawPhone(112), changedPhone, seed.userId]
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

    it('preserves duplicate event and duplicate payment idempotency without contacts', async () => {
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
            { disposition: 'accepted', groble_buyer_display_name: null },
            {
                disposition: 'duplicate_payment',
                groble_buyer_display_name: null,
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
            groble_buyer_email: null,
            groble_buyer_phone_number: null,
            groble_buyer_display_name: null,
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

    it('keeps multiple unresolved cancelled phone snapshots ambiguous', async () => {
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
        await db.exec(
            'ALTER TABLE public.earlybird_orders DISABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
        try {
            await db.query(
                `UPDATE public.earlybird_orders
                 SET expected_buyer_phone_number_normalized = $1
                 WHERE id = $2`,
                [firstSeed.phone, secondCheckout.order_id]
            );
        } finally {
            await db.exec(
                'ALTER TABLE public.earlybird_orders ENABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
            );
        }

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

    it('keeps multiple same-user cancelled legacy orders ambiguous', async () => {
        const seed = await seedPreflight(213);
        const firstCheckout = await createCheckout(seed);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'payment_failed',
                 updated_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [firstCheckout.order_id]
        );
        const secondPreflightId = await seedNewPreflight(313, seed.userId, 'basic');
        const secondCheckout = await createCheckout({
            userId: seed.userId,
            preflightId: secondPreflightId,
        });
        await asService(
            `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
            [secondCheckout.order_id]
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'cancelled',
                 updated_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE id = $1`,
            [firstCheckout.order_id]
        );
        await forceLegacyOrder(firstCheckout.order_id);
        await forceLegacyOrder(secondCheckout.order_id);

        const result = await finalize(seed, 'basic', 213, {
            normalizedPhone: null,
            rawPhone: null,
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
        await db.exec(
            'ALTER TABLE public.earlybird_orders DISABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
        try {
            await db.query(
                `UPDATE public.earlybird_orders
                 SET buyer_match_policy = 'legacy_email',
                     expected_buyer_phone_number_normalized = NULL,
                     expected_buyer_phone_verification_source = NULL,
                     expected_buyer_phone_verified_at = NULL
                 WHERE id = $1`,
                [compatibilityOrder.order_id]
            );
        } finally {
            await db.exec(
                'ALTER TABLE public.earlybird_orders ENABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
            );
        }
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

    it('rolls back a legacy wrapper call for verified-phone orders so canonical retry can win', async () => {
        const seed = await seedPreflight(111);
        const checkout = await createCheckout(seed);

        await expect(asService<FinalizeRow>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'mixed-rollout-event', 'mixed-rollout-idem', 'payment.completed',
                '2026-07-18T21:00:00+09:00', 'mixed-rollout-payment',
                $1, $2, 14900, '2026-07-18T21:00:00+09:00'
            )`,
            [seed.email, BASIC_PRODUCT_ID]
        )).rejects.toThrow(/GROBLE_CANONICAL_PHONE_REQUIRED/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'mixed-rollout-event'
                OR idempotency_key = 'mixed-rollout-idem'`
        )).rows[0].count).toBe(0);

        const canonical = await asService<FinalizeRow>(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'mixed-rollout-event', 'mixed-rollout-idem', 'payment.completed',
                '2026-07-18T21:00:00+09:00', 'mixed-rollout-payment',
                $1, $2, $3, 'Mixed Rollout Buyer', $4, 14900,
                '2026-07-18T21:00:00+09:00'
            )`,
            [seed.email, seed.phone, seed.rawPhone, BASIC_PRODUCT_ID]
        );
        expect(canonical.rows[0]).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
        });
    });

    it('blocks rolling email attribution when any same-product verified order is unresolved', async () => {
        const verified = await seedPreflight(211, 'basic', {
            email: 'verified-login@example.com',
        });
        const legacy = await seedPreflight(212, 'basic', {
            email: 'groble-collision@example.com',
        });
        const verifiedCheckout = await createCheckout(verified);
        const legacyCheckout = await createCheckout(legacy);
        await forceLegacyOrder(legacyCheckout.order_id);

        await expect(finalizeRolling({
            eventId: 'product-wide-gate-event',
            idempotencyKey: 'product-wide-gate-idem',
            paymentId: 'product-wide-gate-payment',
            buyerEmail: legacy.email,
        })).rejects.toThrow(/GROBLE_CANONICAL_PHONE_REQUIRED/);

        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.earlybird_webhook_events
             WHERE event_id = 'product-wide-gate-event'
                OR idempotency_key = 'product-wide-gate-idem'`
        )).rows[0].count).toBe(0);
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.earlybird_orders
             WHERE id IN ($1, $2) ORDER BY id`,
            [verifiedCheckout.order_id, legacyCheckout.order_id]
        )).rows.map(order => order.status)).toEqual([
            'payment_pending',
            'payment_pending',
        ]);
    });

    it('validates rolling input before payment, product, or user attribution locks', async () => {
        const verified = await seedPreflight(217, 'basic', {
            email: 'rolling-invalid-verified@example.com',
        });
        await createCheckout(verified);

        await expect(asService(
            `SELECT * FROM public.finalize_earlybird_groble_payment(
                'rolling-invalid-event', 'rolling-invalid-idem',
                'payment.failed', '2026-07-18T21:00:00+09:00',
                'rolling-invalid-payment', $1, $2, 14900,
                '2026-07-18T21:00:00+09:00'
            )`,
            [verified.email, BASIC_PRODUCT_ID]
        )).rejects.toThrow(/GROBLE_PAYMENT_EVIDENCE_INVALID/);
    });

    it.each(['canonical', 'rolling'] as const)(
        'rejects a NULL event type before known duplicate attribution in the %s overload',
        async (signature) => {
            const legacy = await seedPreflight(218);
            const checkout = await createCheckout(legacy);
            await forceLegacyOrder(checkout.order_id);
            await finalizeRolling({
                eventId: 'null-type-known-event',
                idempotencyKey: 'null-type-known-idem',
                paymentId: 'null-type-known-payment',
                buyerEmail: legacy.email,
            });

            const invalidCall = signature === 'rolling'
                ? asService(
                    `SELECT * FROM public.finalize_earlybird_groble_payment(
                        'null-type-known-event', 'null-type-known-idem',
                        NULL::TEXT, '2026-07-18T21:00:00+09:00',
                        'null-type-known-payment', $1, $2, 14900,
                        '2026-07-18T21:00:00+09:00'
                    )`,
                    [legacy.email, BASIC_PRODUCT_ID]
                )
                : asService(
                    `SELECT * FROM public.finalize_earlybird_groble_payment(
                        'null-type-known-event', 'null-type-known-idem',
                        NULL::TEXT, '2026-07-18T21:00:00+09:00',
                        'null-type-known-payment', $1, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, $2, 14900,
                        '2026-07-18T21:00:00+09:00'
                    )`,
                    [legacy.email, BASIC_PRODUCT_ID]
                );

            await expect(invalidCall).rejects.toThrow(
                /GROBLE_PAYMENT_EVIDENCE_INVALID/
            );
        }
    );

    it('preserves rolling duplicate-event and duplicate-payment replay for accepted legacy orders', async () => {
        const legacy = await seedPreflight(214);
        const checkout = await createCheckout(legacy);
        await forceLegacyOrder(checkout.order_id);
        const first = await finalizeRolling({
            eventId: 'rolling-legacy-event',
            idempotencyKey: 'rolling-legacy-idem',
            paymentId: 'rolling-legacy-payment',
            buyerEmail: legacy.email,
        });
        const verified = await seedPreflight(216, 'basic', {
            email: 'rolling-replay-verified@example.com',
        });
        const verifiedCheckout = await createCheckout(verified);

        const duplicateEvent = await finalizeRolling({
            eventId: 'rolling-legacy-event',
            idempotencyKey: 'rolling-legacy-idem',
            paymentId: 'rolling-legacy-replay-payment',
            buyerEmail: legacy.email,
        });
        const duplicatePayment = await finalizeRolling({
            eventId: 'rolling-legacy-duplicate-payment-event',
            idempotencyKey: 'rolling-legacy-duplicate-payment-idem',
            paymentId: 'rolling-legacy-payment',
            buyerEmail: legacy.email,
        });

        expect(first).toMatchObject({
            disposition: 'accepted',
            order_id: checkout.order_id,
        });
        expect(duplicateEvent).toMatchObject({
            disposition: 'duplicate_event',
            order_id: checkout.order_id,
        });
        expect(duplicatePayment).toMatchObject({
            disposition: 'duplicate_payment',
            order_id: checkout.order_id,
        });
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.earlybird_orders WHERE id = $1`,
            [verifiedCheckout.order_id]
        )).rows[0].status).toBe('payment_pending');
    });

    it('preserves overflow isolation without storing selected-order contacts', async () => {
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
        )).rows[0].groble_buyer_display_name).toBeNull();
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
                `SELECT buyer_match_policy,
                    expected_buyer_phone_number_normalized,
                    expected_buyer_phone_verification_source,
                    expected_buyer_phone_verified_at,
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

// `users_phone_number_provenance_check` 는 normalize_kr_mobile_e164 를 호출하고,
// CHECK 제약은 SECURITY DEFINER 가 아니라 DML 을 실행한 role 로 평가된다.
// 기존 시드는 superuser 로 users 를 INSERT 해서 service-role 쓰기 경로를 밟은 적이 없고,
// 그래서 rollout 의 service_role REVOKE 가 운영에서야 42501 로 드러났다.
describe('Groble phone normalizer service-role execute', () => {
    const VERIFIED_RAW_PHONE = '010-1234-5678';
    const VERIFIED_NORMALIZED_PHONE = '+821012345678';

    interface ProvenanceRow {
        provider: string;
        phone_number_normalized: string | null;
        phone_number_verification_source: string | null;
        verified_at_is_fresh: boolean | null;
        normalized_matches_raw: boolean | null;
    }

    // 복구 migration 없이 6개 rollout 만 적용한, 장애 당시의 production 상태.
    async function createDatabaseWithRolloutOnly(): Promise<PGlite> {
        const database = await createDatabaseBeforePhoneMigration();
        for (const migration of phoneMigrations) {
            await database.exec(migration);
        }
        return database;
    }

    async function createDatabaseAfterPhoneRollout(): Promise<PGlite> {
        const database = await createDatabaseBeforePhoneMigration();
        await applyPhoneMigrations(database);
        return database;
    }

    // /auth/callback 의 supabaseAdmin.from('users').upsert(...) 와 같은 형태다.
    async function upsertVerifiedKakaoPhoneAsService(
        database: PGlite,
        index: number
    ): Promise<Results<unknown>> {
        return asServiceOn(
            database,
            `INSERT INTO public.users (
                id, email, provider, phone_number, phone_number_normalized,
                phone_number_verification_source, phone_number_verified_at
            ) VALUES (
                $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
                pg_catalog.clock_timestamp()
            )
            ON CONFLICT (id) DO UPDATE SET
                provider = EXCLUDED.provider,
                phone_number = EXCLUDED.phone_number,
                phone_number_normalized = EXCLUDED.phone_number_normalized,
                phone_number_verification_source
                    = EXCLUDED.phone_number_verification_source,
                phone_number_verified_at = EXCLUDED.phone_number_verified_at`,
            [
                uuid(USER_NAMESPACE, index),
                `normalizer-grant-${index}@example.com`,
                VERIFIED_RAW_PHONE,
                VERIFIED_NORMALIZED_PHONE,
            ]
        );
    }

    // Postgres 는 이 CHECK 의 OR 분기를 단축 평가하지 않는다. 그래서 전화번호 필드가
    // 전혀 없는 행까지, 즉 provider 와 무관한 모든 service-role users 쓰기가 막혔다.
    it.each([
        {
            name: 'a Kakao phone upsert',
            run: (database: PGlite) => upsertVerifiedKakaoPhoneAsService(database, 940),
        },
        {
            name: 'a Google signup carrying no phone fields',
            run: (database: PGlite) => asServiceOn(
                database,
                `INSERT INTO public.users (id, email, provider)
                 VALUES ($1, 'rollout-only-941@example.com', 'google')`,
                [uuid(USER_NAMESPACE, 941)]
            ),
        },
    ])('leaves $name denied when only the rollout is applied', async ({ run }) => {
        const database = await createDatabaseWithRolloutOnly();
        try {
            await expect(run(database)).rejects.toThrow(
                /permission denied for function normalize_kr_mobile_e164/
            );
        } finally {
            await database.close();
        }
    });

    it('lets the service-role auth callback persist a verified Kakao phone', async () => {
        const database = await createDatabaseAfterPhoneRollout();
        try {
            await expect(
                upsertVerifiedKakaoPhoneAsService(database, 941)
            ).resolves.toBeDefined();

            // 개인정보 원문 대신 provenance 상태만 확인한다.
            const provenance = (await database.query<ProvenanceRow>(
                `SELECT provider,
                        phone_number_normalized,
                        phone_number_verification_source,
                        phone_number_verified_at
                            >= pg_catalog.clock_timestamp() - INTERVAL '24 hours'
                            AS verified_at_is_fresh,
                        public.normalize_kr_mobile_e164(phone_number)
                            IS NOT DISTINCT FROM phone_number_normalized
                            AS normalized_matches_raw
                 FROM public.users
                 WHERE id = $1`,
                [uuid(USER_NAMESPACE, 941)]
            )).rows[0];

            expect(provenance).toMatchObject({
                provider: 'kakao',
                phone_number_normalized: VERIFIED_NORMALIZED_PHONE,
                phone_number_verification_source: 'kakao_rest_api',
                verified_at_is_fresh: true,
                normalized_matches_raw: true,
            });
        } finally {
            await database.close();
        }
    });

    // /api/user/me 의 사용자 행 생성·갱신도 같은 invoker-context 제약을 지나간다.
    it('lets the service role create and update rows that carry no phone at all', async () => {
        const database = await createDatabaseAfterPhoneRollout();
        try {
            const userId = uuid(USER_NAMESPACE, 943);

            await expect(asServiceOn(
                database,
                `INSERT INTO public.users (id, email, provider)
                 VALUES ($1, 'no-phone-943@example.com', 'google')`,
                [userId]
            )).resolves.toBeDefined();

            await expect(asServiceOn(
                database,
                `UPDATE public.users SET email = $2 WHERE id = $1`,
                [userId, 'no-phone-943-renamed@example.com']
            )).resolves.toBeDefined();

            const stored = (await database.query<{
                provider: string;
                phone_number_normalized: string | null;
            }>(
                `SELECT provider, phone_number_normalized
                 FROM public.users WHERE id = $1`,
                [userId]
            )).rows[0];

            expect(stored).toEqual({
                provider: 'google',
                phone_number_normalized: null,
            });
        } finally {
            await database.close();
        }
    });

    it('grants execute to service_role without reaching anon or authenticated', async () => {
        const database = await createDatabaseAfterPhoneRollout();
        try {
            const privileges = (await database.query<Record<string, boolean>>(
                `SELECT
                    pg_catalog.has_function_privilege(
                        'service_role',
                        'public.normalize_kr_mobile_e164(text)',
                        'EXECUTE'
                    ) AS service_role,
                    pg_catalog.has_function_privilege(
                        'anon',
                        'public.normalize_kr_mobile_e164(text)',
                        'EXECUTE'
                    ) AS anon,
                    pg_catalog.has_function_privilege(
                        'authenticated',
                        'public.normalize_kr_mobile_e164(text)',
                        'EXECUTE'
                    ) AS authenticated`
            )).rows[0];

            expect(privileges).toEqual({
                service_role: true,
                anon: false,
                authenticated: false,
            });
        } finally {
            await database.close();
        }
    });

    it('still refuses an unverified checkout after the grant', async () => {
        const database = await createDatabaseAfterPhoneRollout();
        try {
            const userId = uuid(USER_NAMESPACE, 942);
            const preflightId = uuid(PREFLIGHT_NAMESPACE, 942);
            // Kakao REST 검증 provenance 가 없는 사용자.
            await database.query(
                `INSERT INTO public.users (id, email, provider, phone_number)
                 VALUES ($1, $2, 'kakao', $3)`,
                [userId, 'normalizer-grant-942@example.com', VERIFIED_RAW_PHONE]
            );
            await database.query(
                `INSERT INTO public.analysis_preflights (
                    id, user_id, target_instagram_id, status, exclusion_decision,
                    access_mode, plan_cards_snapshot, pricing_version,
                    pricing_snapshot, target_followers_count, target_following_count,
                    required_plan_id, expires_at
                ) VALUES (
                    $1, $2, 'guard_target', 'ready', 'skip', 'production', $3,
                    $4, $5, 100, 100, 'basic',
                    pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
                )`,
                [
                    preflightId,
                    userId,
                    planCards('basic'),
                    EARLYBIRD_PRICING_VERSION,
                    pricingSnapshot,
                ]
            );

            await expect(asServiceOn(
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
            )).rejects.toThrow(/CHECKOUT_PHONE_REQUIRED/);
        } finally {
            await database.close();
        }
    });
});
