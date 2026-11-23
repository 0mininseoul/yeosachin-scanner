import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    originalProfileConsumerSql,
    profileConsumerFixtureSql,
    profileConsumerReadSql,
} from './fixtures/profile-consumer';

const requestId = '10000000-0000-4000-8000-000000000001';
const claimToken = '20000000-0000-4000-8000-000000000001';
const replacementClaim = '20000000-0000-4000-8000-000000000002';
const dispatchToken = '30000000-0000-4000-8000-000000000001';
const readTimeout = 'ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT';
const producerHash = 'a'.repeat(64);
const consumerHash = 'b'.repeat(64);
const workers = 8;
const readsPerWorker = 12;
const producerKey = (index: number) => 'track:profiles:batch:' + index;
const consumerKey = (index: number) => 'track:profile-ai:batch:' + index;

// Requires local PostgreSQL binaries. Starts a private Unix-socket-only cluster.
describe.runIf(process.env.RUN_PROFILE_CONSUMER_POSTGRES_TEST === '1')(
    'profile checkpoint reads and timeout continuation (PostgreSQL)',
    () => {
        let directory: string;
        let cluster: string;
        let started = false;
        let control: Client;
        let locker: Client;
        let readers: Client[] = [];

        beforeAll(async () => {
            directory = mkdtempSync(join(tmpdir(), 'profile-read-'));
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
            await control.query(originalProfileConsumerSql);
            await control.query(
                `INSERT INTO public.analysis_requests(id, pipeline_version, status)
                     VALUES ($1, 'v2', 'processing')`, [requestId],
            );
            await control.query(
                `INSERT INTO public.analysis_preflights(id, consumed_request_id, target_instagram_id)
                     VALUES (gen_random_uuid(), $1, 'fixture')`, [requestId],
            );
            for (let index = 0; index < workers; index++) {
                await control.query(
                    `INSERT INTO public.analysis_pipeline_jobs(
                         request_id, job_key, status, input_hash, track, kind, batch,
                         lease_token, lease_expires_at, attempt_count, dispatch_generation
                     ) VALUES
                         ($1, $2, 'completed', $3, 'profiles', 'profile_fetch', $4, NULL, NULL, 1, 7),
                         ($1, $5, 'processing', $6, 'profile_ai', 'ai', $4, $7,
                          clock_timestamp() + interval '10 minutes', 7, 7)`,
                    [requestId, producerKey(index), producerHash, index, consumerKey(index), consumerHash, claimToken],
                );
                await control.query(
                    `INSERT INTO public.analysis_v2_profile_fetch_batches(
                        request_id, job_key, requested_usernames, frozen_unresolved_usernames, primary_payload_hash
                     ) SELECT $1, $2, array_agg('fixture' || n ORDER BY n), '{}', $3
                       FROM generate_series(1, 30) AS n`,
                    [requestId, producerKey(index), producerHash],
                );
                await control.query(
                    `INSERT INTO public.analysis_v2_profile_fetch_outcomes(
                        request_id, job_key, attempt, ordinal, username, source, status, profile_snapshot
                     ) SELECT $1, $2, 'fresh_apify', n, 'fixture' || n, 'apify', 'success',
                           jsonb_build_object('username', 'fixture' || n)
                       FROM generate_series(1, 30) AS n`,
                    [requestId, producerKey(index)],
                );
            }
            await control.query(
                `INSERT INTO public.analysis_v2_candidate_feature_manifests (
                     request_id, producer_job_key, producer_input_hash, producer_claim_token
                 ) VALUES ($1, $2, $3, $4)`,
                [requestId, consumerKey(0), consumerHash, replacementClaim],
            );
            await control.query(profileConsumerReadSql);
            readers = Array.from({ length: workers }, () => new Client({ ...options, statement_timeout: 200 }));
            await Promise.all(readers.map(async reader => {
                await reader.connect();
                await reader.query('SET ROLE service_role');
            }));
        }, 30_000);

        afterAll(async () => {
            await Promise.allSettled([control?.end(), locker?.end(), ...readers.map(reader => reader.end())]);
            if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
            if (directory) rmSync(directory, { recursive: true, force: true });
        });

        const read = (index: number, useClaim = claimToken) => readers[index].query<{ snapshot: { primaryResults: unknown[] } }>(
            'SELECT public.load_analysis_v2_profile_fetch_for_consumer($1,$2,$3,$4,$5,$6,30) AS snapshot',
            [requestId, consumerKey(index), useClaim, consumerHash, producerKey(index), producerHash],
        );
        const defer = (index: number, code = readTimeout, useClaim = claimToken) => readers[index].query<{
            dispatch_generation: number; attempt_count: number; job_status: string; dispatch_state: string;
        }>('SELECT * FROM public.continue_analysis_v2_scheduler_job($1,$2,$3,$4,$5,5)',
            [requestId, consumerKey(index), useClaim, dispatchToken, code],
        );

        async function load() {
            const start = performance.now();
            const outcomes = await Promise.all(readers.map(async (_, index) => {
                const counts = { completed: 0, timeouts: 0 };
                for (let n = 0; n < readsPerWorker; n++) {
                    try {
                        const result = await read(index);
                        expect(result.rows[0].snapshot.primaryResults).toHaveLength(30);
                        counts.completed++;
                    } catch (error) {
                        if ((error as { code?: string }).code !== '57014') throw error;
                        counts.timeouts++;
                    }
                }
                return counts;
            }));
            return {
                completed: outcomes.reduce((total, outcome) => total + outcome.completed, 0),
                timeouts: outcomes.reduce((total, outcome) => total + outcome.timeouts, 0),
                elapsedMs: Math.round(performance.now() - start),
            };
        }

        it('preserves the checkpoint under request row contention without taking a manifest write lock', async () => {
            const count = workers * readsPerWorker;
            await control.query(originalProfileConsumerSql);
            const before = await load();
            expect(before).toMatchObject({ completed: count, timeouts: 0 });
            const baseline = (await read(0)).rows[0].snapshot;
            await control.query(
                'UPDATE public.analysis_v2_candidate_feature_manifests SET producer_claim_token = $1', [replacementClaim],
            );
            await locker.query('BEGIN');
            try {
                await locker.query('SELECT id FROM public.analysis_requests WHERE id = $1 FOR UPDATE', [requestId]);
                const beforeLocked = await load();
                expect(beforeLocked).toMatchObject({ completed: 0, timeouts: count });

                await control.query(profileConsumerReadSql);
                const afterLocked = await load();
                expect(afterLocked).toMatchObject({ completed: count, timeouts: 0 });
                expect((await read(0)).rows[0].snapshot).toEqual(baseline);
                expect((await control.query('SELECT producer_claim_token = $1 AS unchanged FROM public.analysis_v2_candidate_feature_manifests', [replacementClaim])).rows).toEqual([{ unchanged: true }]);
                console.info('Profile checkpoint read load', { workers, readsPerWorker, before, beforeLocked, afterLocked });
            } finally {
                await locker.query('ROLLBACK');
                await control.query(profileConsumerReadSql);
            }
            await control.query(
                'SELECT public.analysis_v2_assert_result_job_fence($1,$2,$3,$4)',
                [requestId, consumerKey(0), claimToken, consumerHash],
            );
            expect((await control.query('SELECT producer_claim_token = $1 AS rebound FROM public.analysis_v2_candidate_feature_manifests', [claimToken])).rows).toEqual([{ rebound: true }]);
        }, 15_000);

        it('admits only one live retry generation while the common request row is locked', async () => {
            const values = [requestId, consumerKey(1)];
            const checkpoint = (await read(1)).rows[0].snapshot;
            await locker.query('BEGIN');
            try {
                // Simulate a real statement timeout on the remaining checkpoint storage boundary.
                await locker.query('LOCK TABLE public.analysis_v2_profile_fetch_outcomes IN ACCESS EXCLUSIVE MODE');
                await expect(read(1)).rejects.toMatchObject({ code: '57014' });
            } finally {
                await locker.query('ROLLBACK');
            }

            await locker.query('BEGIN');
            try {
                await locker.query('SELECT id FROM public.analysis_requests WHERE id = $1 FOR UPDATE', [requestId]);
                // Unrelated continuation reasons still use their existing write fence.
                await expect(defer(2, 'ANALYSIS_V2_AI_CAPACITY_PENDING')).rejects.toMatchObject({ code: '57014' });
                const attempts = await Promise.allSettled(readers.slice(2).map(client => client.query(
                    'SELECT * FROM public.continue_analysis_v2_scheduler_job($1,$2,$3,$4,$5,5)',
                    [...values, claimToken, dispatchToken, readTimeout],
                )));
                const admitted = attempts.filter(attempt => attempt.status === 'fulfilled');
                expect(admitted).toHaveLength(1);
                expect(admitted[0].value.rows).toMatchObject([{
                    reserved: true, dispatch_generation: 8, job_status: 'pending', dispatch_state: 'reserved', attempt_count: 6,
                }]);
                for (const attempt of attempts) {
                    if (attempt.status === 'rejected') {
                        expect(attempt.reason).toMatchObject({ message: 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH' });
                    }
                }
                await expect(read(1)).rejects.toMatchObject({ message: 'ANALYSIS_V2_RESULT_FENCE_MISMATCH' });
            } finally {
                await locker.query('ROLLBACK');
            }

            const pending = await control.query(
                `SELECT scheduler_not_before_at = dispatch_reserved_at + interval '5 seconds' AS delayed,
                        last_error_code, ai_capacity_deferral_count
                   FROM public.analysis_pipeline_jobs WHERE request_id = $1 AND job_key = $2`, values,
            );
            expect(pending.rows).toEqual([{ delayed: true, last_error_code: readTimeout, ai_capacity_deferral_count: 1 }]);
            // Model the delayed claim's token rotation and attempt increment, then verify the same stored result.
            await control.query(
                `UPDATE public.analysis_pipeline_jobs
                 SET status = 'processing', lease_token = $3, attempt_count = attempt_count + 1,
                     lease_expires_at = clock_timestamp() + interval '10 minutes'
                 WHERE request_id = $1 AND job_key = $2`, [...values, replacementClaim],
            );
            await expect(read(1)).rejects.toMatchObject({ message: 'ANALYSIS_V2_RESULT_FENCE_MISMATCH' });
            expect((await read(1, replacementClaim)).rows[0].snapshot).toEqual(checkpoint);
        });

        it('rejects stale claims and closed requests without reopening jobs, and honors the strict revenue guard', async () => {
            await expect(defer(3, readTimeout, replacementClaim))
                .rejects.toMatchObject({ message: 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH' });
            // A read concurrent with an uncommitted cancellation sees one consistent
            // active snapshot. After commit, both read and continuation reject it.
            await locker.query('BEGIN');
            try {
                await locker.query(
                    "UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1", [requestId],
                );
                expect((await read(3)).rows[0].snapshot.primaryResults).toHaveLength(30);
            } finally {
                await locker.query('COMMIT');
            }
            await expect(read(3)).rejects.toMatchObject({ message: 'ANALYSIS_V2_RESULT_NOT_READY' });
            await expect(defer(3)).rejects.toMatchObject({ message: 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH' });

            await control.query(
                "UPDATE public.analysis_requests SET status = 'processing', plan_access_mode_snapshot = 'test_entitlement' WHERE id = $1",
                [requestId],
            );
            await control.query(
                "INSERT INTO public.analysis_v2_provider_execution_policies VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1')",
                [requestId],
            );
            await expect(defer(3)).rejects.toMatchObject({ message: 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE' });
            const result = await control.query(
                'SELECT status, dispatch_generation, attempt_count FROM public.analysis_pipeline_jobs WHERE request_id = $1 AND job_key = $2',
                [requestId, consumerKey(3)],
            );
            expect(result.rows).toEqual([{ status: 'processing', dispatch_generation: 7, attempt_count: 7 }]);
        });
    },
);
