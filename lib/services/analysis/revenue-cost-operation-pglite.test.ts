import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');
const requestId = '11111111-1111-4111-8111-111111111111';
const standardRequestId = '12121212-1212-4121-8121-121212121212';
const userId = '22222222-2222-4222-8222-222222222222';
const preflightId = '33333333-3333-4333-8333-333333333333';
const hash = (char: string) => char.repeat(64);
const databases: PGlite[] = [];

// Minimal faithful slice of the predecessor schemas. Source anchors:
// 20260810090000 (parent), 20260714175411 + 20260715002600 (preflight runs),
// and the v2 entitlement/policy/request migrations. Every field read by this
// foundation's %ROWTYPE declarations and functions is represented below.
const bootstrap = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE EXTENSION pgcrypto;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT public.gen_random_uuid() $$;
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE TABLE public.analysis_requests (
 id uuid PRIMARY KEY, preflight_id uuid, user_id uuid, pipeline_version text, plan_access_mode_snapshot text,
 selected_plan_id_snapshot text, target_instagram_id text, test_entitlement_jti_hash text, status text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_preflights (
 id uuid PRIMARY KEY, consumed_request_id uuid UNIQUE, user_id uuid, status text, access_mode text,
 target_instagram_id text, target_input_hash text, admission_generation int, admission_status text,
 admission_selected_plan_id text, admission_entitlement_jti_hash text, admission_refreshed_at timestamptz,
 admission_target_followers_count int, admission_target_following_count int
);
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (
 entitlement_jti_hash text PRIMARY KEY, preflight_id uuid, request_id uuid UNIQUE, user_id uuid, selected_plan_id text
);
CREATE TABLE public.analysis_v2_provider_execution_policies (
 request_id uuid PRIMARY KEY, mode text, policy_version text, entitlement_jti_hash text, target_instagram_id text
);
CREATE TABLE public.account_e2e_test_runners (account_id uuid PRIMARY KEY, runner_plan text);
CREATE FUNCTION public.load_e2e_test_runner_v1(uuid) RETURNS TABLE(runner_plan text) LANGUAGE sql AS $$
 SELECT runner_plan FROM public.account_e2e_test_runners WHERE account_id = $1
$$;
CREATE TABLE public.analysis_preflight_provider_runs (
 preflight_id uuid NOT NULL REFERENCES public.analysis_preflights(id), operation_key text NOT NULL,
 status text NOT NULL CHECK (status IN ('starting','running','succeeded','failed','aborted','timed_out','resolved_no_run')),
 actual_usage_usd numeric(18,12), terminalized_at timestamptz, usage_reconciled_at timestamptz,
 PRIMARY KEY (preflight_id, operation_key),
 CHECK ((actual_usage_usd IS NULL OR actual_usage_usd >= 0) AND (usage_reconciled_at IS NULL OR terminalized_at IS NOT NULL))
);
CREATE TABLE public.analysis_pipeline_jobs (
 request_id uuid REFERENCES public.analysis_requests(id) ON DELETE CASCADE, job_key text CHECK (job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'),
 status text NOT NULL CHECK (status IN ('pending','processing','completed','failed','cancelled')),
 lease_token uuid, lease_expires_at timestamptz, input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'), required_job_keys text[], PRIMARY KEY(request_id, job_key),
 CHECK ((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE TABLE public.analysis_v2_provider_runs (
 request_id uuid NOT NULL, job_key text NOT NULL, operation_key text NOT NULL CHECK (operation_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$'),
 input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'), job_claim_token uuid NOT NULL, reservation_token uuid NOT NULL,
 logical_provider text NOT NULL, actor_id text NOT NULL, credential_slot text NOT NULL, max_charge_usd numeric(18,12) NOT NULL CHECK(max_charge_usd >= 0), status text NOT NULL CHECK(status IN ('starting','running','rejected','succeeded','failed','aborted','timed_out')),
 run_id text, actual_usage_usd numeric(18,12), reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), run_started_at timestamptz, terminalized_at timestamptz, usage_reconciled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,job_key,operation_key), UNIQUE(reservation_token), FOREIGN KEY(request_id,job_key) REFERENCES public.analysis_pipeline_jobs(request_id,job_key) ON DELETE CASCADE,
 CHECK ((status='starting' AND run_id IS NULL AND actual_usage_usd IS NULL) OR (status <> 'starting'))
);
CREATE TABLE public.analysis_v2_ai_attempts (
 request_id uuid NOT NULL, job_key text NOT NULL, job_claim_token uuid NOT NULL, operation_key text NOT NULL CHECK(operation_key ~ '^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[a-f0-9]{64}$'), attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 4), reservation_token uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','success','rate_limited','ambiguous','rejected','response_rejected','cutoff')),
 model_name text NOT NULL, location text NOT NULL, stage text NOT NULL, thinking_level text, media_count smallint NOT NULL, media_resolution text, prompt_version text NOT NULL, schema_version smallint NOT NULL, max_output_tokens integer NOT NULL, retry_count smallint NOT NULL,
 usage_metadata_status text, usage_complete boolean, prompt_tokens integer, completion_tokens integer, total_tokens integer, thinking_tokens integer, latency_ms integer, estimated_cost_usd numeric(15,12), finish_reason text, terminal_payload_hash text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminalized_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,operation_key,attempt), UNIQUE(reservation_token), FOREIGN KEY(request_id,job_key) REFERENCES public.analysis_pipeline_jobs(request_id,job_key) ON DELETE CASCADE,
 CHECK ((status='reserved' AND terminalized_at IS NULL AND estimated_cost_usd IS NULL) OR status <> 'reserved'), CHECK(retry_count=attempt-1)
);
CREATE TABLE public.analysis_revenue_run_ledgers (
 request_id uuid PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
 preflight_id uuid NOT NULL, user_id uuid NOT NULL, plan_id text NOT NULL CHECK (plan_id IN ('basic','standard')),
 access_mode text NOT NULL, target_username_hmac text NOT NULL, preflight_refreshed_at timestamptz NOT NULL,
 request_started_at timestamptz NOT NULL, fresh_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
 cost_cap_krw integer NOT NULL CHECK (cost_cap_krw IN (1808,3634)), reserved_cost_krw integer NOT NULL DEFAULT 0,
 actual_cost_krw integer, public_mutual_count integer, screened_count integer, not_screened_count integer,
 unknown_burden_count integer, result_revision_id uuid, image_manifest_id uuid, content_hash text,
 status text NOT NULL DEFAULT 'running', created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz
);
`;

async function createDb(legacyParents = false): Promise<PGlite> {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    databases.push(db);
    await db.exec(bootstrap);
    if (legacyParents) {
        await db.exec(`
            INSERT INTO public.analysis_requests(id) VALUES ('${requestId}'), ('${standardRequestId}');
            INSERT INTO public.analysis_revenue_run_ledgers(request_id,preflight_id,user_id,plan_id,access_mode,target_username_hmac,preflight_refreshed_at,request_started_at,cost_cap_krw,actual_cost_krw)
            VALUES ('${requestId}','${preflightId}','${userId}','basic','test_entitlement','${hash('a')}',clock_timestamp(),clock_timestamp(),1808,NULL),
                   ('${standardRequestId}','${preflightId}','${userId}','standard','test_entitlement','${hash('b')}',clock_timestamp(),clock_timestamp(),3634,NULL);
        `);
    }
    await db.exec(migration);
    return db;
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try { return await db.query<T>(sql, params); } finally { await db.exec('RESET ROLE'); }
}

async function seedBegin(db: PGlite): Promise<void> {
    await db.exec(`
        INSERT INTO public.analysis_requests VALUES ('${requestId}','${preflightId}','${userId}','v2','test_entitlement','basic','opaque-target','${hash('e')}','processing','2026-08-10T00:00:00Z');
        INSERT INTO public.analysis_preflights VALUES ('${preflightId}','${requestId}','${userId}','consumed','test_entitlement','opaque-target','${hash('a')}',1,'ready','basic','${hash('e')}','2026-08-10T00:01:00Z',1,1);
        INSERT INTO public.analysis_v2_test_entitlement_consumptions VALUES ('${hash('e')}','${preflightId}','${requestId}','${userId}','basic');
        INSERT INTO public.analysis_v2_provider_execution_policies VALUES ('${requestId}','test_operation_split','authorized-free-e2e-v1','${hash('e')}','opaque-target');
        INSERT INTO public.account_e2e_test_runners VALUES ('${userId}','basic');
        INSERT INTO public.analysis_preflight_provider_runs VALUES
          ('${preflightId}','target-profile-fallback','succeeded',0.002,'2026-08-10T00:02:00Z','2026-08-10T00:03:00Z'),
          ('${preflightId}','target-profile-fresh-admission:g1','succeeded',0.003,'2026-08-10T00:04:00Z','2026-08-10T00:05:00Z');
    `);
}

async function expectError(operation: Promise<unknown>, code: string): Promise<void> {
    await expect(operation).rejects.toThrow(code);
}

async function begin(db: PGlite): Promise<void> {
    await seedBegin(db);
    await query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]);
}

const jobKey = 'track:relationships:collect';
const claimToken = '44444444-4444-4444-8444-444444444444';
const inputHash = hash('d');
const providerInputHash = hash('9');
const providerOperationKey = `relationship-followers:${hash('c')}`;
const targetProfileOperationKey = `target-profile:${hash('1')}`;
const profileFallbackOperationKey = `profile-fallback:${hash('2')}`;
const profileRepairOperationKey = `profile-repair:${hash('3')}`;
const aiOperationKey = `private-account-name:${hash('f')}`;

async function seedLiveSources(db: PGlite, providerKey = providerOperationKey): Promise<void> {
    await begin(db);
    await db.exec(`
        INSERT INTO public.analysis_pipeline_jobs(request_id,job_key,status,lease_token,lease_expires_at,input_hash)
        VALUES ('${requestId}','${jobKey}','processing','${claimToken}',clock_timestamp() + interval '5 minutes','${inputHash}');
        INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
        VALUES ('${requestId}','${jobKey}','${providerKey}','${providerInputHash}','${claimToken}','55555555-5555-4555-8555-555555555555','apify','actor-id','primary',0.2,'starting');
        INSERT INTO public.analysis_v2_ai_attempts(request_id,job_key,job_claim_token,operation_key,attempt,reservation_token,status,model_name,location,stage,media_count,prompt_version,schema_version,max_output_tokens,retry_count)
        VALUES ('${requestId}','${jobKey}','${claimToken}','${aiOperationKey}',1,'66666666-6666-4666-8666-666666666666','reserved','gemini-3-flash-preview','global','privateAccountName',0,'v1',1,1024,0);
    `);
}

async function replayTotals(db: PGlite): Promise<{ reservedCostKrw: number; economicActualKrw: number; actualCostKrw: number; billedActualKrw: number; status: string; manualReviewReason: string | null; childCount: number }> {
    const parent = await db.query<{ reserved_cost_krw: number; economic_actual_krw: number; actual_cost_krw: number; billed_actual_krw: number; status: string; manual_review_reason: string | null }>(
        'SELECT reserved_cost_krw,economic_actual_krw,actual_cost_krw,billed_actual_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id=$1',
        [requestId],
    );
    const children = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM public.analysis_revenue_cost_operations WHERE request_id=$1',
        [requestId],
    );
    const row = parent.rows[0];
    if (!row) throw new Error('missing ledger');
    return {
        reservedCostKrw: row.reserved_cost_krw,
        economicActualKrw: row.economic_actual_krw,
        actualCostKrw: row.actual_cost_krw,
        billedActualKrw: row.billed_actual_krw,
        status: row.status,
        manualReviewReason: row.manual_review_reason,
        childCount: children.rows[0]?.count ?? 0,
    };
}

async function expectRejectedReplay(db: PGlite, code: string, mutate: () => Promise<void>): Promise<void> {
    const before = await replayTotals(db);
    await mutate();
    await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), code);
    await expect(replayTotals(db)).resolves.toEqual(before);
}

afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

describe('revenue cost operation ledger PGlite', () => {
    it('backfills existing Basic and Standard parents without nullable actual cost arithmetic', async () => {
        const db = await createDb(true);
        const rows = await db.query<{ plan_id: string; margin_target_krw: number; actual_cost_krw: number }>(
            'SELECT plan_id,margin_target_krw,actual_cost_krw FROM public.analysis_revenue_run_ledgers ORDER BY plan_id',
        );
        expect(rows.rows).toEqual([
            { plan_id: 'basic', margin_target_krw: 904, actual_cost_krw: 0 },
            { plan_id: 'standard', margin_target_krw: 1817, actual_cost_krw: 0 },
        ]);
    });

    it('imports exactly two real-hash preflight sources on first begin and exact replay', async () => {
        const db = await createDb();
        await seedBegin(db);
        const first = await query<{ result: { disposition: string; created: boolean; replayed: boolean } }>(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result', [requestId]);
        const replay = await query<{ result: { disposition: string; created: boolean; replayed: boolean } }>(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result', [requestId]);
        expect(first.rows[0]?.result).toMatchObject({ disposition: 'begun', created: true, replayed: false });
        expect(replay.rows[0]?.result).toMatchObject({ disposition: 'begun', created: false, replayed: true });
        const rows = await db.query<{ owner_key_hash: string; source_operation_key_hash: string; economic_actual_krw: number; billed_actual_krw: number }>(
            'SELECT owner_key_hash,source_operation_key_hash,economic_actual_krw,billed_actual_krw FROM public.analysis_revenue_cost_operations ORDER BY attempt',
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows[0]?.owner_key_hash).not.toBe(rows.rows[1]?.owner_key_hash);
        expect(rows.rows[0]?.source_operation_key_hash).not.toBe(rows.rows[1]?.source_operation_key_hash);
        expect(rows.rows.map(row => row.economic_actual_krw)).toEqual([3, 5]);
        expect(rows.rows.map(row => row.billed_actual_krw)).toEqual([0, 0]);
        await expect(db.query('SELECT economic_actual_krw,actual_cost_krw,billed_actual_krw FROM public.analysis_revenue_run_ledgers'))
            .resolves.toMatchObject({ rows: [{ economic_actual_krw: 8, actual_cost_krw: 8, billed_actual_krw: 0 }] });
    });

    it('fails closed for a changed source amount, an extra source generation, and imported child tamper', async () => {
        const db = await createDb();
        await seedBegin(db);
        await query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]);
        await db.exec(`UPDATE public.analysis_preflight_provider_runs SET actual_usage_usd=0.004 WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fallback'`);
        await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), 'REVENUE_COST_LEDGER_DRIFT');
        await db.exec(`UPDATE public.analysis_preflight_provider_runs SET actual_usage_usd=0.002 WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fallback';
          INSERT INTO public.analysis_preflight_provider_runs VALUES ('${preflightId}','target-profile-fresh-admission:g2','succeeded',0.001,'2026-08-10T00:06:00Z','2026-08-10T00:07:00Z')`);
        await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), 'REVENUE_COST_LEDGER_TARGET_LINEAGE');
        await db.exec(`DELETE FROM public.analysis_preflight_provider_runs WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fresh-admission:g2';
          UPDATE public.analysis_revenue_cost_operations SET status='released',started_at=NULL,economic_actual_usd=NULL,billed_actual_usd=NULL,economic_actual_krw=NULL,billed_actual_krw=NULL WHERE request_id='${requestId}' AND attempt=1`);
        await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), 'REVENUE_COST_LEDGER_DRIFT');
    });

    it.each([
        ['target hash', `UPDATE public.analysis_preflights SET target_input_hash='${hash('f')}' WHERE id='${preflightId}'`, 'REVENUE_COST_LEDGER_DRIFT'],
        ['request plan', `UPDATE public.analysis_requests SET selected_plan_id_snapshot='standard' WHERE id='${requestId}'`, 'REVENUE_COST_LEDGER_FENCE'],
        ['admission plan', `UPDATE public.analysis_preflights SET admission_selected_plan_id='standard' WHERE id='${preflightId}'`, 'REVENUE_COST_LEDGER_FENCE'],
        ['request JTI', `UPDATE public.analysis_requests SET test_entitlement_jti_hash='${hash('f')}' WHERE id='${requestId}'`, 'REVENUE_COST_LEDGER_FENCE'],
        ['admission JTI', `UPDATE public.analysis_preflights SET admission_entitlement_jti_hash='${hash('f')}' WHERE id='${preflightId}'`, 'REVENUE_COST_LEDGER_FENCE'],
    ])('rejects a replay when its %s fence drifts', async (_name, mutation, error) => {
        const db = await createDb();
        await begin(db);
        await expectRejectedReplay(db, error, async () => { await db.exec(mutation); });
    });

    it.each([
        [
            'pricing snapshot',
            `ALTER TABLE public.analysis_revenue_run_ledgers DROP CONSTRAINT analysis_revenue_run_ledgers_pricing_snapshot_version_check;
             UPDATE public.analysis_revenue_run_ledgers SET pricing_snapshot_version='tampered-price' WHERE request_id='${requestId}'`,
        ],
        [
            'FX rate',
            `ALTER TABLE public.analysis_revenue_run_ledgers DROP CONSTRAINT analysis_revenue_run_ledgers_buffered_fx_krw_per_usd_check;
             UPDATE public.analysis_revenue_run_ledgers SET buffered_fx_krw_per_usd=1449 WHERE request_id='${requestId}'`,
        ],
    ])('rejects a replay when the immutable parent %s drifts', async (_name, mutation) => {
        const db = await createDb();
        await begin(db);
        await expectRejectedReplay(db, 'REVENUE_COST_LEDGER_DRIFT', async () => { await db.exec(mutation); });
    });

    it.each([
        ['source status', `UPDATE public.analysis_preflight_provider_runs SET status='failed' WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fallback'`, 'REVENUE_COST_LEDGER_TARGET_LINEAGE'],
        ['terminal timestamp', `UPDATE public.analysis_preflight_provider_runs SET terminalized_at='2026-08-10T00:02:30Z' WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fallback'`, 'REVENUE_COST_LEDGER_DRIFT'],
        ['reconciliation timestamp', `UPDATE public.analysis_preflight_provider_runs SET usage_reconciled_at='2026-08-10T00:03:30Z' WHERE preflight_id='${preflightId}' AND operation_key='target-profile-fallback'`, 'REVENUE_COST_LEDGER_DRIFT'],
    ])('rejects a replay when the authoritative source %s drifts', async (_name, mutation, error) => {
        const db = await createDb();
        await begin(db);
        await expectRejectedReplay(db, error, async () => { await db.exec(mutation); });
    });

    it.each([
        ['owner identity', `UPDATE public.analysis_revenue_cost_operations SET owner_key_hash='${hash('f')}' WHERE request_id='${requestId}' AND attempt=1`],
        ['source identity', `UPDATE public.analysis_revenue_cost_operations SET source_operation_key_hash='${hash('f')}' WHERE request_id='${requestId}' AND attempt=1`],
        ['amount', `UPDATE public.analysis_revenue_cost_operations SET estimated_economic_usd=0.004 WHERE request_id='${requestId}' AND attempt=1`],
        ['selected scope', `UPDATE public.analysis_revenue_cost_operations SET selected_manifest_scope_hash='${hash('f')}' WHERE request_id='${requestId}' AND attempt=1`],
        ['denial', `UPDATE public.analysis_revenue_cost_operations SET denial_reason='hard_cap' WHERE request_id='${requestId}' AND attempt=1`],
        ['started timestamp', `UPDATE public.analysis_revenue_cost_operations SET started_at='2026-08-10T00:01:30Z' WHERE request_id='${requestId}' AND attempt=1`],
        ['terminal timestamp', `UPDATE public.analysis_revenue_cost_operations SET terminal_at='2026-08-10T00:03:30Z' WHERE request_id='${requestId}' AND attempt=1`],
    ])('rejects a replay when an imported child %s drifts', async (_name, mutation) => {
        const db = await createDb();
        await begin(db);
        await expectRejectedReplay(db, 'REVENUE_COST_LEDGER_DRIFT', async () => { await db.exec(mutation); });
    });

    it('reserves and starts a provider source exactly once from database authority while AI remains not-ready', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserveProvider = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        const reserveAi = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','ai_attempt','${aiOperationKey}',1::smallint) AS result`;
        await expect(query<{ result: { disposition: string; created: boolean } }>(db, reserveProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'accepted', created: true } }] });
        await expect(query<{ result: { disposition: string; replayed: boolean } }>(db, reserveProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'accepted', replayed: true } }] });
        const beforeAi = await replayTotals(db);
        await expectError(query(db, reserveAi), 'REVENUE_COST_OPERATION_AI_NOT_READY');
        await expect(replayTotals(db)).resolves.toEqual(beforeAi);
        const startProvider = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await expect(query<{ result: { disposition: string; created: boolean } }>(db, startProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'started', created: true } }] });
        await expect(query<{ result: { disposition: string; replayed: boolean } }>(db, startProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'started', replayed: true } }] });
        const hashes = await db.query<{ owner_key_hash: string; source_operation_key_hash: string, estimated_economic_usd: number }>('SELECT owner_key_hash,source_operation_key_hash,estimated_economic_usd FROM public.analysis_revenue_cost_operations WHERE owner_kind = \'provider_run\'');
        expect(hashes.rows).toHaveLength(1);
        expect(hashes.rows[0]?.owner_key_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hashes.rows[0]?.owner_key_hash).not.toBe(hashes.rows[0]?.source_operation_key_hash);
        expect(JSON.stringify(hashes.rows)).not.toContain(providerOperationKey);
        expect(Number(hashes.rows[0]?.estimated_economic_usd)).toBe(0.2);
        await expect(db.query('SELECT reserved_cost_krw FROM public.analysis_revenue_run_ledgers WHERE request_id=$1', [requestId])).resolves.toMatchObject({ rows: [{ reserved_cost_krw: 290 }] });
    });

    it.each([
        [targetProfileOperationKey, 'target_profile'],
        [profileFallbackOperationKey, 'detail_profile'],
        [profileRepairOperationKey, 'detail_profile'],
    ])('derives the exact provider prefix revenue operation mapping for %s', async (providerKey, operationKind) => {
        const db = await createDb();
        await seedLiveSources(db, providerKey);
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerKey}',0::smallint)`);
        await query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerKey}',0::smallint)`);
        await expect(db.query('SELECT operation_kind FROM public.analysis_revenue_cost_operations WHERE request_id=$1 AND owner_kind=$2', [requestId, 'provider_run']))
            .resolves.toMatchObject({ rows: [{ operation_kind: operationKind }] });
    });

    it.each([
        ['wrong job key', '', 'track:other'],
        ['expired lease', `UPDATE public.analysis_pipeline_jobs SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE request_id='${requestId}' AND job_key='${jobKey}'`],
        ['source claim', `UPDATE public.analysis_v2_provider_runs SET job_claim_token='77777777-7777-4777-8777-777777777777' WHERE request_id='${requestId}'`],
        ['source status', `UPDATE public.analysis_v2_provider_runs SET status='running',run_id='run12345' WHERE request_id='${requestId}'`],
    ])('rejects provider reserve fences without changing any parent total or review state: %s', async (_name, mutation, rpcJobKey = jobKey) => {
        const db = await createDb();
        await seedLiveSources(db);
        if (mutation) await db.exec(mutation);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${rpcJobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('rejects a provider reserve under a different request identity without mutation', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v2('${standardRequestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it.each([
        ['caller claim token', '', jobKey, '77777777-7777-4777-8777-777777777777', inputHash, providerOperationKey, '0::smallint'],
        ['job input hash', '', jobKey, claimToken, hash('8'), providerOperationKey, '0::smallint'],
        ['non-processing job', `UPDATE public.analysis_pipeline_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE request_id='${requestId}' AND job_key='${jobKey}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['missing provider source', `DELETE FROM public.analysis_v2_provider_runs WHERE request_id='${requestId}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['unsupported provider prefix mapping', `ALTER TABLE public.analysis_v2_provider_runs DROP CONSTRAINT analysis_v2_provider_runs_operation_key_check; UPDATE public.analysis_v2_provider_runs SET operation_key='unsupported:${hash('c')}' WHERE request_id='${requestId}'`, jobKey, claimToken, inputHash, `unsupported:${hash('c')}`, '0::smallint'],
        ['provider attempt is not zero', '', jobKey, claimToken, inputHash, providerOperationKey, '1::smallint'],
        ['entitlement lineage', `UPDATE public.analysis_v2_test_entitlement_consumptions SET selected_plan_id='standard' WHERE request_id='${requestId}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['execution policy lineage', `UPDATE public.analysis_v2_provider_execution_policies SET mode='tampered' WHERE request_id='${requestId}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['runner plan lineage', `UPDATE public.account_e2e_test_runners SET runner_plan='standard' WHERE account_id='${userId}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['parent fingerprint', `UPDATE public.analysis_revenue_run_ledgers SET target_username_hmac='${hash('f')}' WHERE request_id='${requestId}'`, jobKey, claimToken, inputHash, providerOperationKey, '0::smallint'],
        ['NULL source kind', '', jobKey, claimToken, inputHash, providerOperationKey, '0::smallint', 'NULL::text'],
        ['NULL source attempt', '', jobKey, claimToken, inputHash, providerOperationKey, 'NULL::smallint'],
    ])('rejects every remaining provider reserve authority fence without parent mutation: %s', async (_name, mutation, rpcJobKey, rpcClaim, rpcHash, rpcOperation, rpcAttempt, sourceKind = "'provider_run'") => {
        const db = await createDb();
        await seedLiveSources(db);
        if (mutation) await db.exec(mutation);
        const before = await replayTotals(db);
        const sql = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${rpcJobKey}','${rpcClaim}','${rpcHash}',${sourceKind},'${rpcOperation}',${rpcAttempt})`;
        await expectError(query(db, sql), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('rejects tampered parent aggregates on provider reserve replay and start without mutation', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=0 WHERE request_id='${requestId}'`);
        const beforeReserve = await replayTotals(db);
        await expectError(query(db, reserve), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(beforeReserve);
        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET reserved_cost_krw=290, economic_actual_krw=0, actual_cost_krw=0, billed_actual_krw=0 WHERE request_id='${requestId}'`);
        const beforeStart = await replayTotals(db);
        await expectError(query(db, start), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(beforeStart);
    });

    it('rejects a tampered child identity on start and keeps the reserved parent untouched', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        await query(db, `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`);
        await db.exec(`UPDATE public.analysis_revenue_cost_operations SET owner_key_hash='${hash('f')}' WHERE request_id='${requestId}' AND owner_kind='provider_run'`);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('returns AI-not-ready for a valid AI start source before any mutation', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','ai_attempt','${aiOperationKey}',1::smallint)`), 'REVENUE_COST_OPERATION_AI_NOT_READY');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it.each([
        ['NULL source kind', 'NULL::text', '0::smallint'],
        ['NULL source attempt', "'provider_run'", 'NULL::smallint'],
    ])('rejects invalid start input without mutation: %s', async (_name, sourceKind, sourceAttempt) => {
        const db = await createDb();
        await seedLiveSources(db);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}',${sourceKind},'${providerOperationKey}',${sourceAttempt})`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('records an idempotent hard-cap denial that cannot be started', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET max_charge_usd=2 WHERE request_id='${requestId}'`);
        const sql = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await expect(query<{ result: { disposition: string; created: boolean; reason: string } }>(db, sql)).resolves.toMatchObject({ rows: [{ result: { disposition: 'denied', created: true, reason: 'hard_cap' } }] });
        await expect(query<{ result: { disposition: string; replayed: boolean } }>(db, sql)).resolves.toMatchObject({ rows: [{ result: { disposition: 'denied', replayed: true } }] });
        await expectError(query(db, `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(db.query('SELECT reserved_cost_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id=$1', [requestId])).resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, status: 'manual_review', manual_review_reason: 'cost_denied' }] });
    });

    it('keeps compatibility mutations not-ready and leaves child costs untouched', async () => {
        const db = await createDb(true);
        const calls = [
            `SELECT public.reserve_analysis_revenue_cost_operation_v1('${requestId}'::uuid,'provider_run','${hash('c')}',1::smallint,'detail_profile',1,0.1::numeric,NULL)`,
            `SELECT public.mark_analysis_revenue_cost_operation_started_v1('${requestId}'::uuid,'provider_run','${hash('c')}',1::smallint)`,
            `SELECT public.settle_analysis_revenue_cost_operation_v1('${requestId}'::uuid,'provider_run','${hash('c')}',1::smallint,0.1::numeric,0::numeric)`,
            `SELECT public.release_analysis_revenue_cost_operation_v1('${requestId}'::uuid,'provider_run','${hash('c')}',1::smallint)`,
        ];
        for (const sql of calls) await expectError(query(db, sql), 'REVENUE_COST_OPERATION_NOT_READY');
        await expect(db.query('SELECT count(*)::int AS count FROM public.analysis_revenue_cost_operations')).resolves.toMatchObject({ rows: [{ count: 0 }] });
        const reconciliation = await query<{ result: { finalizable: boolean; reason: string } }>(db,
            `SELECT public.read_analysis_revenue_cost_reconciliation_v1('${requestId}'::uuid,'coordinator:finalize','44444444-4444-4444-8444-444444444444'::uuid,'${hash('d')}') AS result`);
        expect(reconciliation.rows[0]?.result).toMatchObject({ finalizable: false, reason: 'not_ready' });
    });

    it('has only the four-argument reconciliation RPC and foundation schema properties', async () => {
        const db = await createDb();
        const procedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='read_analysis_revenue_cost_reconciliation_v1'`);
        expect(procedures.rows).toEqual([{ args: 'uuid, text, uuid, text' }]);
        const reserveProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='reserve_analysis_revenue_cost_operation_v2'`);
        expect(reserveProcedures.rows).toEqual([{ args: 'uuid, text, uuid, text, text, text, smallint' }]);
        const startProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='mark_analysis_revenue_cost_operation_started_v2'`);
        expect(startProcedures.rows).toEqual([{ args: 'uuid, text, uuid, text, text, text, smallint' }]);
        const table = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.analysis_revenue_cost_operations'::regclass`);
        expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const constraints = await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid='public.analysis_revenue_cost_operations'::regclass`);
        expect(constraints.rows.map(row => row.conname)).toEqual(expect.arrayContaining([
            'analysis_revenue_cost_operations_source_mapping_check',
            'analysis_revenue_cost_operations_lifecycle_check',
        ]));
        const indexes = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename='analysis_revenue_cost_operations'`);
        expect(indexes.rows.map(row => row.indexname)).toEqual(expect.arrayContaining([
            'analysis_revenue_cost_operations_source_lookup_idx',
            'analysis_revenue_cost_operations_operation_status_idx',
        ]));
    });
});
