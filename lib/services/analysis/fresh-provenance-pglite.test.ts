import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    FreshProvenanceStore,
    type FreshProvenanceRpcClient,
} from './fresh-provenance-store';

const harnessSource = readFileSync(
    new URL('./fresh-provenance-pglite.test.ts', import.meta.url),
    'utf8',
);

// This is intentionally the complete forward migration, not a copied SQL
// fragment. The predecessor fixture only supplies the already-migrated schema
// dependencies that existed immediately before this migration.
const forwardMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);
const costOperationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url),
    'utf8',
);
// The forward migration's immediate predecessor is a checked-in immutable
// migration. Loading that file directly keeps this proof valid in a depth-one
// CI checkout, where historical Git objects need not be reachable.
const checkedInRevenuePredecessor = readFileSync(
    new URL('../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql', import.meta.url),
    'utf8',
);
const schedulerFoundationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713155145_add_analysis_v2_job_foundation.sql', import.meta.url),
    'utf8',
);
const schedulerTaskNameMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713214500_fix_analysis_v2_task_name_regex.sql', import.meta.url),
    'utf8',
);
const schedulerRecoveryMigration = readFileSync(
    new URL('../../../supabase/migrations/20260714045814_add_analysis_v2_recovery_rotation.sql', import.meta.url),
    'utf8',
);
const schedulerClaimMigration = readFileSync(
    new URL('../../../supabase/migrations/20260714031500_harden_analysis_v2_terminal_invariants.sql', import.meta.url),
    'utf8',
);
const schedulerCapacityMigration = readFileSync(
    new URL('../../../supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql', import.meta.url),
    'utf8',
);
const schedulerLiveMigration = readFileSync(
    new URL('../../../supabase/migrations/20260727034000_add_analysis_v2_scheduler_live_operations.sql', import.meta.url),
    'utf8',
);
const providerRunFoundationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713171647_add_analysis_v2_provider_run_ledger.sql', import.meta.url),
    'utf8',
);
const providerRunRepairOperationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260721000000_allow_analysis_v2_profile_repair_operation_key.sql', import.meta.url),
    'utf8',
);
const providerRunCredentialSlotMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713204500_expand_analysis_v2_apify_credential_slots.sql', import.meta.url),
    'utf8',
);
const providerRunRejectedMigration = readFileSync(
    new URL('../../../supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql', import.meta.url),
    'utf8',
);
const providerRunAdoptionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260731090000_adopt_capacity_safe_relationship_provider_runs.sql', import.meta.url),
    'utf8',
);
const providerRunLatestCredentialMigration = readFileSync(
    new URL('../../../supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql', import.meta.url),
    'utf8',
);
const providerPolicyMigration = readFileSync(
    new URL('../../../supabase/migrations/20260715103605_expose_v2_access_mode_to_collection_context.sql', import.meta.url),
    'utf8',
);
const profileCheckpointFoundationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql', import.meta.url),
    'utf8',
);
const profileSnapshotCaptionMigration = readFileSync(
    new URL('../../../supabase/migrations/20260716130000_allow_carousel_child_captions.sql', import.meta.url),
    'utf8',
);
const profileRepairAttemptMigration = readFileSync(
    new URL('../../../supabase/migrations/20260720130000_add_analysis_v2_profile_repair_attempt.sql', import.meta.url),
    'utf8',
);
const profileHiddenCountsMigration = readFileSync(
    new URL('../../../supabase/migrations/20260721164500_preserve_hidden_engagement_sentinels.sql', import.meta.url),
    'utf8',
);
const profileSnapshotValidatorRevokeMigration = readFileSync(
    new URL('../../../supabase/migrations/20260721170500_revoke_hidden_snapshot_validator.sql', import.meta.url),
    'utf8',
);
const exactPredecessorSourceHashes: readonly [string, string, string][] = [
    ['revenue ledger', checkedInRevenuePredecessor, '449455fa1d3c59bb60522f6f379aa521e32cfb171f6dcc3c329c344807a09dda'],
    ['revenue cost', costOperationMigration, 'd730b9127b890ea9475e81f4eaefcd6fcf30fceb27efcc6b7b13f510390f4254'],
    ['scheduler foundation', schedulerFoundationMigration, '77601b35d99131e690b4e6503bb2006807f1483d883d48d39c90b26b74e775b4'],
    ['scheduler task-name correction', schedulerTaskNameMigration, 'adc90b1205f388c8ee7338ad75ce9cba011dbf490638ec848600c55d2f6624f2'],
    ['scheduler recovery', schedulerRecoveryMigration, '080a19405177aed74985ad5a54f4a72e801512c6912f72025ac5fd2c2ff34f2c'],
    ['scheduler claim', schedulerClaimMigration, 'a6dc4b0dec163ba184af5acda875c2a65830f5c0f83904a50fb828392688c2c6'],
    ['scheduler capacity', schedulerCapacityMigration, 'c34451eea121a1eb7a6ed515519789374aa73e1319e71e08e0e100ab2e99de25'],
    ['scheduler live operations', schedulerLiveMigration, '887e5ac342a88ae182333db996862a8e193d5085c3b175d18ec54c9d26c9b7c4'],
    ['provider-run foundation', providerRunFoundationMigration, '35065db52a2987007a1db0a6655cedb7680e69e257a97b01a043aa9f4d66d714'],
    ['provider-run repair operation', providerRunRepairOperationMigration, '415b5aad264d7c3c577b7fc9c2ab6edf908dd9effdcb8807d30fe7b7a56be23d'],
    ['provider-run credential slots', providerRunCredentialSlotMigration, '197898acdc1cd5323fa61bade157c0db5aaf6076bab81e019d331a1756efdd0b'],
    ['provider-run rejection state', providerRunRejectedMigration, '67d9e346080a45a060a812eba96fc6b10a66e92e50eb0acd3eb9bbd73968e7e3'],
    ['provider-run adoption key', providerRunAdoptionMigration, 'd97d0443fea9f3ae1d40f0603c1aca72d82191860c4475b0a6bd1cb6184c9866'],
    ['provider-run current slots', providerRunLatestCredentialMigration, '3ea84bc83462de553366e6af04ce3432a938c8485cb930720e8f96165e4cdff2'],
    ['provider policy', providerPolicyMigration, '2634c90909a9ad1b3601ee539292d395c11b1d99d40d53c360c8bbf0ac9fff24'],
    ['profile checkpoint foundation', profileCheckpointFoundationMigration, '3918a48fab30b5fc0d0d35bd4432bd709c5c559f720e3b72cd2a20906f605580'],
    ['profile snapshot caption validator', profileSnapshotCaptionMigration, 'e68cfc9c07ff7d10bdfc9de13b723b896a58dfee990ae28cb36b7f7c019cccc6'],
    ['profile repair attempt', profileRepairAttemptMigration, '67630086ff6edd1a4e9aeec6764e857e90828ebc71a4211157906a93874dc3bf'],
    ['profile hidden-count validator', profileHiddenCountsMigration, '0e2e8cb99353d3f66a6fe489f5f2ca1ac893c7d67d7f3ab384587a34590125d6'],
    ['profile validator permissions', profileSnapshotValidatorRevokeMigration, 'ce7b581166d8f6c56e58d2e94f9dd13f2bcc9fbb8fa6cebd5dd8fb833b5dfea0'],
];

function sourceSection(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0 || end <= start) {
        throw new Error(`PGLITE_PREDECESSOR_SOURCE_SECTION_MISSING:${startMarker}`);
    }
    return source.slice(start, end);
}

function predecessorRevenueLedger(source: string): string {
    const end = source.indexOf('CREATE TABLE public.analysis_result_share_observations');
    if (end <= 0) throw new Error('PGLITE_PREDECESSOR_LEDGER_MISSING');
    return source.slice(0, end);
}

const checkedInRevenueLedgerPredecessor = predecessorRevenueLedger(checkedInRevenuePredecessor);

// The exact source slices create the pre-forward scheduler table and its
// accumulated constraints. This avoids a weak compatibility table whose
// columns or fences drift from the scheduler functions the migration wraps.
const exactSchedulerPredecessorSchema = [
    sourceSection(
        schedulerFoundationMigration,
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_job_keys',
        '-- Keep the mature entitlement validation in a private helper',
    ),
    sourceSection(
        schedulerTaskNameMigration,
        'ALTER TABLE public.analysis_pipeline_jobs',
        'CREATE OR REPLACE FUNCTION public.mark_analysis_v2_job_dispatched',
    ),
    sourceSection(
        schedulerRecoveryMigration,
        'ALTER TABLE public.analysis_pipeline_jobs',
        'CREATE OR REPLACE FUNCTION public.defer_analysis_v2_job_recovery',
    ),
    sourceSection(
        schedulerCapacityMigration,
        'ALTER TABLE public.analysis_pipeline_jobs',
        'CREATE FUNCTION public.defer_analysis_v2_job_for_ai_capacity',
    ),
    sourceSection(
        schedulerLiveMigration,
        'ALTER TABLE public.analysis_pipeline_jobs',
        'CREATE TABLE public.analysis_v2_scheduler_operations',
    ),
].join('\n\n');

const exactProviderRunPredecessorSchema = [
    sourceSection(
        providerRunFoundationMigration,
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_operation_key',
        'CREATE OR REPLACE FUNCTION public.analysis_v2_provider_run_json',
    ),
    providerRunRepairOperationMigration,
    sourceSection(
        providerRunCredentialSlotMigration,
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot',
        'ALTER TABLE public.analysis_v2_relationship_sides',
    ),
    sourceSection(
        schedulerClaimMigration,
        'ALTER TABLE public.analysis_v2_provider_runs',
        'CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs',
    ),
    sourceSection(
        providerRunRejectedMigration,
        'ALTER TABLE public.analysis_v2_provider_runs',
        'ALTER TABLE public.analysis_preflight_provider_runs',
    ),
    sourceSection(
        providerRunAdoptionMigration,
        'ALTER TABLE public.analysis_v2_provider_runs',
        'ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions',
    ),
    sourceSection(
        providerRunLatestCredentialMigration,
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot',
        '-- The authorized-free-e2e-v1 policy is a historical six-slot contract',
    ),
].join('\n\n');

const exactProviderPolicyPredecessorSchema = sourceSection(
    providerPolicyMigration,
    'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_test_operation_slot_map',
    'CREATE OR REPLACE FUNCTION public.bind_analysis_v2_authorized_test_provider_policy',
);

// Profile checkpoint functions and relations are also exact source slices.
// The forward migration widens their attempt domain and invokes both
// validators, so a handwritten approximation here could mask a real
// predecessor incompatibility.
const exactProfileCheckpointPredecessorSchema = [
    sourceSection(
        profileCheckpointFoundationMigration,
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_username_list',
        'CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot',
    ),
    profileSnapshotCaptionMigration,
    sourceSection(
        profileRepairAttemptMigration,
        'ALTER TABLE public.analysis_v2_profile_fetch_outcomes',
        '-- 4. Server-derived repair set',
    ),
    profileHiddenCountsMigration,
    profileSnapshotValidatorRevokeMigration,
].join('\n\n');

function historicalFunction(source: string, name: string): string {
    const match = source.match(new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    ));
    if (!match) throw new Error(`missing historical scheduler function: ${name}`);
    return match[0];
}

const historicalSchedulerFunctions = [
    historicalFunction(schedulerFoundationMigration, 'reserve_analysis_v2_job_dispatch'),
    historicalFunction(schedulerTaskNameMigration, 'mark_analysis_v2_job_dispatched'),
    historicalFunction(schedulerFoundationMigration, 'rearm_analysis_v2_job_dispatch'),
    historicalFunction(schedulerClaimMigration, 'claim_analysis_v2_job'),
    historicalFunction(schedulerLiveMigration, 'continue_analysis_v2_scheduler_job'),
].join('\n\n');

const requestId = '11111111-1111-4111-8111-111111111111';
const preflightId = '22222222-2222-4222-8222-222222222222';
const hostilePreflightId = '23232323-2323-4232-8232-232323232323';
const rewrittenRequestId = '24242424-2424-4242-8242-242424242424';
const userId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const schedulerReservationToken = '77777777-7777-4777-8777-777777777777';
const providerReservationToken = '88888888-8888-4888-8888-888888888888';
const jobKey = 'track:relationships:collect';
const jobInputHash = 'a'.repeat(64);
const providerInputHash = 'b'.repeat(64);
const operationKey = `relationship-followers:${'c'.repeat(64)}`;
const runId = 'FreshApifyRun1234';
const datasetId = 'FreshDataset1234';
const hash = (character: string) => character.repeat(64);
const databases: PGlite[] = [];

// PGlite cannot provision every unrelated production dependency, so this
// bridge holds only the request/preflight lineage signatures exercised by the
// proof. Every relation the forward migration transforms or interprets (jobs,
// profile checkpoints, provider runs, and policy) comes from exact checked-in
// predecessor source slices above.
const pgliteRuntimeDependencyBridge = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE EXTENSION pgcrypto;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid
LANGUAGE sql AS $$ SELECT public.gen_random_uuid() $$;
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea
LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea
LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;

CREATE TABLE public.analysis_requests (
    id uuid PRIMARY KEY,
    preflight_id uuid NOT NULL,
    user_id uuid NOT NULL,
    pipeline_version text NOT NULL,
    plan_access_mode_snapshot text NOT NULL,
    selected_plan_id_snapshot text NOT NULL,
    status text NOT NULL,
    background_processing boolean NOT NULL DEFAULT true,
    progress_step text NOT NULL DEFAULT 'running',
    current_step text NOT NULL DEFAULT 'running',
    error_message text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL
);
CREATE TABLE public.analysis_preflights (
    id uuid PRIMARY KEY,
    consumed_request_id uuid UNIQUE,
    status text NOT NULL,
    access_mode text NOT NULL,
    target_input_hash text NOT NULL,
    admission_refreshed_at timestamptz NOT NULL
);
${exactSchedulerPredecessorSchema}
${exactProfileCheckpointPredecessorSchema}
${exactProviderRunPredecessorSchema}
${exactProviderPolicyPredecessorSchema}

`;

async function installHistoricalSchedulerFunctions(db: PGlite): Promise<void> {
    // PGlite cannot provision the unrelated historical scheduler dependency
    // graph. It still installs the exact published function bodies rather
    // than a behavioral substitute, and every runtime call below is fenced by
    // the forward migration before that legacy body can execute.
    await db.exec('SET check_function_bodies = off');
    await db.exec(historicalSchedulerFunctions);
    await db.exec('SET check_function_bodies = on');
}

async function applyDeployedRevenueHistory(db: PGlite): Promise<void> {
    await db.exec('SET check_function_bodies = off');
    await db.exec(pgliteRuntimeDependencyBridge);
    await db.exec(checkedInRevenueLedgerPredecessor);
    await db.exec(costOperationMigration);
    await installHistoricalSchedulerFunctions(db);
}

async function createDbFromCheckedInPredecessor(): Promise<PGlite> {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    databases.push(db);
    await applyDeployedRevenueHistory(db);
    await db.exec(forwardMigration);
    return db;
}

async function createDb(): Promise<PGlite> {
    return createDbFromCheckedInPredecessor();
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', fn: () => Promise<T>): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await fn();
    } finally {
        await db.exec('RESET ROLE');
    }
}

type FreshRpcName =
    | 'assert_analysis_revenue_fresh_provider_admission_v1'
    | 'record_analysis_revenue_fresh_provider_evidence_v1'
    | 'bind_analysis_revenue_fresh_provider_dataset_v1';

const freshRpcCalls: Record<FreshRpcName, readonly [string, readonly string[]]> = {
    assert_analysis_revenue_fresh_provider_admission_v1: [
        'SELECT public.assert_analysis_revenue_fresh_provider_admission_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash'],
    ],
    record_analysis_revenue_fresh_provider_evidence_v1: [
        'SELECT public.record_analysis_revenue_fresh_provider_evidence_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash', 'p_provider_run_hash'],
    ],
    bind_analysis_revenue_fresh_provider_dataset_v1: [
        'SELECT public.bind_analysis_revenue_fresh_provider_dataset_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash', 'p_provider_run_hash', 'p_provider_dataset_hash'],
    ],
};

async function serviceFreshRpc(
    db: PGlite,
    name: FreshRpcName,
    params: Record<string, unknown>,
): Promise<unknown> {
    const [sql, keys] = freshRpcCalls[name];
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, sql, keys.map(key => params[key]));
        return result.rows[0]?.result ?? null;
    });
}

function rpcClient(db: PGlite): FreshProvenanceRpcClient {
    return {
        async rpc(name, params) {
            if (!(name in freshRpcCalls)) {
                return { data: null, error: { code: 'PGRST202', message: 'unknown RPC' } };
            }
            try {
                return {
                    data: await serviceFreshRpc(db, name as FreshRpcName, params),
                    error: null,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'unknown';
                return {
                    data: null,
                    error: {
                        code: 'P0001',
                        message: message.match(/FRESH_PROVENANCE_[A-Z_]+/)?.[0] ?? message,
                    },
                };
            }
        },
    };
}

async function seed(
    db: PGlite,
    { requestPreflightId = preflightId }: { requestPreflightId?: string } = {},
): Promise<void> {
    const hostilePreflight = requestPreflightId === preflightId ? '' : `
        INSERT INTO public.analysis_preflights(
            id,consumed_request_id,status,access_mode,target_input_hash,admission_refreshed_at
        ) VALUES (
            '${requestPreflightId}',NULL,'ready','test_entitlement','${hash('d')}','2026-08-10T00:00:00Z'
        );`;
    await db.exec(`
        INSERT INTO public.analysis_requests(
            id,preflight_id,user_id,pipeline_version,plan_access_mode_snapshot,
            selected_plan_id_snapshot,status,background_processing,progress_step,current_step,created_at
        ) VALUES (
            '${requestId}','${requestPreflightId}','${userId}','v2','test_entitlement',
            'basic','processing',TRUE,'running','running','2026-08-10T00:01:00Z'
        );
        INSERT INTO public.analysis_preflights(
            id,consumed_request_id,status,access_mode,target_input_hash,admission_refreshed_at
        ) VALUES (
            '${preflightId}','${requestId}','consumed','test_entitlement','${hash('d')}','2026-08-10T00:00:00Z'
        );
        INSERT INTO public.analysis_revenue_run_ledgers(
            request_id,preflight_id,user_id,plan_id,access_mode,target_username_hmac,
            preflight_refreshed_at,request_started_at,cost_cap_krw,margin_target_krw
        ) VALUES (
            '${requestId}','${requestPreflightId}','${userId}','basic','test_entitlement','${hash('d')}',
            '2026-08-10T00:00:00Z','2026-08-10T00:01:00Z',1808,904
        );
        INSERT INTO public.analysis_pipeline_jobs(
            request_id,job_key,track,kind,batch,input_hash,required_job_keys,
            status,dispatch_state,dispatch_generation,dispatch_reservation_token,
            dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,
            lease_token,lease_expires_at,attempt_count,first_started_at,created_at,updated_at
        ) VALUES (
            '${requestId}','${jobKey}','relationships','collect',NULL,'${jobInputHash}','{}'::text[],
            'processing','delivered',1,'${schedulerReservationToken}',
            '2026-08-10T00:01:01Z','2026-08-10T00:01:02Z','analysis-v2.relationships.collect','2026-08-10T00:01:03Z',
            '${claimToken}','2099-01-01T00:00:00Z',1,'2026-08-10T00:01:03Z','2026-08-10T00:01:00Z','2026-08-10T00:01:04Z'
        );
        INSERT INTO public.analysis_v2_provider_execution_policies(
            request_id,mode,policy_version,entitlement_jti_hash,target_instagram_id,
            operation_slot_map,policy_hash
        ) VALUES (
            '${requestId}','test_operation_split','authorized-free-e2e-v1','${hash('e')}','target.user',
            '{"target-profile":"primary","relationship-followers":"tertiary","relationship-following":"quaternary","profile-fallback":"primary","target-likers":"senary","target-comments":"tertiary","candidate-likers":"quaternary"}'::jsonb,
            '${hash('a')}'
        );
        INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,
            logical_provider,actor_id,credential_slot,max_charge_usd,status,
            run_id,reserved_at,run_started_at,updated_at
        ) VALUES (
            '${requestId}','${jobKey}','${operationKey}','${providerInputHash}','${claimToken}','${providerReservationToken}',
            'apify','apify/actor','primary',0.01,'running',
            '${runId}','2026-08-10T00:02:00Z','2026-08-10T00:03:00Z','2026-08-10T00:03:00Z'
        );
        ${hostilePreflight}
    `);
}

function store(db: PGlite): FreshProvenanceStore {
    return new FreshProvenanceStore(rpcClient(db));
}

function identity() {
    return {
        requestId,
        jobKey,
        jobClaimToken: claimToken,
        jobInputHash,
        operationKey,
        providerInputHash,
        runId,
    };
}

const directProfileOutcomes = [{
    username: 'alice',
    source: 'apify',
    status: 'failed',
    failure_category: 'timeout',
    http_status: 504,
    request_count: 1,
    latency_ms: 10,
    captured_at: '2026-08-10T00:04:00Z',
    profile: null,
}];

function freshOperationHash(value: string): string {
    return createHash('sha256').update(
        `analysis-revenue-fresh-provider-operation/v1|${Buffer.byteLength(value, 'utf8')}:${value}`,
        'utf8',
    ).digest('hex');
}

function freshRunHash(value: string): string {
    return createHash('sha256').update(
        [
            'analysis-revenue-fresh-provider-run/v1',
            `${Buffer.byteLength(requestId, 'utf8')}:${requestId}`,
            `${Buffer.byteLength(jobKey, 'utf8')}:${jobKey}`,
            `${Buffer.byteLength(operationKey, 'utf8')}:${operationKey}`,
            `${Buffer.byteLength(value, 'utf8')}:${value}`,
        ].join('|'),
        'utf8',
    ).digest('hex');
}

async function seedBoundFreshEvidence(db: PGlite): Promise<void> {
    await query(db,
        "UPDATE public.analysis_v2_provider_runs SET status='succeeded', terminalized_at='2026-08-10T00:04:00Z' WHERE request_id=$1::uuid",
        [requestId],
    );
    await query(db, `
        INSERT INTO public.analysis_revenue_fresh_provider_evidence(
            request_id,job_key,job_input_hash,operation_key_hash,provider,provider_input_hash,
            provider_run_hash,provider_run_started_at,no_reuse,no_adoption,no_cache,
            provider_dataset_hash,dataset_bound_at
        ) VALUES (
            $1::uuid,$2,$3,$4,'apify',$5,$6,'2026-08-10T00:03:00Z',TRUE,TRUE,TRUE,
            $7,pg_catalog.clock_timestamp()
        )
    `, [
        requestId,
        jobKey,
        jobInputHash,
        freshOperationHash(operationKey),
        providerInputHash,
        freshRunHash(runId),
        hash('f'),
    ]);
}

async function checkpointFreshProfile(db: PGlite): Promise<unknown> {
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, `
            SELECT public.checkpoint_analysis_v2_profile_fresh_apify_v1(
                $1::uuid,$2::text,$3::uuid,$4::text,$5::text[],$6::jsonb,$7::text,$8::text
            ) AS result
        `, [
            requestId,
            jobKey,
            claimToken,
            jobInputHash,
            ['alice'],
            JSON.stringify(directProfileOutcomes),
            operationKey,
            providerInputHash,
        ]);
        return result.rows[0]?.result;
    });
}

async function serviceJsonRpc(db: PGlite, sql: string, params: unknown[] = []): Promise<unknown> {
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, sql, params);
        return result.rows[0]?.result ?? null;
    });
}

async function serviceQuery<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return asRole(db, 'service_role', () => query<T>(db, sql, params));
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('fresh revenue provenance forward migration PGlite proof', () => {
    it('is independent of unreachable Git history in a depth-one checkout', () => {
        expect(harnessSource).not.toContain(['node:', 'child_process'].join(''));
        expect(harnessSource).not.toContain(['exec', 'FileSync('].join(''));
        expect(harnessSource).not.toContain(['git ', 'show'].join(''));
    });

    it('keeps profile checkpoint validators out of the minimal handwritten bridge', () => {
        const bridgeSource = sourceSection(
            harnessSource,
            'const pgliteRuntimeDependencyBridge = `',
            '`;\n\nasync function installHistoricalSchedulerFunctions',
        );
        expect(bridgeSource).toContain('${exactProfileCheckpointPredecessorSchema}');
        expect(bridgeSource).not.toContain(
            'CREATE FUNCTION public.analysis_v2_valid_profile_',
        );
        expect(bridgeSource).not.toContain(
            'CREATE TABLE public.analysis_v2_profile_fetch_',
        );
    });

    it('loads the immutable checked-in predecessor rather than a rewritten history snapshot', () => {
        for (const [name, source, expectedHash] of exactPredecessorSourceHashes) {
            expect(createHash('sha256').update(source, 'utf8').digest('hex'), name)
                .toBe(expectedHash);
        }
        expect(checkedInRevenueLedgerPredecessor.startsWith('-- Revenue E2E additive ledgers.')).toBe(true);
        expect(checkedInRevenueLedgerPredecessor).toContain(
            'CREATE TABLE public.analysis_revenue_run_ledgers',
        );
        expect(checkedInRevenueLedgerPredecessor).not.toContain(
            'analysis_revenue_fresh_provider_evidence',
        );
    });

    it('starts from the exact pre-hardening ledger and scheduler shape before the forward migration adds fresh objects', async () => {
        const db = await PGlite.create({ extensions: { pgcrypto } });
        databases.push(db);
        await applyDeployedRevenueHistory(db);

        const schedulerColumns = await query<{ column_name: string }>(db, `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'analysis_pipeline_jobs'
            ORDER BY ordinal_position
        `);
        expect(schedulerColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
            'track',
            'kind',
            'dispatch_generation',
            'dispatch_reservation_token',
            'dispatch_task_name',
            'recovery_checked_at',
            'recovery_not_before',
            'ai_capacity_deferral_count',
            'scheduler_not_before_at',
        ]));
        const schedulerConstraints = await query<{ conname: string }>(db, `
            SELECT conname
            FROM pg_catalog.pg_constraint
            WHERE conrelid = 'public.analysis_pipeline_jobs'::pg_catalog.regclass
            ORDER BY conname
        `);
        expect(schedulerConstraints.rows.map(row => row.conname)).toEqual(expect.arrayContaining([
            'analysis_pipeline_jobs_dispatch_pair_check',
            'analysis_pipeline_jobs_lease_check',
            'analysis_pipeline_jobs_recovery_schedule_check',
            'analysis_pipeline_jobs_ai_capacity_deferral_count_check',
            'analysis_pipeline_jobs_task_name_check',
        ]));
        const providerColumns = await query<{ column_name: string }>(db, `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'analysis_v2_provider_runs'
            ORDER BY ordinal_position
        `);
        expect(providerColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
            'reservation_token',
            'actor_id',
            'credential_slot',
            'max_charge_usd',
            'terminalized_at',
            'usage_reconciliation_attempt_count',
            'usage_reconciliation_attempted_at',
        ]));
        const providerConstraints = await query<{ conname: string }>(db, `
            SELECT conname
            FROM pg_catalog.pg_constraint
            WHERE conrelid = 'public.analysis_v2_provider_runs'::pg_catalog.regclass
            ORDER BY conname
        `);
        expect(providerConstraints.rows.map(row => row.conname)).toEqual(expect.arrayContaining([
            'analysis_v2_provider_run_operation_key_check',
            'analysis_v2_provider_run_state_check',
            'analysis_v2_provider_usage_attempt_count_check',
            'analysis_v2_provider_usage_attempt_time_check',
            'analysis_v2_provider_runs_adoption_source_run_unique',
        ]));
        const policyColumns = await query<{ column_name: string }>(db, `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'analysis_v2_provider_execution_policies'
            ORDER BY ordinal_position
        `);
        expect(policyColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
            'entitlement_jti_hash',
            'target_instagram_id',
            'operation_slot_map',
            'policy_hash',
        ]));

        const predecessorObjects = await query<{
            ledger_has_scratch: boolean;
            ledger_has_request_fk: boolean;
            evidence_exists: boolean;
            evidence_trigger_count: number;
        }>(db, `
            SELECT
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'analysis_revenue_run_ledgers'
                      AND column_name = 'fresh_provenance'
                ) AS ledger_has_scratch,
                EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint
                    WHERE conrelid = 'public.analysis_revenue_run_ledgers'::pg_catalog.regclass
                      AND conname = 'analysis_revenue_run_ledgers_request_id_fkey'
                ) AS ledger_has_request_fk,
                pg_catalog.to_regclass('public.analysis_revenue_fresh_provider_evidence') IS NOT NULL AS evidence_exists,
                (
                    SELECT count(*)::int
                    FROM pg_catalog.pg_trigger
                    WHERE tgname IN (
                        'analysis_revenue_run_ledger_lineage_immutable',
                        'analysis_revenue_fresh_provider_evidence_immutable'
                    )
                ) AS evidence_trigger_count
        `);
        expect(predecessorObjects.rows[0]).toEqual({
            ledger_has_scratch: true,
            ledger_has_request_fk: true,
            evidence_exists: false,
            evidence_trigger_count: 0,
        });

        await db.exec(forwardMigration);
        const forwardObjects = await query<{
            ledger_has_scratch: boolean;
            ledger_has_request_fk: boolean;
            evidence_exists: boolean;
            evidence_trigger_count: number;
        }>(db, `
            SELECT
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'analysis_revenue_run_ledgers'
                      AND column_name = 'fresh_provenance'
                ) AS ledger_has_scratch,
                EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_constraint
                    WHERE conrelid = 'public.analysis_revenue_run_ledgers'::pg_catalog.regclass
                      AND conname = 'analysis_revenue_run_ledgers_request_id_fkey'
                ) AS ledger_has_request_fk,
                pg_catalog.to_regclass('public.analysis_revenue_fresh_provider_evidence') IS NOT NULL AS evidence_exists,
                (
                    SELECT count(*)::int
                    FROM pg_catalog.pg_trigger
                    WHERE tgname IN (
                        'analysis_revenue_run_ledger_lineage_immutable',
                        'analysis_revenue_fresh_provider_evidence_immutable'
                    )
                ) AS evidence_trigger_count
        `);
        expect(forwardObjects.rows[0]).toEqual({
            ledger_has_scratch: false,
            ledger_has_request_fk: false,
            evidence_exists: true,
            evidence_trigger_count: 2,
        });
    });

    it('applies the exact forward migration after the checked-in predecessor and cost migration chain', async () => {
        const db = await createDbFromCheckedInPredecessor();
        const relation = await query<{ exists: boolean }>(db, `
            SELECT pg_catalog.to_regclass('public.analysis_revenue_fresh_provider_evidence') IS NOT NULL AS exists
        `);
        expect(relation.rows[0]?.exists).toBe(true);
    });

    it('uses the exact profile checkpoint validators and repair constraints before fresh hardening', async () => {
        const db = await PGlite.create({ extensions: { pgcrypto } });
        databases.push(db);
        await applyDeployedRevenueHistory(db);

        const batchColumns = await query<{ column_name: string }>(db, `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'analysis_v2_profile_fetch_batches'
            ORDER BY ordinal_position
        `);
        expect(batchColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
            'requested_usernames',
            'frozen_unresolved_usernames',
            'repair_usernames',
            'repair_payload_hash',
            'repair_completed_at',
        ]));
        const profileConstraints = await query<{ conname: string }>(db, `
            SELECT conname
            FROM pg_catalog.pg_constraint
            WHERE conrelid IN (
                'public.analysis_v2_profile_fetch_batches'::pg_catalog.regclass,
                'public.analysis_v2_profile_fetch_outcomes'::pg_catalog.regclass
            )
            ORDER BY conname
        `);
        expect(profileConstraints.rows.map(row => row.conname)).toEqual(expect.arrayContaining([
            'analysis_v2_profile_batches_repair_pair_check',
            'analysis_v2_profile_batches_repair_subset_check',
            'analysis_v2_profile_outcomes_attempt_check',
            'analysis_v2_profile_outcomes_ordinal_check',
            'analysis_v2_profile_outcomes_result_check',
            'analysis_v2_profile_outcomes_source_check',
        ]));

        const validators = await query<{
            repair_outcomes_valid: boolean;
            uppercase_username_valid: boolean;
            hidden_count_snapshot_valid: boolean;
        }>(db, `
            SELECT
                public.analysis_v2_valid_profile_outcomes(
                    $1::jsonb, ARRAY['alice']::text[], 'repair'
                ) AS repair_outcomes_valid,
                public.analysis_v2_valid_profile_username_list(
                    ARRAY['ALICE']::text[], FALSE
                ) AS uppercase_username_valid,
                public.analysis_v2_valid_profile_snapshot($2::jsonb)
                    AS hidden_count_snapshot_valid
        `, [
            JSON.stringify(directProfileOutcomes),
            JSON.stringify({
                username: 'alice',
                followersCount: 0,
                followingCount: 0,
                postsCount: 0,
                isPrivate: false,
                isVerified: false,
                latestPosts: [{
                    id: 'post-1',
                    shortCode: 'post1',
                    type: 'image',
                    likesCount: 0,
                    commentsCount: 0,
                    timestamp: '2026-08-10T00:04:00Z',
                    taggedUsers: [],
                    mentionedUsers: [],
                    likesCountHidden: true,
                }],
            }),
        ]);
        expect(validators.rows[0]).toEqual({
            repair_outcomes_valid: true,
            uppercase_username_valid: false,
            hidden_count_snapshot_valid: true,
        });
    });

    it('runs the full forward migration and uses only service_role RPCs for exact crash/resume evidence', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);

        await expect(fresh.assertProviderAdmission(identity())).resolves.toEqual({
            disposition: 'admitted', created: false, replayed: true,
        });
        await expect(fresh.recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: true, replayed: false,
        });
        // Simulated process loss after recording: a new store instance sees an
        // exact replay and no extra evidence row before Dataset binding.
        await expect(store(db).recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: false, replayed: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId }))
            .rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded', terminalized_at='2026-08-10T00:04:00Z' WHERE request_id=$1::uuid",
            [requestId],
        );
        await expect(store(db).bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: true, replayed: false,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: false, replayed: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId: 'OtherDataset1234' }))
            .rejects.toThrow('FRESH_PROVENANCE_DRIFT');
    });

    it('rejects profile-repair and generic operation keys in the storage RPC before any evidence write', async () => {
        const db = await createDb();
        await seed(db);
        await expect(serviceFreshRpc(db, 'assert_analysis_revenue_fresh_provider_admission_v1', {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_job_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
            p_operation_key: `profile-repair:${'c'.repeat(64)}`,
            p_provider_input_hash: providerInputHash,
        })).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        await expect(serviceFreshRpc(db, 'assert_analysis_revenue_fresh_provider_admission_v1', {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_job_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
            p_operation_key: `unapproved-provider:${'c'.repeat(64)}`,
            p_provider_input_hash: providerInputHash,
        })).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        const count = await query<{ count: number }>(db,
            'SELECT count(*)::int AS count FROM public.analysis_revenue_fresh_provider_evidence',
        );
        expect(count.rows[0]?.count).toBe(0);
    });

    it('enforces service-only ACL/RLS and denies anon/authenticated direct access', async () => {
        const db = await createDb();
        await seed(db);

        for (const role of ['anon', 'authenticated'] as const) {
            await expect(asRole(db, role, () => query(
                db,
                'SELECT * FROM public.analysis_revenue_fresh_provider_evidence',
            ))).rejects.toThrow();
            await expect(asRole(db, role, () => query(
                db,
                "SELECT public.assert_analysis_revenue_fresh_provider_admission_v1($1::uuid,$2,$3::uuid,$4,$5,$6)",
                [requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash],
            ))).rejects.toThrow();
        }
        await expect(asRole(db, 'service_role', () => query(
            db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='manual_review' WHERE request_id=$1::uuid",
            [requestId],
        ))).rejects.toThrow();
        await expect(asRole(db, 'service_role', () => query(
            db,
            `INSERT INTO public.analysis_revenue_fresh_provider_evidence(
                request_id,job_key,job_input_hash,operation_key_hash,provider,provider_input_hash,
                provider_run_hash,provider_run_started_at,no_reuse,no_adoption,no_cache
            ) VALUES ($1::uuid,$2,$3,$4,'apify',$5,$6,pg_catalog.clock_timestamp(),TRUE,TRUE,TRUE)`,
            [requestId, jobKey, jobInputHash, hash('e'), providerInputHash, hash('f')],
        ))).rejects.toThrow();

        await expect(store(db).assertProviderAdmission(identity())).resolves.toMatchObject({
            disposition: 'admitted',
        });
    });

    it('rejects a hostile request/preflight lineage at fresh admission', async () => {
        const db = await createDb();
        await seed(db, { requestPreflightId: hostilePreflightId });

        await expect(store(db).assertProviderAdmission(identity()))
            .rejects.toThrow('FRESH_PROVENANCE_FENCE');
    });

    it('rejects a hostile request/preflight lineage before the fresh checkpoint can write outcomes', async () => {
        const db = await createDb();
        await seed(db, { requestPreflightId: hostilePreflightId });
        await seedBoundFreshEvidence(db);

        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        const outcomes = await query<{ count: number }>(db,
            'SELECT count(*)::int AS count FROM public.analysis_v2_profile_fetch_outcomes',
        );
        expect(outcomes.rows[0]?.count).toBe(0);
    });

    it('rejects a hostile request/preflight lineage at the common dispatch guard', async () => {
        const db = await createDb();
        await seed(db, { requestPreflightId: hostilePreflightId });
        const dispatchToken = '55555555-5555-4555-8555-555555555555';

        await expect(serviceJsonRpc(
            db,
            'SELECT public.activate_analysis_revenue_dispatch_guard_v1($1::uuid,$2) AS result',
            [requestId, jobKey],
        )).resolves.toMatchObject({ disposition: 'active' });
        await expect(serviceQuery(
            db,
            'SELECT * FROM public.reserve_analysis_v2_job_dispatch($1::uuid,$2,$3::uuid)',
            [requestId, jobKey, dispatchToken],
        )).rejects.toThrow('ANALYSIS_V2_REVENUE_DISPATCH_FENCE');
    });

    it('rejects parent request-id rewrites for a regranted service role and the table owner', async () => {
        const db = await createDb();
        await seed(db);

        // This test-only privilege escalation isolates the trigger's protection
        // from the production ACL/RLS denial path.
        await db.exec(`
            ALTER TABLE public.analysis_revenue_run_ledgers DISABLE ROW LEVEL SECURITY;
            GRANT UPDATE (request_id) ON public.analysis_revenue_run_ledgers TO service_role;
        `);
        await expect(asRole(db, 'service_role', () => query(
            db,
            'UPDATE public.analysis_revenue_run_ledgers SET request_id=$1::uuid WHERE request_id=$2::uuid',
            [rewrittenRequestId, requestId],
        ))).rejects.toThrow('REVENUE_COST_LEDGER_DRIFT');

        await expect(query(
            db,
            'UPDATE public.analysis_revenue_run_ledgers SET request_id=$1::uuid WHERE request_id=$2::uuid',
            [rewrittenRequestId, requestId],
        )).rejects.toThrow('REVENUE_COST_LEDGER_DRIFT');
    });

    it('retains normalized evidence after request deletion and rejects a terminal/manual-review parent', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);
        await fresh.recordProviderRun(identity());

        await query(db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='manual_review', manual_review_reason='routing_failure' WHERE request_id=$1::uuid",
            [requestId],
        );
        await expect(fresh.assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        await query(db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='running', manual_review_reason=NULL WHERE request_id=$1::uuid",
            [requestId],
        );

        await query(db, 'DELETE FROM public.analysis_requests WHERE id=$1::uuid', [requestId]);
        const retained = await query<{
            parent_count: number;
            evidence_count: number;
            raw_id_leak: number;
        }>(db, `
            SELECT
                (SELECT count(*)::int FROM public.analysis_revenue_run_ledgers WHERE request_id=$1::uuid) AS parent_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence WHERE request_id=$1::uuid) AS evidence_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence
                  WHERE provider_run_hash=$2 OR provider_dataset_hash=$3) AS raw_id_leak
        `, [requestId, runId, datasetId]);
        expect(retained.rows[0]).toEqual({ parent_count: 1, evidence_count: 1, raw_id_leak: 0 });
    });

    it('requires terminal Dataset proof for the fresh profile checkpoint and exactly replays it', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);
        await fresh.recordProviderRun(identity());
        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded', terminalized_at='2026-08-10T00:04:00Z' WHERE request_id=$1::uuid",
            [requestId],
        );
        await fresh.bindProviderDataset({ ...identity(), datasetId });
        await expect(checkpointFreshProfile(db)).resolves.toMatchObject({
            primaryResults: [expect.objectContaining({
                outcome: expect.objectContaining({ source: 'apify', requestedUsername: 'alice' }),
            })],
            fallbackResults: [],
        });
        await expect(checkpointFreshProfile(db)).resolves.toMatchObject({
            primaryResults: [expect.objectContaining({
                outcome: expect.objectContaining({ source: 'apify' }),
            })],
        });
        await query(db, `
            UPDATE public.analysis_v2_profile_fetch_outcomes
            SET attempt='primary', source='cache'
            WHERE request_id=$1::uuid AND job_key=$2::text AND attempt='fresh_apify'
        `, [requestId, jobKey]);
        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');
    });

    it('gates every strict scheduler transition on an active running revenue parent and quarantines begin ambiguity', async () => {
        const db = await createDb();
        await seed(db);
        const dispatchToken = '55555555-5555-4555-8555-555555555555';
        const nextDispatchToken = '66666666-6666-4666-8666-666666666666';
        const strictSchedulerCalls: readonly [string, readonly unknown[]][] = [
            [
                'SELECT * FROM public.reserve_analysis_v2_job_dispatch($1::uuid,$2,$3::uuid)',
                [requestId, jobKey, dispatchToken],
            ],
            [
                'SELECT * FROM public.mark_analysis_v2_job_dispatched($1::uuid,$2,$3,$4::uuid,$5)',
                [requestId, jobKey, 1, dispatchToken, 'analysis-v2.relationships.collect'],
            ],
            [
                'SELECT * FROM public.rearm_analysis_v2_job_dispatch($1::uuid,$2,$3,$4::uuid,$5::uuid)',
                [requestId, jobKey, 1, dispatchToken, nextDispatchToken],
            ],
            [
                'SELECT * FROM public.claim_analysis_v2_job($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,$7)',
                [requestId, jobKey, 1, dispatchToken, claimToken, 120, 7],
            ],
            [
                'SELECT * FROM public.continue_analysis_v2_scheduler_job($1::uuid,$2,$3::uuid,$4::uuid,$5,$6)',
                [requestId, jobKey, claimToken, dispatchToken, 'ANALYSIS_V2_AI_CAPACITY_PENDING', 60],
            ],
        ];
        for (const [sql, params] of strictSchedulerCalls) {
            await expect(serviceQuery(db, sql, [...params]))
                .rejects.toThrow('ANALYSIS_V2_REVENUE_DISPATCH_FENCE');
        }

        await expect(serviceJsonRpc(db,
            'SELECT public.activate_analysis_revenue_dispatch_guard_v1($1::uuid,$2) AS result',
            [requestId, jobKey],
        )).resolves.toEqual({ disposition: 'active', created: true, replayed: false });
        const unfencedFunctions = await query<{ count: number }>(db, `
            SELECT count(*)::int AS count
            FROM pg_catalog.pg_proc
            WHERE proname IN (
                'reserve_analysis_v2_job_dispatch_unfenced_20260811',
                'mark_analysis_v2_job_dispatched_unfenced_20260811',
                'rearm_analysis_v2_job_dispatch_unfenced_20260811',
                'claim_analysis_v2_job_unfenced_20260811',
                'continue_analysis_v2_scheduler_job_unfenced_20260811'
            )
        `);
        expect(unfencedFunctions.rows[0]?.count).toBe(5);

        await expect(serviceJsonRpc(db,
            'SELECT public.quarantine_analysis_revenue_dispatch_v1($1::uuid,$2,$3) AS result',
            [requestId, jobKey, 'begin_failure'],
        )).resolves.toEqual({ disposition: 'quarantined', created: true, replayed: false });
        await expect(serviceQuery(db, strictSchedulerCalls[0]![0], [...strictSchedulerCalls[0]![1]]))
            .rejects.toThrow('ANALYSIS_V2_REVENUE_DISPATCH_FENCE');
        await expect(store(db).assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        const quarantined = await query<{ request_status: string; parent_status: string; guard_state: string }>(db, `
            SELECT request.status AS request_status, parent.status AS parent_status, guard.state AS guard_state
            FROM public.analysis_requests AS request
            JOIN public.analysis_revenue_run_ledgers AS parent ON parent.request_id=request.id
            JOIN public.analysis_revenue_dispatch_guards AS guard ON guard.request_id=request.id
            WHERE request.id=$1::uuid
        `, [requestId]);
        expect(quarantined.rows[0]).toEqual({
            request_status: 'failed', parent_status: 'manual_review', guard_state: 'quarantined',
        });
    });
});
