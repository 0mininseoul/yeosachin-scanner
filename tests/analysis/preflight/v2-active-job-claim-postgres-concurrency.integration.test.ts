import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileConsumerFixtureSql } from './fixtures/profile-consumer';

const request = '10000000-0000-4000-8000-000000000001';
const preflight = '10000000-0000-4000-8000-000000000002';
const dispatch = '20000000-0000-4000-8000-000000000001';
const claim = '30000000-0000-4000-8000-000000000001';
const otherClaim = '30000000-0000-4000-8000-000000000002';
const workers = 8;
const claimsPerWorker = 12;
const job = (n: number) => 'track:profile-ai:batch:' + n;

function migration(name: string): string {
    return readFileSync(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
}

function definition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = source.indexOf('\n$$;', start);
    if (start < 0 || end < 0) throw new Error(`Missing SQL fixture function ${name}`);
    return source.slice(start, end + 4);
}

const optimized = migration('20261123171000_share_analysis_v2_active_job_claim_locks');

describe.runIf(process.env.RUN_ACTIVE_JOB_CLAIM_POSTGRES_TEST === '1')(
    'active paid job claim locks on real PostgreSQL',
    () => {
        let directory: string;
        let cluster: string;
        let started = false;
        let control: Client;
        let locker: Client;
        let clients: Client[] = [];

        beforeAll(async () => {
            directory = mkdtempSync(join(tmpdir(), 'claim-lock-'));
            cluster = join(directory, 'pg');
            execFileSync('initdb', ['-D', cluster, '-U', 'fixture', '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
            execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o',
                "-c unix_socket_directories=. -c listen_addresses='' -p 5432", '-w', 'start'], { stdio: 'ignore' });
            started = true;

            const options = { host: cluster, port: 5432, user: 'fixture', database: 'postgres' };
            control = new Client(options);
            locker = new Client(options);
            await Promise.all([control.connect(), locker.connect()]);
            await control.query(profileConsumerFixtureSql);
            await control.query(`
                ALTER TABLE public.analysis_requests ADD COLUMN background_processing boolean NOT NULL DEFAULT false;
                ALTER TABLE public.analysis_pipeline_jobs
                    ADD COLUMN dispatch_workload_role text,
                    ADD COLUMN dispatch_contract_version smallint,
                    ADD COLUMN claim_workload_role text,
                    ADD COLUMN claim_contract_version smallint,
                    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                    ADD COLUMN recovery_checked_at timestamptz,
                    ADD COLUMN recovery_not_before timestamptz;
                CREATE TABLE public.analysis_v2_provider_cleanup_intents (
                    request_id uuid PRIMARY KEY, failed_job_key text, failed_job_input_hash text,
                    failed_claim_token uuid, error_code text, completed_at timestamptz
                );
                CREATE TABLE public.claim_test_request_writes (writes integer NOT NULL);
                INSERT INTO public.claim_test_request_writes VALUES (0);
                CREATE FUNCTION public.claim_test_count_request_writes() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    UPDATE public.claim_test_request_writes SET writes = writes + 1;
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER claim_test_count_request_writes AFTER UPDATE ON public.analysis_requests
                FOR EACH ROW EXECUTE FUNCTION public.claim_test_count_request_writes();
            `);
            const invariants = migration('20260714031500_harden_analysis_v2_terminal_invariants');
            await control.query(definition(invariants, 'claim_analysis_v2_job').replace(
                'public.claim_analysis_v2_job(', 'public.claim_analysis_v2_job_unfenced_20260811(',
            ));
            const takeover = migration('20260830102000_add_analysis_v2_terminal_failure_takeover');
            const claimPatch = takeover.match(/DO \$claim_recovery_patch\$[\s\S]+?\n\$claim_recovery_patch\$;/)?.[0];
            if (!claimPatch) throw new Error('Missing terminal claim recovery patch');
            await control.query(claimPatch);
            await control.query(definition(migration('20260811090000_harden_fresh_provenance'), 'claim_analysis_v2_job'));

            const admission = migration('20260831100000_add_analysis_provider_admission_leases');
            for (const name of ['reserve_analysis_v2_job_dispatch_v2', 'rearm_analysis_v2_job_dispatch_v2',
                'mark_analysis_v2_job_dispatched_v2', 'claim_analysis_v2_job_v2']) {
                await control.query(definition(admission, name));
            }
            await control.query(migration('20261122090000_order_analysis_v2_dispatch_lineage_locks'));
            await control.query(`
                REVOKE ALL ON FUNCTION public.claim_analysis_v2_job_v2(uuid,text,integer,uuid,uuid,integer,integer,text,smallint)
                    FROM PUBLIC, anon, authenticated, service_role;
                GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_job_v2(uuid,text,integer,uuid,uuid,integer,integer,text,smallint)
                    TO service_role;
            `);
            await control.query(definition(migration('20260714045814_add_analysis_v2_recovery_rotation'),
                'analysis_v2_set_job_recovery_schedule'));
            await control.query(`
                CREATE TRIGGER analysis_v2_job_recovery_schedule BEFORE INSERT OR UPDATE ON public.analysis_pipeline_jobs
                FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_set_job_recovery_schedule();
            `);

            clients = Array.from({ length: workers }, (_, i) => new Client({
                ...options, application_name: 'claim-worker-' + i, statement_timeout: 300,
            }));
            await Promise.all(clients.map(async client => {
                await client.connect();
                await client.query('SET ROLE service_role');
            }));
        }, 30_000);

        afterAll(async () => {
            await Promise.allSettled([control?.end(), locker?.end(), ...clients.map(client => client.end())]);
            if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
            if (directory) rmSync(directory, { recursive: true, force: true });
        });

        async function seed(count: number, status = 'processing') {
            await control.query(`
                TRUNCATE public.analysis_v2_profile_fetch_outcomes,
                    public.analysis_v2_profile_fetch_batches, public.analysis_pipeline_jobs,
                    public.analysis_v2_provider_execution_policies, public.analysis_v2_provider_cleanup_intents,
                    public.analysis_requests, public.analysis_preflights;
                UPDATE public.claim_test_request_writes SET writes = 0;
            `);
            await control.query(`
                INSERT INTO public.analysis_requests(id, preflight_id, pipeline_version, status, background_processing)
                VALUES ($1, $2, 'v2', $3, $3 = 'processing')
            `, [request, preflight, status]);
            await control.query(`
                INSERT INTO public.analysis_preflights(id, consumed_request_id, status)
                VALUES ($1, $2, 'consumed')
            `, [preflight, request]);
            await control.query(`
                INSERT INTO public.analysis_pipeline_jobs (
                    request_id, job_key, status, input_hash, track, kind, batch, attempt_count,
                    dispatch_state, dispatch_generation, dispatch_reservation_token,
                    dispatch_workload_role, dispatch_contract_version
                ) SELECT $1, 'track:profile-ai:batch:' || n, 'pending', repeat('a', 64), 'profile_ai', 'ai', n, 0,
                    'enqueued', 1, $2, 'paid', 2
                FROM generate_series(0, $3::int - 1) AS n
            `, [request, dispatch, count]);
        }

        const claimJob = (client: Client, n: number, lease = claim, delivery = dispatch) => client.query<{
            claimed: boolean; job_status: string; attempt_count: number;
        }>(`SELECT * FROM public.claim_analysis_v2_job_v2(
            $1,$2,1,$3,$4,120,7,'paid',2::smallint)`, [request, job(n), delivery, lease]);

        async function waitForWaiter(applicationName: string) {
            for (let step = 0; step < 80; step += 1) {
                const { rows } = await control.query<{ waiting: boolean }>(`SELECT EXISTS (
                    SELECT 1 FROM pg_stat_activity
                    WHERE application_name = $1 AND wait_event_type = 'Lock'
                ) AS waiting`, [applicationName]);
                if (rows[0].waiting) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error('Never observed competing claim at lock barrier');
        }

        async function parallelClaims() {
            const start = performance.now();
            const results = await Promise.all(clients.map(async (client, index) => {
                let successes = 0;
                let timeouts = 0;
                for (let attempt = 0; attempt < claimsPerWorker; attempt += 1) {
                    try {
                        const read = await claimJob(client, index * claimsPerWorker + attempt);
                        expect(read.rows[0]).toMatchObject({ claimed: true, attempt_count: 1 });
                        successes += 1;
                    } catch (err) {
                        if ((err as { code?: string }).code !== '57014') throw err;
                        timeouts += 1;
                    }
                }
                return { successes, timeouts };
            }));
            return {
                successes: results.reduce((n, r) => n + r.successes, 0),
                timeouts: results.reduce((n, r) => n + r.timeouts, 0),
                elapsedMs: Math.round(performance.now() - start),
            };
        }

        it('shares both parent locks across 8 workers and writes only the target job', async () => {
            const count = workers * claimsPerWorker;
            await seed(count);
            const withSharedParents = async () => {
                await locker.query('BEGIN');
                try {
                    await locker.query('SELECT id FROM public.analysis_preflights WHERE id=$1 FOR SHARE', [preflight]);
                    await locker.query('SELECT id FROM public.analysis_requests WHERE id=$1 FOR SHARE', [request]);
                    return await parallelClaims();
                } finally {
                    await locker.query('ROLLBACK');
                }
            };

            const before = await withSharedParents();
            expect(before).toMatchObject({ successes: 0, timeouts: count });
            await control.query(optimized);
            const after = await withSharedParents();
            expect(after).toMatchObject({ successes: count, timeouts: 0 });
            console.info('paid active claim shared-parent load', { before, after });

            const result = await control.query(`
                SELECT count(*) FILTER (
                    WHERE status = 'processing' AND attempt_count = 1 AND dispatch_state = 'delivered'
                        AND claim_workload_role = 'paid' AND claim_contract_version = 2
                        AND recovery_not_before = lease_expires_at
                )::int AS claimed,
                (SELECT writes FROM public.claim_test_request_writes) AS request_writes
                FROM public.analysis_pipeline_jobs
            `);
            expect(result.rows).toEqual([{ claimed: count, request_writes: 0 }]);
            const permission = await control.query(`
                SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
                FROM pg_proc p WHERE proname = 'claim_analysis_v2_job_v2'
            `);
            expect(permission.rows).toEqual([{ service: true, anon: false }]);
        }, 15_000);

        it('allows one new lease when two deliveries race and preserves the same-token response', async () => {
            await seed(1);
            await clients[0].query("SET statement_timeout = '3s'");
            await clients[1].query("SET statement_timeout = '3s'");
            await locker.query('BEGIN');
            let pair: Promise<Awaited<ReturnType<typeof claimJob>>[]> | undefined;
            try {
                await locker.query('SELECT job_key FROM public.analysis_pipeline_jobs FOR NO KEY UPDATE');
                pair = Promise.all([claimJob(clients[0], 0), claimJob(clients[1], 0, otherClaim)]);
                void pair.catch(() => undefined);
                await Promise.all([waitForWaiter('claim-worker-0'), waitForWaiter('claim-worker-1')]);
            } finally {
                await locker.query('ROLLBACK');
            }
            const rows = (await pair!).map(response => response.rows[0]);
            expect(rows.filter(row => row.claimed)).toHaveLength(1);
            expect(rows.every(row => row.attempt_count === 1)).toBe(true);
            const replay = await claimJob(clients[0], 0, rows[0].claimed ? claim : otherClaim);
            expect(replay.rows[0]).toMatchObject({ claimed: true, attempt_count: 1 });
        });

        it('rejects stale and early deliveries and keeps strict approval and first-claim writers', async () => {
            await seed(2);
            await expect(claimJob(clients[0], 0, claim, otherClaim))
                .rejects.toMatchObject({ message: 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH' });
            await control.query(`
                UPDATE public.analysis_pipeline_jobs SET scheduler_not_before_at = clock_timestamp() + interval '1 hour'
                WHERE job_key = $1
            `, [job(0)]);
            await expect(claimJob(clients[0], 0))
                .rejects.toMatchObject({ message: 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY' });
            await control.query("UPDATE public.analysis_requests SET plan_access_mode_snapshot='test_entitlement'");
            await control.query("INSERT INTO public.analysis_v2_provider_execution_policies VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1')", [request]);
            await expect(claimJob(clients[0], 1))
                .rejects.toMatchObject({ message: 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE' });

            await seed(1, 'pending');
            const first = await claimJob(clients[0], 0);
            expect(first.rows[0]).toMatchObject({ claimed: true, attempt_count: 1 });
            const stored = await control.query('SELECT status, background_processing FROM public.analysis_requests');
            expect(stored.rows).toEqual([{ status: 'processing', background_processing: true }]);
        });

        it('honors an intent-owned exhausted claim and cancellation committing during parent acquisition', async () => {
            await seed(2);
            await control.query(`
                UPDATE public.analysis_pipeline_jobs SET attempt_count=7,status='processing',
                    lease_expires_at=clock_timestamp()-interval '1 minute',lease_token=$2 WHERE job_key=$1
            `, [job(0), otherClaim]);
            await control.query(`
                INSERT INTO public.analysis_v2_provider_cleanup_intents
                    (request_id,failed_job_key,failed_job_input_hash,failed_claim_token,error_code)
                VALUES ($1,$2,repeat('a',64),$3,'JOB_ATTEMPTS_EXHAUSTED')
            `, [request, job(0), otherClaim]);
            const exhausted = await claimJob(clients[0], 0);
            expect(exhausted.rows[0]).toMatchObject({ claimed: false, attempt_count: 7, job_status: 'processing' });
            await control.query('DELETE FROM public.analysis_v2_provider_cleanup_intents');

            await locker.query('BEGIN');
            let pending: ReturnType<typeof claimJob> | undefined;
            try {
                await locker.query('SELECT id FROM public.analysis_preflights FOR UPDATE');
                await locker.query("UPDATE public.analysis_requests SET status='failed'");
                await locker.query("UPDATE public.analysis_pipeline_jobs SET status='cancelled' WHERE job_key=$1", [job(1)]);
                pending = claimJob(clients[0], 1);
                void pending.catch(() => undefined);
                await waitForWaiter('claim-worker-0');
                await locker.query('COMMIT');
            } finally {
                await locker.query('ROLLBACK');
            }
            expect((await pending!).rows[0]).toMatchObject({
                claimed: false, attempt_count: 0, job_status: 'cancelled',
            });
        });
    },
);
