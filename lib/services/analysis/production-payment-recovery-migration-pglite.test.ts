import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (name: string): string =>
    readFileSync(new URL(name, migrationsDirectory), 'utf8');

const recoveryMigration = migration('20260827172857_production_preflight_checkout_recovery.sql');
const cleanupMigration = migration('20260827172859_cleanup_confirmed_administrator_test_order.sql');

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const ANONYMOUS_PREFLIGHT_ID = '10000000-0000-4000-8000-000000000003';
const STALE_OWNER_PREFLIGHT_ID = '10000000-0000-4000-8000-000000000004';
const CONCURRENT_PREFLIGHT_ID = '10000000-0000-4000-8000-000000000005';
const CLAIM_TOKEN_HASH = 'a'.repeat(64);
const BOUND_TARGET_HASH = 'b'.repeat(64);
const CONFLICTING_TARGET_HASH = 'c'.repeat(64);

const ADMIN_ID = '20000000-0000-4000-8000-000000000001';
const EXTERNAL_ID = '20000000-0000-4000-8000-000000000002';
const ADMIN_ORDER_ID = '20000000-0000-4000-8000-000000000003';
const EXTERNAL_ORDER_ID = '20000000-0000-4000-8000-000000000004';
const RESULT_ID = '20000000-0000-4000-8000-000000000005';

const recoveryBootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;

CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID,
    idempotency_key TEXT,
    provider_selector TEXT,
    claim_token_hash VARCHAR(64),
    claim_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    target_instagram_id TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    target_input_hash TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public.create_or_replay_analysis_v2_preflight(
    p_user_id UUID,
    p_email TEXT,
    p_auth_provider TEXT,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_access_mode TEXT,
    p_launch_status_snapshot JSONB,
    p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT,
    p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB
)
RETURNS TABLE(
    preflight_id UUID,
    created BOOLEAN,
    preflight_status TEXT,
    expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.analysis_preflights%ROWTYPE;
    v_id UUID;
    v_expires TIMESTAMPTZ;
BEGIN
    SELECT preflight.* INTO v_existing
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        RETURN QUERY SELECT v_existing.id, FALSE, v_existing.status, v_existing.expires_at;
        RETURN;
    END IF;

    v_id := pg_catalog.gen_random_uuid();
    v_expires := pg_catalog.clock_timestamp() + INTERVAL '30 minutes';
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, provider_selector, target_instagram_id,
        status, expires_at, created_at, updated_at
    ) VALUES (
        v_id, p_user_id, p_idempotency_key, 'authenticated_apify',
        p_target_instagram_id, 'ready', v_expires,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    );
    RETURN QUERY SELECT v_id, TRUE, 'ready'::TEXT, v_expires;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;
`;

const cleanupBootstrap = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (
    id UUID PRIMARY KEY,
    email TEXT
);
CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL
);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    target_instagram_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_id TEXT,
    paid_at TIMESTAMPTZ,
    actual_amount_krw INTEGER,
    seller_reference_confirmed_at TIMESTAMPTZ,
    result_request_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY
);
CREATE TABLE public.earlybird_webhook_events (
    order_id UUID PRIMARY KEY
);
`;

const databases: PGlite[] = [];

async function createRecoveryDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(recoveryBootstrap);
    await db.exec(recoveryMigration);
    return db;
}

async function asRole<T>(
    db: PGlite,
    role: 'authenticated' | 'service_role',
    userId: string | null,
    sql: string,
    params: unknown[] = [],
) {
    await db.exec(`SET ROLE ${role}`);
    try {
        if (userId) {
            await db.exec(`SET request.jwt.claim.sub = '${userId}'`);
        }
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
        await db.exec('RESET request.jwt.claim.sub');
    }
}

async function seedClaimRows(db: PGlite): Promise<void> {
    await db.query(
        `INSERT INTO public.users(id, email) VALUES ($1, $2), ($3, $4)`,
        [USER_ID, 'owner@example.com', OTHER_USER_ID, 'other@example.com'],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(
            id, user_id, provider_selector, claim_token_hash, claim_expires_at,
            target_instagram_id, status, expires_at, updated_at, created_at
        ) VALUES
            ($1, NULL, 'anonymous_apify', $4, clock_timestamp() + INTERVAL '10 minutes',
             'target.account', 'ready', clock_timestamp() + INTERVAL '30 minutes',
             clock_timestamp(), clock_timestamp()),
            ($2, $3, 'authenticated_apify', NULL, NULL,
             'old.account', 'ready', clock_timestamp() - INTERVAL '1 minute',
             clock_timestamp() - INTERVAL '2 minutes', clock_timestamp() - INTERVAL '2 minutes'),
            ($5, NULL, 'anonymous_apify', $4, clock_timestamp() + INTERVAL '10 minutes',
             'concurrent.account', 'ready', clock_timestamp() + INTERVAL '30 minutes',
             clock_timestamp(), clock_timestamp())`,
        [
            ANONYMOUS_PREFLIGHT_ID,
            STALE_OWNER_PREFLIGHT_ID,
            USER_ID,
            CLAIM_TOKEN_HASH,
            CONCURRENT_PREFLIGHT_ID,
        ],
    );
}

async function claim(
    db: PGlite,
    preflightId: string,
    userId: string,
    role: 'authenticated' | 'service_role' = 'authenticated',
) {
    return asRole<{ claimed: boolean; preflight_status: string; owner_preflight_id: string | null }>(
        db,
        role,
        userId,
        `SELECT * FROM public.claim_anonymous_analysis_v2_preflight($1, $2, $3)`,
        [preflightId, CLAIM_TOKEN_HASH, userId],
    );
}

describe('production preflight recovery migrations: executable PostgreSQL behavior', () => {
    afterAll(async () => {
        await Promise.all(databases.map(database => database.close()));
    });

    it('enforces auth.uid and role/grant boundaries while serializing owner claims', async () => {
        const db = await createRecoveryDatabase();
        await seedClaimRows(db);

        const privileges = await db.query<{
            authenticated_private_usage: boolean;
            authenticated_private_execute: boolean;
            authenticated_hash_execute: boolean;
            service_hash_execute: boolean;
        }>(`SELECT
            has_schema_privilege('authenticated', 'private', 'USAGE') AS authenticated_private_usage,
            has_function_privilege(
                'authenticated',
                'private.claim_anonymous_analysis_v2_preflight(uuid, character varying, uuid)',
                'EXECUTE'
            ) AS authenticated_private_execute,
            has_function_privilege(
                'authenticated',
                'public.create_or_replay_analysis_v2_preflight_with_target_hash(uuid, text, text, text, text, text, jsonb, jsonb, text, jsonb, jsonb, text)',
                'EXECUTE'
            ) AS authenticated_hash_execute,
            has_function_privilege(
                'service_role',
                'public.create_or_replay_analysis_v2_preflight_with_target_hash(uuid, text, text, text, text, text, jsonb, jsonb, text, jsonb, jsonb, text)',
                'EXECUTE'
            ) AS service_hash_execute`);
        expect(privileges.rows[0]).toEqual({
            authenticated_private_usage: true,
            authenticated_private_execute: true,
            authenticated_hash_execute: false,
            service_hash_execute: true,
        });

        const mismatchedUid = await asRole(
            db,
            'authenticated',
            OTHER_USER_ID,
            `SELECT * FROM public.claim_anonymous_analysis_v2_preflight($1, $2, $3)`,
            [ANONYMOUS_PREFLIGHT_ID, CLAIM_TOKEN_HASH, USER_ID],
        );
        expect(mismatchedUid.rows[0]).toEqual({
            claimed: false,
            preflight_status: 'invalid',
            owner_preflight_id: null,
        });

        const first = await claim(db, ANONYMOUS_PREFLIGHT_ID, USER_ID);
        expect(first.rows[0]).toEqual({
            claimed: true,
            preflight_status: 'claimed',
            owner_preflight_id: null,
        });
        await expect(db.query<{ status: string; user_id: string }>(
            `SELECT status, user_id FROM public.analysis_preflights
             WHERE id = $1`,
            [STALE_OWNER_PREFLIGHT_ID],
        )).resolves.toMatchObject({
            rows: [{ status: 'expired', user_id: USER_ID }],
        });

        // A repeated same-owner claim is deterministic under the helper's
        // advisory/row-lock fence and cannot create a second owner transition.
        const repeated = await claim(db, ANONYMOUS_PREFLIGHT_ID, USER_ID);
        expect(repeated.rows[0]?.claimed).toBe(false);
        expect(repeated.rows[0]?.preflight_status).toBe('rejected');

        await db.query(
            `UPDATE public.analysis_preflights SET status = 'expired' WHERE id = $1`,
            [ANONYMOUS_PREFLIGHT_ID],
        );
        const concurrentResults = await Promise.all([
            claim(db, CONCURRENT_PREFLIGHT_ID, USER_ID),
            claim(db, CONCURRENT_PREFLIGHT_ID, USER_ID),
        ]);
        expect(concurrentResults.map(result => result.rows[0]?.claimed).sort()).toEqual([
            false,
            true,
        ]);

        const claimedRow = await db.query<{ user_id: string | null }>(
            `SELECT user_id FROM public.analysis_preflights WHERE id = $1`,
            [CONCURRENT_PREFLIGHT_ID],
        );
        expect(claimedRow.rows[0]?.user_id).toBe(USER_ID);

        await expect(claim(db, ANONYMOUS_PREFLIGHT_ID, OTHER_USER_ID)).resolves.toMatchObject({
            rows: [{ claimed: false }],
        });
    });

    it('binds a target hash exactly once and rejects a conflicting replay atomically', async () => {
        const db = await createRecoveryDatabase();
        await db.query(
            `INSERT INTO public.users(id, email) VALUES ($1, $2)`,
            [USER_ID, 'owner@example.com'],
        );

        const args = [
            USER_ID,
            'owner@example.com',
            'kakao',
            'target.account',
            'hash-idempotency-key',
            'production',
            JSON.stringify({ version: 1 }),
            JSON.stringify({ version: 1 }),
            'earlybird-2026-08-v5',
            JSON.stringify({ version: 1 }),
            JSON.stringify({ version: 1 }),
        ];
        const call = (hash: string) => asRole<{
            preflight_id: string;
            created: boolean;
            preflight_status: string;
            expires_at: string;
        }>(
            db,
            'service_role',
            null,
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight_with_target_hash(
                $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12
            )`,
            [...args, hash],
        );

        const first = await call(BOUND_TARGET_HASH);
        expect(first.rows[0]).toMatchObject({
            created: true,
            preflight_status: 'ready',
        });
        expect(first.rows[0]?.preflight_id).toBeTruthy();

        const replay = await call(BOUND_TARGET_HASH);
        expect(replay.rows[0]).toMatchObject({
            created: false,
            preflight_id: first.rows[0]?.preflight_id,
        });

        await expect(call(CONFLICTING_TARGET_HASH)).rejects.toThrow(
            'ANALYSIS_V2_PREFLIGHT_TARGET_HASH_CONFLICT',
        );
        await expect(db.query<{ target_input_hash: string | null }>(
            `SELECT target_input_hash FROM public.analysis_preflights WHERE id = $1`,
            [first.rows[0]?.preflight_id],
        )).resolves.toMatchObject({ rows: [{ target_input_hash: BOUND_TARGET_HASH }] });

        await expect(asRole(
            db,
            'authenticated',
            USER_ID,
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight_with_target_hash(
                $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12
            )`,
            [...args, BOUND_TARGET_HASH],
        )).rejects.toThrow(/permission denied|execute/i);
    });
});

async function createCleanupDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(cleanupBootstrap);
    await db.query(
        `INSERT INTO auth.users(id, email) VALUES ($1, $2), ($3, $4)`,
        [ADMIN_ID, 'ym1113@kakao.com', EXTERNAL_ID, 'external@example.com'],
    );
    await db.query(
        `INSERT INTO public.users(id, email) VALUES ($1, $2), ($3, $4)`,
        [ADMIN_ID, 'ym1113@kakao.com', EXTERNAL_ID, 'external@example.com'],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders(
             id, user_id, target_instagram_id, plan_id, status,
             payment_id, paid_at, actual_amount_krw,
             seller_reference_confirmed_at, result_request_id
         ) VALUES (
             $1, $2, '0_min._.00', 'standard', 'payment_pending',
             NULL, NULL, NULL, NULL, NULL
         ), (
             $3, $4, 'external.account', 'standard', 'payment_pending',
             NULL, NULL, NULL, NULL, NULL
         )`,
        [ADMIN_ORDER_ID, ADMIN_ID, EXTERNAL_ORDER_ID, EXTERNAL_ID],
    );
    return db;
}

async function orderStatus(db: PGlite, orderId: string) {
    return db.query<{ status: string }>(
        `SELECT status FROM public.earlybird_orders WHERE id = $1`,
        [orderId],
    );
}

describe('administrator test-order cleanup migration behavior', () => {
    it('cancels exactly the confirmed administrator test order and preserves users/external orders', async () => {
        const db = await createCleanupDatabase();
        await db.exec(cleanupMigration);

        await expect(orderStatus(db, ADMIN_ORDER_ID)).resolves.toMatchObject({
            rows: [{ status: 'cancelled' }],
        });
        await expect(orderStatus(db, EXTERNAL_ORDER_ID)).resolves.toMatchObject({
            rows: [{ status: 'payment_pending' }],
        });
        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM auth.users JOIN public.users USING(id)`,
        )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    });

    it.each([
        ['multiple candidates', async (db: PGlite) => {
            await db.query(
                `INSERT INTO auth.users(id, email) VALUES ($1, $2)`,
                [
                    '20000000-0000-4000-8000-000000000006',
                    'ym1113@kakao.com',
                ],
            );
            await db.query(
                `INSERT INTO public.users(id, email) VALUES ($1, $2)`,
                [
                    '20000000-0000-4000-8000-000000000006',
                    'ym1113@kakao.com',
                ],
            );
            await db.query(
                `INSERT INTO public.earlybird_orders(
                     id, user_id, target_instagram_id, plan_id, status,
                     payment_id, paid_at, actual_amount_krw,
                     seller_reference_confirmed_at, result_request_id
                 ) VALUES ($1, $2, '0_min._.00', 'standard', 'payment_pending', NULL, NULL, NULL, NULL, NULL)`,
                [
                    '20000000-0000-4000-8000-000000000007',
                    ADMIN_ID,
                ],
            );
        }],
        ['payment evidence', async (db: PGlite) => {
            await db.query(
                `UPDATE public.earlybird_orders SET payment_id = 'payment-evidence' WHERE id = $1`,
                [ADMIN_ORDER_ID],
            );
        }],
        ['seller confirmation evidence', async (db: PGlite) => {
            await db.query(
                `UPDATE public.earlybird_orders
                 SET seller_reference_confirmed_at = clock_timestamp()
                 WHERE id = $1`,
                [ADMIN_ORDER_ID],
            );
        }],
        ['fulfillment child', async (db: PGlite) => {
            await db.query(
                `INSERT INTO public.earlybird_fulfillments(order_id) VALUES ($1)`,
                [ADMIN_ORDER_ID],
            );
        }],
        ['result child', async (db: PGlite) => {
            await db.query(
                `INSERT INTO public.analysis_requests(id) VALUES ($1)`,
                [RESULT_ID],
            );
            await db.query(
                `UPDATE public.earlybird_orders SET result_request_id = $1 WHERE id = $2`,
                [RESULT_ID, ADMIN_ORDER_ID],
            );
        }],
        ['webhook child', async (db: PGlite) => {
            await db.query(
                `INSERT INTO public.earlybird_webhook_events(order_id) VALUES ($1)`,
                [ADMIN_ORDER_ID],
            );
        }],
    ] as const)('fails closed for %s and preserves every order', async (_label, setup) => {
        const db = await createCleanupDatabase();
        await setup(db);

        await expect(db.exec(cleanupMigration)).rejects.toThrow(/EARLYBIRD_ADMIN_TEST_CLEANUP/);
        await expect(orderStatus(db, ADMIN_ORDER_ID)).resolves.toMatchObject({
            rows: [{ status: 'payment_pending' }],
        });
        await expect(orderStatus(db, EXTERNAL_ORDER_ID)).resolves.toMatchObject({
            rows: [{ status: 'payment_pending' }],
        });
    });
});
