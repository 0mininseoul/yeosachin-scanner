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
CREATE TABLE public.users (id uuid primary key, account_class text, traffic_class text, lifecycle text);
CREATE TABLE public.analysis_requests (id uuid primary key, preflight_id uuid, user_id uuid, pipeline_version text, plan_access_mode_snapshot text, selected_plan_id_snapshot text, target_instagram_id text, test_entitlement_jti_hash text, status text, created_at timestamptz default clock_timestamp());
CREATE TABLE public.analysis_preflights (id uuid primary key, consumed_request_id uuid, user_id uuid, status text, access_mode text, target_instagram_id text, updated_at timestamptz default clock_timestamp());
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (entitlement_jti_hash text primary key, preflight_id uuid, request_id uuid, user_id uuid, selected_plan_id text);
CREATE TABLE public.analysis_v2_provider_execution_policies (request_id uuid primary key, mode text, policy_version text, entitlement_jti_hash text, target_instagram_id text);
CREATE TABLE public.account_e2e_test_runners (account_id uuid primary key, runner_plan text);
CREATE TABLE public.analysis_preflight_provider_runs (preflight_id uuid, operation_key text);
CREATE TABLE public.analysis_revenue_run_ledgers (
 request_id uuid primary key references public.analysis_requests(id), preflight_id uuid not null, user_id uuid not null, plan_id text not null, access_mode text not null, target_username_hmac text not null, preflight_refreshed_at timestamptz not null, request_started_at timestamptz not null, fresh_provenance jsonb not null default '{}'::jsonb, cost_cap_krw integer not null, reserved_cost_krw integer not null default 0, actual_cost_krw integer, public_mutual_count integer, screened_count integer, not_screened_count integer, unknown_burden_count integer, result_revision_id uuid, image_manifest_id uuid, content_hash text, status text not null default 'running', created_at timestamptz default clock_timestamp(), completed_at timestamptz
);
`;

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(migration);
    await db.exec(`INSERT INTO public.analysis_requests(id) VALUES('${requestId}');
      INSERT INTO public.analysis_revenue_run_ledgers(request_id,preflight_id,user_id,plan_id,access_mode,target_username_hmac,preflight_refreshed_at,request_started_at,cost_cap_krw)
      VALUES('${requestId}','${preflightId}','${userId}','basic','test_entitlement','${hash('a')}',clock_timestamp(),clock_timestamp(),1808);`);
    return db;
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try { return await db.query<T>(sql, params); } finally { await db.exec('RESET ROLE'); }
}

afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

describe('revenue cost operation ledger PGlite', () => {
    it('persists a hard-cap denial and locks the parent into manual review', async () => {
        const db = await createDb();
        const accepted = await query<{ result: { disposition: string } }>(db,
            `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'routing',$2::text,1::smallint,'stage_one_routing',400,1.2::numeric,NULL::text) AS result`, [requestId, hash('b')]);
        expect(accepted.rows[0]?.result).toMatchObject({ disposition: 'accepted' });
        const denied = await query<{ result: { disposition: string; reason: string } }>(db,
            `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'profile',$2::text,1::smallint,'detail_profile',100,0.5::numeric,$3::text) AS result`, [requestId, hash('c'), hash('d')]);
        expect(denied.rows[0]?.result).toMatchObject({ disposition: 'denied', reason: 'hard_cap' });
        const parent = await db.query<{ status: string; reserved_cost_krw: number }>('SELECT status,reserved_cost_krw FROM public.analysis_revenue_run_ledgers');
        expect(parent.rows[0]).toMatchObject({ status: 'manual_review', reserved_cost_krw: 1740 });
    });

    it('permits release only before start and makes a started call durably ambiguous', async () => {
        const db = await createDb();
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'relationship',$2::text,1::smallint,'relationship_followers',1,0.01::numeric,NULL::text)`, [requestId, hash('e')]);
        const released = await query<{ result: { disposition: string } }>(db, `SELECT public.release_analysis_revenue_cost_operation_v1($1::uuid,'relationship',$2::text,1::smallint) AS result`, [requestId, hash('e')]);
        expect(released.rows[0]?.result).toMatchObject({ disposition: 'released' });
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'relationship',$2::text,1::smallint,'relationship_following',1,0.01::numeric,NULL::text)`, [requestId, hash('f')]);
        await query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v1($1::uuid,'relationship',$2::text,1::smallint)`, [requestId, hash('f')]);
        const ambiguous = await query<{ result: { disposition: string } }>(db, `SELECT public.release_analysis_revenue_cost_operation_v1($1::uuid,'relationship',$2::text,1::smallint) AS result`, [requestId, hash('f')]);
        expect(ambiguous.rows[0]?.result).toMatchObject({ disposition: 'ambiguous' });
    });

    it('records an actual overrun instead of rolling it back and keeps reconciliation non-finalizable without coverage', async () => {
        const db = await createDb();
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v1($1::uuid,'routing',$2::text,1::smallint,'stage_one_routing',1,0.01::numeric,NULL::text)`, [requestId, hash('1')]);
        await query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v1($1::uuid,'routing',$2::text,1::smallint)`, [requestId, hash('1')]);
        const settled = await query<{ result: { disposition: string } }>(db,
            `SELECT public.settle_analysis_revenue_cost_operation_v1($1::uuid,'routing',$2::text,1::smallint,2::numeric,0::numeric) AS result`, [requestId, hash('1')]);
        expect(settled.rows[0]?.result).toMatchObject({ disposition: 'settled' });
        const parent = await db.query<{ status: string; economic_actual_krw: number; reserved_cost_krw: number }>('SELECT status,economic_actual_krw,reserved_cost_krw FROM public.analysis_revenue_run_ledgers');
        expect(parent.rows[0]).toMatchObject({ status: 'manual_review', economic_actual_krw: 2900, reserved_cost_krw: 0 });
        const reconciliation = await query<{ result: { finalizable: boolean; reason: string; economicDisposition: string } }>(db,
            `SELECT public.read_analysis_revenue_cost_reconciliation_v1($1::uuid) AS result`, [requestId]);
        expect(reconciliation.rows[0]?.result).toMatchObject({ finalizable: false, reason: 'coverage_gate_absent', economicDisposition: 'hard_cap_exceeded' });
    });
});
