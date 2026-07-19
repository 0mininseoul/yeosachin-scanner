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
    EARLYBIRD_PRICING_VERSION,
} from '@/lib/domain/earlybird/catalog';

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
            EARLYBIRD_PRICING_VERSION,
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
            EARLYBIRD_PRICING_VERSION,
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
            EARLYBIRD_PRICING_VERSION,
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
                        EARLYBIRD_PRICING_VERSION,
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
                        EARLYBIRD_PRICING_VERSION,
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
                EARLYBIRD_PRICING_VERSION,
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
                    EARLYBIRD_PRICING_VERSION,
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
                EARLYBIRD_PRICING_VERSION,
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
                EARLYBIRD_PRICING_VERSION,
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
                    EARLYBIRD_PRICING_VERSION,
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
                EARLYBIRD_PRICING_VERSION,
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
                    EARLYBIRD_PRICING_VERSION,
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
