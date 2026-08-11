import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RevenueCostOperationStore } from './revenue-cost-operation-store';
import {
    createRevenueCostProviderRunSettlement,
    type RevenueCostProviderRunSettlementClient,
} from './revenue-cost-provider-run-reconciliation';
import type { AnalysisV2ProviderUsageRevenueCostSettlement } from './v2-provider-lifecycle';
import type { StoredAnalysisV2ProviderRun } from './v2-provider-run-store';

const migration = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');
const providerSettlementQueueMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260811100000_add_revenue_cost_provider_settlement_queue.sql',
        import.meta.url
    ),
    'utf8'
);
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
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
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
	CREATE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
	 SELECT COALESCE(p_slot IN ('primary','secondary','tertiary','quaternary','quinary','senary','septenary'), FALSE)
	$$;
	CREATE TABLE public.analysis_pipeline_jobs (
	 request_id uuid REFERENCES public.analysis_requests(id) ON DELETE CASCADE, job_key text CHECK (job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'),
	 status text NOT NULL DEFAULT 'pending', dispatch_state text NOT NULL DEFAULT 'pending', dispatch_generation int NOT NULL DEFAULT 0,
	 dispatch_reservation_token uuid, dispatch_reserved_at timestamptz, dispatched_at timestamptz, dispatch_task_name text, delivered_at timestamptz,
	 lease_token uuid, lease_expires_at timestamptz, input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'), required_job_keys text[] NOT NULL DEFAULT '{}'::text[],
	 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(request_id, job_key),
	 CONSTRAINT analysis_pipeline_jobs_status_check CHECK (status IN ('pending','processing','completed','failed','cancelled')),
	 CONSTRAINT analysis_pipeline_jobs_dispatch_state_check CHECK (dispatch_state IN ('pending','reserved','enqueued','delivered')),
	 CONSTRAINT analysis_pipeline_jobs_dispatch_generation_check CHECK (dispatch_generation BETWEEN 0 AND 1000),
	 CONSTRAINT analysis_pipeline_jobs_dispatch_pair_check CHECK (
	   (dispatch_state='pending' AND dispatch_generation=0 AND dispatch_reservation_token IS NULL AND dispatch_reserved_at IS NULL AND dispatched_at IS NULL AND dispatch_task_name IS NULL AND delivered_at IS NULL)
	   OR (dispatch_state='reserved' AND dispatch_generation>0 AND dispatch_reservation_token IS NOT NULL AND dispatch_reserved_at IS NOT NULL AND dispatched_at IS NULL AND dispatch_task_name IS NULL AND delivered_at IS NULL)
	   OR (dispatch_state='enqueued' AND dispatch_generation>0 AND dispatch_reservation_token IS NOT NULL AND dispatch_reserved_at IS NOT NULL AND dispatched_at IS NOT NULL AND dispatch_task_name IS NOT NULL AND delivered_at IS NULL)
	   OR (dispatch_state='delivered' AND dispatch_generation>0 AND dispatch_reservation_token IS NOT NULL AND dispatch_reserved_at IS NOT NULL AND dispatched_at IS NOT NULL AND dispatch_task_name IS NOT NULL AND delivered_at IS NOT NULL)
	 ),
	 CONSTRAINT analysis_pipeline_jobs_task_name_check CHECK (dispatch_task_name IS NULL OR (char_length(dispatch_task_name) BETWEEN 1 AND 512 AND dispatch_task_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]*$')),
	 CONSTRAINT analysis_pipeline_jobs_lease_check CHECK ((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND dispatch_state='delivered') OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)),
	 CONSTRAINT analysis_pipeline_jobs_timestamp_check CHECK (updated_at >= created_at AND (dispatch_reserved_at IS NULL OR dispatch_reserved_at >= created_at) AND (dispatched_at IS NULL OR dispatched_at >= dispatch_reserved_at) AND (delivered_at IS NULL OR delivered_at >= dispatched_at) AND (lease_expires_at IS NULL OR lease_expires_at > updated_at))
	);
	CREATE TABLE public.analysis_v2_provider_runs (
	 request_id uuid NOT NULL, job_key text NOT NULL, operation_key text NOT NULL CHECK (operation_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$'),
	 input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'), job_claim_token uuid NOT NULL, reservation_token uuid NOT NULL,
	 logical_provider text NOT NULL CHECK(logical_provider IN ('apify','coderx')), actor_id text NOT NULL CHECK(char_length(actor_id) BETWEEN 3 AND 200 AND actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'), credential_slot text NOT NULL, max_charge_usd numeric(18,12) NOT NULL,
	 status text NOT NULL CHECK(status IN ('starting','running','rejected','succeeded','failed','aborted','timed_out')),
	 run_id text, actual_usage_usd numeric(18,12), reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), run_started_at timestamptz, terminalized_at timestamptz, usage_reconciled_at timestamptz, usage_reconciliation_attempt_count integer NOT NULL DEFAULT 0, usage_reconciliation_attempted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	 PRIMARY KEY(request_id,job_key,operation_key), UNIQUE(reservation_token), FOREIGN KEY(request_id,job_key) REFERENCES public.analysis_pipeline_jobs(request_id,job_key) ON DELETE CASCADE,
	 CONSTRAINT analysis_v2_provider_run_credential_check CHECK (public.analysis_v2_valid_apify_credential_slot(credential_slot)),
	 CONSTRAINT analysis_v2_provider_run_run_id_check CHECK (run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'),
	 CONSTRAINT analysis_v2_provider_run_cost_check CHECK (max_charge_usd BETWEEN 0 AND 100000 AND (actual_usage_usd IS NULL OR actual_usage_usd BETWEEN 0 AND 100000)),
	 CONSTRAINT analysis_v2_provider_run_state_check CHECK (
	   (status='starting' AND run_id IS NULL AND run_started_at IS NULL AND terminalized_at IS NULL AND actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
	   OR (status='running' AND run_id IS NOT NULL AND run_started_at IS NOT NULL AND terminalized_at IS NULL AND actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
	   OR (status='rejected' AND run_id IS NULL AND run_started_at IS NULL AND terminalized_at IS NOT NULL AND actual_usage_usd=0 AND usage_reconciled_at IS NOT NULL)
	   OR (status IN ('succeeded','failed','aborted','timed_out') AND run_id IS NOT NULL AND run_started_at IS NOT NULL AND terminalized_at IS NOT NULL AND ((actual_usage_usd IS NULL AND usage_reconciled_at IS NULL) OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL)))
	 ),
	 CONSTRAINT analysis_v2_provider_run_time_check CHECK (updated_at >= reserved_at AND (run_started_at IS NULL OR run_started_at >= reserved_at) AND (terminalized_at IS NULL OR terminalized_at >= run_started_at) AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at))
	);
	CREATE TABLE public.analysis_v2_ai_attempts (
	 request_id uuid NOT NULL, job_key text NOT NULL, job_claim_token uuid NOT NULL, operation_key text NOT NULL CHECK(operation_key ~ '^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[a-f0-9]{64}$'), attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 4), reservation_token uuid NOT NULL,
	 status text NOT NULL CHECK(status IN ('reserved','success','rate_limited','ambiguous','rejected','response_rejected','cutoff')),
	 model_name text NOT NULL, location text NOT NULL, stage text NOT NULL, thinking_level text, media_count smallint NOT NULL, media_resolution text, prompt_version text NOT NULL, schema_version smallint NOT NULL, max_output_tokens integer NOT NULL, retry_count smallint NOT NULL,
	 usage_metadata_status text, usage_complete boolean, prompt_tokens integer, completion_tokens integer, total_tokens integer, thinking_tokens integer, latency_ms integer, estimated_cost_usd numeric(15,12), finish_reason text, terminal_payload_hash text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminalized_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	 PRIMARY KEY(request_id,operation_key,attempt), UNIQUE(reservation_token), FOREIGN KEY(request_id,job_key) REFERENCES public.analysis_pipeline_jobs(request_id,job_key) ON DELETE CASCADE,
	 CONSTRAINT analysis_v2_ai_attempt_model_check CHECK(model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
	 CONSTRAINT analysis_v2_ai_attempt_location_check CHECK(location ~ '^[a-z][a-z0-9-]{0,62}$'),
	 CONSTRAINT analysis_v2_ai_attempt_stage_check CHECK(stage IN ('genderTriage','genderResolution','featureAnalysis','highRiskNarrative','privateAccountName','partnerSafety')),
	 CONSTRAINT analysis_v2_ai_attempt_thinking_check CHECK(thinking_level IS NULL OR thinking_level IN ('MINIMAL','LOW','MEDIUM','HIGH')),
	 CONSTRAINT analysis_v2_ai_attempt_media_check CHECK(media_count BETWEEN 0 AND 11 AND (media_resolution IS NULL OR media_resolution IN ('LOW','MEDIUM','HIGH'))),
	 CONSTRAINT analysis_v2_ai_attempt_prompt_check CHECK(char_length(prompt_version) BETWEEN 1 AND 64 AND prompt_version ~ '^[A-Za-z0-9._:-]+$' AND schema_version BETWEEN 1 AND 9999 AND max_output_tokens BETWEEN 1 AND 65536 AND retry_count=attempt-1),
	 CONSTRAINT analysis_v2_ai_attempt_usage_check CHECK ((usage_metadata_status='complete' AND usage_complete AND prompt_tokens BETWEEN 0 AND 100000000 AND completion_tokens BETWEEN 0 AND 100000000 AND total_tokens BETWEEN 0 AND 100000000 AND thinking_tokens BETWEEN 0 AND 100000000 AND total_tokens=prompt_tokens+completion_tokens+thinking_tokens) OR (usage_metadata_status IN ('missing','malformed') AND NOT usage_complete AND prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL AND thinking_tokens IS NULL AND estimated_cost_usd IS NULL) OR (usage_metadata_status IS NULL AND usage_complete IS NULL AND prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL AND thinking_tokens IS NULL AND estimated_cost_usd IS NULL)),
	 CONSTRAINT analysis_v2_ai_attempt_terminal_shape_check CHECK ((status='reserved' AND latency_ms IS NULL AND finish_reason IS NULL AND terminal_payload_hash IS NULL AND terminalized_at IS NULL) OR (status <> 'reserved' AND usage_metadata_status IS NOT NULL AND usage_complete IS NOT NULL AND latency_ms BETWEEN 0 AND 3600000 AND terminal_payload_hash ~ '^[0-9a-f]{64}$' AND terminalized_at IS NOT NULL)),
	 CONSTRAINT analysis_v2_ai_attempt_generation_failure_check CHECK (status NOT IN ('rate_limited','ambiguous') OR (usage_metadata_status='missing' AND NOT usage_complete AND prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL AND thinking_tokens IS NULL AND estimated_cost_usd IS NULL AND finish_reason IS NULL)),
	 CONSTRAINT analysis_v2_ai_attempt_cost_check CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd BETWEEN 0 AND 999.999999999999),
	 CONSTRAINT analysis_v2_ai_attempt_time_check CHECK(updated_at >= created_at AND (terminalized_at IS NULL OR terminalized_at >= created_at))
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
    await db.exec(providerSettlementQueueMigration);
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
const secondProviderOperationKey = `relationship-following:${hash('7')}`;
const targetProfileOperationKey = `target-profile:${hash('1')}`;
const profileFallbackOperationKey = `profile-fallback:${hash('2')}`;
const profileRepairOperationKey = `profile-repair:${hash('3')}`;
const aiOperationKey = `private-account-name:${hash('f')}`;

async function seedLiveSources(db: PGlite, providerKey = providerOperationKey): Promise<void> {
    await begin(db);
    await db.exec(`
        INSERT INTO public.analysis_pipeline_jobs(
          request_id,job_key,status,dispatch_state,dispatch_generation,dispatch_reservation_token,
          dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,lease_token,lease_expires_at,
          input_hash,created_at,updated_at
        ) VALUES (
          '${requestId}','${jobKey}','processing','delivered',1,'${claimToken}',
          clock_timestamp() - interval '3 minutes',clock_timestamp() - interval '2 minutes','analysis-v2.relationships.collect',clock_timestamp() - interval '1 minute','${claimToken}',clock_timestamp() + interval '5 minutes',
          '${inputHash}',clock_timestamp() - interval '4 minutes',clock_timestamp() - interval '30 seconds'
        );
        INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
        VALUES ('${requestId}','${jobKey}','${providerKey}','${providerInputHash}','${claimToken}','55555555-5555-4555-8555-555555555555','apify','actor-id','primary',0.2,'starting');
        INSERT INTO public.analysis_v2_ai_attempts(request_id,job_key,job_claim_token,operation_key,attempt,reservation_token,status,model_name,location,stage,media_count,prompt_version,schema_version,max_output_tokens,retry_count)
        VALUES ('${requestId}','${jobKey}','${claimToken}','${aiOperationKey}',1,'66666666-6666-4666-8666-666666666666','reserved','gemini-3-flash-preview','global','privateAccountName',0,'v1',1,1024,0);
    `);
}

async function scrubTerminalRequestPiiProductionEquivalent(db: PGlite): Promise<void> {
    // Mirrors analysis_v2_scrub_terminal_request_pii: raw target values become
    // retained placeholders, while target_input_hash and immutable lineage stay.
    await db.exec(`
        UPDATE public.analysis_preflights
           SET target_instagram_id='retained.33333333333333333333'
         WHERE consumed_request_id='${requestId}' AND status='consumed';
        UPDATE public.analysis_requests
           SET target_instagram_id='retained.11111111111111111111'
         WHERE id='${requestId}' AND pipeline_version='v2';
    `);
}

async function replayTotals(db: PGlite): Promise<{ reservedCostKrw: number; economicActualKrw: number; actualCostKrw: number; billedActualKrw: number; status: string; manualReviewReason: string | null; preflightRefreshedAt: string; requestStartedAt: string; childCount: number }> {
    const parent = await db.query<{ reserved_cost_krw: number; economic_actual_krw: number; actual_cost_krw: number; billed_actual_krw: number; status: string; manual_review_reason: string | null; preflight_refreshed_at: string; request_started_at: string }>(
        'SELECT reserved_cost_krw,economic_actual_krw,actual_cost_krw,billed_actual_krw,status,manual_review_reason,preflight_refreshed_at,request_started_at FROM public.analysis_revenue_run_ledgers WHERE request_id=$1',
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
        preflightRefreshedAt: row.preflight_refreshed_at,
        requestStartedAt: row.request_started_at,
        childCount: children.rows[0]?.count ?? 0,
    };
}

async function expectRejectedReplay(db: PGlite, code: string, mutate: () => Promise<void>): Promise<void> {
    const before = await replayTotals(db);
    await mutate();
    await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), code);
    await expect(replayTotals(db)).resolves.toEqual(before);
}

type PgliteRpcResult = {
    data: unknown;
    error: { code?: string; message?: string } | null;
};

type RevenueChildFilter = 'request_id' | 'owner_kind' | 'source_job_key'
    | 'source_operation_key_hash' | 'source_attempt';

interface PgliteRevenueChildQuery {
    eq(column: RevenueChildFilter, value: string | number): PgliteRevenueChildQuery;
    maybeSingle(): Promise<PgliteRpcResult>;
}

interface PgliteRevenueSettlementFixture {
    settlement: AnalysisV2ProviderUsageRevenueCostSettlement;
    rpcCalls: string[];
}

const SETTLE_V2_RPC = 'settle_analysis_revenue_cost_operation_v2';
const MANUAL_REVIEW_RPC = 'mark_analysis_revenue_manual_review_v1';

function pgliteRpcError(error: unknown): { code: string; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    const revenueCode = message.match(/REVENUE_COST_[A-Z_]+/)?.[0];
    return { code: 'P0001', message: revenueCode ?? message };
}

function rpcString(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`missing string RPC parameter: ${key}`);
    return value;
}

function rpcNumber(params: Record<string, unknown>, key: string): number {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`missing numeric RPC parameter: ${key}`);
    return value;
}

async function executePgliteRevenueRpc(
    db: PGlite,
    functionName: string,
    params: Record<string, unknown>,
): Promise<PgliteRpcResult> {
    try {
        switch (functionName) {
            case SETTLE_V2_RPC: {
                const result = await query<{ result: unknown }>(db, `
                    SELECT public.settle_analysis_revenue_cost_operation_v2(
                        $1::uuid, $2::text, $3::text, $4::text, $5::smallint
                    ) AS result
                `, [
                    rpcString(params, 'p_request_id'),
                    rpcString(params, 'p_job_key'),
                    rpcString(params, 'p_source_kind'),
                    rpcString(params, 'p_source_operation_key'),
                    rpcNumber(params, 'p_source_attempt'),
                ]);
                return { data: result.rows[0]?.result ?? null, error: null };
            }
            case MANUAL_REVIEW_RPC: {
                const result = await query<{ result: unknown }>(db, `
                    SELECT public.mark_analysis_revenue_manual_review_v1(
                        $1::uuid, $2::text
                    ) AS result
                `, [
                    rpcString(params, 'p_request_id'),
                    rpcString(params, 'p_reason_code'),
                ]);
                return { data: result.rows[0]?.result ?? null, error: null };
            }
            default:
                return {
                    data: null,
                    error: {
                        code: 'P0001',
                        message: `unsupported PGlite revenue RPC: ${functionName}`,
                    },
                };
        }
    } catch (error) {
        return { data: null, error: pgliteRpcError(error) };
    }
}

function pgliteRevenueChildQuery(db: PGlite): PgliteRevenueChildQuery {
    const filters = new Map<RevenueChildFilter, string | number>();
    const builder: PgliteRevenueChildQuery = {
        eq(column, value) {
            filters.set(column, value);
            return builder;
        },
        async maybeSingle() {
            const request = filters.get('request_id');
            const ownerKind = filters.get('owner_kind');
            const job = filters.get('source_job_key');
            const sourceHash = filters.get('source_operation_key_hash');
            const attempt = filters.get('source_attempt');
            if (
                typeof request !== 'string'
                || typeof ownerKind !== 'string'
                || typeof job !== 'string'
                || typeof sourceHash !== 'string'
                || typeof attempt !== 'number'
            ) {
                return {
                    data: null,
                    error: { code: 'P0001', message: 'incomplete PGlite revenue child lookup' },
                };
            }
            try {
                const result = await query<{ status: string }>(db, `
                    SELECT status
                      FROM public.analysis_revenue_cost_operations
                     WHERE request_id=$1::uuid
                       AND owner_kind=$2::text
                       AND source_job_key=$3::text
                       AND source_operation_key_hash=$4::text
                       AND source_attempt=$5::smallint
                `, [request, ownerKind, job, sourceHash, attempt]);
                if (result.rows.length > 1) {
                    return {
                        data: null,
                        error: { code: 'P0001', message: 'non-unique PGlite revenue child lookup' },
                    };
                }
                return { data: result.rows[0] ?? null, error: null };
            } catch (error) {
                return { data: null, error: pgliteRpcError(error) };
            }
        },
    };
    return builder;
}

function createPgliteRevenueSettlementClient(db: PGlite): {
    client: RevenueCostProviderRunSettlementClient;
    rpcCalls: string[];
} {
    const rpcCalls: string[] = [];
    const client: RevenueCostProviderRunSettlementClient = {
        async rpc(functionName, params) {
            rpcCalls.push(functionName);
            return executePgliteRevenueRpc(db, functionName, params);
        },
        from(table) {
            if (table !== 'analysis_revenue_cost_operations') {
                throw new Error(`unexpected PGlite revenue table: ${table}`);
            }
            return {
                select(columns) {
                    if (columns !== 'status') {
                        throw new Error(`unexpected PGlite revenue columns: ${columns}`);
                    }
                    return pgliteRevenueChildQuery(db);
                },
            };
        },
    };
    return { client, rpcCalls };
}

function sourceOperationHash(operationKey: string): string {
    return createHash('sha256').update(operationKey, 'utf8').digest('hex');
}

function createPgliteRevenueSettlementFixture(db: PGlite): PgliteRevenueSettlementFixture {
    const { client, rpcCalls } = createPgliteRevenueSettlementClient(db);
    const store = new RevenueCostOperationStore(client);
    const settlement = createRevenueCostProviderRunSettlement(client, store);
    return { settlement, rpcCalls };
}

async function providerRunFromDatabase(db: PGlite): Promise<StoredAnalysisV2ProviderRun> {
    const result = await db.query<{
        request_id: string;
        job_key: string;
        operation_key: string;
        input_hash: string;
        reservation_token: string;
        logical_provider: string;
        actor_id: string;
        credential_slot: string;
        max_charge_usd: number | string;
        status: string;
        run_id: string | null;
        actual_usage_usd: number | string | null;
        reserved_at: string;
        run_started_at: string | null;
        terminalized_at: string | null;
        usage_reconciled_at: string | null;
    }>(`
        SELECT request_id,job_key,operation_key,input_hash,reservation_token,
               logical_provider,actor_id,credential_slot,max_charge_usd,status,
               run_id,actual_usage_usd,reserved_at,run_started_at,terminalized_at,
               usage_reconciled_at
          FROM public.analysis_v2_provider_runs
         WHERE request_id=$1::uuid
           AND job_key=$2::text
           AND operation_key=$3::text
    `, [requestId, jobKey, providerOperationKey]);
    const row = result.rows[0];
    if (!row) throw new Error('missing authoritative PGlite provider run');
    return {
        requestId: row.request_id,
        jobKey: row.job_key,
        operationKey: row.operation_key,
        inputHash: row.input_hash,
        reservationToken: row.reservation_token,
        logicalProvider: row.logical_provider as StoredAnalysisV2ProviderRun['logicalProvider'],
        actorId: row.actor_id,
        credentialSlot: row.credential_slot as StoredAnalysisV2ProviderRun['credentialSlot'],
        maxChargeUsd: Number(row.max_charge_usd),
        status: row.status as StoredAnalysisV2ProviderRun['status'],
        runId: row.run_id,
        actualUsageUsd: row.actual_usage_usd === null ? null : Number(row.actual_usage_usd),
        reservedAt: row.reserved_at,
        runStartedAt: row.run_started_at,
        terminalizedAt: row.terminalized_at,
        usageReconciledAt: row.usage_reconciled_at,
    };
}

function providerReserveSql(): string {
    return `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
}

function providerStartSql(): string {
    return `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
}

function providerSettleSql(): string {
    return `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
}

async function setProviderRejected(db: PGlite): Promise<void> {
    await db.exec(`
        UPDATE public.analysis_v2_provider_runs
           SET status='rejected',run_id=NULL,run_started_at=NULL,
               terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0,
               usage_reconciled_at=reserved_at + interval '3 seconds',
               updated_at=reserved_at + interval '4 seconds'
         WHERE request_id='${requestId}' AND job_key='${jobKey}'
           AND operation_key='${providerOperationKey}'
    `);
}

async function setProviderSucceeded(db: PGlite): Promise<void> {
    await db.exec(`
        UPDATE public.analysis_v2_provider_runs
           SET status='succeeded',run_id='run12345',
               run_started_at=reserved_at + interval '1 second',
               terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,
               usage_reconciled_at=reserved_at + interval '3 seconds',
               updated_at=reserved_at + interval '4 seconds'
         WHERE request_id='${requestId}' AND job_key='${jobKey}'
           AND operation_key='${providerOperationKey}'
    `);
}

async function prepareExactReleasedProviderChild(db: PGlite): Promise<void> {
    await seedLiveSources(db);
    await query(db, providerReserveSql());
    await setProviderRejected(db);
    await query(db, providerSettleSql());
}

async function prepareExactSettledProviderChild(db: PGlite): Promise<void> {
    await seedLiveSources(db);
    await query(db, providerReserveSql());
    await query(db, providerStartSql());
    await setProviderSucceeded(db);
    await query(db, providerSettleSql());
}

async function exactProviderCostState(db: PGlite): Promise<{
    childStatus: string;
    childStartedAt: string | null;
    childTerminalAt: string | null;
    childEconomicUsd: number | null;
    ledgerStatus: string;
    manualReviewReason: string | null;
    reservedCostKrw: number;
    economicActualKrw: number;
}> {
    const result = await db.query<{
        child_status: string;
        child_started_at: string | null;
        child_terminal_at: string | null;
        child_economic_usd: number | string | null;
        ledger_status: string;
        manual_review_reason: string | null;
        reserved_cost_krw: number;
        economic_actual_krw: number;
    }>(`
        SELECT child.status AS child_status,
               child.started_at AS child_started_at,
               child.terminal_at AS child_terminal_at,
               child.economic_actual_usd AS child_economic_usd,
               ledger.status AS ledger_status,
               ledger.manual_review_reason,
               ledger.reserved_cost_krw,
               ledger.economic_actual_krw
          FROM public.analysis_revenue_cost_operations AS child
          JOIN public.analysis_revenue_run_ledgers AS ledger
            ON ledger.request_id=child.request_id
         WHERE child.request_id=$1::uuid
           AND child.owner_kind='provider_run'
           AND child.source_job_key=$2::text
           AND child.source_operation_key_hash=$3::text
           AND child.source_attempt=0::smallint
    `, [requestId, jobKey, sourceOperationHash(providerOperationKey)]);
    const row = result.rows[0];
    if (!row) throw new Error('missing exact PGlite revenue child');
    return {
        childStatus: row.child_status,
        childStartedAt: row.child_started_at,
        childTerminalAt: row.child_terminal_at,
        childEconomicUsd: row.child_economic_usd === null
            ? null
            : Number(row.child_economic_usd),
        ledgerStatus: row.ledger_status,
        manualReviewReason: row.manual_review_reason,
        reservedCostKrw: row.reserved_cost_krw,
        economicActualKrw: row.economic_actual_krw,
    };
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
        const beforeAi = await replayTotals(db);
        await expectError(query(db, reserveAi), 'REVENUE_COST_OPERATION_AI_NOT_READY');
        await expect(replayTotals(db)).resolves.toEqual(beforeAi);
        await expect(query<{ result: { replayed: boolean } }>(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result', [requestId]))
            .resolves.toMatchObject({ rows: [{ result: { replayed: true } }] });
        await expect(db.query(`SELECT count(*)::int AS count FROM public.analysis_revenue_cost_operations WHERE owner_kind='ai_attempt' OR lifecycle_anomaly IS NOT NULL`))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(query<{ result: { disposition: string; created: boolean } }>(db, reserveProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'accepted', created: true } }] });
        await expect(query<{ result: { disposition: string; replayed: boolean } }>(db, reserveProvider)).resolves.toMatchObject({ rows: [{ result: { disposition: 'accepted', replayed: true } }] });
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

    it.each(['completed', 'failed'])('rejects %s requests before a first reserve and a started replay without further cost mutation', async (requestStatus) => {
        const firstReserve = await createDb();
        await seedLiveSources(firstReserve);
        await firstReserve.exec(`UPDATE public.analysis_requests SET status='${requestStatus}' WHERE id='${requestId}'`);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const beforeFirstReserve = await replayTotals(firstReserve);
        await expectError(query(firstReserve, reserve), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(firstReserve)).resolves.toEqual(beforeFirstReserve);

        const startedReplay = await createDb();
        await seedLiveSources(startedReplay);
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(startedReplay, reserve);
        await query(startedReplay, start);
        await startedReplay.exec(`UPDATE public.analysis_requests SET status='${requestStatus}' WHERE id='${requestId}'`);
        const beforeStartedReplay = await replayTotals(startedReplay);
        await expectError(query(startedReplay, start), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(startedReplay)).resolves.toEqual(beforeStartedReplay);
    });

    it.each([
        ['preflight refreshed at', `UPDATE public.analysis_revenue_run_ledgers SET preflight_refreshed_at='2026-08-10T00:01:01Z' WHERE request_id='${requestId}'`],
        ['request started at', `UPDATE public.analysis_revenue_run_ledgers SET request_started_at='2026-08-10T00:00:01Z' WHERE request_id='${requestId}'`],
    ])('rejects %s drift on a reserve replay without further parent or child mutation', async (_name, mutation) => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await db.exec(mutation);
        const before = await replayTotals(db);
        await expectError(query(db, reserve), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it.each([
        ['preflight refreshed at', `UPDATE public.analysis_revenue_run_ledgers SET preflight_refreshed_at='2026-08-10T00:01:01Z' WHERE request_id='${requestId}'`],
        ['request started at', `UPDATE public.analysis_revenue_run_ledgers SET request_started_at='2026-08-10T00:00:01Z' WHERE request_id='${requestId}'`],
    ])('rejects %s drift on start without further parent or child mutation', async (_name, mutation) => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await db.exec(mutation);
        const before = await replayTotals(db);
        await expectError(query(db, start), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
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
        ['source status', `UPDATE public.analysis_v2_provider_runs SET status='running',run_id='run12345',run_started_at=clock_timestamp() WHERE request_id='${requestId}'`],
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

    it('fences a denied-child parent mismatch before settlement and preserves cost-denied unless cost-overrun is stronger', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        await db.exec(`INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
            VALUES ('${requestId}','${jobKey}','${secondProviderOperationKey}','${providerInputHash}','${claimToken}','77777777-7777-4777-8777-777777777777','apify','actor-id','primary',2,'starting')`);
        const reserve = (key: string) => `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint) AS result`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve(providerOperationKey));
        await expect(query<{ result: { disposition: string } }>(db, reserve(secondProviderOperationKey))).resolves.toMatchObject({ rows: [{ result: { disposition: 'denied' } }] });
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}';
            UPDATE public.analysis_revenue_run_ledgers SET status='running',manual_review_reason=NULL WHERE request_id='${requestId}'`);
        const beforeFence = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(beforeFence);

        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='running',manual_review_reason='cost_overrun' WHERE request_id='${requestId}'`);
        const beforeOverrunFence = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(beforeOverrunFence);

        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_denied' WHERE request_id='${requestId}'`);
        await expect(query(db, settle)).resolves.toBeDefined();
        await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'cost_denied' }] });
        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET manual_review_reason='cost_overrun' WHERE request_id='${requestId}'`);
        await expect(query(db, settle)).resolves.toBeDefined();
        await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'cost_overrun' }] });
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

    it.each([
        ['caller claim token', '', '77777777-7777-4777-8777-777777777777', inputHash],
        ['job input hash', '', claimToken, hash('8')],
        ['source claim token', `UPDATE public.analysis_v2_provider_runs SET job_claim_token='77777777-7777-4777-8777-777777777777' WHERE request_id='${requestId}'`, claimToken, inputHash],
        ['expired job lease', `UPDATE public.analysis_pipeline_jobs SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE request_id='${requestId}' AND job_key='${jobKey}'`, claimToken, inputHash],
    ])('rejects release v2 %s drift without parent or child mutation', async (_name, mutation, rpcClaim, rpcHash) => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        if (mutation) await db.exec(mutation);
        const before = await replayTotals(db);
        await expectError(query(db, `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${rpcClaim}','${rpcHash}','provider_run','${providerOperationKey}',0::smallint)`), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('releases a reserved provider operation only when the authoritative source proves rejection without a run', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='rejected',actual_usage_usd=0,terminalized_at=clock_timestamp(),usage_reconciled_at=clock_timestamp() WHERE request_id='${requestId}'`);
        await expect(query<{ result: { disposition: string; created: boolean } }>(db, release)).resolves.toMatchObject({ rows: [{ result: { disposition: 'released', created: true } }] });
        await expect(query<{ result: { replayed: boolean } }>(db, release)).resolves.toMatchObject({ rows: [{ result: { replayed: true } }] });
        await expect(db.query(`SELECT reserved_cost_krw,billed_actual_krw FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, billed_actual_krw: 0 }] });
    });

    it('releases a locally started child when the provider authoritatively rejects before a run exists', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve); await query(db, start);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='rejected',actual_usage_usd=0,terminalized_at=reserved_at + interval '1 second',usage_reconciled_at=reserved_at + interval '2 seconds',updated_at=reserved_at + interval '3 seconds' WHERE request_id='${requestId}'`);
        await expect(query<{ result: { disposition: string } }>(db, settle)).resolves.toMatchObject({ rows: [{ result: { disposition: 'released' } }] });
        await expect(db.query(`SELECT status,started_at,terminal_at FROM public.analysis_revenue_cost_operations WHERE request_id='${requestId}' AND owner_kind='provider_run'`))
            .resolves.toMatchObject({ rows: [{ status: 'released', started_at: null }] });
        await expect(db.query(`SELECT reserved_cost_krw FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`)).resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0 }] });
    });

    it('settles definitive rejection after production-equivalent terminal PII scrub and replays without touching a stronger parent review', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve); await query(db, start);
        await db.exec(`
            UPDATE public.analysis_v2_provider_runs
               SET status='rejected',actual_usage_usd=0,terminalized_at=reserved_at + interval '1 second',usage_reconciled_at=reserved_at + interval '2 seconds',updated_at=reserved_at + interval '3 seconds'
             WHERE request_id='${requestId}';
            UPDATE public.analysis_pipeline_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL
             WHERE request_id='${requestId}' AND job_key='${jobKey}';
            UPDATE public.analysis_requests SET status='completed' WHERE id='${requestId}';
        `);
        await scrubTerminalRequestPiiProductionEquivalent(db);

        await expect(query<{ result: { disposition: string } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'released' } }] });
        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='cost_overrun' WHERE request_id='${requestId}'`);
        const beforeReplay = await replayTotals(db);
        await expect(query<{ result: { replayed: boolean } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'released', replayed: true } }] });
        await expect(replayTotals(db)).resolves.toEqual(beforeReplay);
        await expect(db.query(`SELECT status,started_at FROM public.analysis_revenue_cost_operations WHERE request_id='${requestId}' AND owner_kind='provider_run'`))
            .resolves.toMatchObject({ rows: [{ status: 'released', started_at: null }] });
    });

    it.each([
        ['request/preflight binding', `UPDATE public.analysis_requests SET preflight_id='${standardRequestId}' WHERE id='${requestId}'`],
        ['retained preflight target hash', `UPDATE public.analysis_preflights SET target_input_hash='${hash('f')}' WHERE id='${preflightId}'`],
        ['parent target hash', `UPDATE public.analysis_revenue_run_ledgers SET target_username_hmac='${hash('f')}' WHERE request_id='${requestId}'`],
        ['entitlement preflight binding', `UPDATE public.analysis_v2_test_entitlement_consumptions SET preflight_id='${standardRequestId}' WHERE request_id='${requestId}'`],
        ['provider reconciliation timestamp', `UPDATE public.analysis_v2_provider_runs SET usage_reconciled_at=usage_reconciled_at + interval '1 second',updated_at=updated_at + interval '2 seconds' WHERE request_id='${requestId}'`],
    ])('rejects scrubbed terminal settlement drift in %s without parent or child mutation', async (_name, mutation) => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve); await query(db, start);
        await db.exec(`
            UPDATE public.analysis_v2_provider_runs SET status='rejected',actual_usage_usd=0,terminalized_at=reserved_at + interval '1 second',usage_reconciled_at=reserved_at + interval '2 seconds',updated_at=reserved_at + interval '3 seconds' WHERE request_id='${requestId}';
            UPDATE public.analysis_pipeline_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE request_id='${requestId}' AND job_key='${jobKey}';
            UPDATE public.analysis_requests SET status='completed' WHERE id='${requestId}';
        `);
        await scrubTerminalRequestPiiProductionEquivalent(db);
        await query(db, settle);
        await db.exec(mutation);
        const before = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('recovers an ambiguity-released child from authoritative rejection exactly once', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve); await query(db, start); await query(db, release);
        await expect(db.query(`SELECT reserved_cost_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, status: 'manual_review', manual_review_reason: 'ambiguous_external_call' }] });
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='rejected',actual_usage_usd=0,terminalized_at=reserved_at + interval '1 second',usage_reconciled_at=reserved_at + interval '2 seconds',updated_at=reserved_at + interval '3 seconds' WHERE request_id='${requestId}'`);

        await expect(query<{ result: { disposition: string; created: boolean; replayed: boolean } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'released', created: true, replayed: false } }] });
        const recovered = await replayTotals(db);
        await expect(query<{ result: { disposition: string; replayed: boolean } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'released', replayed: true } }] });
        await expect(replayTotals(db)).resolves.toEqual(recovered);
        await expect(db.query(`
            SELECT child.status AS child_status,child.started_at IS NULL AS started_cleared,
                   child.terminal_at=provider.usage_reconciled_at AS terminal_reconciled,
                   child.economic_actual_usd IS NULL AS economic_usage_cleared,
                   child.billed_actual_usd IS NULL AS billed_usage_cleared,
                   parent.reserved_cost_krw,parent.economic_actual_krw,parent.actual_cost_krw,parent.billed_actual_krw,
                   parent.status AS parent_status,parent.manual_review_reason
              FROM public.analysis_revenue_cost_operations child
              JOIN public.analysis_v2_provider_runs provider ON provider.request_id=child.request_id
              JOIN public.analysis_revenue_run_ledgers parent ON parent.request_id=child.request_id
             WHERE child.request_id='${requestId}' AND child.owner_kind='provider_run'
        `)).resolves.toMatchObject({ rows: [{
            child_status: 'released', started_cleared: true, terminal_reconciled: true,
            economic_usage_cleared: true, billed_usage_cleared: true,
            reserved_cost_krw: 0, economic_actual_krw: 8, actual_cost_krw: 8, billed_actual_krw: 0,
            parent_status: 'running', manual_review_reason: null,
        }] });
    });

    it('rejects a null direct manual-review reason without mutating the parent', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const before = await replayTotals(db);
        await expectError(
            query(db, `SELECT public.mark_analysis_revenue_manual_review_v1('${requestId}',NULL::text)`),
            'REVENUE_COST_MANUAL_REVIEW_INVALID',
        );
        await expect(replayTotals(db)).resolves.toEqual(before);
    });

    it('applies direct manual-review reason precedence without downgrading stronger causes', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        for (const [existing, incoming, expected] of [
            ['cost_overrun', 'routing_failure', 'cost_overrun'],
            ['cost_overrun', 'ambiguous_external_call', 'cost_overrun'],
            ['cost_overrun', 'cost_overrun', 'cost_overrun'],
            ['cost_denied', 'routing_failure', 'cost_denied'],
            ['cost_denied', 'ambiguous_external_call', 'cost_denied'],
            ['cost_denied', 'cost_overrun', 'cost_overrun'],
            ['ambiguous_external_call', 'routing_failure', 'ambiguous_external_call'],
            ['ambiguous_external_call', 'ambiguous_external_call', 'ambiguous_external_call'],
            ['ambiguous_external_call', 'cost_overrun', 'cost_overrun'],
            ['routing_failure', 'routing_failure', 'routing_failure'],
            ['routing_failure', 'ambiguous_external_call', 'ambiguous_external_call'],
            ['routing_failure', 'cost_overrun', 'cost_overrun'],
        ]) {
            await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='${existing}' WHERE request_id='${requestId}'`);
            await expect(query<{ result: { disposition: string } }>(db, `SELECT public.mark_analysis_revenue_manual_review_v1('${requestId}','${incoming}') AS result`))
                .resolves.toMatchObject({ rows: [{ result: { disposition: 'manual_review' } }] });
            await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
                .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: expected }] });
        }
    });

    it('keeps active ambiguity through another child skipped-start settlement, then retains that anomaly after final reconciliation', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        await db.exec(`INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
            VALUES ('${requestId}','${jobKey}','${secondProviderOperationKey}','${providerInputHash}','${claimToken}','77777777-7777-4777-8777-777777777777','apify','actor-id','primary',0.2,'starting')`);
        const reserve = (key: string) => `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const start = (key: string) => `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const release = (key: string) => `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const settle = (key: string) => `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${key}',0::smallint)`;
        await query(db, reserve(providerOperationKey));
        await query(db, reserve(secondProviderOperationKey));
        await query(db, start(providerOperationKey));
        await query(db, release(providerOperationKey));

        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run67890',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${secondProviderOperationKey}'`);
        await query(db, settle(secondProviderOperationKey));
        await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'ambiguous_external_call' }] });

        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}'`);
        await query(db, settle(providerOperationKey));
        await expect(db.query(`SELECT parent.status,parent.manual_review_reason,child.lifecycle_anomaly FROM public.analysis_revenue_run_ledgers parent JOIN public.analysis_revenue_cost_operations child ON child.request_id=parent.request_id WHERE parent.request_id='${requestId}' AND child.source_operation_key_hash=encode(digest('${secondProviderOperationKey}','sha256'),'hex')`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'routing_failure', lifecycle_anomaly: 'skipped_start' }] });
        const afterTerminal = await replayTotals(db);
        await query(db, settle(secondProviderOperationKey));
        await query(db, settle(providerOperationKey));
        await expect(replayTotals(db)).resolves.toEqual(afterTerminal);
    });

    it('constrains skipped-start evidence to a settled child and fences aggregate drift on its exact replay', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await expect(db.exec(`UPDATE public.analysis_revenue_cost_operations SET lifecycle_anomaly='skipped_start' WHERE request_id='${requestId}' AND owner_kind='provider_run'`))
            .rejects.toThrow('analysis_revenue_cost_operations_lifecycle_anomaly_check');
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}'`);
        await query(db, settle);
        await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='running',manual_review_reason=NULL WHERE request_id='${requestId}'`);
        const beforeReplay = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(beforeReplay);
    });

    it('limits skipped-start evidence to provider settlement and rejects imported replay drift', async () => {
        const db = await createDb();
        await begin(db);
        const markImported = `UPDATE public.analysis_revenue_cost_operations SET lifecycle_anomaly='skipped_start' WHERE request_id='${requestId}' AND owner_kind='preflight_provider_run'`;
        await expect(db.exec(markImported)).rejects.toThrow('analysis_revenue_cost_operations_lifecycle_anomaly_check');
        await expect(db.query(`SELECT lifecycle_anomaly FROM public.analysis_revenue_cost_operations WHERE request_id='${requestId}' ORDER BY attempt`))
            .resolves.toMatchObject({ rows: [{ lifecycle_anomaly: null }, { lifecycle_anomaly: null }] });

        await db.exec('ALTER TABLE public.analysis_revenue_cost_operations DROP CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_check');
        await db.exec(markImported);
        const beforeReplay = await replayTotals(db);
        await expectError(query(db, 'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid)', [requestId]), 'REVENUE_COST_LEDGER_DRIFT');
        await expect(replayTotals(db)).resolves.toEqual(beforeReplay);
    });

    it('never downgrades cost-overrun or cost-denied during ambiguity or reserved-but-confirmed recovery', async () => {
        for (const reason of ['cost_overrun', 'cost_denied'] as const) {
            const db = await createDb();
            await seedLiveSources(db);
            await db.exec(`INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
                VALUES ('${requestId}','${jobKey}','${secondProviderOperationKey}','${providerInputHash}','${claimToken}','77777777-7777-4777-8777-777777777777','apify','actor-id','primary',0.2,'starting')`);
            const reserve = (key: string) => `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
            const start = (key: string) => `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
            const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
            const settleSecond = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${secondProviderOperationKey}',0::smallint)`;
            await query(db, reserve(providerOperationKey)); await query(db, reserve(secondProviderOperationKey));
            await query(db, start(providerOperationKey));
            await db.exec(`UPDATE public.analysis_revenue_run_ledgers SET status='manual_review',manual_review_reason='${reason}' WHERE request_id='${requestId}'`);
            await expect(query(db, release)).resolves.toBeDefined();
            await expect(db.query(`SELECT manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
                .resolves.toMatchObject({ rows: [{ manual_review_reason: reason }] });
            await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='succeeded',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${secondProviderOperationKey}'`);
            await query(db, settleSecond);
            await expect(db.query(`SELECT manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
                .resolves.toMatchObject({ rows: [{ manual_review_reason: reason }] });
        }
    });

    it('clears ambiguous_external_call only after every ambiguous child has authoritative terminal recovery', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        await db.exec(`INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
            VALUES ('${requestId}','${jobKey}','${secondProviderOperationKey}','${providerInputHash}','${claimToken}','77777777-7777-4777-8777-777777777777','apify','actor-id','primary',0.2,'starting')`);
        await db.exec(`INSERT INTO public.analysis_v2_provider_runs(request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,credential_slot,max_charge_usd,status)
            VALUES ('${requestId}','${jobKey}','${targetProfileOperationKey}','${providerInputHash}','${claimToken}','88888888-8888-4888-8888-888888888888','apify','actor-id','primary',0.2,'starting')`);
        const reserve = (key: string) => `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const start = (key: string) => `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const release = (key: string) => `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${key}',0::smallint)`;
        const settle = (key: string) => `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${key}',0::smallint)`;
        for (const key of [providerOperationKey, secondProviderOperationKey]) {
            await query(db, reserve(key));
        }
        for (const key of [providerOperationKey, secondProviderOperationKey]) {
            await query(db, start(key));
        }
        await query(db, release(providerOperationKey));
        const afterFirstAmbiguity = await replayTotals(db);
        await expectError(query(db, reserve(targetProfileOperationKey)), 'REVENUE_COST_OPERATION_FENCE');
        await expect(replayTotals(db)).resolves.toEqual(afterFirstAmbiguity);
        await query(db, release(secondProviderOperationKey));
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}'`);
        await query(db, settle(providerOperationKey));
        await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'ambiguous_external_call' }] });
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run67890',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}' AND operation_key='${secondProviderOperationKey}'`);
        await query(db, settle(secondProviderOperationKey));
        await expect(db.query(`SELECT status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'running', manual_review_reason: null }] });
    });

    it('uses a lifecycle-safe terminal timestamp for a definite no-run starting release', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve); await query(db, release);
        await expect(db.query(`SELECT terminal_at >= created_at AS lifecycle_safe FROM public.analysis_revenue_cost_operations WHERE request_id='${requestId}' AND owner_kind='provider_run'`))
            .resolves.toMatchObject({ rows: [{ lifecycle_safe: true }] });
    });

    it.each(['succeeded', 'failed'])('settles authoritative terminal %s usage after the request and lease are terminal', async (status) => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve);
        await query(db, start);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='${status}',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.21,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}';
          UPDATE public.analysis_pipeline_jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE request_id='${requestId}' AND job_key='${jobKey}';
          UPDATE public.analysis_requests SET status='completed' WHERE id='${requestId}'`);
        await expect(query<{ result: { disposition: string; created: boolean } }>(db, settle)).resolves.toMatchObject({ rows: [{ result: { disposition: 'settled', created: true } }] });
        await expect(query<{ result: { replayed: boolean } }>(db, settle)).resolves.toMatchObject({ rows: [{ result: { disposition: 'settled', replayed: true } }] });
        await expect(db.query(`SELECT reserved_cost_krw,economic_actual_krw,actual_cost_krw,billed_actual_krw FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, economic_actual_krw: 313, actual_cost_krw: 313, billed_actual_krw: 0 }] });
    });

    it('does not mutate an active or terminal-unreconciled provider source during settlement', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve); await query(db, start);
        const beforeRunning = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_NOT_READY');
        await expect(replayTotals(db)).resolves.toEqual(beforeRunning);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',updated_at=reserved_at + interval '3 seconds' WHERE request_id='${requestId}'`);
        const beforeUnreconciled = await replayTotals(db);
        await expectError(query(db, settle), 'REVENUE_COST_OPERATION_NOT_READY');
        await expect(replayTotals(db)).resolves.toEqual(beforeUnreconciled);
    });

    it('records terminal cost truth and fences skipped start plus over-cap truth for manual review', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='succeeded',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=2,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}'`);
        await query(db, settle);
        await expect(db.query(`SELECT reserved_cost_krw,economic_actual_krw,billed_actual_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, economic_actual_krw: 2908, billed_actual_krw: 0, status: 'manual_review', manual_review_reason: 'cost_overrun' }] });
    });

    it('fences a started provider release as ambiguous then clears that ambiguity only after terminal reconciliation', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve); await query(db, start);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='running',run_id='run12345',run_started_at=reserved_at + interval '1 second',updated_at=reserved_at + interval '2 seconds' WHERE request_id='${requestId}'`);
        await expect(query<{ result: { disposition: string } }>(db, release)).resolves.toMatchObject({ rows: [{ result: { disposition: 'ambiguous' } }] });
        await expect(db.query(`SELECT reserved_cost_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, status: 'manual_review', manual_review_reason: 'ambiguous_external_call' }] });
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='failed',terminalized_at=reserved_at + interval '3 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '4 seconds',updated_at=reserved_at + interval '5 seconds' WHERE request_id='${requestId}'`);
        await expect(query<{ result: { disposition: string } }>(db, settle)).resolves.toMatchObject({ rows: [{ result: { disposition: 'settled' } }] });
        await expect(db.query(`SELECT status,manual_review_reason,billed_actual_krw FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'running', manual_review_reason: null, billed_actual_krw: 0 }] });
    });

    it('treats a started marker as ambiguous even before the provider has a run id', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const release = `SELECT public.release_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve); await query(db, start);
        await expect(query<{ result: { disposition: string } }>(db, release)).resolves.toMatchObject({ rows: [{ result: { disposition: 'ambiguous' } }] });
        await expect(db.query(`SELECT reserved_cost_krw,status,manual_review_reason FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ reserved_cost_krw: 0, status: 'manual_review', manual_review_reason: 'ambiguous_external_call' }] });
    });

    it('marks a reserved child with below-cap confirmed usage as routing failure rather than losing provider truth', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint)`;
        await query(db, reserve);
        await db.exec(`UPDATE public.analysis_v2_provider_runs SET status='succeeded',run_id='run12345',run_started_at=reserved_at + interval '1 second',terminalized_at=reserved_at + interval '2 seconds',actual_usage_usd=0.1,usage_reconciled_at=reserved_at + interval '3 seconds',updated_at=reserved_at + interval '4 seconds' WHERE request_id='${requestId}'`);
        await query(db, settle);
        await expect(db.query(`SELECT status,manual_review_reason,billed_actual_krw FROM public.analysis_revenue_run_ledgers WHERE request_id='${requestId}'`))
            .resolves.toMatchObject({ rows: [{ status: 'manual_review', manual_review_reason: 'routing_failure', billed_actual_krw: 0 }] });
    });

    it('keeps a terminal failed provider child discoverable until its authoritative settlement succeeds', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const start = `SELECT public.mark_analysis_revenue_cost_operation_started_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const list = 'SELECT public.list_analysis_v2_unreconciled_provider_runs(64) AS result';
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve);
        await query(db, start);
        await db.exec(`
            UPDATE public.analysis_v2_provider_runs
               SET status='failed',run_id='run12345',reserved_at=clock_timestamp() - interval '4 minutes',
                   run_started_at=clock_timestamp() - interval '3 minutes',
                   terminalized_at=clock_timestamp() - interval '2 minutes',actual_usage_usd=0.1,
                   usage_reconciled_at=clock_timestamp() - interval '90 seconds',updated_at=clock_timestamp()
             WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}';
            UPDATE public.analysis_revenue_cost_operations
               SET created_at=clock_timestamp() - interval '4 minutes',
                   started_at=clock_timestamp() - interval '3 minutes'
             WHERE request_id='${requestId}' AND owner_kind='provider_run'
        `);

        const afterCrash = await query<{ result: Array<Record<string, unknown>> }>(db, list);
        expect(afterCrash.rows[0]?.result).toEqual([
            expect.objectContaining({
                status: 'failed',
                actualUsageUsd: 0.1,
                revenueCostSettlementRequired: true,
            }),
        ]);

        // A process can die after provider usage is durable. Reset only the
        // durable queue backoff, then prove the same exact child is retried.
        await db.exec(`
            UPDATE public.analysis_v2_provider_runs
               SET usage_reconciliation_attempted_at=clock_timestamp() - interval '2 hours',
                   updated_at=clock_timestamp()
             WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}'
        `);
        await expect(query<{ result: Array<Record<string, unknown>> }>(db, list))
            .resolves.toMatchObject({
                rows: [{ result: [expect.objectContaining({
                    revenueCostSettlementRequired: true,
                })] }],
            });
        await expect(query<{ result: { disposition: string } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'settled' } }] });
        await expect(query<{ result: Array<unknown> }>(db, list))
            .resolves.toMatchObject({ rows: [{ result: [] }] });
    });

    it('retries a possibly committed reserved child only after rejected provider truth is durable', async () => {
        const db = await createDb();
        await seedLiveSources(db);
        const reserve = `SELECT public.reserve_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','${claimToken}','${inputHash}','provider_run','${providerOperationKey}',0::smallint)`;
        const list = 'SELECT public.list_analysis_v2_unreconciled_provider_runs(64) AS result';
        const settle = `SELECT public.settle_analysis_revenue_cost_operation_v2('${requestId}','${jobKey}','provider_run','${providerOperationKey}',0::smallint) AS result`;
        await query(db, reserve);
        await db.exec(`
            UPDATE public.analysis_v2_provider_runs
               SET status='rejected',reserved_at=clock_timestamp() - interval '4 minutes',
                   terminalized_at=clock_timestamp() - interval '2 minutes',actual_usage_usd=0,
                   usage_reconciled_at=clock_timestamp() - interval '90 seconds',updated_at=clock_timestamp()
             WHERE request_id='${requestId}' AND operation_key='${providerOperationKey}'
        `);

        await expect(query<{ result: Array<Record<string, unknown>> }>(db, list))
            .resolves.toMatchObject({
                rows: [{ result: [expect.objectContaining({
                    status: 'rejected',
                    actualUsageUsd: 0,
                    revenueCostSettlementRequired: true,
                })] }],
            });
        await expect(query<{ result: { disposition: string } }>(db, settle))
            .resolves.toMatchObject({ rows: [{ result: { disposition: 'released' } }] });
        await expect(db.query(`
            SELECT status,started_at IS NULL AS started_cleared
              FROM public.analysis_revenue_cost_operations
             WHERE request_id='${requestId}' AND owner_kind='provider_run'
        `)).resolves.toMatchObject({
            rows: [{ status: 'released', started_cleared: true }],
        });
    });

    it('fails closed when an exact released marker conflicts with incurred provider usage', async () => {
        const db = await createDb();
        await prepareExactReleasedProviderChild(db);
        await setProviderSucceeded(db);
        const fixture = createPgliteRevenueSettlementFixture(db);

        await expect(
            fixture.settlement.settleAfterUsageReconciliation(
                await providerRunFromDatabase(db),
                { knownRevenueCostOperation: true },
            ),
        ).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        // The wrapper must reach the exact-child SQL proof instead of directly
        // accepting the stale released marker, then fence the request.
        expect(fixture.rpcCalls).toEqual([SETTLE_V2_RPC, MANUAL_REVIEW_RPC]);
        await expect(exactProviderCostState(db)).resolves.toMatchObject({
            childStatus: 'released',
            childEconomicUsd: null,
            ledgerStatus: 'manual_review',
            manualReviewReason: 'ambiguous_external_call',
            reservedCostKrw: 0,
            economicActualKrw: 8,
        });
    });

    it('fails closed when an exact settled marker conflicts with rejected provider truth', async () => {
        const db = await createDb();
        await prepareExactSettledProviderChild(db);
        await setProviderRejected(db);
        const fixture = createPgliteRevenueSettlementFixture(db);

        await expect(
            fixture.settlement.settleAfterUsageReconciliation(
                await providerRunFromDatabase(db),
                { knownRevenueCostOperation: true },
            ),
        ).rejects.toThrow('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');

        // Rejection proves no new provider run; it cannot silently overwrite
        // a settled, incurred child that belongs to the opposite outcome.
        expect(fixture.rpcCalls).toEqual([SETTLE_V2_RPC, MANUAL_REVIEW_RPC]);
        await expect(exactProviderCostState(db)).resolves.toMatchObject({
            childStatus: 'settled',
            childEconomicUsd: 0.1,
            ledgerStatus: 'manual_review',
            manualReviewReason: 'ambiguous_external_call',
            reservedCostKrw: 0,
            economicActualKrw: 153,
        });
    });

    it('replays an exact released child through settleV2 without mutation', async () => {
        const db = await createDb();
        await prepareExactReleasedProviderChild(db);
        const before = await exactProviderCostState(db);
        const fixture = createPgliteRevenueSettlementFixture(db);

        await expect(
            fixture.settlement.settleAfterUsageReconciliation(
                await providerRunFromDatabase(db),
                { knownRevenueCostOperation: true },
            ),
        ).resolves.toBeUndefined();

        expect(fixture.rpcCalls).toEqual([SETTLE_V2_RPC]);
        await expect(exactProviderCostState(db)).resolves.toEqual(before);
    });

    it('replays an exact settled child through settleV2 without mutation', async () => {
        const db = await createDb();
        await prepareExactSettledProviderChild(db);
        const before = await exactProviderCostState(db);
        const fixture = createPgliteRevenueSettlementFixture(db);

        await expect(
            fixture.settlement.settleAfterUsageReconciliation(
                await providerRunFromDatabase(db),
                { knownRevenueCostOperation: true },
            ),
        ).resolves.toBeUndefined();

        expect(fixture.rpcCalls).toEqual([SETTLE_V2_RPC]);
        await expect(exactProviderCostState(db)).resolves.toEqual(before);
    });

    it('has only the four-argument reconciliation RPC and foundation schema properties', async () => {
        const db = await createDb();
        const procedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='read_analysis_revenue_cost_reconciliation_v1'`);
        expect(procedures.rows).toEqual([{ args: 'uuid, text, uuid, text' }]);
        const reserveProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='reserve_analysis_revenue_cost_operation_v2'`);
        expect(reserveProcedures.rows).toEqual([{ args: 'uuid, text, uuid, text, text, text, smallint' }]);
        const startProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='mark_analysis_revenue_cost_operation_started_v2'`);
        expect(startProcedures.rows).toEqual([{ args: 'uuid, text, uuid, text, text, text, smallint' }]);
        const settleProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='settle_analysis_revenue_cost_operation_v2'`);
        expect(settleProcedures.rows).toEqual([{ args: 'uuid, text, text, text, smallint' }]);
        const releaseProcedures = await db.query<{ args: string }>(`SELECT pg_catalog.oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='release_analysis_revenue_cost_operation_v2'`);
        expect(releaseProcedures.rows).toEqual([{ args: 'uuid, text, uuid, text, text, text, smallint' }]);
        const privileges = await db.query<{ role: string; settle: boolean; release: boolean }>(`
            SELECT role, pg_catalog.has_function_privilege(role,
                'public.settle_analysis_revenue_cost_operation_v2(uuid,text,text,text,smallint)'::regprocedure, 'EXECUTE') AS settle,
                pg_catalog.has_function_privilege(role,
                'public.release_analysis_revenue_cost_operation_v2(uuid,text,uuid,text,text,text,smallint)'::regprocedure, 'EXECUTE') AS release
              FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role)
             ORDER BY role
        `);
        expect(privileges.rows).toEqual([
            { role: 'anon', settle: false, release: false },
            { role: 'authenticated', settle: false, release: false },
            { role: 'service_role', settle: true, release: true },
        ]);
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
