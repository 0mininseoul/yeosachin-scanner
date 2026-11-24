import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.FRESH_PROVENANCE_POSTGRES_TEST_URL;
const destructiveTestMarker = process.env.FRESH_PROVENANCE_POSTGRES_TEST_MARKER;
const marker = 'local-ephemeral-fresh-provenance-only';
const describePostgres = isSafeFreshProvenancePostgresTestTarget(databaseUrl, destructiveTestMarker)
    ? describe
    : describe.skip;

const costOperationMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url),
    'utf8',
);
const providerSettlementQueueMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811100000_add_revenue_cost_provider_settlement_queue.sql', import.meta.url),
    'utf8',
);
const freshHardeningMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);

const freshCheckpointMarker = '-- Trusted fresh Apify profile checkpoint.';
const freshCheckpointStart = freshHardeningMigration.indexOf(freshCheckpointMarker);
if (freshCheckpointStart < 0) {
    throw new Error('FRESH_PROVENANCE_POSTGRES_MIGRATION_SECTION_MISSING');
}

// The full PGlite proof applies the complete forward migration.  This real
// PostgreSQL fixture deliberately takes the exact preceding source section:
// it contains every production function touched below, while avoiding an
// unrelated profile-checkpoint dependency graph in a lock-focused test.
const freshProvenanceMigration = freshHardeningMigration.slice(0, freshCheckpointStart);

const dispatchLockMigration = new URL(
    '../../../supabase/migrations/20261122090000_order_analysis_v2_dispatch_lineage_locks.sql',
    import.meta.url,
);
const resultLockMigration = '20261123170000_share_analysis_v2_ai_result_parent_locks.sql';


function migrationSource(filename: string): string {
    return readFileSync(new URL(`../../../supabase/migrations/${filename}`, import.meta.url), 'utf8');
}

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = source.indexOf('\n$$;', start);
    if (start < 0 || end < 0) throw new Error(`FRESH_PROVENANCE_POSTGRES_FUNCTION_MISSING:${name}`);
    return source.slice(start, end + '\n$$;'.length);
}

function aiTerminalizerStatusPatch(filename: string): string {
    const source = migrationSource(filename);
    const reference = source.indexOf(
        "'public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)'",
    );
    const start = source.lastIndexOf('DO $migration$', reference);
    const end = source.indexOf('\n$migration$;', reference);
    if (reference < 0 || start < 0 || end < 0) throw new Error('AI_TERMINALIZER_STATUS_PATCH_MISSING');
    return source.slice(start, end + '\n$migration$;'.length);
}

const requestId = '11111111-1111-4111-8111-111111111111';
const preflightId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const jobKey = 'track:relationships:collect';
const jobInputHash = 'a'.repeat(64);
const providerInputHash = 'b'.repeat(64);
const operationKey = `relationship-followers:${'c'.repeat(64)}`;
const runId = 'FreshApifyRun1234';
const datasetId = 'FreshDataset1234';

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freshRunHash(): string {
    return hash([
        'analysis-revenue-fresh-provider-run/v1',
        `${Buffer.byteLength(requestId, 'utf8')}:${requestId}`,
        `${Buffer.byteLength(jobKey, 'utf8')}:${jobKey}`,
        `${Buffer.byteLength(operationKey, 'utf8')}:${operationKey}`,
        `${Buffer.byteLength(runId, 'utf8')}:${runId}`,
    ].join('|'));
}

function freshDatasetHash(): string {
    return hash([
        'analysis-revenue-fresh-provider-dataset/v1',
        `${Buffer.byteLength(requestId, 'utf8')}:${requestId}`,
        `${Buffer.byteLength(jobKey, 'utf8')}:${jobKey}`,
        `${Buffer.byteLength(operationKey, 'utf8')}:${operationKey}`,
        `${Buffer.byteLength(runId, 'utf8')}:${runId}`,
        `${Buffer.byteLength(datasetId, 'utf8')}:${datasetId}`,
    ].join('|'));
}

function sourceOperationHash(): string {
    return hash(operationKey);
}

function ownerHash(): string {
    return hash(
        `revenue-cost/live-provider-owner/v2:${requestId}:${jobKey}:${operationKey}:${providerInputHash}`,
    );
}

export function isSafeFreshProvenancePostgresTestTarget(
    connectionString: string | undefined,
    suppliedMarker: string | undefined,
): boolean {
    if (suppliedMarker !== marker || !connectionString) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/fresh_provenance_concurrency_test';
    } catch {
        return false;
    }
}

function faithfulCostBootstrap(): string {
    // Reuse the exact checked-in predecessor fixture that executes the full
    // cost migration in its PGlite proof; only the idempotent role declarations
    // differ so this dedicated, disposable database can be reused locally.
    const source = readFileSync(
        new URL('../execution/revenue-cost-operation-pglite.test.ts', import.meta.url),
        'utf8',
    );
    const matched = source.match(/const bootstrap = `([\s\S]*?)`;\n\nasync function createDb/);
    if (!matched?.[1]) throw new Error('FRESH_PROVENANCE_POSTGRES_BOOTSTRAP_MISSING');
    return matched[1].replace(
        'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;',
        () => `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
               DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
}

async function asService<T>(
    client: PoolClient,
    sql: string,
    values: unknown[] = [],
    statementTimeoutMs = 5_000,
): Promise<T> {
    await client.query('BEGIN');
    try {
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query<{ result: T }>(sql, values);
        await client.query('COMMIT');
        if (!result.rows[0]) throw new Error('FRESH_PROVENANCE_POSTGRES_EMPTY_RPC_RESULT');
        return result.rows[0].result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function waitForApplicationName(pool: Pool, applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        const activity = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM pg_catalog.pg_stat_activity
             WHERE application_name = $1 AND state = 'active'`,
            [applicationName],
        );
        if (activity.rows[0]?.count === 1) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`FRESH_PROVENANCE_POSTGRES_BARRIER_TIMEOUT:${applicationName}`);
}

async function waitForLockWait(pool: Pool, blockedPid: number, blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        const activity = await pool.query<{
            wait_event_type: string | null;
            blocking_pids: number[];
        }>(
            `SELECT wait_event_type,
                    pg_catalog.pg_blocking_pids(pid) AS blocking_pids
             FROM pg_catalog.pg_stat_activity
             WHERE pid = $1`,
            [blockedPid],
        );
        const row = activity.rows[0];
        if (row?.wait_event_type === 'Lock' && row.blocking_pids.includes(blockerPid)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('FRESH_PROVENANCE_POSTGRES_LOCK_BARRIER_TIMEOUT');
}

async function seedRevenueLineage(pool: Pool): Promise<void> {
    await pool.query(
        `INSERT INTO public.analysis_requests(
            id,preflight_id,user_id,pipeline_version,plan_access_mode_snapshot,
            selected_plan_id_snapshot,target_instagram_id,test_entitlement_jti_hash,status,created_at
        ) VALUES ($1,$2,$3,'v2','test_entitlement','basic','opaque-target',$4,'processing',clock_timestamp())`,
        [requestId, preflightId, userId, 'e'.repeat(64)],
    );
    await pool.query(
        `INSERT INTO public.analysis_preflights(
            id,consumed_request_id,user_id,status,access_mode,target_instagram_id,target_input_hash,
            admission_generation,admission_status,admission_selected_plan_id,
            admission_entitlement_jti_hash,admission_refreshed_at,
            admission_target_followers_count,admission_target_following_count
        ) VALUES ($1,$2,$3,'consumed','test_entitlement','opaque-target',$4,1,'ready','basic',$5,
                  clock_timestamp(),1,1)`,
        [preflightId, requestId, userId, 'd'.repeat(64), 'e'.repeat(64)],
    );
    await pool.query(
        `INSERT INTO public.analysis_v2_test_entitlement_consumptions(
            entitlement_jti_hash,preflight_id,request_id,user_id,selected_plan_id
        ) VALUES ($1,$2,$3,$4,'basic')`,
        ['e'.repeat(64), preflightId, requestId, userId],
    );
    await pool.query(
        `INSERT INTO public.analysis_v2_provider_execution_policies(
            request_id,mode,policy_version,entitlement_jti_hash,target_instagram_id
        ) VALUES ($1,'test_operation_split','authorized-free-e2e-v1',$2,'opaque-target')`,
        [requestId, 'e'.repeat(64)],
    );
    await pool.query(
        'INSERT INTO public.account_e2e_test_runners(account_id,runner_plan) VALUES ($1,\'basic\')',
        [userId],
    );
    await pool.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,status,actual_usage_usd,terminalized_at,usage_reconciled_at
        ) VALUES
            ($1,'target-profile-fallback','succeeded',0.002,clock_timestamp(),clock_timestamp()),
            ($1,'target-profile-fresh-admission:g1','succeeded',0.003,clock_timestamp(),clock_timestamp())`,
        [preflightId],
    );

    const beginClient = await pool.connect();
    try {
        await asService(beginClient,
            'SELECT public.begin_analysis_revenue_cost_ledger_v1($1::uuid) AS result',
            [requestId],
        );
    } finally {
        beginClient.release();
    }

    await pool.query(
        `INSERT INTO public.analysis_pipeline_jobs(
            request_id,job_key,status,dispatch_state,dispatch_generation,dispatch_reservation_token,
            dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,lease_token,
            lease_expires_at,input_hash,created_at,updated_at
        ) VALUES (
            $1,$2,'processing','delivered',1,'77777777-7777-4777-8777-777777777777',
            clock_timestamp() - interval '3 minutes',clock_timestamp() - interval '2 minutes',
            'analysis-v2.relationships.collect',clock_timestamp() - interval '1 minute',$3,
            clock_timestamp() + interval '5 minutes',$4,
            clock_timestamp() - interval '4 minutes',clock_timestamp() - interval '30 seconds'
        )`,
        [requestId, jobKey, claimToken, jobInputHash],
    );
    await pool.query(
        `INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,
            logical_provider,actor_id,credential_slot,max_charge_usd,status,reserved_at,updated_at
        ) VALUES (
            $1,$2,$3,$4,$5,'88888888-8888-4888-8888-888888888888',
            'apify','apify/actor','primary',0.001,'starting',clock_timestamp(),clock_timestamp()
        )`,
        [requestId, jobKey, operationKey, providerInputHash, claimToken],
    );
}

async function installConcurrencyBarriers(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE FUNCTION public.test_hold_fresh_admission(
            p_request_id uuid,p_job_key text,p_job_claim_token uuid,p_job_input_hash text,
            p_operation_key text,p_provider_input_hash text
        ) RETURNS jsonb LANGUAGE plpgsql AS $$
        DECLARE v_result jsonb;
        BEGIN
            v_result := public.assert_analysis_revenue_fresh_provider_admission_v1(
                p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,p_operation_key,p_provider_input_hash
            );
            PERFORM pg_catalog.set_config('application_name','fresh-admission-holding-locks',FALSE);
            PERFORM pg_catalog.pg_sleep(0.75);
            RETURN v_result;
        END;
        $$;

        CREATE FUNCTION public.test_hold_fresh_record(
            p_request_id uuid,p_job_key text,p_job_claim_token uuid,p_job_input_hash text,
            p_operation_key text,p_provider_input_hash text,p_provider_run_hash text
        ) RETURNS jsonb LANGUAGE plpgsql AS $$
        DECLARE v_result jsonb;
        BEGIN
            v_result := public.record_analysis_revenue_fresh_provider_evidence_v1(
                p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,p_operation_key,
                p_provider_input_hash,p_provider_run_hash
            );
            PERFORM pg_catalog.set_config('application_name','fresh-record-holding-locks',FALSE);
            PERFORM pg_catalog.pg_sleep(0.75);
            RETURN v_result;
        END;
        $$;
    `);
}

describe('fresh provenance PostgreSQL destructive-test target guard', () => {
    it('accepts only an explicit loopback disposable database and marker', () => {
        expect(isSafeFreshProvenancePostgresTestTarget(
            'postgresql://tester@127.0.0.1:55432/fresh_provenance_concurrency_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/fresh_provenance_concurrency_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/fresh_provenance_concurrency_test', undefined],
    ])('rejects an unsafe target or absent marker', (url, suppliedMarker) => {
        expect(isSafeFreshProvenancePostgresTestTarget(url, suppliedMarker)).toBe(false);
    });
});

describePostgres('fresh provenance PostgreSQL concurrency', () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            DROP SCHEMA IF EXISTS extensions CASCADE;
            CREATE SCHEMA public;
        `);
        await pool.query(faithfulCostBootstrap());
        await pool.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
        await pool.query(costOperationMigration);
        await pool.query(freshProvenanceMigration);
        await pool.query(providerSettlementQueueMigration);
        await installConcurrencyBarriers(pool);
        await seedRevenueLineage(pool);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('serializes opposing Fresh and provider-cost operations without deadlock and preserves exact ownership', async () => {
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            await first.query("SET application_name = 'fresh-provenance-first'");
            await second.query("SET application_name = 'fresh-provenance-second'");
            const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

            const admission = asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.test_hold_fresh_admission($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text) AS result`,
                [requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash],
            );
            await waitForApplicationName(pool, 'fresh-admission-holding-locks');
            const reserve = asService<{ disposition: string; created: boolean; replayed: boolean }>(second,
                `SELECT public.reserve_analysis_revenue_cost_operation_v2(
                    $1::uuid,$2::text,$3::uuid,$4::text,'provider_run',$5::text,0::smallint
                ) AS result`,
                [requestId, jobKey, claimToken, jobInputHash, operationKey],
            );
            await waitForLockWait(pool, secondPid, firstPid);
            await expect(admission).resolves.toMatchObject({
                disposition: 'admitted', created: false, replayed: true,
            });
            await expect(reserve).resolves.toMatchObject({
                disposition: 'accepted', created: true, replayed: false,
            });

            await expect(asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.mark_analysis_revenue_cost_operation_started_v2(
                    $1::uuid,$2::text,$3::uuid,$4::text,'provider_run',$5::text,0::smallint
                ) AS result`,
                [requestId, jobKey, claimToken, jobInputHash, operationKey],
            )).resolves.toMatchObject({ disposition: 'started', created: true, replayed: false });

            await pool.query(
                `UPDATE public.analysis_v2_provider_runs
                 SET status='succeeded',run_id=$1,
                     run_started_at=reserved_at + interval '1 second',
                     terminalized_at=reserved_at + interval '2 seconds',
                     actual_usage_usd=0.001,
                     usage_reconciled_at=reserved_at + interval '3 seconds',
                     updated_at=reserved_at + interval '4 seconds'
                 WHERE request_id=$2::uuid AND job_key=$3::text AND operation_key=$4::text`,
                [runId, requestId, jobKey, operationKey],
            );

            const record = asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.test_hold_fresh_record(
                    $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text
                ) AS result`,
                [requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash, freshRunHash()],
            );
            await waitForApplicationName(pool, 'fresh-record-holding-locks');
            const settle = asService<{ disposition: string; created: boolean; replayed: boolean }>(second,
                `SELECT public.settle_analysis_revenue_cost_operation_v2(
                    $1::uuid,$2::text,'provider_run',$3::text,0::smallint
                ) AS result`,
                [requestId, jobKey, operationKey],
            );
            await waitForLockWait(pool, secondPid, firstPid);
            await expect(record).resolves.toMatchObject({
                disposition: 'recorded', created: true, replayed: false,
            });
            await expect(settle).resolves.toMatchObject({
                disposition: 'settled', created: true, replayed: false,
            });

            await expect(asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.bind_analysis_revenue_fresh_provider_dataset_v1(
                    $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text
                ) AS result`,
                [
                    requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash,
                    freshRunHash(), freshDatasetHash(),
                ],
            )).resolves.toMatchObject({ disposition: 'bound', created: true, replayed: false });

            await expect(asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.record_analysis_revenue_fresh_provider_evidence_v1(
                    $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text
                ) AS result`,
                [requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash, freshRunHash()],
            )).resolves.toMatchObject({ disposition: 'recorded', created: false, replayed: true });
            await expect(asService<{ disposition: string; created: boolean; replayed: boolean }>(second,
                `SELECT public.settle_analysis_revenue_cost_operation_v2(
                    $1::uuid,$2::text,'provider_run',$3::text,0::smallint
                ) AS result`,
                [requestId, jobKey, operationKey],
            )).resolves.toMatchObject({ disposition: 'settled', created: false, replayed: true });
            await expect(asService<{ disposition: string; created: boolean; replayed: boolean }>(first,
                `SELECT public.bind_analysis_revenue_fresh_provider_dataset_v1(
                    $1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text
                ) AS result`,
                [
                    requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash,
                    freshRunHash(), freshDatasetHash(),
                ],
            )).resolves.toMatchObject({ disposition: 'bound', created: false, replayed: true });

            const invariants = await pool.query<{
                evidence_count: number;
                evidence_fresh: boolean;
                evidence_dataset_hash: string | null;
                child_count: number;
                child_owner_hash: string | null;
                child_status: string | null;
                child_economic_usd: string | null;
                child_source_hash: string | null;
                parent_status: string;
                parent_manual_review_reason: string | null;
                parent_reserved_krw: number;
                parent_economic_krw: number;
                settled_krw: number;
            }>(
                `SELECT
                    (SELECT count(*)::int
                       FROM public.analysis_revenue_fresh_provider_evidence
                      WHERE request_id=$1::uuid AND job_key=$2::text) AS evidence_count,
                    (SELECT bool_and(no_reuse AND no_adoption AND no_cache)
                       FROM public.analysis_revenue_fresh_provider_evidence
                      WHERE request_id=$1::uuid AND job_key=$2::text) AS evidence_fresh,
                    (SELECT provider_dataset_hash
                       FROM public.analysis_revenue_fresh_provider_evidence
                      WHERE request_id=$1::uuid AND job_key=$2::text) AS evidence_dataset_hash,
                    (SELECT count(*)::int
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND owner_kind='provider_run'
                        AND source_job_key=$2::text AND source_operation_key_hash=$3::text) AS child_count,
                    (SELECT owner_key_hash
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND owner_kind='provider_run'
                        AND source_job_key=$2::text AND source_operation_key_hash=$3::text) AS child_owner_hash,
                    (SELECT status
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND owner_kind='provider_run'
                        AND source_job_key=$2::text AND source_operation_key_hash=$3::text) AS child_status,
                    (SELECT economic_actual_usd::text
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND owner_kind='provider_run'
                        AND source_job_key=$2::text AND source_operation_key_hash=$3::text) AS child_economic_usd,
                    (SELECT source_operation_key_hash
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND owner_kind='provider_run'
                        AND source_job_key=$2::text AND source_operation_key_hash=$3::text) AS child_source_hash,
                    parent.status AS parent_status,
                    parent.manual_review_reason AS parent_manual_review_reason,
                    parent.reserved_cost_krw AS parent_reserved_krw,
                    parent.economic_actual_krw AS parent_economic_krw,
                    (SELECT coalesce(sum(economic_actual_krw),0)::int
                       FROM public.analysis_revenue_cost_operations
                      WHERE request_id=$1::uuid AND status='settled') AS settled_krw
                 FROM public.analysis_revenue_run_ledgers AS parent
                 WHERE parent.request_id=$1::uuid`,
                [requestId, jobKey, sourceOperationHash()],
            );
            expect(invariants.rows[0]).toEqual({
                evidence_count: 1,
                evidence_fresh: true,
                evidence_dataset_hash: freshDatasetHash(),
                child_count: 1,
                child_owner_hash: ownerHash(),
                child_status: 'settled',
                child_economic_usd: '0.001000000000',
                child_source_hash: sourceOperationHash(),
                parent_status: 'running',
                parent_manual_review_reason: null,
                parent_reserved_krw: 0,
                parent_economic_krw: 10,
                settled_krw: 10,
            });
        } finally {
            first.release();
            second.release();
        }
    }, 30_000);
});

describePostgres('paid V2 dispatch and Vertex audit PostgreSQL lock order', () => {
    const paidJob = 'track:profile-ai:batch:1';
    const dispatchToken = '77777777-7777-4777-8777-777777777777';
    const auditToken = '88888888-8888-4888-8888-888888888888';
    const metadata = {
        model_name: 'gemini-fixture', location: 'global', stage: 'genderTriage',
        thinking_level: null, media_count: 0, media_resolution: null,
        prompt_version: 'fixture-v1', schema_version: 1, max_output_tokens: 32, retry_count: 0,
    };
    const identity = {
        model_name: metadata.model_name, stage: metadata.stage,
        thinking_level: metadata.thinking_level, media_resolution: metadata.media_resolution,
        prompt_version: metadata.prompt_version, schema_version: metadata.schema_version,
        max_output_tokens: metadata.max_output_tokens,
        input_hash: jobInputHash, media_snapshot_hash: 'f'.repeat(64), cache_scope: 'request',
    };
    const telemetry = {
        ...metadata, usage_metadata_status: 'complete', usage_complete: true,
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, thinking_tokens: 0,
        latency_ms: 100, estimated_cost_usd: 0.001, finish_reason: 'STOP',
    };
    const output = '{"decision":"fixture"}';
    const outputHash = hash(`analysis-v2-ai-result-content:v1\0${output}`);
    const auditSql = `SELECT public.terminalize_analysis_v2_ai_attempt_with_result(
        $1::uuid,$2::text,$3::uuid,$4::text,1::smallint,$5::uuid,
        $6::jsonb,$7::jsonb,$8::jsonb,$9::text,$10::text
    ) AS result`;
    const reserveSql = `SELECT public.reserve_analysis_v2_ai_attempt(
        $1::uuid,$2::text,$3::uuid,$4::text,1::smallint,$5::uuid,$6::jsonb
    ) AS result`;
    const claimSql = `SELECT pg_catalog.to_jsonb(claim_row) AS result
       FROM public.claim_analysis_v2_job_v2($1::uuid,$2::text,1,$3::uuid,$4::uuid,120,7,'paid',2::smallint) AS claim_row`;
    let pool: Pool;
    let auditOperation: string;

    beforeAll(async () => {
        pool = new Pool({ connectionString: databaseUrl, max: 11 });
        await pool.query(`
            DROP SCHEMA IF EXISTS public CASCADE;
            DROP SCHEMA IF EXISTS extensions CASCADE;
            CREATE SCHEMA public;
        `);
        await pool.query(faithfulCostBootstrap());
        await pool.query(`
            GRANT USAGE ON SCHEMA public TO service_role;
            DROP TABLE public.analysis_v2_ai_result_checkpoints, public.analysis_v2_ai_attempts;
            ALTER TABLE public.analysis_requests
                ADD COLUMN background_processing boolean, ADD COLUMN policy_versions_snapshot jsonb;
            ALTER TABLE public.analysis_pipeline_jobs
                ADD COLUMN track text, ADD COLUMN kind text, ADD COLUMN batch integer,
                ADD COLUMN attempt_count integer NOT NULL DEFAULT 0, ADD COLUMN first_started_at timestamptz,
                ADD COLUMN last_error_code text, ADD COLUMN last_error_at timestamptz,
                ADD COLUMN dispatch_workload_role text, ADD COLUMN dispatch_contract_version smallint,
                ADD COLUMN claim_workload_role text, ADD COLUMN claim_contract_version smallint;
            CREATE TABLE public.analysis_v2_provider_cleanup_intents (
                request_id uuid PRIMARY KEY, failed_job_key text, failed_job_input_hash text,
                failed_claim_token uuid, error_code text, completed_at timestamptz
            );
            CREATE TABLE public.analysis_revenue_dispatch_guards (
                request_id uuid PRIMARY KEY, state text, reason_code text
            );
        `);
        await pool.query(costOperationMigration);
        const jobClaim = functionDefinition(migrationSource(
            '20260714031500_harden_analysis_v2_terminal_invariants.sql',
        ), 'claim_analysis_v2_job');
        await pool.query(jobClaim.replace('public.claim_analysis_v2_job(', 'public.claim_analysis_v2_job_unfenced_20260811('));
        for (const name of ['assert_analysis_revenue_dispatch_guard_v1', 'claim_analysis_v2_job']) {
            await pool.query(functionDefinition(freshHardeningMigration, name));
        }
        const paidWrappers = migrationSource('20260831100000_add_analysis_provider_admission_leases.sql');
        for (const name of [
            'reserve_analysis_v2_job_dispatch_v2', 'rearm_analysis_v2_job_dispatch_v2',
            'mark_analysis_v2_job_dispatched_v2', 'claim_analysis_v2_job_v2',
        ]) await pool.query(functionDefinition(paidWrappers, name));
        await pool.query(`
            REVOKE ALL ON FUNCTION public.claim_analysis_v2_job_v2(
                uuid,text,integer,uuid,uuid,integer,integer,text,smallint
            ) FROM PUBLIC, anon, authenticated, service_role;
            GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_job_v2(
                uuid,text,integer,uuid,uuid,integer,integer,text,smallint
            ) TO service_role;
        `);
        await pool.query(migrationSource('20260713170859_add_analysis_v2_ai_attempt_ledger.sql'));
        await pool.query(migrationSource('20260713173056_add_analysis_v2_ai_result_checkpoint_cache.sql'));
        await pool.query(aiTerminalizerStatusPatch('20260716162523_harden_analysis_v2_ai_unavailable_replay_policy.sql'));
        await pool.query(aiTerminalizerStatusPatch('20260725010000_add_analysis_v2_gender_resolution_stage.sql'));
        auditOperation = (await pool.query<{ value: string }>(
            'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [identity],
        )).rows[0]!.value;
        await pool.query(`
            INSERT INTO public.analysis_requests(id,preflight_id,pipeline_version,status)
            VALUES ($1,$2,'v2','processing')`, [requestId, preflightId]);
        await pool.query(`
            INSERT INTO public.analysis_preflights(id,consumed_request_id,status)
            VALUES ($1,$2,'consumed')`, [preflightId, requestId]);
        await pool.query(`
            INSERT INTO public.analysis_pipeline_jobs (
                request_id,job_key,track,kind,batch,input_hash,status,attempt_count,
                dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_task_name,
                dispatch_reserved_at,dispatched_at,delivered_at,lease_token,lease_expires_at,
                dispatch_workload_role,dispatch_contract_version,claim_workload_role,claim_contract_version,
                created_at,updated_at
            ) VALUES ($1,$2,'profiles','profile_ai',1,$3,'processing',1,
                'delivered',1,$4,'fixture-task',statement_timestamp(),statement_timestamp(),statement_timestamp(),
                $5,statement_timestamp()+interval '5 minutes','paid',2,'paid',2,
                statement_timestamp(),statement_timestamp())
        `, [requestId, paidJob, jobInputHash, dispatchToken, claimToken]);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    async function runAuditAlongsideClaim(): Promise<{
        audit: { outcome?: string; code?: string };
        claim: { claimed?: boolean; attempt_count?: number; code?: string };
    }> {
        const auditClient = await pool.connect();
        const claimClient = await pool.connect();
        try {
            await pool.query('DELETE FROM public.analysis_v2_ai_result_checkpoints');
            await pool.query('DELETE FROM public.analysis_v2_ai_attempts');
            const auditArgs = [requestId, paidJob, claimToken, auditOperation, auditToken];
            await expect(asService(auditClient, reserveSql, [...auditArgs, metadata]))
                .resolves.toMatchObject({ created: true });
            const auditPid = (await auditClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const claimPid = (await claimClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            await auditClient.query('BEGIN');
            await auditClient.query("SET LOCAL statement_timeout = '5s'");
            // Pause the audit after its first lineage lock to force the exact
            // overlap before executing the actual successful-result RPC.
            await auditClient.query('SELECT 1 FROM public.analysis_preflights WHERE id=$1::uuid FOR UPDATE', [preflightId]);
            const claim = asService<{ claimed: boolean; attempt_count: number }>(
                claimClient, claimSql, [requestId, paidJob, dispatchToken, claimToken],
            ).catch((error: { code?: string }) => ({ code: error.code }));
            await waitForLockWait(pool, claimPid, auditPid);
            await auditClient.query('SET LOCAL ROLE service_role');
            let audit: { outcome?: string; code?: string };
            try {
                const result = await auditClient.query<{ result: { outcome: string } }>(
                    auditSql, [...auditArgs, telemetry, identity, output, output, outputHash],
                );
                audit = result.rows[0]!.result;
                await auditClient.query('COMMIT');
            } catch (error) {
                audit = { code: (error as { code?: string }).code };
                await auditClient.query('ROLLBACK');
            }
            return { audit, claim: await claim };
        } finally {
            await auditClient.query('ROLLBACK');
            await claimClient.query('ROLLBACK');
            auditClient.release();
            claimClient.release();
        }
    }

    it('reproduces the original paid claim / Vertex result deadlock and removes the cycle', async () => {
        const before = await runAuditAlongsideClaim();
        expect([before.audit.code, before.claim.code]).toContain('40P01');

        const migration = readFileSync(dispatchLockMigration, 'utf8');
        await pool.query(migration);
        await pool.query(migration);
        const privileges = await pool.query(`
            SELECT has_function_privilege('service_role', 'public.lock_analysis_v2_dispatch_parents(uuid)', 'EXECUTE') AS helper,
                   has_function_privilege('anon', 'public.claim_analysis_v2_job_v2(uuid,text,integer,uuid,uuid,integer,integer,text,smallint)', 'EXECUTE') AS anon_claim
        `);
        expect(privileges.rows[0]).toEqual({ helper: false, anon_claim: false });
        const after = await runAuditAlongsideClaim();
        expect(after.audit).toMatchObject({ outcome: 'checkpointed' });
        expect(after.claim).toMatchObject({ claimed: true, attempt_count: 1 });

        const client = await pool.connect();
        try {
            const auditArgs = [requestId, paidJob, claimToken, auditOperation, auditToken];
            await expect(asService(client, reserveSql, [...auditArgs, metadata]))
                .resolves.toMatchObject({ created: false, status: 'success' });
            await expect(asService(client, auditSql, [...auditArgs, telemetry, identity, output, output, outputHash]))
                .resolves.toMatchObject({ outcome: 'checkpointed' });
            await expect(asService(client, claimSql, [requestId, paidJob, auditToken, claimToken]))
                .rejects.toThrow('ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH');
        } finally {
            client.release();
        }
        const auditRows = await pool.query(`
            SELECT count(*)::int AS attempt_count, sum(estimated_cost_usd)::text AS cost_usd,
                   (SELECT count(*)::int FROM public.analysis_v2_ai_result_checkpoints) AS checkpoint_count
            FROM public.analysis_v2_ai_attempts
        `);
        expect(auditRows.rows[0]).toEqual({ attempt_count: 1, cost_usd: '0.001000000000', checkpoint_count: 1 });
    }, 15_000);

    it('allows sibling result commits with shared parents under an eight-connection load', async () => {
        await pool.query('DELETE FROM public.analysis_v2_ai_result_checkpoints');
        await pool.query('DELETE FROM public.analysis_v2_ai_attempts');

        const workload = Array.from({ length: 8 }, (_, ordinal) => ({
            job: `track:profile-ai:batch:${100 + ordinal}`,
            batch: 100 + ordinal,
            claim: randomUUID(),
            attempts: Array.from({ length: 12 }, (_, index) => ({
                token: randomUUID(),
                identity: {
                    ...identity,
                    input_hash: hash(`result-concurrency:${ordinal}:${index}`),
                },
            })),
        }));
        type AuditResult = { outcome: string };
        const deliveries: unknown[][][] = [];
        const blocker = await pool.connect();
        const clients = await Promise.all(workload.map(() => pool.connect()));
        try {
            for (const { job, batch, claim, attempts } of workload) {
                await blocker.query(`
                    INSERT INTO public.analysis_pipeline_jobs (
                        request_id,job_key,track,kind,batch,input_hash,status,attempt_count,
                        dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_task_name,
                        dispatch_reserved_at,dispatched_at,delivered_at,lease_token,lease_expires_at,
                        dispatch_workload_role,dispatch_contract_version,claim_workload_role,claim_contract_version,
                        created_at,updated_at
                    ) SELECT request_id,$2,track,kind,$3,input_hash,status,attempt_count,
                        dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_task_name,
                        dispatch_reserved_at,dispatched_at,delivered_at,$4,statement_timestamp()+interval '5 minutes',
                        dispatch_workload_role,dispatch_contract_version,claim_workload_role,claim_contract_version,
                        created_at,updated_at
                      FROM public.analysis_pipeline_jobs
                     WHERE request_id=$1 AND job_key=$5
                `, [requestId, job, batch, claim, paidJob]);
                const args: unknown[][] = [];
                for (const attempt of attempts) {
                    const { rows } = await blocker.query<{ value: string }>(
                        'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [attempt.identity],
                    );
                    const intent = [requestId, job, claim, rows[0]!.value, attempt.token];
                    await expect(asService(blocker, reserveSql, [...intent, metadata]))
                        .resolves.toMatchObject({ created: true });
                    args.push([...intent, telemetry, attempt.identity, output, output, outputHash]);
                }
                deliveries.push(args);
            }

            async function runWithSharedParents(): Promise<{ outcomes: string[]; elapsedMs: number }> {
                await blocker.query('BEGIN');
                try {
                    await blocker.query(
                        'SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR SHARE', [preflightId],
                    );
                    await blocker.query(
                        'SELECT 1 FROM public.analysis_requests WHERE id=$1 FOR SHARE', [requestId],
                    );
                    const startedAt = performance.now();
                    const results = await Promise.all(clients.map(async (client, index) => {
                        const outcomes: string[] = [];
                        for (const args of deliveries[index]!) {
                            try {
                                const result = await asService<AuditResult>(client, auditSql, args, 200);
                                outcomes.push(result.outcome);
                            } catch (error) {
                                outcomes.push((error as { code?: string }).code ?? 'unknown');
                            }
                        }
                        return outcomes;
                    }));
                    return { outcomes: results.flat(), elapsedMs: Math.round(performance.now() - startedAt) };
                } finally {
                    await blocker.query('ROLLBACK');
                }
            }

            const reservationIdentity = { ...identity, input_hash: hash('sibling-reservation-race') };
            const operationKey = (await blocker.query<{ value: string }>(
                'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [reservationIdentity],
            )).rows[0]!.value;
            const reserveFor = (index: number) => [
                requestId, workload[index]!.job, workload[index]!.claim, operationKey, randomUUID(), metadata,
            ];

            await blocker.query('BEGIN');
            try {
                await blocker.query('SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR SHARE', [preflightId]);
                await expect(asService(clients[0]!, reserveSql, reserveFor(0), 200))
                    .rejects.toMatchObject({ code: '57014' });
            } finally {
                await blocker.query('ROLLBACK');
            }
            const original = await runWithSharedParents();
            expect(original.outcomes).toEqual(Array<string>(96).fill('57014'));
            const pending = await blocker.query(`
                SELECT count(*)::int AS reserved FROM public.analysis_v2_ai_attempts WHERE status = 'reserved'
            `);
            expect(pending.rows[0]).toEqual({ reserved: 96 });
            const migration = migrationSource(resultLockMigration);
            await blocker.query(migration);
            await blocker.query(migration);
            const updated = await runWithSharedParents();
            expect(updated.outcomes).toEqual(Array<string>(96).fill('checkpointed'));

            // Duplicate post-provider delivery is idempotent on both clients.
            await expect(Promise.all(
                clients.slice(0, 2).map(client => asService<AuditResult>(client, auditSql, deliveries[0]![0]!)),
            )).resolves.toEqual([expect.objectContaining({ outcome: 'checkpointed' }),
                expect.objectContaining({ outcome: 'checkpointed' })]);
            const accounting = await blocker.query(`
                SELECT count(*)::int AS attempts,
                       count(*) FILTER (WHERE status = 'success')::int AS successes,
                       sum(estimated_cost_usd)::text AS cost_usd,
                       (SELECT count(*)::int FROM public.analysis_v2_ai_result_checkpoints) AS checkpoints
                FROM public.analysis_v2_ai_attempts
            `);
            expect(accounting.rows[0]).toEqual({
                attempts: 96, successes: 96, cost_usd: '0.096000000000', checkpoints: 96,
            });
            await blocker.query('BEGIN');
            try {
                await blocker.query('SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR SHARE', [preflightId]);
                await blocker.query('SELECT 1 FROM public.analysis_requests WHERE id=$1 FOR SHARE', [requestId]);
                type Reservation = { created: boolean; reservationToken: string };
                const collision = await Promise.allSettled(
                    clients.slice(0, 2).map((client, index) => asService<Reservation>(
                        client, reserveSql, reserveFor(index), 200,
                    )),
                );
                expect(collision.filter(result => result.status === 'fulfilled')).toEqual([
                    expect.objectContaining({ value: expect.objectContaining({ created: true }) }),
                ]);
                expect(collision.filter(result => result.status === 'rejected')).toEqual([
                    expect.objectContaining({
                        reason: expect.objectContaining({ code: 'P0001', message: 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT' }),
                    }),
                ]);
                const winner = collision.findIndex(result => result.status === 'fulfilled');
                const committed = collision[winner] as PromiseFulfilledResult<Reservation>;
                await expect(asService(clients[winner]!, reserveSql, reserveFor(winner), 200))
                    .resolves.toMatchObject({ created: false, reservationToken: committed.value.reservationToken });
            } finally {
                await blocker.query('ROLLBACK');
            }
            console.info('AI result sibling load (96 writes, 8 connections, 200ms timeout)', {
                originalMs: original.elapsedMs,
                updatedMs: updated.elapsedMs,
            });
        } finally {
            for (const client of clients) client.release();
            blocker.release();
        }
    }, 15_000);

    it('preserves late attempt cost when the request closes while acquiring shared locks', async () => {
        await pool.query(migrationSource(resultLockMigration));
        const auditClient = await pool.connect();
        const closer = await pool.connect();
        try {
            const closeToken = randomUUID();
            const payloadIdentity = { ...identity, input_hash: hash('late-result-after-close') };
            const { rows } = await auditClient.query<{ value: string }>(
                'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [payloadIdentity],
            );
            const args = [requestId, paidJob, claimToken, rows[0]!.value, closeToken];
            await expect(asService(auditClient, reserveSql, [...args, metadata]))
                .resolves.toMatchObject({ created: true });
            const auditPid = (await auditClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const closerPid = (await closer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

            await closer.query('BEGIN');
            await closer.query('SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR UPDATE', [preflightId]);
            await closer.query("UPDATE public.analysis_requests SET status='failed' WHERE id=$1", [requestId]);

            const finish = asService(auditClient, auditSql, [...args, telemetry, payloadIdentity, output, output, outputHash]);
            await waitForLockWait(pool, auditPid, closerPid);
            await closer.query('COMMIT');
            await expect(finish).resolves.toMatchObject({ outcome: 'fenced' });

            const late = await closer.query(`
                SELECT attempt.status, attempt.estimated_cost_usd::text AS cost_usd,
                       EXISTS (
                           SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
                           WHERE checkpoint.request_id = attempt.request_id
                             AND checkpoint.operation_key = attempt.operation_key
                       ) AS has_checkpoint
                FROM public.analysis_v2_ai_attempts AS attempt
                WHERE attempt.request_id=$1 AND attempt.operation_key=$2
            `, [requestId, rows[0]!.value]);
            expect(late.rows[0]).toEqual({ status: 'success', cost_usd: '0.001000000000', has_checkpoint: false });

            // While terminal, a shared preflight lock still serializes the
            // complete-cost-rollup snapshot as in the old outer transaction.
            await closer.query('BEGIN');
            await closer.query('SELECT 1 FROM public.analysis_preflights WHERE id=$1 FOR SHARE', [preflightId]);
            await expect(asService(
                auditClient, auditSql, [...args, telemetry, payloadIdentity, output, output, outputHash], 200,
            )).rejects.toMatchObject({ code: '57014' });
        } finally {
            await closer.query('ROLLBACK').catch(() => undefined);
            await closer.query("UPDATE public.analysis_requests SET status='processing' WHERE id=$1", [requestId]);
            closer.release();
            auditClient.release();
        }
    }, 15_000);

    it('shares the active job fence across eight distinct audit attempts without weakening ownership', async () => {
        await pool.query(migrationSource(resultLockMigration));
        await pool.query(migrationSource('20261123210000_fence_failed_analysis_v2_vertex_dispatch.sql'));
        const blocker = await pool.connect();
        const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()));
        try {
            const attempts = await Promise.all(clients.map(async (client, index) => {
                const payload = { ...identity, input_hash: hash(`same-job-audit-${index}`) };
                const { rows } = await client.query<{ value: string }>(
                    'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [payload],
                );
                return { payload, args: [requestId, paidJob, claimToken, rows[0]!.value, randomUUID()] };
            }));
            const [first] = attempts;
            await blocker.query('BEGIN');
            try {
                await blocker.query(
                    'SELECT 1 FROM public.analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2 FOR SHARE',
                    [requestId, paidJob],
                );
                await expect(asService(clients[0]!, reserveSql, [...first!.args, metadata], 250))
                    .rejects.toMatchObject({ code: '57014' });
            } finally {
                await blocker.query('ROLLBACK');
            }

            await blocker.query(migrationSource('20261124163000_share_analysis_v2_ai_audit_job_fences.sql'));
            await blocker.query('BEGIN');
            try {
                await blocker.query(
                    'SELECT 1 FROM public.analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2 FOR SHARE',
                    [requestId, paidJob],
                );
                await expect(Promise.all(clients.map((client, index) =>
                    asService(client, reserveSql, [...attempts[index]!.args, metadata], 250),
                ))).resolves.toEqual(Array(8).fill(expect.objectContaining({ created: true })));
                await expect(Promise.all(clients.map((client, index) => {
                    const { payload, args } = attempts[index]!;
                    return asService(client, auditSql, [...args, telemetry, payload, output, output, outputHash], 250);
                }))).resolves.toEqual(Array(8).fill(expect.objectContaining({ outcome: 'checkpointed' })));
            } finally {
                await blocker.query('ROLLBACK');
            }

            const { args, payload } = attempts[0]!;
            await expect(Promise.all(clients.slice(0, 2).map(client =>
                asService(client, auditSql, [...args, telemetry, payload, output, output, outputHash]),
            ))).resolves.toEqual(Array(2).fill(expect.objectContaining({ outcome: 'checkpointed' })));
            const recorded = await blocker.query(`
                SELECT count(*)::int AS attempts, sum(estimated_cost_usd)::text AS cost,
                       (SELECT count(*)::int FROM public.analysis_v2_ai_result_checkpoints
                         WHERE request_id=$1 AND operation_key = ANY($2::text[])) AS checkpoints
                FROM public.analysis_v2_ai_attempts
                WHERE request_id=$1 AND operation_key = ANY($2::text[])
            `, [requestId, attempts.map(attempt => attempt.args[3])]);
            expect(recorded.rows[0]).toEqual({ attempts: 8, checkpoints: 8, cost: '0.008000000000' });

            const collisionOperation = (await blocker.query<{ value: string }>(
                'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value',
                [{ ...identity, input_hash: hash('same-job-collision') }],
            )).rows[0]!.value;
            const collision = await Promise.all(clients.slice(0, 2).map(client =>
                asService<{ created: boolean; reservationToken: string }>(client, reserveSql,
                    [requestId, paidJob, claimToken, collisionOperation, randomUUID(), metadata],
                ),
            ));
            expect(collision.map(reservation => reservation.created).sort()).toEqual([false, true]);
            expect(collision[0]!.reservationToken).toBe(collision[1]!.reservationToken);

            await blocker.query('BEGIN');
            try {
                await blocker.query(
                    'UPDATE public.analysis_pipeline_jobs SET lease_token=$3 WHERE request_id=$1 AND job_key=$2',
                    [requestId, paidJob, randomUUID()],
                );
                await expect(asService(clients[0]!, auditSql,
                    [...args, telemetry, payload, output, output, outputHash], 250,
                )).rejects.toMatchObject({ code: '57014' });
                await blocker.query('COMMIT');
            } finally {
                await blocker.query('ROLLBACK');
            }
            await expect(asService(clients[0]!, auditSql,
                [...args, telemetry, payload, output, output, outputHash],
            )).resolves.toMatchObject({ outcome: 'fenced' });
        } finally {
            await blocker.query(
                'UPDATE public.analysis_pipeline_jobs SET lease_token=$3 WHERE request_id=$1 AND job_key=$2',
                [requestId, paidJob, claimToken],
            );
            for (const client of clients) client.release();
            blocker.release();
        }
    }, 15_000);

    it('atomically replays an accepted deterministic narrative with its original rejection and one charge', async () => {
        const narrativeJob = 'track:narratives:batch:0';
        const attemptSource = migrationSource('20260725010000_add_analysis_v2_gender_resolution_stage.sql');
        const attemptConstraintStart = attemptSource.indexOf(
            'ALTER TABLE public.analysis_v2_ai_attempts\n    DROP CONSTRAINT analysis_v2_ai_attempt_stage_check',
        );
        const attemptConstraintEnd = attemptSource.indexOf(
            'ALTER TABLE public.analysis_v2_ai_result_checkpoints', attemptConstraintStart,
        );
        if (attemptConstraintStart < 0 || attemptConstraintEnd < 0) {
            throw new Error('Missing attempt status constraints');
        }
        await pool.query(attemptSource.slice(attemptConstraintStart, attemptConstraintEnd));
        const resultSource = migrationSource('20260713185711_add_analysis_v2_result_finalization.sql');
        const resultFences = migrationSource('20260713213000_harden_analysis_v2_result_runtime_boundary.sql');
        const tableDefinition = (name: string) => {
            const start = resultSource.indexOf(`CREATE TABLE public.${name} (`);
            const end = resultSource.indexOf('\n);', start);
            if (start < 0 || end < 0) throw new Error(`Missing result fixture table ${name}`);
            return resultSource.slice(start, end + 3);
        };
        await pool.query(functionDefinition(resultSource, 'analysis_v2_result_valid_public_copy'));
        await pool.query(tableDefinition('analysis_v2_narrative_manifests'));
        await pool.query(tableDefinition('analysis_v2_narrative_rows'));
        await pool.query(`ALTER TABLE public.analysis_v2_candidate_feature_manifests
            ADD COLUMN producer_input_hash text, ADD COLUMN producer_claim_token uuid`);
        for (const manifest of [
            'preliminary_score', 'reverse_like', 'partner_safety', 'candidate_score', 'private_name',
        ]) {
            await pool.query(`CREATE TABLE public.analysis_v2_${manifest}_manifests (
                request_id uuid, producer_job_key text, producer_input_hash text, producer_claim_token uuid
            )`);
        }
        await pool.query(`CREATE TABLE public.analysis_v2_candidate_score_rows (
            request_id uuid, candidate_id text, risk_band text, featured_rank integer
        )`);
        await pool.query(functionDefinition(resultFences, 'analysis_v2_assert_result_job_fence'));
        await pool.query(functionDefinition(resultFences, 'analysis_v2_result_staging_hash'));
        await pool.query(functionDefinition(resultFences, 'analysis_v2_result_checkpoint_json'));
        await pool.query(functionDefinition(resultSource, 'checkpoint_analysis_v2_narratives'));
        await pool.query(`INSERT INTO public.analysis_pipeline_jobs (
            request_id,job_key,track,kind,batch,input_hash,status,attempt_count,
            dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_task_name,
            dispatch_reserved_at,dispatched_at,delivered_at,lease_token,lease_expires_at,
            dispatch_workload_role,dispatch_contract_version,claim_workload_role,claim_contract_version,
            created_at,updated_at
        ) SELECT request_id,$2,'narratives','ai',0,input_hash,status,attempt_count,
            dispatch_state,dispatch_generation,dispatch_reservation_token,dispatch_task_name,
            dispatch_reserved_at,dispatched_at,delivered_at,$3,clock_timestamp()+interval '5 minutes',
            dispatch_workload_role,dispatch_contract_version,claim_workload_role,claim_contract_version,
            created_at,updated_at
          FROM public.analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$4`,
        [requestId,narrativeJob,claimToken,paidJob]);
        await pool.query(`INSERT INTO public.analysis_v2_candidate_score_rows VALUES ($1,'candidate:fixture','high_risk',1)`,
            [requestId]);
        const narrativeIdentity = { ...identity, stage: 'highRiskNarrative' };
        const narrativeTelemetry = { ...telemetry, stage: 'highRiskNarrative' };
        const narrativeMetadata = { ...metadata, stage: 'highRiskNarrative' };
        const lines = ['후보의 공개 게시물에서 확인한 내용입니다.', '확인한 공개 단서와 수집 범위를 함께 봐야 합니다.'];
        const narrativeOutput = JSON.stringify({ lines: lines.map(text => ({ evidenceRefs: ['profile:bio'], text })) });
        const narrativeHash = hash(`analysis-v2-ai-result-content:v1\0${narrativeOutput}`);
        const renderSql = 'SELECT public.checkpoint_analysis_v2_narratives($1,$2,$3,$4,$5::jsonb) AS result';
        const client = await pool.connect();
        const blocker = await pool.connect();
        try {
            const intent = async (input: typeof narrativeIdentity) => {
                const { rows } = await client.query<{ value: string }>(
                    'SELECT public.analysis_v2_ai_result_operation_key($1::jsonb) AS value', [input],
                );
                const args = [requestId, narrativeJob, claimToken, rows[0]!.value, randomUUID()];
                await expect(asService(client, reserveSql, [...args, narrativeMetadata]))
                    .resolves.toMatchObject({ created: true });
                return args;
            };
            const render = (operationKey: string) => asService(client, renderSql, [
                requestId,narrativeJob,claimToken,jobInputHash,
                JSON.stringify([{ candidateId: 'candidate:fixture', lines, source: 'checkpoint',
                    operationKey, aiResultHash: narrativeHash }]),
            ]);
            const oldRejected = await intent({ ...narrativeIdentity, input_hash: hash('prior-rejection') });
            await asService(client, `SELECT public.terminalize_analysis_v2_ai_attempt(
                $1::uuid,$2::text,$3::uuid,$4::text,1::smallint,$5::uuid,'response_rejected',$6::jsonb
            ) AS result`, [...oldRejected, narrativeTelemetry]);
            await expect(render(oldRejected[3]!)).rejects.toMatchObject({
                code: 'P0001', message: 'ANALYSIS_V2_RESULT_NOT_READY',
            });

            await client.query(migrationSource('20261124163002_checkpoint_deterministically_repaired_narratives.sql'));
            const repair = auditSql.replace('terminalize_analysis_v2_ai_attempt_with_result', 'terminalize_analysis_v2_repaired_narrative');
            const args = await intent(narrativeIdentity);
            const paid = [...args, narrativeTelemetry, narrativeIdentity, narrativeOutput, narrativeOutput, narrativeHash];
            await expect(asService(client, repair, paid)).rejects.toMatchObject({
                code: 'P0001', message: 'ANALYSIS_V2_AI_RESULT_INVALID',
            });
            await client.query(`UPDATE public.analysis_requests SET policy_versions_snapshot='{"aiStage":"ai-stage-policy-v2.11"}' WHERE id=$1`,
                [requestId]);
            await blocker.query('BEGIN');
            try {
                await blocker.query('SELECT id FROM public.analysis_preflights WHERE id=$1 FOR UPDATE', [preflightId]);
                await expect(asService(client, repair, paid, 200)).rejects.toMatchObject({ code: '57014' });
            } finally {
                await blocker.query('ROLLBACK');
            }
            const savedEvidence = () => client.query(`
                SELECT attempt.status, attempt.finish_reason, attempt.estimated_cost_usd::text AS cost,
                       checkpoint.source, checkpoint.result_hash
                FROM public.analysis_v2_ai_attempts AS attempt
                LEFT JOIN public.analysis_v2_ai_result_checkpoints AS checkpoint
                  ON checkpoint.request_id=attempt.request_id AND checkpoint.operation_key=attempt.operation_key
                WHERE attempt.request_id=$1 AND attempt.operation_key=$2`, [requestId,args[3]]);
            expect((await savedEvidence()).rows).toEqual([
                { status:'reserved', finish_reason:null, cost:null, source:null, result_hash:null },
            ]);
            await expect(Promise.all([asService(client,repair,paid), asService(blocker,repair,paid)]))
                .resolves.toEqual(Array(2).fill(expect.objectContaining({
                    outcome: 'checkpointed',
                    checkpoint: expect.objectContaining({ source: 'deterministic_repair', estimatedCostUsd: 0.001 }),
                })));
            expect((await savedEvidence()).rows).toEqual([{
                status: 'response_rejected', finish_reason: 'STOP', cost: '0.001000000000',
                source: 'deterministic_repair', result_hash: narrativeHash,
            }]);
            await expect(asService(client,
                'SELECT public.load_analysis_v2_ai_result_checkpoint($1,$2) AS result', [requestId, args[3]],
            )).resolves.toMatchObject({
                source: 'deterministic_repair', result: JSON.parse(narrativeOutput), resultHash: narrativeHash,
            });
            await expect(render(args[3]!)).resolves.toMatchObject({ itemCount: 1, rowCount: 1 });
            const stored = await client.query('SELECT line_one,line_two FROM public.analysis_v2_narrative_rows WHERE request_id=$1',
                [requestId]);
            expect(stored.rows).toEqual([{ line_one: lines[0], line_two: lines[1] }]);
            const ordinaryIdentity = { ...narrativeIdentity, input_hash: hash('ordinary-success') };
            const ordinary = await intent(ordinaryIdentity);
            await expect(asService(client, auditSql, [
                ...ordinary, narrativeTelemetry, ordinaryIdentity, narrativeOutput, narrativeOutput, narrativeHash,
            ])).resolves.toMatchObject({ outcome: 'checkpointed', checkpoint: { source: 'generated' } });
            expect((await client.query(
                'SELECT status FROM public.analysis_v2_ai_attempts WHERE request_id=$1 AND operation_key=$2',
                [requestId, ordinary[3]],
            )).rows).toEqual([{ status: 'success' }]);
        } finally {
            blocker.release();
            client.release();
        }
    }, 15_000);
});
