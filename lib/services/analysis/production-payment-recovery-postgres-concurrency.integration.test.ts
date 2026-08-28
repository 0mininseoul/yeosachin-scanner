import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.PRODUCTION_PAYMENT_RECOVERY_POSTGRES_TEST_URL;
const suppliedMarker = process.env.PRODUCTION_PAYMENT_RECOVERY_POSTGRES_TEST_MARKER;
const destructiveTestMarker = 'local-ephemeral-production-payment-recovery-only';
const nativePostgresRequired = process.env.PRODUCTION_PAYMENT_RECOVERY_POSTGRES_TEST_REQUIRED === 'true';
const describePostgres = (
    isSafeProductionPaymentRecoveryPostgresTestTarget(databaseUrl, suppliedMarker)
    || nativePostgresRequired
) ? describe : describe.skip;

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const checkoutMigration = readFileSync(
    new URL('20260812122517_update_earlybird_pricing_v5.sql', migrationsDirectory),
    'utf8',
);
const recoveryMigration = readFileSync(
    new URL('20260827172857_production_preflight_checkout_recovery.sql', migrationsDirectory),
    'utf8',
);
const cleanupOperation = readFileSync(
    new URL('20260828_cleanup_confirmed_administrator_test_order.sql', new URL('../../../supabase/operations/', import.meta.url)),
    'utf8',
);
const productionCleanupFingerprint =
    'ca805b0332bcbf8a263c4ffcfa7bd792226f555d8f2d37f928b30544912b6a52';

const USER_ID = '41000000-0000-4000-8000-000000000001';
const ANONYMOUS_PREFLIGHT_ID = '41000000-0000-4000-8000-000000000002';
const OWNER_PREFLIGHT_ID = '41000000-0000-4000-8000-000000000003';
const CLAIM_TOKEN_HASH = 'a'.repeat(64);
const ADMIN_ID = '41000000-0000-4000-8000-000000000004';
const ADMIN_PREFLIGHT_ID = '41000000-0000-4000-8000-000000000005';
const ADMIN_ORDER_ID = '41000000-0000-4000-8000-000000000006';

const bootstrap = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS private CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS extensions CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto;
DO $$ BEGIN
    CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE ROLE service_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE auth.users (
    id UUID PRIMARY KEY,
    email TEXT
);

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$
    SELECT pg_catalog.gen_random_uuid()
$$;

CREATE FUNCTION extensions.digest(data BYTEA, algorithm TEXT)
RETURNS BYTEA LANGUAGE sql IMMUTABLE AS $$
    SELECT public.digest(data, algorithm)
$$;

CREATE FUNCTION public.normalize_kr_mobile_e164(raw_phone TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN pg_catalog.regexp_replace(raw_phone, '[^0-9]', '', 'g') ~ '^010[0-9]{8}$'
        THEN '+82' || pg_catalog.substr(pg_catalog.regexp_replace(raw_phone, '[^0-9]', '', 'g'), 2)
        ELSE NULL
    END
$$;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    provider TEXT,
    phone_number TEXT,
    phone_number_normalized TEXT,
    phone_number_verification_source TEXT,
    phone_number_verified_at TIMESTAMPTZ
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID,
    idempotency_key TEXT,
    provider_selector TEXT,
    claim_token_hash VARCHAR(64),
    claim_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    error_code TEXT,
    blocked_at TIMESTAMPTZ,
    target_instagram_id TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
    access_mode TEXT,
    launch_status_snapshot JSONB,
    plan_catalog_snapshot JSONB,
    plan_cards_snapshot JSONB NOT NULL,
    pricing_version TEXT NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    required_plan_id TEXT,
    target_input_hash TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_preflights_blocked_payload_check CHECK (
        (status = 'blocked' AND error_code IS NOT NULL AND blocked_at IS NOT NULL)
        OR (status <> 'blocked' AND error_code IS NULL AND blocked_at IS NULL)
    )
);
CREATE UNIQUE INDEX analysis_preflights_user_idempotency_idx
    ON public.analysis_preflights(user_id, idempotency_key)
    WHERE user_id IS NOT NULL;

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL,
    preflight_id UUID,
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
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
    status TEXT NOT NULL DEFAULT 'payment_pending',
    payment_id TEXT,
    actual_groble_product_id TEXT,
    actual_amount_krw INTEGER,
    paid_at TIMESTAMPTZ,
    due_at TIMESTAMPTZ,
    plan_sequence SMALLINT,
    result_request_id UUID,
    checkout_blocked_at TIMESTAMPTZ,
    checkout_blocked_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX earlybird_orders_one_pending_per_user
    ON public.earlybird_orders(user_id)
    WHERE status = 'payment_pending';
CREATE TABLE public.analysis_requests (id UUID PRIMARY KEY);
CREATE TABLE public.earlybird_fulfillments (order_id UUID PRIMARY KEY);
CREATE TABLE public.earlybird_webhook_events (order_id UUID PRIMARY KEY);

-- The migration under test keeps this previous RPC available and wraps it.
-- The function is replaced by the effective v5 checkout migration below.
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
    -- Match the effective production create RPC: the public.users row is the
    -- serialization boundary shared with the anonymous claim helper. Do not
    -- add a synthetic advisory lock that production does not acquire.
    PERFORM 1
    FROM public.users AS owner_user
    WHERE owner_user.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ANALYSIS_V2_INVALID_AUTH_INPUT';
    END IF;

    SELECT preflight.* INTO v_existing
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        RETURN QUERY SELECT v_existing.id, FALSE, v_existing.status, v_existing.expires_at;
        RETURN;
    END IF;

    -- A fresh create supersedes unfinished active preflights only after the
    -- user row has serialized it against a concurrent anonymous claim.
    UPDATE public.analysis_preflights
    SET status = 'expired',
        updated_at = pg_catalog.clock_timestamp()
    WHERE user_id = p_user_id
      AND status IN ('pending', 'processing', 'ready');

    v_id := pg_catalog.gen_random_uuid();
    v_expires := pg_catalog.clock_timestamp() + INTERVAL '30 minutes';
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, provider_selector, target_instagram_id,
        status, expires_at, exclusion_decision, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, required_plan_id,
        created_at, updated_at
    ) VALUES (
        v_id, p_user_id, p_idempotency_key, 'authenticated_apify',
        p_target_instagram_id, 'ready', v_expires, 'skip', p_access_mode,
        p_launch_status_snapshot, p_plan_catalog_snapshot,
        '{"standard":{"selectionState":"required"}}'::jsonb,
        p_pricing_version, p_pricing_snapshot, 'standard',
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    );
    RETURN QUERY SELECT v_id, TRUE, 'ready'::TEXT, v_expires;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;
`;

export function isSafeProductionPaymentRecoveryPostgresTestTarget(
    connectionString: string | undefined,
    marker: string | undefined,
): boolean {
    if (!connectionString || marker !== destructiveTestMarker) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/production_payment_recovery_test';
    } catch {
        return false;
    }
}

describe('production payment recovery PostgreSQL destructive-test target guard', () => {
    it('accepts only the explicitly marked loopback disposable database', () => {
        expect(isSafeProductionPaymentRecoveryPostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/production_payment_recovery_test',
            destructiveTestMarker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/production_payment_recovery_test', destructiveTestMarker],
        ['postgresql://tester@127.0.0.1:55432/postgres', destructiveTestMarker],
        ['postgresql://tester@127.0.0.1:55432/production_payment_recovery_test', undefined],
    ])('rejects an unsafe target or missing marker', (connectionString, marker) => {
        expect(isSafeProductionPaymentRecoveryPostgresTestTarget(connectionString, marker)).toBe(false);
    });

    it('does not silently skip a native run when the CI gate is required', () => {
        if (nativePostgresRequired) {
            expect(isSafeProductionPaymentRecoveryPostgresTestTarget(
                databaseUrl,
                suppliedMarker,
            )).toBe(true);
        }
    });
});

async function waitForLockWait(
    pool: Pool,
    blockedPid: number,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await pool.query<{
            wait_event_type: string | null;
        }>(
            `SELECT wait_event_type
             FROM pg_catalog.pg_stat_activity
             WHERE pid = $1`,
            [blockedPid],
        );
        if (result.rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('PRODUCTION_PAYMENT_RECOVERY_LOCK_WAIT_TIMEOUT');
}

async function waitForUsersRowLockWait(
    pool: Pool,
    blockedPid: number,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await pool.query<{ wait_event_type: string | null; blocker_count: number }>(
            `SELECT activity.wait_event_type,
                    pg_catalog.cardinality(pg_catalog.pg_blocking_pids(activity.pid))::INTEGER AS blocker_count
             FROM pg_catalog.pg_stat_activity AS activity
             WHERE activity.pid = $1`,
            [blockedPid],
        );
        if (
            result.rows[0]?.wait_event_type === 'Lock'
            && result.rows[0].blocker_count > 0
        ) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('PRODUCTION_PAYMENT_RECOVERY_USERS_ROW_LOCK_WAIT_TIMEOUT');
}

async function waitForAdvisoryLockWait(
    pool: Pool,
    blockedPid: number,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await pool.query(
            `SELECT 1
             FROM pg_catalog.pg_locks
             WHERE pid = $1
               AND locktype = 'advisory'
               AND mode = 'ExclusiveLock'
               AND NOT granted
             LIMIT 1`,
            [blockedPid],
        );
        if (result.rowCount === 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('PRODUCTION_PAYMENT_RECOVERY_ADVISORY_LOCK_WAIT_TIMEOUT');
}

async function waitForAnalysisAnonymousPreflightAdvisoryWait(
    pool: Pool,
    blockedPid: number,
    userId: string,
): Promise<void> {
    const keyResult = await pool.query<{ lock_key: string }>(
        `SELECT pg_catalog.hashtextextended(
             'analysis-anonymous-preflight:' || $1,
             0
         )::TEXT AS lock_key`,
        [userId],
    );
    const lockKey = BigInt(keyResult.rows[0]?.lock_key ?? '0');
    const unsignedKey = BigInt.asUintN(64, lockKey);
    const classId = (unsignedKey >> BigInt(32)) & BigInt(0xffffffff);
    const objectId = unsignedKey & BigInt(0xffffffff);

    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await pool.query(
            `SELECT 1
             FROM pg_catalog.pg_locks
             WHERE pid = $1
               AND locktype = 'advisory'
               AND mode = 'ExclusiveLock'
               AND NOT granted
               AND classid::BIGINT = $2::BIGINT
               AND objid::BIGINT = $3::BIGINT
             LIMIT 1`,
            [blockedPid, classId.toString(), objectId.toString()],
        );
        if (result.rowCount === 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('PRODUCTION_PAYMENT_RECOVERY_ANALYSIS_PREFLIGHT_ADVISORY_LOCK_WAIT_TIMEOUT');
}

async function setSessionRole(
    client: PoolClient,
    role: 'authenticated' | 'service_role',
    userId?: string,
): Promise<void> {
    await client.query(`SET LOCAL ROLE ${role}`);
    if (userId) {
        await client.query(
            `SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, TRUE)`,
            [userId],
        );
    }
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
}

async function claimOnClient(
    client: PoolClient,
    preflightId: string,
): Promise<{
    claimed: boolean;
    preflight_status: string;
    owner_preflight_id: string | null;
}> {
    await client.query('BEGIN');
    await setSessionRole(client, 'authenticated', USER_ID);
    const result = await client.query<{
        claimed: boolean;
        preflight_status: string;
        owner_preflight_id: string | null;
    }>(
        `SELECT * FROM public.claim_anonymous_analysis_v2_preflight($1, $2, $3)`,
        [preflightId, CLAIM_TOKEN_HASH, USER_ID],
    );
    return result.rows[0];
}

async function createPreflightWithTargetHashOnClient(
    client: PoolClient,
    idempotencyKey: string,
    targetInputHash: string,
): Promise<{
    preflight_id: string;
    created: boolean;
    preflight_status: string;
    expires_at: string;
}> {
    await client.query('BEGIN');
    await setSessionRole(client, 'service_role');
    const result = await client.query<{
        preflight_id: string;
        created: boolean;
        preflight_status: string;
        expires_at: string;
    }>(
        `SELECT * FROM public.create_or_replay_analysis_v2_preflight_with_target_hash(
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12
         )`,
        [
            USER_ID,
            'native-owner@example.test',
            'kakao',
            'target.account',
            idempotencyKey,
            'production',
            JSON.stringify({ version: 1 }),
            JSON.stringify({ version: 1 }),
            'earlybird-2026-08-v5',
            JSON.stringify({ version: 1 }),
            JSON.stringify({ version: 1 }),
            targetInputHash,
        ],
    );
    return result.rows[0];
}

async function createWithLineageMarkerOnClient(
    client: PoolClient,
    preflightId: string,
): Promise<{ order_id: string; created: boolean; disposition: string }> {
    await client.query('BEGIN');
    await setSessionRole(client, 'service_role');
    const result = await client.query<{
        order_id: string;
        created: boolean;
        disposition: string;
    }>(
        `SELECT * FROM public.create_earlybird_checkout_with_lineage_marker(
             $1, $2, 'standard', 'standard-product-01', 19900,
             'earlybird-2026-08-v5', 'earlybird-auto-start-v2',
             '결제 확인 후 판독이 자동으로 시작됩니다.', pg_catalog.clock_timestamp()
         )`,
        [USER_ID, preflightId],
    );
    return result.rows[0];
}

async function cleanupOperationForFixture(pool: Pool): Promise<string> {
    const result = await pool.query<{ fingerprint: string }>(
        `SELECT pg_catalog.encode(
             extensions.digest(
                 pg_catalog.convert_to(
                     'earlybird-admin-cleanup:v1|'
                     || id::TEXT
                     || '|'
                     || groble_seller_reference
                     || '|'
                     || pg_catalog.to_char(
                         created_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                     ),
                     'UTF8'
                 ),
                 'sha256'
             ),
             'hex'
         ) AS fingerprint
         FROM public.earlybird_orders
         WHERE id = $1
           AND groble_seller_reference IS NOT NULL
           AND created_at IS NOT NULL`,
        [ADMIN_ORDER_ID],
    );
    const fingerprint = result.rows[0]?.fingerprint;
    if (!fingerprint) throw new Error('CLEANUP_FIXTURE_FINGERPRINT_MISSING');
    return cleanupOperation.replaceAll(productionCleanupFingerprint, fingerprint);
}

describePostgres('production payment recovery migration two-session concurrency', () => {
    let pool: Pool;

    beforeAll(async () => {
        if (!isSafeProductionPaymentRecoveryPostgresTestTarget(
            databaseUrl,
            suppliedMarker,
        )) {
            throw new Error(
                'Refusing destructive PostgreSQL test: use the loopback production_payment_recovery_test database and explicit marker.',
            );
        }
        pool = new Pool({ connectionString: databaseUrl, max: 4 });
        const identity = await pool.query<{ database_name: string }>(
            'SELECT pg_catalog.current_database() AS database_name',
        );
        if (identity.rows[0]?.database_name !== 'production_payment_recovery_test') {
            throw new Error(
                'Refusing destructive PostgreSQL test against an unexpected database.',
            );
        }
        await pool.query(bootstrap);
        await pool.query(checkoutMigration);
        await pool.query(recoveryMigration);
    }, 30_000);

    beforeEach(async () => {
        await pool.query(
            `TRUNCATE public.earlybird_orders, public.analysis_preflights, public.users, auth.users`,
        );
    });

    afterAll(async () => {
        await pool?.end();
    });

    it('serializes concurrent target-hash preflight creation through the create wrapper', async () => {
        await pool.query(
            `INSERT INTO public.users(
                 id, email, provider, phone_number, phone_number_normalized,
                 phone_number_verification_source, phone_number_verified_at
             ) VALUES (
                 $1, 'native-owner@example.test', 'kakao', '010-1234-5678',
                 '+821012345678', 'kakao_rest_api', pg_catalog.clock_timestamp()
             )`,
            [USER_ID],
        );

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const secondPid = await second.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            const firstResult = await createPreflightWithTargetHashOnClient(
                first,
                'native-target-hash-idempotency',
                'b'.repeat(64),
            );
            const secondResultPromise = createPreflightWithTargetHashOnClient(
                second,
                'native-target-hash-idempotency',
                'b'.repeat(64),
            );
            await waitForLockWait(pool, secondPid.rows[0].pid);
            await first.query('COMMIT');
            const secondResult = await secondResultPromise;
            await second.query('COMMIT');

            expect(firstResult).toMatchObject({ created: true, preflight_status: 'ready' });
            expect(secondResult).toMatchObject({
                created: false,
                preflight_id: firstResult.preflight_id,
                preflight_status: 'ready',
            });
            await expect(pool.query<{ count: number; target_input_hash: string }>(
                `SELECT count(*)::INTEGER AS count,
                        max(target_input_hash) AS target_input_hash
                 FROM public.analysis_preflights
                 WHERE user_id = $1 AND idempotency_key = $2`,
                [USER_ID, 'native-target-hash-idempotency'],
            )).resolves.toMatchObject({
                rows: [{ count: 1, target_input_hash: 'b'.repeat(64) }],
            });
        } catch (error) {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });

    it('blocks target-hash creation behind an anonymous claim at the public.users row and proves the final owner state', async () => {
        await pool.query(
            `INSERT INTO public.users(
                 id, email, provider, phone_number, phone_number_normalized,
                 phone_number_verification_source, phone_number_verified_at
             ) VALUES (
                 $1, 'native-claim-create@example.test', 'kakao', '010-1234-5678',
                 '+821012345678', 'kakao_rest_api', pg_catalog.clock_timestamp()
             )`,
            [USER_ID],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, provider_selector, claim_token_hash,
                 claim_expires_at, target_instagram_id, status, expires_at,
                 exclusion_decision, access_mode, plan_cards_snapshot,
                 pricing_version, pricing_snapshot, target_followers_count,
                 target_following_count, required_plan_id, created_at, updated_at
             ) VALUES (
                 $1, NULL, 'anonymous_apify', $2,
                 pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
                 'target.account', 'ready',
                 pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                 'skip', 'anonymous',
                 '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
                 'earlybird-2026-08-v5',
                 '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                 300, 100, 'standard',
                 pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
             )`,
            [ANONYMOUS_PREFLIGHT_ID, CLAIM_TOKEN_HASH],
        );

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const secondPid = await second.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            const claimResult = await claimOnClient(first, ANONYMOUS_PREFLIGHT_ID);
            const createResultPromise = createPreflightWithTargetHashOnClient(
                second,
                'native-claim-create-idempotency',
                'b'.repeat(64),
            );
            await waitForUsersRowLockWait(pool, secondPid.rows[0].pid);
            await first.query('COMMIT');
            const createResult = await createResultPromise;
            await second.query('COMMIT');

            expect(claimResult).toMatchObject({
                claimed: true,
                preflight_status: 'claimed',
            });
            expect(createResult).toMatchObject({
                created: true,
                preflight_status: 'ready',
            });
            await expect(pool.query<{
                status: string;
                user_id: string;
                target_input_hash: string | null;
            }>(
                `SELECT status, user_id, target_input_hash
                 FROM public.analysis_preflights
                 WHERE id = $1`,
                [ANONYMOUS_PREFLIGHT_ID],
            )).resolves.toMatchObject({
                rows: [{
                    status: 'expired',
                    user_id: USER_ID,
                    target_input_hash: null,
                }],
            });
            await expect(pool.query<{ count: number }>(
                `SELECT count(*)::INTEGER AS count
                 FROM public.analysis_preflights
                 WHERE user_id = $1 AND status IN ('pending', 'processing', 'ready')`,
                [USER_ID],
            )).resolves.toMatchObject({ rows: [{ count: 1 }] });
            await expect(pool.query<{ target_input_hash: string | null }>(
                `SELECT target_input_hash
                 FROM public.analysis_preflights
                 WHERE id = $1`,
                [createResult.preflight_id],
            )).resolves.toMatchObject({ rows: [{ target_input_hash: 'b'.repeat(64) }] });
        } catch (error) {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });

    it('observes the exact ungranted analysis-anonymous-preflight advisory wait', async () => {
        await pool.query(
            `INSERT INTO public.users(
                 id, email, provider, phone_number, phone_number_normalized,
                 phone_number_verification_source, phone_number_verified_at
             ) VALUES (
                 $1, 'native-claim@example.test', 'kakao', '010-1234-5678',
                 '+821012345678', 'kakao_rest_api', pg_catalog.clock_timestamp()
             )`,
            [USER_ID],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, provider_selector, claim_token_hash,
                 claim_expires_at, target_instagram_id, status, expires_at,
                 exclusion_decision, access_mode, plan_cards_snapshot,
                 pricing_version, pricing_snapshot, target_followers_count,
                 target_following_count, required_plan_id, created_at, updated_at
             ) VALUES (
                 $1, NULL, 'anonymous_apify', $2,
                 pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
                 'same.account', 'ready',
                 pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                 'skip', 'anonymous',
                 '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
                 'earlybird-2026-08-v5',
                 '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                 300, 100, 'standard',
                 pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
             )`,
            [ANONYMOUS_PREFLIGHT_ID, CLAIM_TOKEN_HASH],
        );

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const secondPid = await second.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            const firstResult = await claimOnClient(first, ANONYMOUS_PREFLIGHT_ID);
            const secondResultPromise = claimOnClient(second, ANONYMOUS_PREFLIGHT_ID);
            await waitForAnalysisAnonymousPreflightAdvisoryWait(
                pool,
                secondPid.rows[0].pid,
                USER_ID,
            );
            await first.query('COMMIT');
            const secondResult = await secondResultPromise;
            await second.query('COMMIT');

            expect(firstResult).toMatchObject({ claimed: true, preflight_status: 'claimed' });
            expect(secondResult).toMatchObject({ claimed: false, preflight_status: 'rejected' });
        } catch (error) {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });

    it('waits for the canonical product lock before the administrator cleanup operation deletes', async () => {
        await pool.query(
            `INSERT INTO auth.users(id, email)
             VALUES ($1, 'ym1113@kakao.com')`,
            [ADMIN_ID],
        );
        await pool.query(
            `INSERT INTO public.users(
                 id, email, provider, phone_number, phone_number_normalized,
                 phone_number_verification_source, phone_number_verified_at
             ) VALUES (
                 $1, 'ym1113@kakao.com', 'kakao', '010-1234-5678',
                 '+821012345678', 'kakao_rest_api', pg_catalog.clock_timestamp()
             )`,
            [ADMIN_ID],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, target_instagram_id, status, expires_at,
                 exclusion_decision, plan_cards_snapshot, pricing_version,
                 pricing_snapshot, target_followers_count, target_following_count,
                 required_plan_id, created_at, updated_at
             ) VALUES (
                 $1, $2, '0_min._.00', 'ready',
                 pg_catalog.clock_timestamp() + INTERVAL '30 minutes', 'skip',
                 '{"standard":{"selectionState":"required"}}'::jsonb,
                 'earlybird-2026-08-v5',
                 '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                 300, 100, 'standard',
                 pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
             )`,
            [ADMIN_PREFLIGHT_ID, ADMIN_ID],
        );
        await pool.query(
            `INSERT INTO public.earlybird_orders(
                 id, user_id, preflight_id, target_instagram_id,
                 target_followers_count, target_following_count, exclusion_decision,
                 plan_id, pricing_version, expected_amount_krw,
                 expected_groble_product_id, buyer_match_policy,
                 disclosure_version, disclosure_text, disclosure_accepted_at,
                 status, payment_id, actual_groble_product_id, actual_amount_krw,
                 paid_at, groble_seller_reference, seller_reference_confirmed_at
             ) VALUES (
                 $1, $2, $3, '0_min._.00', 300, 100, 'skip', 'standard',
                 'earlybird-2026-08-v5', 19900, 'cleanup-product-v1',
                 'verified_kakao_phone', 'earlybird-auto-start-v2',
                 '결제 확인 후 판독이 자동으로 시작됩니다.', pg_catalog.clock_timestamp(),
                 'payment_pending', NULL, NULL, NULL, NULL,
                 'ord.0123456789abcdef0123456789abcdef', NULL
             )`,
            [ADMIN_ORDER_ID, ADMIN_ID, ADMIN_PREFLIGHT_ID],
        );

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const secondPid = await second.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            await first.query('BEGIN');
            await first.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                     pg_catalog.hashtextextended('earlybird:groble:product:cleanup-product-v1', 0)
                 )`,
            );
            const operationPromise = cleanupOperationForFixture(pool).then(operation => second.query(operation));
            await waitForAdvisoryLockWait(pool, secondPid.rows[0].pid);
            await first.query('COMMIT');
            const operationResult = await operationPromise;
            expect(JSON.stringify(operationResult)).toMatch(
                /earlybird-admin-test-order-cleanup:v1[\s\S]*1|1[\s\S]*earlybird-admin-test-order-cleanup:v1/,
            );

            await expect(pool.query(
                `SELECT id FROM public.earlybird_orders WHERE id = $1`,
                [ADMIN_ORDER_ID],
            )).resolves.toMatchObject({ rows: [] });
            await expect(pool.query(
                `SELECT id FROM public.users WHERE id = $1`,
                [ADMIN_ID],
            )).resolves.toMatchObject({ rows: [{ id: ADMIN_ID }] });
            await expect(pool.query(
                `SELECT id FROM public.analysis_preflights WHERE id = $1`,
                [ADMIN_PREFLIGHT_ID],
            )).resolves.toMatchObject({ rows: [{ id: ADMIN_PREFLIGHT_ID }] });
        } catch (error) {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });

    it('serializes concurrent supersession marker writes and preserves payment truth', async () => {
        await pool.query(
            `INSERT INTO public.users(
                 id, email, provider, phone_number, phone_number_normalized,
                 phone_number_verification_source, phone_number_verified_at
             ) VALUES (
                 $1, 'native-marker@example.test', 'kakao', '010-1234-5678',
                 '+821012345678', 'kakao_rest_api', pg_catalog.clock_timestamp()
             )`,
            [USER_ID],
        );
        await pool.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, target_instagram_id, status, expires_at,
                 exclusion_decision, plan_cards_snapshot, pricing_version,
                 pricing_snapshot, target_followers_count, target_following_count,
                 required_plan_id, created_at, updated_at
             ) VALUES
                 ($1, $2, 'marker.account', 'ready',
                  pg_catalog.clock_timestamp() + INTERVAL '30 minutes', 'skip',
                  '{"standard":{"selectionState":"required"}}'::jsonb,
                  'earlybird-2026-08-v5',
                  '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                  300, 100, 'standard',
                  pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                  pg_catalog.clock_timestamp() - INTERVAL '2 minutes'),
                 ($3, $2, 'marker.account', 'expired',
                  pg_catalog.clock_timestamp() + INTERVAL '30 minutes', 'skip',
                  '{"standard":{"selectionState":"required"}}'::jsonb,
                  'earlybird-2026-08-v5',
                  '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                  300, 100, 'standard',
                  pg_catalog.clock_timestamp() - INTERVAL '1 minute',
                  pg_catalog.clock_timestamp() - INTERVAL '1 minute')`,
            [OWNER_PREFLIGHT_ID, USER_ID, ANONYMOUS_PREFLIGHT_ID],
        );
        const seed = await pool.query<{ order_id: string; created: boolean }>(
            `SELECT * FROM public.create_earlybird_checkout(
                 $1, $2, 'standard', 'standard-product-01', 19900,
                 'earlybird-2026-08-v5', 'earlybird-auto-start-v2',
                 '결제 확인 후 판독이 자동으로 시작됩니다.', pg_catalog.clock_timestamp()
             )`,
            [USER_ID, OWNER_PREFLIGHT_ID],
        );
        expect(seed.rows[0]).toMatchObject({ created: true });
        await pool.query(
            `UPDATE public.earlybird_orders
             SET groble_seller_reference = 'ord.0123456789abcdef0123456789abcdef'
             WHERE id = $1`,
            [seed.rows[0]?.order_id],
        );
        await pool.query(
            `UPDATE public.analysis_preflights
             SET status = 'ready'
             WHERE id = $1`,
            [ANONYMOUS_PREFLIGHT_ID],
        );

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const secondPid = await second.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            const firstResult = await createWithLineageMarkerOnClient(
                first,
                ANONYMOUS_PREFLIGHT_ID,
            );
            const secondResultPromise = createWithLineageMarkerOnClient(
                second,
                ANONYMOUS_PREFLIGHT_ID,
            );
            await waitForAdvisoryLockWait(pool, secondPid.rows[0].pid);
            await first.query('COMMIT');
            const secondResult = await secondResultPromise;
            await second.query('COMMIT');

            expect(firstResult).toMatchObject({
                order_id: seed.rows[0]?.order_id,
                created: false,
                disposition: 'superseded',
            });
            expect(secondResult).toMatchObject({
                order_id: seed.rows[0]?.order_id,
                created: false,
                disposition: 'superseded',
            });
            await expect(pool.query<{
                status: string;
                checkout_blocked_at: string | null;
                checkout_blocked_reason: string | null;
            }>(
                `SELECT status, checkout_blocked_at, checkout_blocked_reason
                 FROM public.earlybird_orders
                 WHERE id = $1`,
                [seed.rows[0]?.order_id],
            )).resolves.toMatchObject({
                rows: [{
                    status: 'payment_pending',
                    checkout_blocked_reason: 'SUPERSEDED_LINEAGE',
                }],
            });
        } catch (error) {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });
});
