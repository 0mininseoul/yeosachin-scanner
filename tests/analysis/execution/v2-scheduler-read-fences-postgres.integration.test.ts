import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrations = new URL('../../../supabase/migrations/', import.meta.url);
const readSql = (file: string) => readFileSync(new URL(file, migrations), 'utf8');
const scheduler = 'claim_analysis_v2_scheduler_operation';
const heartbeat = 'checkpoint_analysis_v2_active_profile_heartbeat';
const schedulerSignature = `${scheduler}(uuid,text,uuid,text,text,uuid,integer)`;
const heartbeatSignature = `${heartbeat}(uuid,text,uuid,text,timestamptz,integer,text,text,text[],text,integer,text)`;
const leaseToken = randomUUID();
const requestId = randomUUID();
const inputHash = 'a'.repeat(64);
const batch = (index: number) => `track:profile-ai:batch:${index}`;
const operationKey = (index: number) => `gender-triage:${index.toString(16).padStart(64, '0')}`;

function sqlFragment(sql: string, pattern: RegExp): string {
    const match = sql.match(pattern)?.[0];
    if (match === undefined) throw new Error(`Missing source fixture fragment for ${pattern}`);
    return match;
}

function functionSql(file: string, functionName: string): string {
    return sqlFragment(readSql(file), new RegExp(
        `^CREATE (?:OR REPLACE )?FUNCTION public\\.${functionName}\\([\\s\\S]*?^\\$\\$;`, 'm',
    ));
}

function schedulerPolicyPatch(file: string): string {
    const patches = [...readSql(file).matchAll(/^DO \$migration\$[\s\S]*?^\$migration\$;/gm)]
        .map(match => match[0]).filter(patch => patch.includes(schedulerSignature));
    if (patches.length !== 1) throw new Error(`Expected one scheduler policy patch in ${file}`);
    return patches[0]!;
}

function claim(client: Client, key: string, jobIndex: number) {
    return client.query<{ decision: string; recovery_only: boolean }>(
        `SELECT decision, recovery_only FROM public.${scheduler}(
            $1, $2, $3, $4, 'genderTriage', $5, 330
        )`, [requestId, batch(jobIndex), leaseToken, key, randomUUID()],
    );
}

function tick(client: Client, jobIndex: number, startedAt: Date, ordinal: number) {
    return client.query<{ advanced: boolean }>(
        `SELECT public.${heartbeat}($1, $2, $3, $4, $5, 12, 'f***e', NULL, '{}', NULL, $6, 'analyzing') AS advanced`,
        [requestId, batch(jobIndex), leaseToken, inputHash, startedAt, ordinal],
    );
}

// Requires local PostgreSQL binaries. Starts a private Unix-socket-only cluster.
describe.runIf(process.env.RUN_SCHEDULER_READ_FENCE_POSTGRES_TEST === '1')(
    'scheduler and profile heartbeat read fences (PostgreSQL)',
    () => {
        let directory: string;
        let cluster: string;
        let started = false;
        let admin: Client;
        let blocker: Client;
        let readers: Client[] = [];

        beforeAll(async () => {
            directory = mkdtempSync(join(tmpdir(), 'scheduler-read-'));
            cluster = join(directory, 'pg');
            execFileSync('initdb', ['-D', cluster, '-U', 'fixture', '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
            execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o',
                "-c unix_socket_directories=. -c listen_addresses='' -p 5432", '-w', 'start'], { stdio: 'ignore' });
            started = true;
            const options = { host: cluster, port: 5432, user: 'fixture', database: 'postgres' };
            admin = new Client(options);
            blocker = new Client(options);
            readers = Array.from({ length: 8 }, () => new Client({ ...options, statement_timeout: 200 }));
            await Promise.all([admin, blocker, ...readers].map(client => client.connect()));
            await admin.query(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE TABLE public.analysis_requests (
                    id UUID PRIMARY KEY, pipeline_version TEXT NOT NULL, status TEXT NOT NULL,
                    policy_versions_snapshot JSONB NOT NULL
                );
                CREATE TABLE public.analysis_pipeline_jobs (
                    request_id UUID REFERENCES public.analysis_requests(id),
                    job_key TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL,
                    lease_token UUID, lease_expires_at TIMESTAMPTZ, PRIMARY KEY (request_id, job_key)
                );
                CREATE TABLE public.analysis_v2_dag_batch_topology (
                    request_id UUID, topology_kind TEXT, batch INTEGER, item_count INTEGER,
                    PRIMARY KEY (request_id, topology_kind, batch)
                );
                CREATE TABLE public.analysis_v2_ai_attempts (
                    request_id UUID, job_key TEXT, operation_key TEXT, status TEXT, estimated_cost_usd NUMERIC
                );
                CREATE TABLE public.analysis_v2_ai_result_checkpoints (
                    request_id UUID, job_key TEXT, operation_key TEXT, stage TEXT
                );
                CREATE TABLE public.analysis_v2_active_profile_heartbeats (
                    request_id UUID NOT NULL, job_key TEXT NOT NULL, job_input_hash TEXT NOT NULL,
                    claim_token UUID NOT NULL, started_at TIMESTAMPTZ NOT NULL,
                    completed_count SMALLINT NOT NULL, total_count SMALLINT NOT NULL,
                    masked_username TEXT NOT NULL, image_url TEXT, feed_image_urls TEXT[] NOT NULL,
                    candidate_key TEXT, call_phase TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (request_id, job_key),
                    FOREIGN KEY (request_id, job_key)
                        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
                );
                CREATE FUNCTION public.analysis_v2_valid_ai_operation_key(value TEXT)
                RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
                    SELECT value ~ '^(gender-triage|feature-analysis|private-account-name):[0-9a-f]{64}$'
                $$;
            `);
            await admin.query(sqlFragment(readSql('20260727034000_add_analysis_v2_scheduler_live_operations.sql'),
                /^CREATE TABLE public\.analysis_v2_scheduler_operations \([\s\S]*?^\);$/m));
            await admin.query(functionSql('20260728110000_add_ai_stage_policy_v210.sql', scheduler));
            for (const file of [
                '20260728180000_add_risk_policy_v25.sql',
                '20260803123000_add_ai_stage_policy_v211_quality.sql',
                '20260902091000_add_vertex_ai_cost_policy_fences.sql',
            ]) {
                await admin.query(schedulerPolicyPatch(file));
            }
            await admin.query(functionSql('20260801010000_add_progress_candidate_media.sql',
                'analysis_v2_valid_active_profile_feed_image_urls'));
            await admin.query(functionSql('20260829120000_add_analysis_v2_progress_signals_history.sql', heartbeat));
            for (const signature of [schedulerSignature, heartbeatSignature]) {
                await admin.query(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;
                    GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
            }
            await Promise.all(readers.map(reader => reader.query('SET ROLE service_role')));
            await admin.query(`
                INSERT INTO public.analysis_requests VALUES ($1, 'v2', 'processing', $2);
            `, [requestId, JSON.stringify({
                pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.12', scheduler: 'ai-scheduler-v1',
            })]);
            for (let index = 0; index < readers.length; index++) {
                await admin.query(`INSERT INTO public.analysis_pipeline_jobs
                    VALUES ($1, $2, 'processing', $3, $4, clock_timestamp() + INTERVAL '5 minutes')`,
                [requestId, batch(index), inputHash, leaseToken]);
                await admin.query("INSERT INTO public.analysis_v2_dag_batch_topology VALUES ($1, 'profile', $2, 12)",
                    [requestId, index]);
            }
        }, 30_000);

        afterAll(async () => {
            await Promise.allSettled([admin, blocker, ...readers].filter(Boolean).map(client => client.end()));
            if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
            if (directory) rmSync(directory, { recursive: true, force: true });
        });

        it('admits concurrent claims and heartbeats under shared parent locks and preserves writer fences', async () => {
            const observed: Array<{ elapsedMs: number; timeouts: number }> = [];
            async function runUnderReaders() {
                await blocker.query('BEGIN');
                const since = performance.now();
                try {
                    await blocker.query('SELECT id FROM public.analysis_requests WHERE id = $1 FOR SHARE', [requestId]);
                    await blocker.query('SELECT job_key FROM public.analysis_pipeline_jobs WHERE request_id = $1 FOR SHARE', [requestId]);
                    const outcomes = await Promise.all(readers.map(async (reader, index) => {
                        let timeouts = 0;
                        const startedAt = new Date();
                        for (let run = 0; run < 12; run++) {
                            for (const query of [
                                () => claim(reader, operationKey(index * 12 + run), index),
                                () => tick(reader, index, startedAt, run + 1),
                            ]) {
                                try {
                                    await query();
                                } catch (error) {
                                    if ((error as { code?: string }).code !== '57014') throw error;
                                    timeouts++;
                                }
                            }
                        }
                        return timeouts;
                    }));
                    observed.push({ elapsedMs: Math.round(performance.now() - since), timeouts: outcomes.reduce((a, b) => a + b, 0) });
                } finally {
                    await blocker.query('ROLLBACK');
                }
            }
            await runUnderReaders();
            await admin.query(readSql('20261123172000_share_analysis_v2_scheduler_read_fences.sql'));
            await runUnderReaders();
            console.log('scheduler and heartbeat shared-read load', observed);
            expect(observed.map(result => result.timeouts)).toEqual([192, 0]);
            await expect(admin.query('SELECT count(*)::int AS claims FROM public.analysis_v2_scheduler_operations'))
                .resolves.toMatchObject({ rows: [{ claims: 96 }] });
            await expect(admin.query('SELECT count(*)::int AS last_ordinal FROM public.analysis_v2_active_profile_heartbeats WHERE completed_count = 12'))
                .resolves.toMatchObject({ rows: [{ last_ordinal: 8 }] });
            await expect(tick(readers[0]!, 0, new Date(), 11))
                .resolves.toMatchObject({ rows: [{ advanced: false }] });
            await expect(admin.query(`
                SELECT has_function_privilege('service_role', 'public.${schedulerSignature}', 'EXECUTE') AS scheduler_service,
                       has_function_privilege('anon', 'public.${heartbeatSignature}', 'EXECUTE') AS heartbeat_anon
            `)).resolves.toMatchObject({ rows: [{ scheduler_service: true, heartbeat_anon: false }] });
            await blocker.query('BEGIN');
            try {
                await blocker.query('SELECT job_key FROM public.analysis_pipeline_jobs WHERE request_id = $1 AND job_key = $2 FOR NO KEY UPDATE',
                    [requestId, batch(0)]);
                await expect(claim(readers[0]!, operationKey(96), 0)).rejects.toHaveProperty('code', '57014');
                await expect(tick(readers[0]!, 0, new Date(), 11)).rejects.toHaveProperty('code', '57014');
            } finally {
                await blocker.query('ROLLBACK');
            }
        }, 30_000);

        it('admits one execution for a newly raced operation and retains unsafe attempts for recovery', async () => {
            const key = operationKey(1000);
            await blocker.query('BEGIN');
            try {
                await expect(claim(blocker, key, 0)).resolves.toMatchObject({ rows: [{ decision: 'execute' }] });
                const duplicates = readers.map(reader => claim(reader, key, 0));
                await admin.query('SELECT pg_sleep(0.05)');
                await blocker.query('COMMIT');
                await expect(Promise.all(duplicates)).resolves.toEqual(
                    readers.map(() => expect.objectContaining({ rows: [{ decision: 'deferred', recovery_only: false }] })),
                );
            } finally {
                await blocker.query('ROLLBACK');
            }
            await admin.query(`INSERT INTO public.analysis_v2_ai_attempts
                VALUES ($1, $2, $3, 'reserved', NULL), ($1, $2, $4, 'success', 0.00034)`,
                [requestId, batch(0), key, operationKey(1001)]);
            await admin.query(`UPDATE public.analysis_v2_scheduler_operations
                SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
                WHERE request_id = $1 AND operation_key = $2`, [requestId, key]);
            await expect(claim(readers[0]!, key, 0)).resolves.toMatchObject({ rows: [{ decision: 'deferred' }] });
            await expect(admin.query('SELECT estimated_cost_usd, status FROM public.analysis_v2_ai_attempts ORDER BY status'))
                .resolves.toMatchObject({ rows: [
                    { estimated_cost_usd: null, status: 'reserved' },
                    { estimated_cost_usd: '0.00034', status: 'success' },
                ] });
            await expect(admin.query('SELECT count(*)::int AS claims FROM public.analysis_v2_scheduler_operations WHERE operation_key = $1', [key]))
                .resolves.toMatchObject({ rows: [{ claims: 1 }] });
        });

        it('rejects a job lease that expires while waiting for a conflicting job lock', async () => {
            const key = operationKey(1002);
            const reader = readers[0]!;
            await reader.query("SET statement_timeout = '1s'");
            await admin.query(`UPDATE public.analysis_pipeline_jobs
                SET lease_expires_at = clock_timestamp() + INTERVAL '100 milliseconds'
                WHERE request_id = $1 AND job_key = $2`, [requestId, batch(7)]);
            await blocker.query('BEGIN');
            try {
                await blocker.query('SELECT job_key FROM public.analysis_pipeline_jobs WHERE request_id = $1 AND job_key = $2 FOR NO KEY UPDATE',
                    [requestId, batch(7)]);
                const pending = claim(reader, key, 7);
                const rejection = expect(pending).rejects.toThrow('ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH');
                await admin.query('SELECT pg_sleep(0.15)');
                await blocker.query('COMMIT');
                await rejection;
            } finally {
                await blocker.query('ROLLBACK');
                await reader.query("SET statement_timeout = '200ms'");
            }
            await expect(admin.query('SELECT count(*)::int AS claims FROM public.analysis_v2_scheduler_operations WHERE operation_key = $1', [key]))
                .resolves.toMatchObject({ rows: [{ claims: 0 }] });
        });
    },
);
