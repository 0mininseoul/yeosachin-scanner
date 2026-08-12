import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260812032216_add_authorized_revenue_settlement_readiness.sql',
        import.meta.url,
    ),
    'utf8',
);
const freshAdmissionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714030000_add_analysis_v2_fresh_admission_gate.sql',
        import.meta.url,
    ),
    'utf8',
);
const preflightId = '33333333-3333-4333-8333-333333333333';
const userId = '22222222-2222-4222-8222-222222222222';
const admissionToken = '44444444-4444-4444-8444-444444444444';
const entitlementHash = 'a'.repeat(64);
const databases: PGlite[] = [];

function functionDefinition(source: string, name: string) {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`${name} is missing`);
    const end = source.indexOf('$$;', start);
    if (end < 0) throw new Error(`${name} has no bounded body`);
    return source.slice(start, end + 3);
}

const deployedReserveDefinition = functionDefinition(
    freshAdmissionMigration,
    'reserve_analysis_v2_preflight_admission',
);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    access_mode TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    launch_status_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    plan_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    pricing_version TEXT NOT NULL DEFAULT 'deferred',
    pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    policy_versions_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    admission_status TEXT NOT NULL,
    admission_generation INTEGER NOT NULL,
    admission_selected_plan_id TEXT,
    admission_entitlement_jti_hash TEXT,
    admission_token UUID,
    admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    admission_requested_at TIMESTAMP WITH TIME ZONE,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
    admission_dispatch_state TEXT NOT NULL DEFAULT 'pending',
    admission_dispatch_generation INTEGER NOT NULL DEFAULT 0,
    admission_dispatch_token UUID,
    admission_dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    admission_dispatched_at TIMESTAMP WITH TIME ZONE,
    admission_error_code TEXT,
    admission_target_followers_count INTEGER,
    admission_target_following_count INTEGER,
    admission_capacity_required_plan_id TEXT,
    admission_required_plan_id TEXT,
    admission_plan_cards_snapshot JSONB,
    admission_failure_count INTEGER NOT NULL DEFAULT 0,
    admission_last_error_code TEXT,
    consumed_request_id UUID,
    target_input_hash TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL DEFAULT '${entitlementHash}',
    logical_provider TEXT NOT NULL DEFAULT 'apify',
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL DEFAULT 'primary',
    max_charge_usd NUMERIC(18, 12) NOT NULL DEFAULT 0.002600000000,
    run_id TEXT,
    status TEXT NOT NULL,
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp() - INTERVAL '61 seconds',
    run_started_at TIMESTAMP WITH TIME ZONE DEFAULT pg_catalog.clock_timestamp() - INTERVAL '60 seconds',
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (preflight_id, operation_key)
);

CREATE TABLE public.analysis_requests (id UUID PRIMARY KEY);
CREATE TABLE public.users (id UUID PRIMARY KEY);
CREATE TABLE public.account_e2e_test_runners (
    account_id UUID PRIMARY KEY,
    runner_plan TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (
    entitlement_jti_hash TEXT PRIMARY KEY
);

-- Forward declarations required by the additive migration-first consume gate.
-- The readiness tests do not execute these stubs; they only let PGlite compile
-- the same function signature that already exists in the production baseline.
CREATE FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID
) RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE sql AS $$
    SELECT '55555555-5555-4555-8555-555555555555'::UUID,
           TRUE,
           'bootstrap'::TEXT,
           'pending'::TEXT,
           TRUE
$$;
CREATE FUNCTION public.bind_analysis_v2_authorized_test_provider_policy(
    UUID, UUID, TEXT, TEXT, TEXT, JSONB
) RETURNS JSONB
LANGUAGE sql AS $$ SELECT '{}'::JSONB $$;

CREATE FUNCTION public.load_e2e_test_runner_v1(p_user_id UUID)
RETURNS TABLE(runner_plan TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT runner.runner_plan
    FROM public.account_e2e_test_runners AS runner
    WHERE runner.account_id = p_user_id
$$;
CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
`;

function readinessDefinition() {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission('
    );
    if (start < 0) return '';
    const end = migration.indexOf('$$;', start);
    return end < 0 ? migration.slice(start) : migration.slice(start, end + 3);
}

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(deployedReserveDefinition);
    await db.exec(migration);
    await db.exec(`
        INSERT INTO public.analysis_preflights (
            id, user_id, status, expires_at, access_mode, admission_status,
            admission_generation, admission_selected_plan_id, admission_entitlement_jti_hash, admission_token,
            admission_refreshed_at, admission_dispatch_generation, target_input_hash
        ) VALUES (
            '${preflightId}', '${userId}', 'ready',
            pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
            'test_entitlement', 'ready', 1, 'basic', '${entitlementHash}', '${admissionToken}',
            pg_catalog.clock_timestamp() - INTERVAL '3 minutes', 1, '${entitlementHash}'
        );
        INSERT INTO public.users (id) VALUES ('${userId}');
        INSERT INTO public.account_e2e_test_runners (account_id, runner_plan)
        VALUES ('${userId}', 'basic');
        INSERT INTO public.analysis_preflight_provider_runs (
            preflight_id, operation_key, status, actual_usage_usd, terminalized_at, usage_reconciled_at
        ) VALUES
            ('${preflightId}', 'target-profile-fallback', 'succeeded', 0.0025,
             pg_catalog.clock_timestamp() - INTERVAL '61 seconds', pg_catalog.clock_timestamp() - INTERVAL '31 seconds'),
            ('${preflightId}', 'target-profile-fresh-admission:g1', 'succeeded', NULL,
             pg_catalog.clock_timestamp() - INTERVAL '60 seconds', NULL);
    `);
    return db;
}

async function serviceQuery<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function readiness(db: PGlite) {
    return serviceQuery<{ result: { disposition: string } }>(db, `
        SELECT public.prepare_analysis_v2_authorized_revenue_settlement_admission(
            $1::UUID, $2::UUID, 'basic', $3::TEXT
        ) AS result
    `, [preflightId, userId, entitlementHash]);
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('authorized revenue settlement readiness', () => {
    it('keeps the exact admission retryable until provider usage settles, then re-arms that same token', async () => {
        expect(readinessDefinition()).toContain('usage_reconciled_at IS NULL');
        const db = await createDb();

        await expect(readiness(db)).resolves.toMatchObject({
            rows: [{ result: { disposition: 'pending' } }],
        });
        await expect(db.query(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_requests'
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(db.query(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_v2_test_entitlement_consumptions'
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(db.query(
            `SELECT admission_generation,
                    admission_refreshed_at < pg_catalog.clock_timestamp() - INTERVAL '2 minutes'
                        AS still_stale,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 1, still_stale: true, provider_run_count: 2 }],
        });

        await db.exec(`
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(readiness(db)).resolves.toMatchObject({
            rows: [{ result: {
                disposition: 'ready',
                admissionToken,
            } }],
        });
        await expect(db.query(
            `SELECT admission_token::TEXT AS admission_token,
                    admission_refreshed_at > pg_catalog.clock_timestamp() - INTERVAL '1 minute'
                        AS rearmed
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_token: admissionToken, rearmed: true }],
        });
    });

    it('fails closed for an extra provider generation instead of falling back to a new admission', async () => {
        const db = await createDb();
        await db.exec(`
            INSERT INTO public.analysis_preflight_provider_runs (
                preflight_id, operation_key, status, actual_usage_usd,
                terminalized_at, usage_reconciled_at
            ) VALUES (
                '${preflightId}', 'target-profile-fresh-admission:g2', 'succeeded', 0.0025,
                pg_catalog.clock_timestamp() - INTERVAL '60 seconds',
                pg_catalog.clock_timestamp() - INTERVAL '30 seconds'
            );
        `);

        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );
        await expect(db.query(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_requests'
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it('fails closed when the exact settlement fence is presented by admission generation 2', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET admission_generation = 2;
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );
        await expect(db.query(
            `SELECT admission_generation,
                    admission_refreshed_at < pg_catalog.clock_timestamp() - INTERVAL '2 minutes'
                        AS still_stale
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 2, still_stale: true }],
        });
    });

    it('keeps a stale strict generation one admission pending without reserving generation two', async () => {
        const db = await createDb();

        await expect(serviceQuery(db, `
            SELECT *
            FROM public.reserve_analysis_v2_preflight_admission(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID, $5::UUID
            )
        `, [
            preflightId,
            userId,
            entitlementHash,
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
        ])).resolves.toMatchObject({
            rows: [{
                admission_status: 'pending',
                should_enqueue: false,
                admission_generation: 1,
                dispatch_token: null,
            }],
        });
        await expect(db.query(
            `SELECT admission_generation, admission_status,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{
                admission_generation: 1,
                admission_status: 'ready',
                provider_run_count: 2,
            }],
        });
    });

    it('returns the stored stale blocked strict outcome without reserving generation two', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET status = 'blocked', admission_status = 'blocked';
        `);

        await expect(serviceQuery(db, `
            SELECT *
            FROM public.reserve_analysis_v2_preflight_admission(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID, $5::UUID
            )
        `, [
            preflightId,
            userId,
            entitlementHash,
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
        ])).resolves.toMatchObject({
            rows: [{
                admission_status: 'blocked',
                should_enqueue: false,
                admission_generation: 1,
                dispatch_token: null,
            }],
        });
        await expect(db.query(
            `SELECT admission_generation,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 1, provider_run_count: 2 }],
        });
    });

    it('keeps an already-stale generation two strict row pending without a generation-three recollection', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET admission_generation = 2, admission_dispatch_generation = 2;
        `);

        await expect(serviceQuery(db, `
            SELECT *
            FROM public.reserve_analysis_v2_preflight_admission(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID, $5::UUID
            )
        `, [
            preflightId,
            userId,
            entitlementHash,
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
        ])).resolves.toMatchObject({
            rows: [{
                admission_status: 'pending',
                should_enqueue: false,
                admission_generation: 2,
                dispatch_generation: 2,
                dispatch_token: null,
            }],
        });
        await expect(db.query(
            `SELECT admission_generation,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 2, provider_run_count: 2 }],
        });
    });

    it.each([
        'target-profile-fallback',
        'target-profile-fresh-admission:g1',
    ])('rejects an exact provider lineage whose %s source input hash differs from the preflight target hash', async operationKey => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp(),
                input_hash = '${'b'.repeat(64)}'
            WHERE preflight_id = '${preflightId}'
              AND operation_key = '${operationKey}';
        `);

        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );
    });

    it('fails closed for a nullable target hash in the first-migration four-argument readiness path', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET target_input_hash = NULL
            WHERE id = '${preflightId}';
        `);

        // The first migration must fence before it can return a retryable
        // reconciliation-pending response. It has no server-derived target
        // proof and therefore must not defer, derive, or bind a NULL hash.
        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );

        await db.exec(`
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );
        await expect(db.query(
            `SELECT target_input_hash
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ target_input_hash: null }],
        });
    });

    it('keeps a nullable target hash unbound when the two provider source hashes disagree', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET target_input_hash = NULL
            WHERE id = '${preflightId}';
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp(),
                input_hash = '${'b'.repeat(64)}'
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(readiness(db)).rejects.toThrow(
            'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'
        );
        await expect(db.query(
            `SELECT target_input_hash,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_requests) AS request_count,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_v2_test_entitlement_consumptions) AS consumption_count
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ target_input_hash: null, request_count: 0, consumption_count: 0 }],
        });
    });

    it.each([
        ['blocked', 'basic', 'b'.repeat(64)],
        ['blocked', 'standard', entitlementHash],
        ['ready', 'basic', 'b'.repeat(64)],
        ['ready', 'standard', entitlementHash],
    ])('fences a stale strict g1 %s admission when its caller identity differs without a new provider generation', async (admissionStatus, selectedPlanId, jtiHash) => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET status = CASE WHEN '${admissionStatus}' = 'blocked' THEN 'blocked' ELSE 'ready' END,
                admission_status = '${admissionStatus}'
            WHERE id = '${preflightId}';
        `);

        await expect(serviceQuery(db, `
            SELECT *
            FROM public.reserve_analysis_v2_preflight_admission(
                $1::UUID, $2::UUID, $3::TEXT, $4::TEXT, $5::UUID, $6::UUID
            )
        `, [
            preflightId,
            userId,
            selectedPlanId,
            jtiHash,
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
        ])).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        await expect(db.query(
            `SELECT admission_generation,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 1, provider_run_count: 2 }],
        });
    });

    it('leaves an unregistered test-entitlement caller on the legacy reserve path', async () => {
        const db = await createDb();
        await db.exec(`
            DELETE FROM public.account_e2e_test_runners
            WHERE account_id = '${userId}';
        `);

        await expect(serviceQuery(db, `
            SELECT *
            FROM public.reserve_analysis_v2_preflight_admission(
                $1::UUID, $2::UUID, 'standard', $3::TEXT, $4::UUID, $5::UUID
            )
        `, [
            preflightId,
            userId,
            'b'.repeat(64),
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
        ])).resolves.toMatchObject({
            rows: [{
                admission_generation: 2,
                should_enqueue: true,
            }],
        });
    });

    it('blocks the migration-first legacy consume gate for generation 2 before request creation', async () => {
        const db = await createDb();
        const consumeSql = `
            SELECT *
            FROM public.consume_analysis_v2_authorized_test_entitlement(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID,
                'target.account', 'authorized-free-e2e-v1', '{}'::JSONB
            )
        `;
        await db.exec(`
            UPDATE public.analysis_preflights
            SET admission_generation = 2;
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(serviceQuery(db, consumeSql, [
            preflightId,
            userId,
            entitlementHash,
            admissionToken,
        ])).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        await expect(db.query(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_requests'
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it('blocks the legacy authorized consume RPC until settlement, then reuses the exact token', async () => {
        const db = await createDb();
        const consumeSql = `
            SELECT *
            FROM public.consume_analysis_v2_authorized_test_entitlement(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID,
                'target.account', 'authorized-free-e2e-v1', '{}'::JSONB
            )
        `;

        await expect(serviceQuery(db, consumeSql, [
            preflightId,
            userId,
            entitlementHash,
            admissionToken,
        ])).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_PENDING');
        await expect(db.query(
            'SELECT count(*)::INTEGER AS count FROM public.analysis_requests'
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });

        await db.exec(`
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);
        await expect(serviceQuery(db, consumeSql, [
            preflightId,
            userId,
            entitlementHash,
            admissionToken,
        ])).resolves.toMatchObject({
            rows: [{ request_id: '55555555-5555-4555-8555-555555555555', created: true }],
        });

        await db.exec(`
            UPDATE public.analysis_preflights
            SET status = 'consumed', consumed_request_id = '55555555-5555-4555-8555-555555555555';
        `);
        await expect(serviceQuery(db, consumeSql, [
            preflightId,
            userId,
            entitlementHash,
            admissionToken,
        ])).resolves.toMatchObject({
            rows: [{ request_id: '55555555-5555-4555-8555-555555555555', created: true }],
        });
    });

    it('rejects a caller admission token that differs from the canonical settled token', async () => {
        const db = await createDb();
        const consumeSql = `
            SELECT *
            FROM public.consume_analysis_v2_authorized_test_entitlement(
                $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::UUID,
                'target.account', 'authorized-free-e2e-v1', '{}'::JSONB
            )
        `;
        await db.exec(`
            UPDATE public.analysis_preflight_provider_runs
            SET actual_usage_usd = 0.0025,
                usage_reconciled_at = pg_catalog.clock_timestamp()
            WHERE preflight_id = '${preflightId}'
              AND operation_key = 'target-profile-fresh-admission:g1';
        `);

        await expect(serviceQuery(db, consumeSql, [
            preflightId,
            userId,
            entitlementHash,
            '88888888-8888-4888-8888-888888888888',
        ])).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
    });

    it('marks an already-consumed preflight as replayable instead of reserving a new generation', async () => {
        const db = await createDb();
        await db.exec(`
            UPDATE public.analysis_preflights
            SET status = 'consumed', consumed_request_id = '55555555-5555-4555-8555-555555555555';
        `);

        await expect(readiness(db)).resolves.toMatchObject({
            rows: [{ result: { disposition: 'replayable' } }],
        });
        await expect(db.query(
            `SELECT admission_generation,
                    (SELECT count(*)::INTEGER
                     FROM public.analysis_preflight_provider_runs
                     WHERE preflight_id = '${preflightId}') AS provider_run_count
             FROM public.analysis_preflights
             WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({
            rows: [{ admission_generation: 1, provider_run_count: 2 }],
        });
    });

    it('keeps the settlement fence service-role-only and denies PUBLIC/anon while allowing service_role', async () => {
        const db = await createDb();
        const functionSignatures = [
            'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text)',
            'public.reserve_analysis_v2_preflight_admission(uuid,uuid,text,text,uuid,uuid)',
            'public.consume_analysis_v2_authorized_test_entitlement(uuid,uuid,text,text,uuid,text,text,jsonb)',
        ];
        for (const functionSignature of functionSignatures) {
            await expect(db.query(`
                SELECT has_function_privilege('anon', '${functionSignature}', 'EXECUTE') AS anon_execute,
                       has_function_privilege('authenticated', '${functionSignature}', 'EXECUTE') AS authenticated_execute,
                       has_function_privilege('service_role', '${functionSignature}', 'EXECUTE') AS service_execute
            `)).resolves.toMatchObject({
                rows: [{ anon_execute: false, authenticated_execute: false, service_execute: true }],
            });
            const aclResult = await db.query<{ acl: string }>(`
                SELECT COALESCE(array_to_string(proacl, ','), '') AS acl
                FROM pg_proc
                WHERE oid = '${functionSignature}'::regprocedure
            `);
            const acl = aclResult.rows[0]?.acl ?? '';
            expect(acl).toContain('service_role=X');
            expect(acl).not.toContain('anon=X');
            expect(acl).not.toContain('authenticated=X');
            expect(acl).not.toMatch(/(^|,)=X/);
        }
        const internalSignature = 'public.analysis_v2_reserve_preflight_admission_after_settlement_internal(uuid,uuid,text,text,uuid,uuid)';
        await expect(db.query(`
            SELECT has_function_privilege('anon', '${internalSignature}', 'EXECUTE') AS anon_execute,
                   has_function_privilege('authenticated', '${internalSignature}', 'EXECUTE') AS authenticated_execute,
                   has_function_privilege('service_role', '${internalSignature}', 'EXECUTE') AS service_execute
        `)).resolves.toMatchObject({
            rows: [{ anon_execute: false, authenticated_execute: false, service_execute: false }],
        });
        const functionSecurity = await db.query<{
            owner: string;
            config: string;
        }>(`
            SELECT pg_catalog.pg_get_userbyid(proowner) AS owner,
                   COALESCE(pg_catalog.array_to_string(proconfig, ','), '') AS config
            FROM pg_catalog.pg_proc
            WHERE oid = ANY(ARRAY[
                'public.prepare_analysis_v2_authorized_revenue_settlement_admission(uuid,uuid,text,text)'::regprocedure,
                'public.reserve_analysis_v2_preflight_admission(uuid,uuid,text,text,uuid,uuid)'::regprocedure,
                'public.consume_analysis_v2_authorized_test_entitlement(uuid,uuid,text,text,uuid,text,text,jsonb)'::regprocedure,
                'public.analysis_v2_reserve_preflight_admission_after_settlement_internal(uuid,uuid,text,text,uuid,uuid)'::regprocedure
            ])
        `);
        expect(functionSecurity.rows).toHaveLength(4);
        for (const row of functionSecurity.rows) {
            expect(row.owner).not.toMatch(/^(?:anon|authenticated|service_role)$/);
            expect(row.config).toContain('search_path=');
        }
        await db.exec('SET ROLE anon');
        try {
            await expect(db.query(
                `SELECT public.prepare_analysis_v2_authorized_revenue_settlement_admission(
                    '${preflightId}'::UUID, '${userId}'::UUID, 'basic', '${entitlementHash}'
                )`
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT * FROM public.reserve_analysis_v2_preflight_admission(
                    '${preflightId}'::UUID, '${userId}'::UUID, 'basic', '${entitlementHash}',
                    '${admissionToken}'::UUID, '${admissionToken}'::UUID
                )`
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
