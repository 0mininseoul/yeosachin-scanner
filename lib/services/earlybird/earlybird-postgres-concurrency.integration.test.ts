import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PRICING_VERSION,
} from '@/lib/domain/earlybird/catalog';

const databaseUrl = process.env.EARLYBIRD_POSTGRES_TEST_URL;
const destructiveTestMarker = process.env.EARLYBIRD_POSTGRES_TEST_MARKER;
const describePostgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260717085730_add_groble_earlybird_presale.sql',
        import.meta.url
    ),
    'utf8'
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
    email VARCHAR(255) UNIQUE NOT NULL
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
        await pool.query(migration);
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
                    'INSERT INTO public.users (id, email) VALUES ($1, $2)',
                    [seed.userId, seed.email]
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
                        $1, $2, 'payment.completed', $3, $4, $5, $6, $7, $8
                    )`,
                    [
                        `event_${planId}_${seed.index}`,
                        `idem_${planId}_${seed.index}`,
                        '2026-07-17T21:00:00+09:00',
                        `payment_${planId}_${seed.index}`,
                        seed.email,
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
});
