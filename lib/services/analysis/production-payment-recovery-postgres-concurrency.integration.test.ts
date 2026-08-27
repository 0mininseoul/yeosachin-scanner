import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.PRODUCTION_PAYMENT_RECOVERY_POSTGRES_TEST_URL;
const suppliedMarker = process.env.PRODUCTION_PAYMENT_RECOVERY_POSTGRES_TEST_MARKER;
const destructiveTestMarker = 'local-ephemeral-production-payment-recovery-only';
const describePostgres = isSafeProductionPaymentRecoveryPostgresTestTarget(
    databaseUrl,
    suppliedMarker,
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

const USER_ID = '41000000-0000-4000-8000-000000000001';
const ANONYMOUS_PREFLIGHT_ID = '41000000-0000-4000-8000-000000000002';
const OWNER_PREFLIGHT_ID = '41000000-0000-4000-8000-000000000003';
const CLAIM_TOKEN_HASH = 'a'.repeat(64);

const bootstrap = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS private CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS extensions CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
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

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$
    SELECT pg_catalog.gen_random_uuid()
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX earlybird_orders_one_pending_per_user
    ON public.earlybird_orders(user_id)
    WHERE status = 'payment_pending';

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
LANGUAGE sql
AS $$
    SELECT NULL::UUID, FALSE, NULL::TEXT, NULL::TIMESTAMPTZ
    WHERE FALSE
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

async function createOnClient(
    client: PoolClient,
    preflightId: string,
): Promise<{ order_id: string; created: boolean }> {
    await client.query('BEGIN');
    await setSessionRole(client, 'service_role');
    const result = await client.query<{ order_id: string; created: boolean }>(
        `SELECT * FROM public.create_earlybird_checkout(
             $1, $2, 'standard', 'standard-product-01', 19900,
             'earlybird-2026-08-v5', 'earlybird-auto-start-v2',
             '결제 확인 후 판독이 자동으로 시작됩니다.', pg_catalog.clock_timestamp()
         )`,
        [USER_ID, preflightId],
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
            `TRUNCATE public.earlybird_orders, public.analysis_preflights, public.users`,
        );
    });

    afterAll(async () => {
        await pool?.end();
    });

    it.each([
        ['same target, claim first', true, true],
        ['same target, create first', true, false],
        ['different target, claim first', false, true],
        ['different target, create first', false, false],
    ] as const)(
        'serializes %s without deadlock or dual active ownership',
        async (_label, sameTarget, claimFirst) => {
            const anonymousTarget = sameTarget ? 'same.account' : 'anonymous.account';
            const ownerTarget = sameTarget ? 'same.account' : 'owner.account';
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
            await pool.query(
                `INSERT INTO public.analysis_preflights(
                     id, user_id, provider_selector, claim_token_hash,
                     claim_expires_at, target_instagram_id, status, expires_at,
                     exclusion_decision, access_mode, plan_cards_snapshot,
                     pricing_version, pricing_snapshot, target_followers_count,
                     target_following_count, required_plan_id, created_at, updated_at
                 ) VALUES
                     ($1, NULL, 'anonymous_apify', $2,
                      pg_catalog.clock_timestamp() + INTERVAL '10 minutes', $3,
                      'ready', pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                      'skip', 'anonymous',
                      '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
                      'earlybird-2026-08-v5',
                      '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                      300, 100, 'standard',
                      pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                      pg_catalog.clock_timestamp() - INTERVAL '2 minutes'),
                     ($4, $5, 'authenticated_apify', NULL, NULL, $6,
                      'ready', pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                      'skip', 'production',
                      '{"basic":{"selectionState":"available_upgrade"},"standard":{"selectionState":"required"}}'::jsonb,
                      'earlybird-2026-08-v5',
                      '{"standard":{"status":"quoted","currency":"KRW","amountKrw":19900}}'::jsonb,
                      300, 100, 'standard',
                      pg_catalog.clock_timestamp() - INTERVAL '1 minute',
                      pg_catalog.clock_timestamp() - INTERVAL '1 minute')`,
                [
                    ANONYMOUS_PREFLIGHT_ID,
                    CLAIM_TOKEN_HASH,
                    anonymousTarget,
                    OWNER_PREFLIGHT_ID,
                    USER_ID,
                    ownerTarget,
                ],
            );

            const first = await pool.connect();
            const second = await pool.connect();
            try {
                const secondPid = await second.query<{ pid: number }>(
                    'SELECT pg_catalog.pg_backend_pid() AS pid',
                );
                const firstResult = claimFirst
                    ? await claimOnClient(first, ANONYMOUS_PREFLIGHT_ID)
                    : await createOnClient(first, OWNER_PREFLIGHT_ID);
                const secondResultPromise = claimFirst
                    ? createOnClient(second, OWNER_PREFLIGHT_ID)
                    : claimOnClient(second, ANONYMOUS_PREFLIGHT_ID);
                await waitForLockWait(pool, secondPid.rows[0].pid);
                await first.query('COMMIT');
                const secondResult = await secondResultPromise;
                await second.query('COMMIT');

                const claimResult = claimFirst ? firstResult : secondResult;
                const createResult = claimFirst ? secondResult : firstResult;
                expect(claimResult).toMatchObject({
                    claimed: false,
                    preflight_status: sameTarget
                        ? 'owner_active'
                        : 'owner_active_other_target',
                });
                expect(createResult).toMatchObject({ created: true });
                await expect(pool.query<{ count: number }>(
                    `SELECT count(*)::INTEGER AS count
                     FROM public.analysis_preflights
                     WHERE user_id = $1 AND status IN ('pending', 'processing', 'ready')`,
                    [USER_ID],
                )).resolves.toMatchObject({ rows: [{ count: 1 }] });
                await expect(pool.query<{ count: number }>(
                    `SELECT count(*)::INTEGER AS count
                     FROM public.earlybird_orders
                     WHERE user_id = $1 AND status = 'payment_pending'`,
                    [USER_ID],
                )).resolves.toMatchObject({ rows: [{ count: 1 }] });
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
        },
    );

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
