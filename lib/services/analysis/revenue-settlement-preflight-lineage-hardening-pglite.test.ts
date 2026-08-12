import { readdirSync, readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const hotfixMigration = readFileSync(
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
const hardeningMigrationName = readdirSync(migrationsDirectory).find(name =>
    /_harden_preflight_target_lineage\.sql$/.test(name)
);
const hardeningMigration = hardeningMigrationName
    ? readFileSync(new URL(`../../../supabase/migrations/${hardeningMigrationName}`, import.meta.url), 'utf8')
    : '';

const preflightId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const admissionToken = '33333333-3333-4333-8333-333333333333';
const entitlementHash = 'a'.repeat(64);
const sourceHash = 'b'.repeat(64);
const tamperedServerHash = 'c'.repeat(64);
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
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    access_mode TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    target_instagram_id TEXT NOT NULL DEFAULT 'target.account',
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
    claim_token_hash TEXT,
    claim_expires_at TIMESTAMP WITH TIME ZONE,
    claimed_at TIMESTAMP WITH TIME ZONE,
    provider_selector TEXT NOT NULL DEFAULT 'selfhosted_auth',
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT NOT NULL DEFAULT 'pending',
    dispatch_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL DEFAULT '${sourceHash}',
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
    SELECT '44444444-4444-4444-8444-444444444444'::UUID,
           TRUE,
           'bootstrap'::TEXT,
           'pending'::TEXT,
           TRUE
$$;
CREATE FUNCTION public.bind_analysis_v2_authorized_test_provider_policy(
    UUID, UUID, TEXT, TEXT, TEXT, JSONB
) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::JSONB $$;
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

CREATE FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
RETURNS TABLE(claimed BOOLEAN, preflight_status TEXT, owner_preflight_id UUID)
LANGUAGE sql AS $$ SELECT FALSE, 'bootstrap'::TEXT, NULL::UUID $$;
CREATE FUNCTION public.create_anonymous_analysis_v2_preflight(
    TEXT, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ, JSONB, JSONB, VARCHAR, JSONB, JSONB
) RETURNS TABLE(preflight_id UUID, created BOOLEAN, preflight_status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE sql AS $$
    SELECT '55555555-5555-4555-8555-555555555555'::UUID, FALSE, 'bootstrap'::TEXT,
           pg_catalog.clock_timestamp()
$$;
CREATE FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT FALSE $$;
CREATE FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(UUID, VARCHAR, UUID)
RETURNS TABLE(should_enqueue BOOLEAN, dispatch_generation INTEGER, reservation_token UUID, preflight_status TEXT)
LANGUAGE sql AS $$ SELECT FALSE, 0, NULL::UUID, 'bootstrap'::TEXT $$;
CREATE FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(UUID, VARCHAR, INTEGER, UUID)
RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT FALSE $$;
CREATE FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT FALSE $$;

ALTER TABLE public.analysis_preflights ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_preflights TO anon, authenticated;
CREATE POLICY analysis_preflights_authenticated_owner_select
    ON public.analysis_preflights
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);
CREATE POLICY analysis_preflights_authenticated_owner_update
    ON public.analysis_preflights
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);
`;

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(deployedReserveDefinition);
    await db.exec(hotfixMigration);
    if (hardeningMigration) await db.exec(hardeningMigration);
    await db.exec(`
        INSERT INTO public.analysis_preflights (
            id, user_id, status, expires_at, access_mode, admission_status,
            admission_generation, admission_selected_plan_id, admission_entitlement_jti_hash, admission_token,
            admission_refreshed_at, admission_dispatch_generation, target_input_hash
        ) VALUES (
            '${preflightId}', '${userId}', 'ready',
            pg_catalog.clock_timestamp() + INTERVAL '10 minutes',
            'test_entitlement', 'ready', 1, 'basic', '${entitlementHash}', '${admissionToken}',
            pg_catalog.clock_timestamp() - INTERVAL '3 minutes', 1, NULL
        );
        INSERT INTO public.users (id) VALUES ('${userId}');
        INSERT INTO public.account_e2e_test_runners (account_id, runner_plan)
        VALUES ('${userId}', 'basic');
        INSERT INTO public.analysis_preflight_provider_runs (
            preflight_id, operation_key, status, actual_usage_usd, terminalized_at, usage_reconciled_at
        ) VALUES
            ('${preflightId}', 'target-profile-fallback', 'succeeded', 0.0025,
             pg_catalog.clock_timestamp() - INTERVAL '61 seconds', pg_catalog.clock_timestamp() - INTERVAL '31 seconds'),
            ('${preflightId}', 'target-profile-fresh-admission:g1', 'succeeded', 0.0025,
             pg_catalog.clock_timestamp() - INTERVAL '60 seconds', pg_catalog.clock_timestamp() - INTERVAL '30 seconds');
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

async function authenticatedQuery<T>(db: PGlite, sql: string): Promise<Results<T>> {
    await db.exec(`SELECT pg_catalog.set_config('request.jwt.claim.sub', '${userId}', FALSE)`);
    await db.exec('SET ROLE authenticated');
    try {
        return await db.query<T>(sql);
    } finally {
        await db.exec('RESET ROLE');
        await db.exec("SELECT pg_catalog.set_config('request.jwt.claim.sub', '', FALSE)");
    }
}

async function legacyReadiness(db: PGlite) {
    return serviceQuery<{ result: { disposition: string } }>(db, `
        SELECT public.prepare_analysis_v2_authorized_revenue_settlement_admission(
            $1::UUID, $2::UUID, 'basic', $3::TEXT
        ) AS result
    `, [preflightId, userId, entitlementHash]);
}

async function serverReadiness(db: PGlite, serverTargetHash: string) {
    return serviceQuery<{ result: { disposition: string } }>(db, `
        SELECT public.prepare_analysis_v2_authorized_revenue_settlement_admission(
            $1::UUID, $2::UUID, 'basic', $3::TEXT, $4::TEXT
        ) AS result
    `, [preflightId, userId, entitlementHash, serverTargetHash]);
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('revenue settlement preflight target-lineage hardening', () => {
    it('denies an authenticated owner direct mutation of target and economic lineage after provider rows exist', async () => {
        const db = await createDb();

        const mutation = await authenticatedQuery(db, `
            UPDATE public.analysis_preflights
            SET target_instagram_id = 'different.target',
                target_input_hash = '${tamperedServerHash}',
                admission_selected_plan_id = 'standard',
                pricing_version = 'tampered',
                pricing_snapshot = '{"basic":{"amountKrw":1}}'::JSONB,
                policy_versions_snapshot = '{"tampered":true}'::JSONB
            WHERE id = '${preflightId}'
        `);
        expect(mutation.affectedRows).toBe(0);
        await expect(db.query(`
            SELECT target_instagram_id, target_input_hash, admission_selected_plan_id,
                   pricing_version, pricing_snapshot, policy_versions_snapshot
            FROM public.analysis_preflights
            WHERE id = '${preflightId}'
        `)).resolves.toMatchObject({
            rows: [{
                target_instagram_id: 'target.account',
                target_input_hash: null,
                admission_selected_plan_id: 'basic',
                pricing_version: 'deferred',
                pricing_snapshot: {},
                policy_versions_snapshot: {},
            }],
        });
    });

    it('does not allow the legacy readiness signature to bind a NULL target hash from provider rows alone', async () => {
        const db = await createDb();

        await expect(legacyReadiness(db)).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        await expect(db.query(
            `SELECT target_input_hash FROM public.analysis_preflights WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({ rows: [{ target_input_hash: null }] });
    });

    it('binds a NULL target hash only when the server-recomputed target hash matches both provider sources', async () => {
        const db = await createDb();

        await expect(serverReadiness(db, tamperedServerHash))
            .rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        await expect(serverReadiness(db, sourceHash)).resolves.toMatchObject({
            rows: [{ result: { disposition: 'ready', admissionToken } }],
        });
        await expect(db.query(
            `SELECT target_input_hash FROM public.analysis_preflights WHERE id = '${preflightId}'`
        )).resolves.toMatchObject({ rows: [{ target_input_hash: sourceHash }] });
    });
});
