import { readFileSync } from 'node:fs';
import {
    Pool,
    type PoolClient,
    type QueryResult,
    type QueryResultRow,
} from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
} from '@/lib/domain/earlybird/catalog';

const LEGACY_PRICING_VERSION = 'earlybird-2026-07-v1';
const databaseUrl = process.env.EARLYBIRD_POSTGRES_TEST_URL;
const destructiveTestMarker = process.env.EARLYBIRD_POSTGRES_TEST_MARKER;
const describePostgres = databaseUrl ? describe : describe.skip;
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
].map(file => readFileSync(
    new URL(`../../../supabase/migrations/${file}`, import.meta.url),
    'utf8'
));
const scrubbedRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731040000_recover_scrubbed_earlybird_freshness_conflict.sql',
        import.meta.url
    ),
    'utf8'
);
const rehydratingAdmissionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730140000_rehydrate_earlybird_paid_preflight_snapshot.sql',
        import.meta.url
    ),
    'utf8'
);
const rebindIntroductionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730150000_rebind_expired_paid_earlybird_preflights.sql',
        import.meta.url
    ),
    'utf8'
);

function functionSql(source: string, marker: string): string {
    const start = source.indexOf(marker);
    const name = marker.slice(marker.indexOf('public.') + 7, marker.indexOf('('));
    if (start < 0) throw new Error(`missing ${name} replacement`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`unterminated ${name} replacement`);
    return source.slice(start, end + 4);
}

function replacementFunctionSql(name: string): string {
    return functionSql(
        scrubbedRecoveryMigration,
        `CREATE OR REPLACE FUNCTION public.${name}(`
    );
}

const createPreflightSql = replacementFunctionSql(
    'create_or_replay_analysis_v2_preflight'
);
const rebindPreflightSql = replacementFunctionSql(
    'rebind_expired_paid_earlybird_preflight'
);
const autoAdmitSql = replacementFunctionSql(
    'auto_admit_eligible_earlybird_fulfillments'
);
const productionAdmitCoreSql = functionSql(
    rehydratingAdmissionMigration,
    'CREATE OR REPLACE FUNCTION public.admit_earlybird_fulfillment('
);
const productionAdmitWrapperSql = functionSql(
    rebindIntroductionMigration,
    'CREATE FUNCTION public.admit_earlybird_fulfillment(p_order_id UUID)'
);

const bootstrap = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS extensions CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

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
    phone_number VARCHAR(50)
);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id)
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

const pricingSnapshot = {
    basic: { currency: 'KRW', status: 'quoted', amountKrw: 14_900 },
    standard: { currency: 'KRW', status: 'quoted', amountKrw: 19_900 },
    plus: { currency: 'KRW', status: 'deferred', amountKrw: null },
};

function uuid(prefix: '1' | '2', index: number): string {
    return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

export function isSafeEarlybirdPostgresTestTarget(
    connectionString: string | undefined,
    marker: string | undefined
): boolean {
    if (marker !== 'local-ephemeral-earlybird-only' || !connectionString) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/earlybird_concurrency_test';
    } catch {
        return false;
    }
}

describe('earlybird PostgreSQL destructive-test target guard', () => {
    it('accepts only the explicit loopback test database and marker', () => {
        expect(isSafeEarlybirdPostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/earlybird_concurrency_test',
            'local-ephemeral-earlybird-only'
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/earlybird_concurrency_test', 'local-ephemeral-earlybird-only'],
        ['postgresql://tester@127.0.0.1:55432/postgres', 'local-ephemeral-earlybird-only'],
        ['postgresql://tester@127.0.0.1:55432/earlybird_concurrency_test', undefined],
    ])('rejects an unsafe target or missing marker', (url, marker) => {
        expect(isSafeEarlybirdPostgresTestTarget(url, marker)).toBe(false);
    });
});

function planCards(planId: 'basic' | 'standard') {
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

async function asService<T>(
    pool: Pool,
    operation: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function waitForLockWait(pool: Pool, applicationName: string): Promise<boolean> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        const activity = await pool.query<{ wait_event_type: string | null }>(
            `SELECT wait_event_type
             FROM pg_catalog.pg_stat_activity
             WHERE application_name = $1
               AND state = 'active'`,
            [applicationName]
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') return true;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
}

interface NativeCheckoutSeed {
    userId: string;
    preflightId: string;
    email: string;
    rawPhone: string;
    phone: string;
}

async function seedNativeCheckout(
    pool: Pool,
    index: number,
    email: string
): Promise<NativeCheckoutSeed> {
    const userId = uuid('1', index);
    const preflightId = uuid('2', index);
    const suffix = String(index).padStart(4, '0');
    const rawPhone = `010-0000-${suffix}`;
    const phone = `+82100000${suffix}`;

    await pool.query(
        `INSERT INTO public.users (
            id, email, provider, phone_number, phone_number_normalized,
            phone_number_verification_source, phone_number_verified_at
        ) VALUES (
            $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
            pg_catalog.clock_timestamp()
        )`,
        [userId, email, rawPhone, phone]
    );
    await pool.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', NULL, 'production', $4,
            $5, $6, 300, 100, 'basic',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `native_lock_${index}`,
            planCards('basic'),
            LEGACY_PRICING_VERSION,
            pricingSnapshot,
        ]
    );

    return { userId, preflightId, email, rawPhone, phone };
}

async function seedNativePreflight(
    pool: Pool,
    userId: string,
    index: number
): Promise<string> {
    const preflightId = uuid('2', index);
    await pool.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, created_at, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'skip', NULL, 'production', $4,
            $5, $6, 300, 100, 'basic',
            pg_catalog.clock_timestamp() + INTERVAL '1 second',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `native_lock_${index}`,
            planCards('basic'),
            LEGACY_PRICING_VERSION,
            pricingSnapshot,
        ]
    );
    return preflightId;
}

async function createNativeCheckout(
    pool: Pool,
    seed: NativeCheckoutSeed,
    productId = 'basic_product-01'
): Promise<string> {
    const result = await asService(pool, client => client.query<{ order_id: string }>(
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, 'basic', $3, 14900, $4, $5, $6,
            pg_catalog.clock_timestamp()
        )`,
        [
            seed.userId,
            seed.preflightId,
            productId,
            LEGACY_PRICING_VERSION,
            EARLYBIRD_DISCLOSURE_VERSION,
            EARLYBIRD_DISCLOSURE_TEXT,
        ]
    ));
    return result.rows[0].order_id;
}

async function forceNativeLegacyOrder(pool: Pool, orderId: string): Promise<void> {
    await pool.query(
        'ALTER TABLE public.earlybird_orders DISABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
    );
    try {
        await pool.query(
            `UPDATE public.earlybird_orders
             SET buyer_match_policy = 'legacy_email',
                 expected_buyer_phone_number_normalized = NULL,
                 expected_buyer_phone_verification_source = NULL,
                 expected_buyer_phone_verified_at = NULL
             WHERE id = $1`,
            [orderId]
        );
    } finally {
        await pool.query(
            'ALTER TABLE public.earlybird_orders ENABLE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
    }
}

async function runServiceQuery<T extends QueryResultRow>(
    client: PoolClient,
    query: string,
    parameters: readonly unknown[] = []
): Promise<T> {
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE service_role');
        await client.query("SET LOCAL statement_timeout = '10s'");
        const result = await client.query<T>(query, [...parameters]);
        await client.query('COMMIT');
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

describePostgres('earlybird real PostgreSQL concurrency', () => {
    let pool: Pool;

    beforeAll(async () => {
        if (!isSafeEarlybirdPostgresTestTarget(databaseUrl, destructiveTestMarker)) {
            throw new Error(
                'Refusing destructive PostgreSQL test: use the loopback earlybird_concurrency_test database and explicit marker.'
            );
        }
        pool = new Pool({ connectionString: databaseUrl, max: 30 });
        const identity = await pool.query<{ database_name: string }>(
            'SELECT pg_catalog.current_database() AS database_name'
        );
        if (identity.rows[0]?.database_name !== 'earlybird_concurrency_test') {
            throw new Error('Refusing destructive PostgreSQL test against an unexpected database.');
        }
        await pool.query(bootstrap);
        await pool.query(presaleMigration);
        for (const migration of phoneMigrations) {
            await pool.query(migration);
        }
        await pool.query(`
            ALTER TABLE public.users
                ADD COLUMN analysis_count INTEGER NOT NULL DEFAULT 0,
                ADD COLUMN is_paid_user BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE public.analysis_preflights
                ALTER COLUMN plan_cards_snapshot DROP NOT NULL,
                ALTER COLUMN target_followers_count DROP NOT NULL,
                ALTER COLUMN target_following_count DROP NOT NULL,
                ALTER COLUMN required_plan_id DROP NOT NULL,
                ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT 'legacy-preflight',
                ADD COLUMN launch_status_snapshot JSONB,
                ADD COLUMN plan_catalog_snapshot JSONB,
                ADD COLUMN policy_versions_snapshot JSONB,
                ADD COLUMN target_is_private BOOLEAN,
                ADD COLUMN capacity_required_plan_id TEXT,
                ADD COLUMN admission_capacity_required_plan_id TEXT,
                ADD COLUMN admission_required_plan_id TEXT,
                ADD COLUMN admission_plan_cards_snapshot JSONB,
                ADD COLUMN consumed_request_id UUID,
                ADD COLUMN error_code TEXT,
                ADD COLUMN blocked_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN ready_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN lease_token UUID,
                ADD COLUMN lease_expires_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN target_full_name TEXT,
                ADD COLUMN target_bio TEXT,
                ADD COLUMN target_profile_image_url TEXT,
                ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE
                    NOT NULL DEFAULT pg_catalog.clock_timestamp();
            ALTER TABLE public.earlybird_orders
                ADD COLUMN seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE;
            CREATE TABLE public.earlybird_fulfillments(
                order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
                status TEXT NOT NULL,
                request_id UUID,
                operator_admitted_at TIMESTAMP WITH TIME ZONE,
                lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                next_attempt_at TIMESTAMP WITH TIME ZONE,
                last_error_code TEXT,
                last_error_at TIMESTAMP WITH TIME ZONE,
                manual_review_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp()
            );
            CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
        `);
        await pool.query(createPreflightSql);
        await pool.query(rebindPreflightSql);
        await pool.query(productionAdmitCoreSql);
        await pool.query(`
            ALTER FUNCTION public.admit_earlybird_fulfillment(UUID)
                RENAME TO admit_earlybird_fulfillment_core_20260730140000
        `);
        await pool.query(productionAdmitWrapperSql);
        await pool.query(autoAdmitSql);
    }, 30_000);

    beforeEach(async () => {
        await pool.query(`
            TRUNCATE public.earlybird_webhook_events,
                public.earlybird_waitlist,
                public.earlybird_orders,
                public.analysis_preflights,
                public.analysis_requests,
                public.users CASCADE;
            UPDATE public.earlybird_plan_inventory SET sold_count = 0;
        `);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it.each(['basic', 'standard'] as const)(
        'serializes eleven concurrent %s confirmations into ten sales and one refund case',
        async (planId) => {
            const productId = `${planId}_product-01`;
            const amount = planId === 'basic' ? 14_900 : 19_900;
            const seeds = Array.from({ length: 11 }, (_, offset) => {
                const index = (planId === 'basic' ? 100 : 200) + offset;
                return {
                    index,
                    userId: uuid('1', index),
                    preflightId: uuid('2', index),
                    email: `postgres-${planId}-${index}@example.com`,
                };
            });

            for (const seed of seeds) {
                await pool.query(
                    `INSERT INTO public.users (
                        id, email, provider, phone_number, phone_number_normalized,
                        phone_number_verification_source, phone_number_verified_at
                    ) VALUES (
                        $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
                        pg_catalog.clock_timestamp()
                    )`,
                    [
                        seed.userId,
                        seed.email,
                        `010-0000-${String(seed.index).padStart(4, '0')}`,
                        `+82100000${String(seed.index).padStart(4, '0')}`,
                    ]
                );
                await pool.query(
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
                        `target_${seed.index}`,
                        planCards(planId),
                        LEGACY_PRICING_VERSION,
                        pricingSnapshot,
                        planId === 'basic' ? 300 : 700,
                        planId,
                    ]
                );
                await asService(pool, client => client.query(
                    `SELECT * FROM public.create_earlybird_checkout(
                        $1, $2, $3, $4, $5, $6, $7, $8,
                        pg_catalog.clock_timestamp()
                    )`,
                    [
                        seed.userId,
                        seed.preflightId,
                        planId,
                        productId,
                        amount,
                        LEGACY_PRICING_VERSION,
                        EARLYBIRD_DISCLOSURE_VERSION,
                        EARLYBIRD_DISCLOSURE_TEXT,
                    ]
                ));
            }

            const results = await Promise.all(seeds.map(seed => asService(pool, async client => {
                const result = await client.query<{
                    status: string;
                    plan_sequence: number | null;
                }>(
                    `SELECT * FROM public.finalize_earlybird_groble_payment(
                        $1, $2, 'payment.completed', $3, $4, $5, $6, $7,
                        $8, $9, $10, $11
                    )`,
                    [
                        `event_${planId}_${seed.index}`,
                        `idem_${planId}_${seed.index}`,
                        '2026-07-17T21:00:00+09:00',
                        `payment_${planId}_${seed.index}`,
                        `groble-postgres-${planId}-${seed.index}@example.com`,
                        `+82100000${String(seed.index).padStart(4, '0')}`,
                        `010-0000-${String(seed.index).padStart(4, '0')}`,
                        `Postgres Buyer ${seed.index}`,
                        productId,
                        amount,
                        '2026-07-17T21:00:00+09:00',
                    ]
                );
                return result.rows[0];
            })));

            expect(results.filter(result => result.status === 'paid')).toHaveLength(10);
            expect(results.filter(result => result.status === 'overflow_refund_required'))
                .toHaveLength(1);
            expect(results.flatMap(result => result.plan_sequence ?? []).sort((a, b) => a - b))
                .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        }
    );

    it('serializes direct shared rebind against create/replay without a FK deadlock', async () => {
        const seed = await seedNativeCheckout(
            pool,
            300,
            'native-user-preflight-order@example.com'
        );
        const order = await pool.query<{ id: string }>(
            `INSERT INTO public.earlybird_orders(
                user_id, preflight_id, target_instagram_id,
                target_followers_count, target_following_count,
                exclusion_decision, plan_id, pricing_version,
                expected_amount_krw, expected_groble_product_id,
                disclosure_version, disclosure_text, disclosure_accepted_at
             ) VALUES (
                $1, $2, 'native_lock_300', 300, 100, 'skip', 'basic',
                $3, 14900, 'basic_product-01', 'earlybird-48h-v1',
                'lock-order-only', pg_catalog.clock_timestamp()
             )
             RETURNING id`,
            [seed.userId, seed.preflightId, LEGACY_PRICING_VERSION]
        );
        const orderId = order.rows[0].id;
        const launchSnapshot = {
            basic: 'production',
            standard: 'production',
            plus: 'test_only',
        };
        const catalogSnapshot = {
            basic: {
                launchStatus: 'production',
                relationshipCapacity: { followers: 400, following: 400 },
                detailedMutualLimit: 300,
            },
            standard: {
                launchStatus: 'production',
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
            },
            plus: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 1200, following: 1200 },
                detailedMutualLimit: 900,
            },
        };
        const policySnapshot = { pipeline: 'v2', risk: 'v1', aiStage: 'v1' };
        const replayKey = 'native-rebind-race-key';
        await pool.query(
            `UPDATE public.analysis_preflights
             SET idempotency_key = $2,
                 launch_status_snapshot = $3::JSONB,
                 plan_catalog_snapshot = $4::JSONB,
                 policy_versions_snapshot = $5::JSONB,
                 target_is_private = FALSE,
                 capacity_required_plan_id = 'basic',
                 created_at = pg_catalog.clock_timestamp() - INTERVAL '31 minutes',
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
                 ready_at = pg_catalog.clock_timestamp() - INTERVAL '31 minutes'
             WHERE id = $1`,
            [
                seed.preflightId,
                replayKey,
                JSON.stringify(launchSnapshot),
                JSON.stringify(catalogSnapshot),
                JSON.stringify(policySnapshot),
            ]
        );
        await pool.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid',
                 payment_id = 'native-rebind-race-payment',
                 actual_groble_product_id = expected_groble_product_id,
                 actual_amount_krw = expected_amount_krw,
                 paid_at = pg_catalog.clock_timestamp(),
                 seller_reference_confirmed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [orderId]
        );
        await pool.query(
            `INSERT INTO public.earlybird_fulfillments(order_id, status)
             VALUES ($1, 'awaiting_operator')`,
            [orderId]
        );

        const blockerClient = await pool.connect();
        const createClient = await pool.connect();
        const rebindClient = await pool.connect();
        const createApplication = 'earlybird-direct-create-replay';
        const rebindApplication = 'earlybird-direct-shared-rebind';
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT 1 FROM public.analysis_preflights
                 WHERE id = $1 FOR UPDATE`,
                [seed.preflightId]
            );

            await createClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [createApplication]
            );
            const createPromise = runServiceQuery<{
                preflight_id: string;
                preflight_status: string;
            }>(
                createClient,
                `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                    $1, $2, 'kakao', 'native_lock_300', $3, 'production',
                    $4::JSONB, $5::JSONB, $6, $7::JSONB, $8::JSONB
                )`,
                [
                    seed.userId,
                    seed.email,
                    replayKey,
                    JSON.stringify(launchSnapshot),
                    JSON.stringify(catalogSnapshot),
                    LEGACY_PRICING_VERSION,
                    JSON.stringify(pricingSnapshot),
                    JSON.stringify(policySnapshot),
                ]
            );
            expect(await waitForLockWait(pool, createApplication)).toBe(true);

            await rebindClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [rebindApplication]
            );
            const rebindPromise = runServiceQuery<{ rebound_id: string }>(
                rebindClient,
                `SELECT public.rebind_expired_paid_earlybird_preflight($1)
                    AS rebound_id`,
                [orderId]
            );
            expect(await waitForLockWait(pool, rebindApplication)).toBe(true);

            await blockerClient.query('COMMIT');
            await expect(createPromise).resolves.toMatchObject({
                preflight_id: seed.preflightId,
                preflight_status: 'expired',
            });
            const rebound = await rebindPromise;
            expect(rebound.rebound_id).not.toBe(seed.preflightId);
            expect((await pool.query<{ preflight_id: string }>(
                'SELECT preflight_id FROM public.earlybird_orders WHERE id = $1',
                [orderId]
            )).rows[0].preflight_id).toBe(rebound.rebound_id);
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await createClient.query('ROLLBACK').catch(() => undefined);
            await rebindClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            createClient.release();
            rebindClient.release();
        }
    }, 15_000);

    it('serializes actual auto-admit against create/replay without a FK deadlock', async () => {
        const seed = await seedNativeCheckout(
            pool,
            300,
            'native-auto-rebind-order@example.com'
        );
        const order = await pool.query<{ id: string }>(
            `INSERT INTO public.earlybird_orders(
                user_id, preflight_id, target_instagram_id,
                target_followers_count, target_following_count,
                exclusion_decision, plan_id, pricing_version,
                expected_amount_krw, expected_groble_product_id,
                disclosure_version, disclosure_text, disclosure_accepted_at
             ) VALUES (
                $1, $2, 'native_lock_300', 300, 100, 'skip', 'basic',
                $3, 14900, 'basic_product-01', 'earlybird-48h-v1',
                'auto-lock-order-only', pg_catalog.clock_timestamp()
             )
             RETURNING id`,
            [seed.userId, seed.preflightId, LEGACY_PRICING_VERSION]
        );
        const orderId = order.rows[0].id;
        const launchSnapshot = {
            basic: 'production',
            standard: 'production',
            plus: 'test_only',
        };
        const catalogSnapshot = {
            basic: {
                launchStatus: 'production',
                relationshipCapacity: { followers: 400, following: 400 },
                detailedMutualLimit: 300,
            },
            standard: {
                launchStatus: 'production',
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
            },
            plus: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 1200, following: 1200 },
                detailedMutualLimit: 900,
            },
        };
        const policySnapshot = { pipeline: 'v2', risk: 'v1', aiStage: 'v1' };
        const replayKey = 'native-auto-rebind-race-key';
        await pool.query(
            `UPDATE public.analysis_preflights
             SET idempotency_key = $2,
                 launch_status_snapshot = $3::JSONB,
                 plan_catalog_snapshot = $4::JSONB,
                 policy_versions_snapshot = $5::JSONB,
                 target_is_private = FALSE,
                 capacity_required_plan_id = 'basic',
                 created_at = pg_catalog.clock_timestamp() - INTERVAL '31 minutes',
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
                 ready_at = pg_catalog.clock_timestamp() - INTERVAL '31 minutes'
             WHERE id = $1`,
            [
                seed.preflightId,
                replayKey,
                JSON.stringify(launchSnapshot),
                JSON.stringify(catalogSnapshot),
                JSON.stringify(policySnapshot),
            ]
        );
        await pool.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid',
                 payment_id = 'native-auto-rebind-payment',
                 actual_groble_product_id = expected_groble_product_id,
                 actual_amount_krw = expected_amount_krw,
                 paid_at = pg_catalog.clock_timestamp(),
                 seller_reference_confirmed_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [orderId]
        );
        await pool.query(
            `INSERT INTO public.earlybird_fulfillments(order_id, status)
             VALUES ($1, 'awaiting_operator')`,
            [orderId]
        );

        const blockerClient = await pool.connect();
        const autoClient = await pool.connect();
        const duplicateAutoClient = await pool.connect();
        const createClient = await pool.connect();
        const autoApplication = 'earlybird-actual-auto-admit';
        const duplicateAutoApplication = 'earlybird-duplicate-auto-admit';
        const createApplication = 'earlybird-create-behind-auto';
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT 1 FROM public.analysis_preflights
                 WHERE id = $1 FOR UPDATE`,
                [seed.preflightId]
            );

            await autoClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [autoApplication]
            );
            const autoPromise = runServiceQuery<{
                order_id: string;
                fulfillment_status: string;
                preflight_id: string;
            }>(
                autoClient,
                'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
            );
            expect(await waitForLockWait(pool, autoApplication)).toBe(true);

            await duplicateAutoClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [duplicateAutoApplication]
            );
            const duplicateAutoPromise = runServiceQuery<{
                order_id: string;
                fulfillment_status: string;
            }>(
                duplicateAutoClient,
                'SELECT * FROM public.auto_admit_eligible_earlybird_fulfillments(20)'
            );
            expect(await waitForLockWait(pool, duplicateAutoApplication)).toBe(true);

            await createClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [createApplication]
            );
            const createPromise = runServiceQuery<{
                preflight_id: string;
                preflight_status: string;
            }>(
                createClient,
                `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                    $1, $2, 'kakao', 'native_lock_300', $3, 'production',
                    $4::JSONB, $5::JSONB, $6, $7::JSONB, $8::JSONB
                )`,
                [
                    seed.userId,
                    seed.email,
                    replayKey,
                    JSON.stringify(launchSnapshot),
                    JSON.stringify(catalogSnapshot),
                    LEGACY_PRICING_VERSION,
                    JSON.stringify(pricingSnapshot),
                    JSON.stringify(policySnapshot),
                ]
            );
            expect(await waitForLockWait(pool, createApplication)).toBe(true);

            await blockerClient.query('COMMIT');
            const admitted = await autoPromise;
            expect(admitted).toMatchObject({
                order_id: orderId,
                fulfillment_status: 'admission_pending',
            });
            expect(admitted.preflight_id).not.toBe(seed.preflightId);
            await expect(duplicateAutoPromise).resolves.toBeUndefined();
            await expect(createPromise).resolves.toMatchObject({
                preflight_id: seed.preflightId,
                preflight_status: 'expired',
            });
            expect((await pool.query<{ count: number }>(
                `SELECT pg_catalog.count(*)::INTEGER AS count
                 FROM public.analysis_preflights
                 WHERE status = 'ready' AND user_id = $1`,
                [seed.userId]
            )).rows[0].count).toBe(1);
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await autoClient.query('ROLLBACK').catch(() => undefined);
            await duplicateAutoClient.query('ROLLBACK').catch(() => undefined);
            await createClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            autoClient.release();
            duplicateAutoClient.release();
            createClient.release();
        }
    }, 15_000);

    it('waits for checkout user lock and observes the newly committed order', async () => {
        const index = 301;
        const userId = uuid('1', index);
        const preflightId = uuid('2', index);
        const email = 'postgres-lock-wait@example.com';
        const phone = '+821000000301';
        const rawPhone = '010-0000-0301';
        const applicationName = 'earlybird-lock-wait-finalizer';

        await pool.query(
            `INSERT INTO public.users (
                id, email, provider, phone_number, phone_number_normalized,
                phone_number_verification_source, phone_number_verified_at
            ) VALUES (
                $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
                pg_catalog.clock_timestamp()
            )`,
            [userId, email, rawPhone, phone]
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, target_instagram_id, status, exclusion_decision,
                excluded_instagram_id, access_mode, plan_cards_snapshot,
                pricing_version, pricing_snapshot, target_followers_count,
                target_following_count, required_plan_id, expires_at
            ) VALUES (
                $1, $2, 'lock_wait_target', 'ready', 'skip', NULL, 'production', $3,
                $4, $5, 300, 100, 'basic',
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
            )`,
            [
                preflightId,
                userId,
                planCards('basic'),
                LEGACY_PRICING_VERSION,
                pricingSnapshot,
            ]
        );

        const checkoutClient = await pool.connect();
        const finalizerClient = await pool.connect();
        try {
            await checkoutClient.query('BEGIN');
            await checkoutClient.query('SET LOCAL ROLE service_role');
            await checkoutClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [userId]
            );

            await finalizerClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [applicationName]
            );
            const finalizerPromise = (async () => {
                await finalizerClient.query('BEGIN');
                await finalizerClient.query('SET LOCAL ROLE service_role');
                const result = await finalizerClient.query<{
                    disposition: string;
                    order_id: string | null;
                }>(
                    `SELECT * FROM public.finalize_earlybird_groble_payment(
                        'lock-wait-event', 'lock-wait-idem', 'payment.completed',
                        '2026-07-18T21:00:00+09:00', 'lock-wait-payment',
                        $1, $2, $3, 'Lock Wait Buyer', $4, 14900,
                        '2026-07-18T21:00:00+09:00'
                    )`,
                    [email, phone, rawPhone, 'basic_product-01']
                );
                await finalizerClient.query('COMMIT');
                return result.rows[0];
            })();

            const observedAdvisoryWait = await waitForLockWait(pool, applicationName);

            const checkout = await checkoutClient.query<{ order_id: string }>(
                `SELECT * FROM public.create_earlybird_checkout(
                    $1, $2, 'basic', 'basic_product-01', 14900, $3, $4, $5,
                    pg_catalog.clock_timestamp()
                )`,
                [
                    userId,
                    preflightId,
                    LEGACY_PRICING_VERSION,
                    EARLYBIRD_DISCLOSURE_VERSION,
                    EARLYBIRD_DISCLOSURE_TEXT,
                ]
            );
            await checkoutClient.query('COMMIT');
            const finalized = await finalizerPromise;

            expect(observedAdvisoryWait).toBe(true);
            expect(finalized).toMatchObject({
                disposition: 'accepted',
                order_id: checkout.rows[0].order_id,
            });
        } catch (error) {
            await checkoutClient.query('ROLLBACK').catch(() => undefined);
            await finalizerClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            checkoutClient.release();
            finalizerClient.release();
        }
    }, 15_000);

    it('serializes pending cancellation before finalization and reconciles by phone', async () => {
        const index = 302;
        const userId = uuid('1', index);
        const preflightId = uuid('2', index);
        const email = 'postgres-status-race@example.com';
        const phone = '+821000000302';
        const rawPhone = '010-0000-0302';
        const applicationName = 'earlybird-status-race-finalizer';

        await pool.query(
            `INSERT INTO public.users (
                id, email, provider, phone_number, phone_number_normalized,
                phone_number_verification_source, phone_number_verified_at
            ) VALUES (
                $1, $2, 'kakao', $3, $4, 'kakao_rest_api',
                pg_catalog.clock_timestamp()
            )`,
            [userId, email, rawPhone, phone]
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, target_instagram_id, status, exclusion_decision,
                excluded_instagram_id, access_mode, plan_cards_snapshot,
                pricing_version, pricing_snapshot, target_followers_count,
                target_following_count, required_plan_id, expires_at
            ) VALUES (
                $1, $2, 'status_race_target', 'ready', 'skip', NULL, 'production', $3,
                $4, $5, 300, 100, 'basic',
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
            )`,
            [
                preflightId,
                userId,
                planCards('basic'),
                LEGACY_PRICING_VERSION,
                pricingSnapshot,
            ]
        );
        const checkout = await asService(pool, client => client.query<{ order_id: string }>(
            `SELECT * FROM public.create_earlybird_checkout(
                $1, $2, 'basic', 'basic_product-01', 14900, $3, $4, $5,
                pg_catalog.clock_timestamp()
            )`,
            [
                userId,
                preflightId,
                LEGACY_PRICING_VERSION,
                EARLYBIRD_DISCLOSURE_VERSION,
                EARLYBIRD_DISCLOSURE_TEXT,
            ]
        ));
        const orderId = checkout.rows[0].order_id;

        const cancellationClient = await pool.connect();
        const finalizerClient = await pool.connect();
        try {
            await cancellationClient.query('BEGIN');
            await cancellationClient.query('SET LOCAL ROLE service_role');
            await cancellationClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [userId]
            );

            await finalizerClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [applicationName]
            );
            const finalizerPromise = (async () => {
                await finalizerClient.query('BEGIN');
                await finalizerClient.query('SET LOCAL ROLE service_role');
                const result = await finalizerClient.query<{
                    disposition: string;
                    order_id: string | null;
                    status: string | null;
                }>(
                    `SELECT * FROM public.finalize_earlybird_groble_payment(
                        'status-race-event', 'status-race-idem', 'payment.completed',
                        '2026-07-18T21:00:00+09:00', 'status-race-payment',
                        'different-status-race@example.com', $1, $2,
                        'Status Race Buyer', 'basic_product-01', 14900,
                        '2026-07-18T21:00:00+09:00'
                    )`,
                    [phone, rawPhone]
                );
                await finalizerClient.query('COMMIT');
                return result.rows[0];
            })();

            const observedAdvisoryWait = await waitForLockWait(pool, applicationName);
            await cancellationClient.query(
                `SELECT public.set_earlybird_refund_status($1, 'cancelled')`,
                [orderId]
            );
            await cancellationClient.query('COMMIT');
            const finalized = await finalizerPromise;

            expect(observedAdvisoryWait).toBe(true);
            expect(finalized).toMatchObject({
                disposition: 'late_cancelled_payment',
                order_id: orderId,
                status: 'refund_pending',
            });
            expect((await pool.query<{ status: string }>(
                `SELECT status FROM public.earlybird_orders WHERE id = $1`,
                [orderId]
            )).rows[0].status).toBe('refund_pending');
        } catch (error) {
            await cancellationClient.query('ROLLBACK').catch(() => undefined);
            await finalizerClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            cancellationClient.release();
            finalizerClient.release();
        }
    }, 15_000);

    it('holds the product fence while a rolling finalizer decides legacy attribution', async () => {
        const productId = 'basic_product-01';
        const legacy = await seedNativeCheckout(
            pool,
            304,
            'native-product-fence-legacy@example.com'
        );
        const verified = await seedNativeCheckout(
            pool,
            305,
            'native-product-fence-verified@example.com'
        );
        const legacyOrderId = await createNativeCheckout(pool, legacy, productId);
        await forceNativeLegacyOrder(pool, legacyOrderId);

        const blockerClient = await pool.connect();
        const wrapperClient = await pool.connect();
        const checkoutClient = await pool.connect();
        const wrapperApplication = 'earlybird-product-fence-wrapper';
        const checkoutApplication = 'earlybird-product-fence-checkout';
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [legacy.userId]
            );
            await wrapperClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [wrapperApplication]
            );
            const wrapperPromise = runServiceQuery<{
                disposition: string;
                order_id: string | null;
            }>(
                wrapperClient,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'native-product-fence-event',
                    'native-product-fence-idem',
                    'payment.completed',
                    '2026-07-18T21:00:00+09:00',
                    'native-product-fence-payment',
                    $1, $2, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [legacy.email, productId]
            );
            expect(await waitForLockWait(pool, wrapperApplication)).toBe(true);

            await checkoutClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [checkoutApplication]
            );
            const checkoutPromise = runServiceQuery<{ order_id: string }>(
                checkoutClient,
                `SELECT * FROM public.create_earlybird_checkout(
                    $1, $2, 'basic', $3, 14900, $4, $5, $6,
                    pg_catalog.clock_timestamp()
                )`,
                [
                    verified.userId,
                    verified.preflightId,
                    productId,
                    LEGACY_PRICING_VERSION,
                    EARLYBIRD_DISCLOSURE_VERSION,
                    EARLYBIRD_DISCLOSURE_TEXT,
                ]
            );
            const checkoutWaitedForProduct = await waitForLockWait(
                pool,
                checkoutApplication
            );

            await blockerClient.query('COMMIT');
            const [wrapperOutcome, checkoutOutcome] = await Promise.allSettled([
                wrapperPromise,
                checkoutPromise,
            ]);

            expect(checkoutWaitedForProduct).toBe(true);
            expect(wrapperOutcome.status).toBe('fulfilled');
            expect(checkoutOutcome.status).toBe('fulfilled');
            if (wrapperOutcome.status !== 'fulfilled') throw wrapperOutcome.reason;
            if (checkoutOutcome.status !== 'fulfilled') throw checkoutOutcome.reason;
            expect(wrapperOutcome.value).toMatchObject({
                disposition: 'accepted',
                order_id: legacyOrderId,
            });
            expect((await pool.query<{ status: string }>(
                `SELECT status FROM public.earlybird_orders WHERE id = $1`,
                [checkoutOutcome.value.order_id]
            )).rows[0].status).toBe('payment_pending');
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await wrapperClient.query('ROLLBACK').catch(() => undefined);
            await checkoutClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            wrapperClient.release();
            checkoutClient.release();
        }
    }, 20_000);

    it('serializes same-payment rolling and canonical finalizers without deadlock', async () => {
        const productId = 'basic_product-01';
        const legacy = await seedNativeCheckout(
            pool,
            306,
            'native-same-payment-legacy@example.com'
        );
        const legacyOrderId = await createNativeCheckout(pool, legacy, productId);
        await forceNativeLegacyOrder(pool, legacyOrderId);

        const blockerClient = await pool.connect();
        const wrapperClient = await pool.connect();
        const canonicalClient = await pool.connect();
        const wrapperApplication = 'earlybird-same-payment-wrapper';
        const canonicalApplication = 'earlybird-same-payment-canonical';
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [legacy.userId]
            );
            await wrapperClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [wrapperApplication]
            );
            const wrapperPromise = runServiceQuery<{ disposition: string }>(
                wrapperClient,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'native-same-payment-wrapper-event',
                    'native-same-payment-wrapper-idem',
                    'payment.completed',
                    '2026-07-18T21:00:00+09:00',
                    'native-shared-payment',
                    $1, $2, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [legacy.email, productId]
            );
            expect(await waitForLockWait(pool, wrapperApplication)).toBe(true);

            await canonicalClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [canonicalApplication]
            );
            const canonicalPromise = runServiceQuery<{ disposition: string }>(
                canonicalClient,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'native-same-payment-canonical-event',
                    'native-same-payment-canonical-idem',
                    'payment.completed',
                    '2026-07-18T21:00:00+09:00',
                    'native-shared-payment',
                    $1, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                    $2, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [legacy.email, productId]
            );
            expect(await waitForLockWait(pool, canonicalApplication)).toBe(true);

            await blockerClient.query('COMMIT');
            const outcomes = await Promise.allSettled([
                wrapperPromise,
                canonicalPromise,
            ]);

            expect(outcomes.every(outcome => outcome.status === 'fulfilled'))
                .toBe(true);
            const dispositions = outcomes.flatMap(outcome =>
                outcome.status === 'fulfilled' ? outcome.value.disposition : []
            );
            expect(dispositions.sort()).toEqual([
                'accepted',
                'duplicate_payment',
            ]);
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await wrapperClient.query('ROLLBACK').catch(() => undefined);
            await canonicalClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            wrapperClient.release();
            canonicalClient.release();
        }
    }, 20_000);

    it('prelocks a duplicate-payment owner with cross-product wrapper candidates', async () => {
        const owner = await seedNativeCheckout(
            pool,
            307,
            'native-cross-lock-owner@example.com'
        );
        const emailCandidate = await seedNativeCheckout(
            pool,
            308,
            'native-cross-lock-email@example.com'
        );
        const existingPaymentId = 'native-cross-lock-existing-payment';
        const crossingProductId = 'native-cross-lock-product';
        const duplicateProductId = 'native-cross-lock-other-product';
        const paidOrderId = await createNativeCheckout(
            pool,
            owner,
            duplicateProductId
        );
        await pool.query(
            `UPDATE public.earlybird_orders
             SET status = 'paid', payment_id = $1
             WHERE id = $2`,
            [existingPaymentId, paidOrderId]
        );
        const secondPreflightId = await seedNativePreflight(
            pool,
            owner.userId,
            309
        );
        await createNativeCheckout(pool, {
            ...owner,
            preflightId: secondPreflightId,
        }, crossingProductId);
        await pool.query(
            `INSERT INTO public.earlybird_webhook_events (
                event_id, idempotency_key, event_type, occurred_at,
                payment_id, product_id, amount_krw, disposition
            ) VALUES (
                'native-cross-lock-known-event',
                'native-cross-lock-known-idem',
                'payment.completed', pg_catalog.clock_timestamp(),
                'native-cross-lock-known-payment', $1, 14900, 'unmatched'
            )`,
            [crossingProductId]
        );

        const blockerClient = await pool.connect();
        const crossingClient = await pool.connect();
        const duplicateClient = await pool.connect();
        const crossingApplication = 'earlybird-cross-lock-known-wrapper';
        const duplicateApplication = 'earlybird-cross-lock-duplicate-payment';
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [owner.userId]
            );

            await crossingClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [crossingApplication]
            );
            const crossingPromise = runServiceQuery<{ disposition: string }>(
                crossingClient,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'native-cross-lock-known-event',
                    'native-cross-lock-known-idem',
                    'payment.completed',
                    '2026-07-18T21:00:00+09:00',
                    'native-cross-lock-known-replay-payment',
                    $1, $2, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [emailCandidate.email, crossingProductId]
            );
            expect(await waitForLockWait(pool, crossingApplication)).toBe(true);

            await duplicateClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [duplicateApplication]
            );
            const duplicatePromise = runServiceQuery<{ disposition: string }>(
                duplicateClient,
                `SELECT * FROM public.finalize_earlybird_groble_payment(
                    'native-cross-lock-duplicate-event',
                    'native-cross-lock-duplicate-idem',
                    'payment.completed',
                    '2026-07-18T21:00:00+09:00',
                    $1, $2, $3, 14900,
                    '2026-07-18T21:00:00+09:00'
                )`,
                [existingPaymentId, emailCandidate.email, duplicateProductId]
            );
            expect(await waitForLockWait(pool, duplicateApplication)).toBe(true);

            await blockerClient.query('COMMIT');
            const outcomes = await Promise.allSettled([
                crossingPromise,
                duplicatePromise,
            ]);

            const rejected = outcomes.find(outcome => outcome.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
            const dispositions = outcomes.flatMap(outcome =>
                outcome.status === 'fulfilled' ? outcome.value.disposition : []
            );
            expect(dispositions.sort()).toEqual([
                'duplicate_event',
                'duplicate_payment',
            ]);
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await crossingClient.query('ROLLBACK').catch(() => undefined);
            await duplicateClient.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            crossingClient.release();
            duplicateClient.release();
        }
    }, 20_000);

    it('fails closed for a raw-only Phase 1 checkout that resumes after activation', async () => {
        await pool.query(bootstrap);
        await pool.query(presaleMigration);
        await pool.query(phoneMigrations[0]);

        const index = 303;
        const userId = uuid('1', index);
        const preflightId = uuid('2', index);
        const rawPhone = '010-4444-5555';
        const applicationName = 'earlybird-straddling-legacy-checkout';

        await pool.query(
            `INSERT INTO public.users (id, email, provider, phone_number)
             VALUES ($1, 'straddling-legacy@example.com', 'kakao', $2)`,
            [userId, rawPhone]
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, target_instagram_id, status, exclusion_decision,
                excluded_instagram_id, access_mode, plan_cards_snapshot,
                pricing_version, pricing_snapshot, target_followers_count,
                target_following_count, required_plan_id, expires_at
            ) VALUES (
                $1, $2, 'straddling_legacy_target', 'ready', 'skip', NULL,
                'production', $3, $4, $5, 300, 100, 'basic',
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
            )`,
            [
                preflightId,
                userId,
                planCards('basic'),
                LEGACY_PRICING_VERSION,
                pricingSnapshot,
            ]
        );

        const blockerClient = await pool.connect();
        const legacyClient = await pool.connect();
        let legacyCheckoutPromise: Promise<QueryResult<{ order_id: string }>> | null = null;
        try {
            await blockerClient.query('BEGIN');
            await blockerClient.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::TEXT, 0)
                )`,
                [userId]
            );

            await legacyClient.query(
                `SELECT pg_catalog.set_config('application_name', $1, FALSE)`,
                [applicationName]
            );
            await legacyClient.query('BEGIN');
            await legacyClient.query('SET LOCAL ROLE service_role');
            legacyCheckoutPromise = legacyClient.query<{ order_id: string }>(
                `SELECT * FROM public.create_earlybird_checkout(
                    $1, $2, 'basic', 'basic_product-01', 14900, $3, $4, $5,
                    pg_catalog.clock_timestamp()
                )`,
                [
                    userId,
                    preflightId,
                    LEGACY_PRICING_VERSION,
                    EARLYBIRD_DISCLOSURE_VERSION,
                    EARLYBIRD_DISCLOSURE_TEXT,
                ]
            );

            expect(await waitForLockWait(pool, applicationName)).toBe(true);

            await pool.query(phoneMigrations[1]);
            await pool.query(phoneMigrations[2]);
            expect((await pool.query<{ order_count: string }>(
                `SELECT pg_catalog.count(*)::TEXT AS order_count
                 FROM public.earlybird_orders
                 WHERE user_id = $1`,
                [userId]
            )).rows[0].order_count).toBe('0');

            await blockerClient.query('COMMIT');
            await expect(legacyCheckoutPromise).rejects.toThrow(
                /CHECKOUT_PHONE_REQUIRED/
            );
            await legacyClient.query('ROLLBACK');
            expect((await pool.query<{ order_count: string }>(
                `SELECT pg_catalog.count(*)::TEXT AS order_count
                 FROM public.earlybird_orders
                 WHERE user_id = $1`,
                [userId]
            )).rows[0].order_count).toBe('0');

            await pool.query(phoneMigrations[3]);
            await pool.query(phoneMigrations[4]);
        } catch (error) {
            await blockerClient.query('ROLLBACK').catch(() => undefined);
            await legacyClient.query('ROLLBACK').catch(() => undefined);
            await legacyCheckoutPromise?.catch(() => undefined);
            throw error;
        } finally {
            blockerClient.release();
            legacyClient.release();
        }
    }, 30_000);
});
