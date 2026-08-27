import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (name: string): string =>
    readFileSync(new URL(name, migrationsDirectory), 'utf8');

const recoveryMigration = migration('20260827172857_production_preflight_checkout_recovery.sql');
const cleanupMigration = migration('20260827172859_cleanup_confirmed_administrator_test_order.sql');
const effectiveV5CheckoutMigration = migration('20260812122517_update_earlybird_pricing_v5.sql');

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
const ADMIN_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000006';
const EXTERNAL_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000007';
const LINEAGE_OLDER_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000001';
const LINEAGE_NEWER_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000002';

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

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    preflight_id UUID NOT NULL,
    target_instagram_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    pricing_version TEXT NOT NULL,
    expected_amount_krw INTEGER NOT NULL,
    expected_groble_product_id TEXT NOT NULL,
    buyer_match_policy TEXT NOT NULL,
    expected_buyer_phone_number_normalized TEXT,
    expected_buyer_phone_verification_source TEXT,
    expected_buyer_phone_verified_at TIMESTAMPTZ,
    disclosure_version TEXT NOT NULL,
    disclosure_text TEXT NOT NULL,
    disclosure_accepted_at TIMESTAMPTZ NOT NULL,
    groble_seller_reference TEXT,
    seller_reference_confirmed_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    payment_id TEXT,
    actual_groble_product_id TEXT,
    actual_amount_krw INTEGER,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.gen_random_uuid() $$;
CREATE FUNCTION public.normalize_kr_mobile_e164(raw_phone TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN pg_catalog.regexp_replace(raw_phone, '[^0-9]', '', 'g') ~ '^010[0-9]{8}$'
        THEN '+82' || pg_catalog.substr(pg_catalog.regexp_replace(raw_phone, '[^0-9]', '', 'g'), 2)
        ELSE NULL
    END
$$;
CREATE TABLE auth.users (
    id UUID PRIMARY KEY,
    email TEXT
);
CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    provider TEXT,
    phone_number TEXT,
    phone_number_normalized TEXT,
    phone_number_verification_source TEXT,
    phone_number_verified_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    idempotency_key TEXT,
    provider_selector TEXT,
    claim_token_hash VARCHAR(64),
    claim_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    target_instagram_id TEXT NOT NULL DEFAULT '0_min._.00',
    status TEXT NOT NULL DEFAULT 'ready',
    expires_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
    exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    excluded_instagram_id TEXT,
    target_followers_count INTEGER NOT NULL DEFAULT 300,
    target_following_count INTEGER NOT NULL DEFAULT 100,
    required_plan_id TEXT NOT NULL DEFAULT 'basic',
    pricing_version TEXT NOT NULL DEFAULT 'earlybird-2026-08-v5',
    pricing_snapshot JSONB NOT NULL DEFAULT '{"basic":{"status":"quoted","currency":"KRW","amountKrw":9900},"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
    plan_cards_snapshot JSONB NOT NULL DEFAULT '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    target_input_hash TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL,
    preflight_id UUID,
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER NOT NULL DEFAULT 300,
    target_following_count INTEGER NOT NULL DEFAULT 100,
    exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    excluded_instagram_id TEXT,
    plan_id TEXT NOT NULL,
    pricing_version TEXT NOT NULL DEFAULT 'earlybird-2026-08-v5',
    expected_amount_krw INTEGER NOT NULL DEFAULT 19900,
    expected_groble_product_id TEXT NOT NULL DEFAULT 'standard-product-01',
    buyer_match_policy TEXT NOT NULL DEFAULT 'verified_kakao_phone',
    expected_buyer_phone_number_normalized TEXT,
    expected_buyer_phone_verification_source TEXT,
    expected_buyer_phone_verified_at TIMESTAMPTZ,
    disclosure_version TEXT NOT NULL DEFAULT 'earlybird-auto-start-v2',
    disclosure_text TEXT NOT NULL DEFAULT '결제 확인 후 판독이 자동으로 시작됩니다.',
    disclosure_accepted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    status TEXT NOT NULL DEFAULT 'payment_pending',
    payment_id TEXT,
    actual_groble_product_id TEXT,
    paid_at TIMESTAMPTZ,
    actual_amount_krw INTEGER,
    seller_reference_confirmed_at TIMESTAMPTZ,
    result_request_id UUID,
    groble_seller_reference TEXT,
    due_at TIMESTAMPTZ,
    plan_sequence SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY
);
CREATE TABLE public.earlybird_webhook_events (
    order_id UUID PRIMARY KEY
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
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, provider_selector, target_instagram_id,
        status, expires_at
    ) VALUES (
        extensions.gen_random_uuid(), p_user_id, p_idempotency_key, 'authenticated_apify',
        p_target_instagram_id, 'ready',
        pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
    )
    RETURNING id, FALSE, status, expires_at
    INTO preflight_id, created, preflight_status, expires_at;
    created := TRUE;
    RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;
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

describe('durable earlybird checkout supersession marker', () => {
    it('keeps same-preflight replay valid, marks the older order, and survives newer-preflight deletion', async () => {
        const db = await createLineageDatabase();

        const created = await createLineageCheckout(db, LINEAGE_OLDER_PREFLIGHT_ID);
        expect(created.rows[0]).toMatchObject({
            created: true,
            disposition: 'created',
        });
        const orderId = created.rows[0]?.order_id;
        expect(orderId).toBeTruthy();

        const replay = await createLineageCheckout(db, LINEAGE_OLDER_PREFLIGHT_ID);
        expect(replay.rows[0]).toMatchObject({
            order_id: orderId,
            created: false,
            disposition: 'replayed',
        });

        await db.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, target_instagram_id, status, expires_at,
                 exclusion_decision, target_followers_count, target_following_count,
                 required_plan_id, pricing_version, pricing_snapshot,
                 plan_cards_snapshot, created_at, updated_at
             ) VALUES (
                 $1, $2, '0_min._.00', 'ready', clock_timestamp() + INTERVAL '30 minutes',
                 'skip', 300, 100, 'standard', 'earlybird-2026-08-v5',
                 '{"basic":{"status":"quoted","currency":"KRW","amountKrw":9900},"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                 '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
                 clock_timestamp(), clock_timestamp())`,
            [LINEAGE_NEWER_PREFLIGHT_ID, ADMIN_ID],
        );

        const superseded = await createLineageCheckout(db, LINEAGE_NEWER_PREFLIGHT_ID);
        expect(superseded.rows[0]).toMatchObject({
            order_id: orderId,
            created: false,
            disposition: 'superseded',
        });
        await expect(db.query<{
            status: string;
            checkout_blocked_at: string | null;
            checkout_blocked_reason: string | null;
        }>(
            `SELECT status, checkout_blocked_at, checkout_blocked_reason
             FROM public.earlybird_orders WHERE id = $1`,
            [orderId],
        )).resolves.toMatchObject({
            rows: [{
                status: 'payment_pending',
                checkout_blocked_reason: 'SUPERSEDED_LINEAGE',
            }],
        });

        await db.query(
            `UPDATE public.analysis_preflights SET status = 'expired' WHERE id = $1`,
            [LINEAGE_NEWER_PREFLIGHT_ID],
        );
        await db.query(
            `DELETE FROM public.analysis_preflights WHERE id = $1`,
            [LINEAGE_NEWER_PREFLIGHT_ID],
        );

        const blockedReplay = await createLineageCheckout(db, LINEAGE_OLDER_PREFLIGHT_ID);
        expect(blockedReplay.rows[0]).toMatchObject({
            order_id: orderId,
            created: false,
            disposition: 'superseded',
        });
        await expect(db.query<{ status: string; checkout_blocked_reason: string }>(
            `SELECT status, checkout_blocked_reason
             FROM public.earlybird_orders WHERE id = $1`,
            [orderId],
        )).resolves.toMatchObject({
            rows: [{ status: 'payment_pending', checkout_blocked_reason: 'SUPERSEDED_LINEAGE' }],
        });
    });
});

async function createCleanupDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(cleanupBootstrap);
    await db.exec(effectiveV5CheckoutMigration);
    await db.query(
        `INSERT INTO auth.users(id, email) VALUES ($1, $2), ($3, $4)`,
        [ADMIN_ID, 'ym1113@kakao.com', EXTERNAL_ID, 'external@example.com'],
    );
    await db.query(
        `INSERT INTO public.users(
             id, email, provider, phone_number, phone_number_normalized,
             phone_number_verification_source, phone_number_verified_at
         ) VALUES
             ($1, $2, 'kakao', '010-1234-5678', '+821012345678', 'kakao_rest_api', clock_timestamp()),
             ($3, $4, 'kakao', '010-9999-9999', '+821099999999', 'kakao_rest_api', clock_timestamp())`,
        [ADMIN_ID, 'ym1113@kakao.com', EXTERNAL_ID, 'external@example.com'],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(id, user_id) VALUES ($1, $2), ($3, $4)`,
        [ADMIN_PREFLIGHT_ID, ADMIN_ID, EXTERNAL_PREFLIGHT_ID, EXTERNAL_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders(
             id, user_id, preflight_id, target_instagram_id, plan_id, status,
             payment_id, paid_at, actual_amount_krw,
             seller_reference_confirmed_at, result_request_id
         ) VALUES (
             $1, $2, $5, '0_min._.00', 'standard', 'payment_pending',
             NULL, NULL, NULL, NULL, NULL
         ), (
             $3, $4, $6, 'external.account', 'standard', 'payment_pending',
             NULL, NULL, NULL, NULL, NULL
         )`,
        [
            ADMIN_ORDER_ID,
            ADMIN_ID,
            EXTERNAL_ORDER_ID,
            EXTERNAL_ID,
            ADMIN_PREFLIGHT_ID,
            EXTERNAL_PREFLIGHT_ID,
        ],
    );
    return db;
}

async function createLineageDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(cleanupBootstrap);
    await db.exec(effectiveV5CheckoutMigration);
    await db.exec(recoveryMigration);
    await db.query(
        `INSERT INTO public.users(
             id, email, provider, phone_number, phone_number_normalized,
             phone_number_verification_source, phone_number_verified_at
         ) VALUES ($1, $2, 'kakao', '010-1234-5678', '+821012345678',
                   'kakao_rest_api', clock_timestamp())`,
        [ADMIN_ID, 'ym1113@kakao.com'],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, target_instagram_id, status, expires_at,
             exclusion_decision, target_followers_count, target_following_count,
             required_plan_id, pricing_version, pricing_snapshot,
             plan_cards_snapshot, created_at, updated_at
         ) VALUES
             ($1, $2, '0_min._.00', 'ready', clock_timestamp() + INTERVAL '30 minutes',
              'skip', 300, 100, 'standard', 'earlybird-2026-08-v5',
              '{"basic":{"status":"quoted","currency":"KRW","amountKrw":9900},"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
              '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
              clock_timestamp() - INTERVAL '1 minute', clock_timestamp() - INTERVAL '1 minute')`,
        [LINEAGE_OLDER_PREFLIGHT_ID, ADMIN_ID],
    );
    return db;
}

async function createLineageCheckout(
    db: PGlite,
    preflightId: string,
) {
    return asRole<{
        order_id: string;
        created: boolean;
        disposition: string;
    }>(
        db,
        'service_role',
        null,
        `SELECT * FROM public.create_earlybird_checkout_with_lineage_marker(
             $1, $2, 'standard', 'standard-product-01', 19900,
             'earlybird-2026-08-v5', 'earlybird-auto-start-v2',
             '결제 확인 후 판독이 자동으로 시작됩니다.', clock_timestamp()
         )`,
        [ADMIN_ID, preflightId],
    );
}

async function orderStatus(db: PGlite, orderId: string) {
    return db.query<{ status: string }>(
        `SELECT status FROM public.earlybird_orders WHERE id = $1`,
        [orderId],
    );
}

describe('administrator test-order cleanup migration behavior', () => {
    it('deletes exactly the confirmed administrator test order and preserves users/preflights/external orders', async () => {
        const db = await createCleanupDatabase();
        await db.exec(cleanupMigration);

        await expect(orderStatus(db, ADMIN_ORDER_ID)).resolves.toMatchObject({
            rows: [],
        });
        await expect(orderStatus(db, EXTERNAL_ORDER_ID)).resolves.toMatchObject({
            rows: [{ status: 'payment_pending' }],
        });
        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM auth.users JOIN public.users USING(id)`,
        )).resolves.toMatchObject({ rows: [{ count: 2 }] });
        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_preflights`,
        )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    });

    it('allows the preserved administrator to create a fresh same-product Standard checkout under v5', async () => {
        const db = await createCleanupDatabase();
        await db.exec(cleanupMigration);

        const fresh = await db.query<{
            order_id: string;
            created: boolean;
        }>(
            `SELECT * FROM public.create_earlybird_checkout(
                 $1, $2, 'standard', 'standard-product-01', 19900,
                 'earlybird-2026-08-v5', 'earlybird-auto-start-v2',
                 '결제 확인 후 판독이 자동으로 시작됩니다.', clock_timestamp()
             )`,
            [ADMIN_ID, ADMIN_PREFLIGHT_ID],
        );

        expect(fresh.rows[0]).toMatchObject({ created: true });
        await expect(db.query<{
            user_id: string;
            target_instagram_id: string;
            plan_id: string;
            pricing_version: string;
            expected_amount_krw: number;
        }>(
            `SELECT user_id, target_instagram_id, plan_id, pricing_version,
                    expected_amount_krw
             FROM public.earlybird_orders
             WHERE id = $1`,
            [fresh.rows[0]?.order_id],
        )).resolves.toMatchObject({
            rows: [{
                user_id: ADMIN_ID,
                target_instagram_id: '0_min._.00',
                plan_id: 'standard',
                pricing_version: 'earlybird-2026-08-v5',
                expected_amount_krw: 19_900,
            }],
        });
    });

    it.each([
        ['multiple candidates', async (db: PGlite) => {
            await db.query(
                `INSERT INTO public.earlybird_orders(
                     id, user_id, preflight_id, target_instagram_id, plan_id, status,
                     payment_id, paid_at, actual_amount_krw,
                     seller_reference_confirmed_at, result_request_id
                 ) VALUES ($1, $2, $3, '0_min._.00', 'standard', 'payment_pending', NULL, NULL, NULL, NULL, NULL)`,
                [
                    '20000000-0000-4000-8000-000000000008',
                    ADMIN_ID,
                    ADMIN_PREFLIGHT_ID,
                ],
            );
        }],
        ['payment evidence', async (db: PGlite) => {
            await db.query(
                `UPDATE public.earlybird_orders SET payment_id = 'payment-evidence' WHERE id = $1`,
                [ADMIN_ORDER_ID],
            );
        }],
        ['provider product evidence', async (db: PGlite) => {
            await db.query(
                `UPDATE public.earlybird_orders
                 SET actual_groble_product_id = 'standard-product-01'
                 WHERE id = $1`,
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
