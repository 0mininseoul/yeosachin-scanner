import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');
const requestId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const preflightId = '33333333-3333-4333-8333-333333333333';
const hash = (char: string) => char.repeat(64);
const databases: PGlite[] = [];

const bootstrap = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$
  SELECT (substr(md5(random()::text),1,8)||'-'||substr(md5(random()::text),1,4)||'-4'||substr(md5(random()::text),1,3)||'-8'||substr(md5(random()::text),1,3)||'-'||substr(md5(random()::text),1,12))::uuid
$$;
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('00', 32), 'hex') $$;
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(repeat('00', 32), 'hex') $$;
CREATE TABLE public.users (id uuid primary key, account_class text, traffic_class text, lifecycle text);
CREATE TABLE public.analysis_requests (id uuid primary key, preflight_id uuid, user_id uuid, pipeline_version text, plan_access_mode_snapshot text, selected_plan_id_snapshot text, target_instagram_id text, test_entitlement_jti_hash text, status text, created_at timestamptz default clock_timestamp());
CREATE TABLE public.analysis_preflights (id uuid primary key, consumed_request_id uuid, user_id uuid, status text, access_mode text, target_instagram_id text, target_input_hash text, admission_generation int, admission_status text, admission_selected_plan_id text, admission_entitlement_jti_hash text, admission_refreshed_at timestamptz, admission_target_followers_count int, admission_target_following_count int, updated_at timestamptz default clock_timestamp());
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (entitlement_jti_hash text primary key, preflight_id uuid, request_id uuid, user_id uuid, selected_plan_id text);
CREATE TABLE public.analysis_v2_provider_execution_policies (request_id uuid primary key, mode text, policy_version text, entitlement_jti_hash text, target_instagram_id text);
CREATE TABLE public.account_e2e_test_runners (account_id uuid primary key, runner_plan text);
CREATE TABLE public.analysis_preflight_provider_runs (preflight_id uuid, operation_key text, status text, actual_usage_usd numeric, usage_reconciled_at timestamptz, terminalized_at timestamptz);
CREATE TABLE public.analysis_pipeline_jobs (request_id uuid, job_key text, status text, lease_token uuid, lease_expires_at timestamptz, input_hash text, required_job_keys text[]);
CREATE TABLE public.analysis_v2_provider_runs (request_id uuid, job_key text, operation_key text, max_charge_usd numeric, status text, actual_usage_usd numeric, usage_reconciled_at timestamptz);
CREATE TABLE public.analysis_v2_ai_attempts (request_id uuid, job_key text, operation_key text, attempt smallint, status text, usage_metadata_status text, usage_complete boolean, estimated_cost_usd numeric, terminalized_at timestamptz);
CREATE TABLE public.analysis_v2_gender_routing_manifests (request_id uuid, relationship_checkpoint_id text, policy_version text, canonical_input_hmac text, status text, plan_id text, selected_count int);
CREATE TABLE public.analysis_v2_gender_routing_candidates (request_id uuid, relationship_checkpoint_id text, policy_version text, candidate_key text, ordinal int, selected boolean);
CREATE FUNCTION public.load_e2e_test_runner_v1(uuid) RETURNS TABLE(runner_plan text) LANGUAGE sql AS $$ SELECT 'basic'::text $$;
CREATE TABLE public.analysis_revenue_run_ledgers (
 request_id uuid primary key references public.analysis_requests(id), preflight_id uuid not null, user_id uuid not null, plan_id text not null, access_mode text not null, target_username_hmac text not null, preflight_refreshed_at timestamptz not null, request_started_at timestamptz not null, fresh_provenance jsonb not null default '{}'::jsonb, cost_cap_krw integer not null, reserved_cost_krw integer not null default 0, actual_cost_krw integer, public_mutual_count integer, screened_count integer, not_screened_count integer, unknown_burden_count integer, result_revision_id uuid, image_manifest_id uuid, content_hash text, status text not null default 'running', created_at timestamptz default clock_timestamp(), completed_at timestamptz
);
`;

async function createDb(withLedger = true): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(migration);
    if (withLedger) await db.exec(`INSERT INTO public.analysis_requests(id) VALUES('${requestId}');
      INSERT INTO public.analysis_revenue_run_ledgers(request_id,preflight_id,user_id,plan_id,access_mode,target_username_hmac,preflight_refreshed_at,request_started_at,cost_cap_krw,margin_target_krw)
      VALUES('${requestId}','${preflightId}','${userId}','basic','test_entitlement','${hash('a')}',clock_timestamp(),clock_timestamp(),1808,904);`);
    return db;
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try { return await db.query<T>(sql, params); } finally { await db.exec('RESET ROLE'); }
}

afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

describe('revenue cost operation ledger PGlite', () => {
    it('imports exactly the two settled fresh preflight runs and replays idempotently', async () => {
        const db = await createDb(false);
        await db.exec(`
            INSERT INTO public.analysis_requests VALUES ('${requestId}','${preflightId}','${userId}','v2','test_entitlement','basic','opaque-target','${hash('e')}','processing',clock_timestamp());
            INSERT INTO public.analysis_preflights VALUES ('${preflightId}','${requestId}','${userId}','consumed','test_entitlement','opaque-target','${hash('a')}',1,'ready','basic','${hash('e')}',clock_timestamp(),1,1,clock_timestamp());
            INSERT INTO public.analysis_v2_test_entitlement_consumptions VALUES ('${hash('e')}','${preflightId}','${requestId}','${userId}','basic');
            INSERT INTO public.analysis_v2_provider_execution_policies VALUES ('${requestId}','test_operation_split','authorized-free-e2e-v1','${hash('e')}','opaque-target');
            INSERT INTO public.analysis_preflight_provider_runs VALUES ('${preflightId}','target-profile-fallback','succeeded',0.002,clock_timestamp(),clock_timestamp()), ('${preflightId}','target-profile-fresh-admission:g1','succeeded',0.003,clock_timestamp(),clock_timestamp());
        `);
        const first = await query<{ result: { disposition: string } }>(db, `SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result`, [requestId]);
        const replay = await query<{ result: { disposition: string } }>(db, `SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result`, [requestId]);
        expect(first.rows[0]?.result).toMatchObject({ disposition: 'begun' });
        expect(replay.rows[0]?.result).toMatchObject({ disposition: 'begun' });
        const imported = await db.query<{ target_username_hmac: string; count: number; billed: number; economic: number }>(`
            SELECT ledger.target_username_hmac, count(operation.id)::int AS count, sum(operation.billed_actual_krw)::int AS billed, sum(operation.economic_actual_krw)::int AS economic
            FROM public.analysis_revenue_run_ledgers AS ledger
            JOIN public.analysis_revenue_cost_operations AS operation ON operation.request_id=ledger.request_id
            WHERE ledger.request_id='${requestId}' GROUP BY ledger.target_username_hmac`);
        expect(imported.rows[0]).toMatchObject({ target_username_hmac: hash('a'), count: 2, billed: 0, economic: 8 });
    });
    it('persists a hard-cap denial and locks the parent into manual review', async () => {
        const db = await createDb();
        const accepted = await query<{ result: { disposition: string } }>(db,
            `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'ai_attempt',$2::text,1::smallint,'stage_one_routing',400,1.2::numeric,NULL::text) AS result`, [requestId, hash('b')]);
        expect(accepted.rows[0]?.result).toMatchObject({ disposition: 'accepted' });
        const denied = await query<{ result: { disposition: string; reason: string } }>(db,
            `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'ai_attempt',$2::text,2::smallint,'stage_one_routing_retry',400,0.5::numeric,NULL::text) AS result`, [requestId, hash('c')]);
        expect(denied.rows[0]?.result).toMatchObject({ disposition: 'denied', reason: 'hard_cap' });
        const parent = await db.query<{ status: string; reserved_cost_krw: number }>('SELECT status,reserved_cost_krw FROM public.analysis_revenue_run_ledgers');
        expect(parent.rows[0]).toMatchObject({ status: 'manual_review', reserved_cost_krw: 1740 });
    });

    it('permits release only before start and makes a started call durably ambiguous', async () => {
        const db = await createDb();
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'provider_run',$2::text,1::smallint,'relationship_followers',1,0.01::numeric,NULL::text)`, [requestId, hash('e')]);
        const released = await query<{ result: { disposition: string } }>(db, `SELECT public.release_analysis_revenue_cost_operation_v1($1::uuid,'provider_run',$2::text,1::smallint) AS result`, [requestId, hash('e')]);
        expect(released.rows[0]?.result).toMatchObject({ disposition: 'released' });
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'provider_run',$2::text,1::smallint,'relationship_following',1,0.01::numeric,NULL::text)`, [requestId, hash('f')]);
        await query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v1($1::uuid,'provider_run',$2::text,1::smallint)`, [requestId, hash('f')]);
        const ambiguous = await query<{ result: { disposition: string } }>(db, `SELECT public.release_analysis_revenue_cost_operation_v1($1::uuid,'provider_run',$2::text,1::smallint) AS result`, [requestId, hash('f')]);
        expect(ambiguous.rows[0]?.result).toMatchObject({ disposition: 'ambiguous' });
    });

    it('records an actual overrun instead of rolling it back and keeps reconciliation non-finalizable without coverage', async () => {
        const db = await createDb();
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'ai_attempt',$2::text,1::smallint,'stage_one_routing',1,0.01::numeric,NULL::text)`, [requestId, hash('1')]);
        await query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v1($1::uuid,'ai_attempt',$2::text,1::smallint)`, [requestId, hash('1')]);
        const settled = await query<{ result: { disposition: string } }>(db,
            `SELECT public.settle_analysis_revenue_cost_operation_v1($1::uuid,'ai_attempt',$2::text,1::smallint,2::numeric,0::numeric) AS result`, [requestId, hash('1')]);
        expect(settled.rows[0]?.result).toMatchObject({ disposition: 'settled' });
        const parent = await db.query<{ status: string; economic_actual_krw: number; reserved_cost_krw: number }>('SELECT status,economic_actual_krw,reserved_cost_krw FROM public.analysis_revenue_run_ledgers');
        expect(parent.rows[0]).toMatchObject({ status: 'manual_review', economic_actual_krw: 2900, reserved_cost_krw: 0 });
        // The finalizer claim fence is exercised by the complete request graph;
        // this lifecycle test intentionally stops at the parent manual-review state.
    });
});
