import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.SCORE_AUDIT_POSTGRES_TEST_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727032000_add_analysis_v2_score_audit.sql',
    import.meta.url,
), 'utf8');
const cleanupMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260901192353_fix_analysis_v2_score_audit_expiry_orphans.sql',
    import.meta.url,
), 'utf8');
const riskPolicyMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260726090000_add_risk_policy_v24.sql',
    import.meta.url,
), 'utf8');
const finalScoreCheckpointPayload =
    '{"riskPolicyVersion":"risk-policy-v2.4","candidates":[]}';
let first: Client;
let second: Client;
let barrier: Client;

const lockBarrierKey = 842_194_731_006;

describe('score-audit PostgreSQL fixture', () => {
    it('provides a structurally valid final-score checkpoint payload', () => {
        expect(JSON.parse(finalScoreCheckpointPayload)).toEqual({
            riskPolicyVersion: 'risk-policy-v2.4',
            candidates: [],
        });
    });
});

function functionDefinition(source: string, name: string, occurrence = 0): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    let start = -1;
    for (let index = 0; index <= occurrence; index += 1) {
        start = source.indexOf(marker, start + 1);
        if (start < 0) throw new Error(`Missing prerequisite ${name}`);
    }
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded prerequisite ${name}`);
    return source.slice(start, end + 4);
}

async function waitUntilLockBlocked(observer: Client, blockedPid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await observer.query<{ blocked: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_stat_activity
                WHERE pid = $1 AND wait_event_type = 'Lock'
             ) AS blocked`,
            [blockedPid],
        );
        if (state.rows[0]?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('POSTGRES_LOCK_BARRIER_TIMEOUT');
}

async function waitUntilBlockedBy(
    observer: Client,
    blockedPid: number,
    blockerPid: number,
): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await observer.query<{ blocked: boolean }>(
            'SELECT $2 = ANY(pg_catalog.pg_blocking_pids($1)) AS blocked',
            [blockedPid, blockerPid],
        );
        if (state.rows[0]?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('POSTGRES_LOCK_BLOCKER_TIMEOUT');
}

describePostgres('actual score-audit migration PostgreSQL lock order', () => {
    beforeAll(async () => {
        first = new Client({ connectionString: databaseUrl });
        second = new Client({ connectionString: databaseUrl });
        barrier = new Client({ connectionString: databaseUrl });
        await Promise.all([first.connect(), second.connect(), barrier.connect()]);
        await first.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
                    THEN CREATE ROLE anon NOLOGIN; END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                    THEN CREATE ROLE authenticated NOLOGIN; END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
                    THEN CREATE ROLE service_role NOLOGIN; END IF;
            END $$;
            CREATE SCHEMA IF NOT EXISTS extensions;
            CREATE OR REPLACE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid LANGUAGE sql VOLATILE AS $$
                SELECT pg_catalog.gen_random_uuid()
            $$;
            CREATE TABLE public.analysis_requests (
                id uuid PRIMARY KEY, status text NOT NULL,
                pipeline_version text NOT NULL, policy_versions_snapshot jsonb NOT NULL
            );
            CREATE TABLE public.analysis_v2_result_summaries (
                request_id uuid PRIMARY KEY, score_policy_version text NOT NULL,
                female_count smallint NOT NULL,
                created_at timestamptz NOT NULL DEFAULT clock_timestamp()
            );
            CREATE TABLE public.analysis_v2_female_results (
                request_id uuid NOT NULL, candidate_id text NOT NULL,
                sort_ordinal smallint NOT NULL, instagram_id text NOT NULL,
                display_score numeric NOT NULL, risk_band text NOT NULL,
                featured_rank smallint, PRIMARY KEY (request_id, candidate_id)
            );
            CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
                request_id uuid NOT NULL, stage_kind text NOT NULL,
                batch_key int NOT NULL, result_hash text NOT NULL, payload jsonb NOT NULL,
                item_count int GENERATED ALWAYS AS (
                    CASE WHEN jsonb_typeof(payload->'candidates') = 'array'
                         THEN jsonb_array_length(payload->'candidates') ELSE 0 END
                ) STORED, PRIMARY KEY (request_id, stage_kind, batch_key)
            );
            CREATE TABLE public.analysis_v2_candidate_feature_rows (
                request_id uuid NOT NULL, candidate_id text NOT NULL,
                full_name text, bio text, classification_source text NOT NULL,
                terminal_classification text NOT NULL,
                PRIMARY KEY (request_id, candidate_id)
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id uuid NOT NULL, job_key text NOT NULL, status text NOT NULL,
                input_hash text NOT NULL, completion_token uuid
            );
            CREATE TABLE public.analysis_v2_narrative_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_candidate_score_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_partner_safety_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_reverse_like_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_preliminary_score_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_private_name_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_candidate_feature_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_ai_result_checkpoints (request_id uuid);
            CREATE TABLE public.analysis_v2_profile_fetch_batches (request_id uuid);
            CREATE TABLE public.analysis_v2_target_evidence_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_relationship_manifests (request_id uuid);
            CREATE TABLE public.analysis_v2_relationship_sides (request_id uuid);
        `);
        await first.query(functionDefinition(
            riskPolicyMigration, 'analysis_v2_expected_relative_risk_rows', 0,
        ));
        await first.query(functionDefinition(
            riskPolicyMigration, 'analysis_v2_expected_relative_risk_rows_v23',
        ));
        await first.query(functionDefinition(
            riskPolicyMigration, 'analysis_v2_expected_relative_risk_rows', 1,
        ));
        await first.query(migration);
        await first.query(cleanupMigration);
    }, 30_000);

    afterAll(async () => {
        await Promise.all([first?.end(), second?.end(), barrier?.end()]);
    }, 30_000);

    it.each([['claim-first', false], ['purge-first', true]] as const)(
        '%s uses the actual migration without deadlock or stale rich evidence',
        async (_label, purgeFirst) => {
            const requestId = randomUUID();
            const resultHash = 'd'.repeat(64);
            await first.query(
                `INSERT INTO public.analysis_requests VALUES (
                    $1, 'completed', 'v2',
                    '{"risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'
                 )`,
                [requestId],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES (
                    $1, 'final_score', -1, $2,
                    '${finalScoreCheckpointPayload}',
                    DEFAULT
                 )`,
                [requestId, resultHash],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_result_summaries
                 VALUES ($1, 'risk-policy-v2.4', 0, clock_timestamp())`,
                [requestId],
            );
            await first.query(
                `UPDATE public.analysis_v2_score_audit_intents
                 SET retain_until = clock_timestamp() - interval '1 second'
                 WHERE request_id = $1`,
                [requestId],
            );
            const winner = purgeFirst ? second : first;
            const blocked = purgeFirst ? first : second;
            const blockedPid = await blocked.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            );
            await Promise.all([
                winner.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                              SET LOCAL statement_timeout = '10s'`),
                blocked.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                               SET LOCAL statement_timeout = '10s'`),
            ]);
            await winner.query(
                `SELECT 1 FROM public.analysis_v2_score_audit_intents
                 WHERE request_id = $1 FOR UPDATE`,
                [requestId],
            );
            if (purgeFirst) {
                const blockedClaim = blocked.query(
                    'SELECT public.claim_analysis_v2_score_audit($1)', [requestId],
                );
                await waitUntilLockBlocked(winner, blockedPid.rows[0]!.pid);
                await winner.query(
                    'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)',
                );
                await winner.query('COMMIT');
                await blockedClaim;
                await blocked.query('COMMIT');
            } else {
                const skipped = await blocked.query<{ count: number }>(
                    `SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)
                     AS count`,
                );
                expect(skipped.rows[0]?.count).toBe(0);
                await winner.query(
                    'SELECT public.claim_analysis_v2_score_audit($1)', [requestId],
                );
                await winner.query('COMMIT');
                await blocked.query('COMMIT');
            }
            await first.query(
                'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)',
            );
            const finalState = await first.query(
                `SELECT run.status, run.reason, run.source_result_hash,
                        run.source_generation, intent.intent_status,
                        locator.active AS locator_active,
                        (SELECT count(*)::int
                         FROM public.analysis_v2_ai_scoring_stage_checkpoints
                         WHERE request_id = $1) AS checkpoints
                 FROM public.analysis_v2_score_audit_runs AS run
                 JOIN public.analysis_v2_score_audit_intents AS intent
                   ON intent.request_id = run.request_id
                 JOIN public.analysis_v2_score_audit_scan_locators AS locator
                   ON locator.request_id = run.request_id
                 WHERE run.request_id = $1`,
                [requestId],
            );
            expect(finalState.rows[0]).toMatchObject({
                status: 'partial',
                reason: 'SOURCE_EVIDENCE_EXPIRED',
                source_result_hash: resultHash,
                source_generation: 1,
                intent_status: 'released',
                locator_active: false,
                checkpoints: 0,
            });
        },
        30_000,
    );

    it('does not deadlock exact expiry and working-set purges when they interleave', async () => {
        const requestId = randomUUID();
        const resultHash = 'e'.repeat(64);
        const triggerName = 'score_audit_test_wait_for_purge_barrier';
        const triggerFunction = 'score_audit_test_wait_for_purge_barrier';

        await barrier.query(`
            CREATE OR REPLACE FUNCTION public.${triggerFunction}()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                PERFORM pg_catalog.pg_advisory_xact_lock(${lockBarrierKey.toString()});
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER ${triggerName}
            BEFORE INSERT ON public.analysis_v2_score_audit_runs
            FOR EACH ROW EXECUTE FUNCTION public.${triggerFunction}();
        `);

        try {
            await first.query(
                `INSERT INTO public.analysis_requests VALUES (
                    $1, 'completed', 'v2',
                    '{"risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'
                 )`,
                [requestId],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES (
                    $1, 'final_score', -1, $2,
                    '${finalScoreCheckpointPayload}', DEFAULT
                 )`,
                [requestId, resultHash],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_result_summaries
                 VALUES ($1, 'risk-policy-v2.4', 0, clock_timestamp())`,
                [requestId],
            );
            await first.query(
                `UPDATE public.analysis_v2_score_audit_intents
                 SET retain_until = clock_timestamp() - interval '1 second'
                 WHERE request_id = $1`,
                [requestId],
            );

            await barrier.query('BEGIN');
            await barrier.query(
                'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
                [lockBarrierKey.toString()],
            );
            await Promise.all([
                first.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                             SET LOCAL statement_timeout = '8s';
                             SET LOCAL deadlock_timeout = '100ms'`),
                second.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                              SET LOCAL statement_timeout = '8s';
                              SET LOCAL deadlock_timeout = '100ms'`),
            ]);

            const purgePid = await first.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            );
            const workingSetPid = await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            );
            const purge = first.query(
                'SELECT public.purge_expired_analysis_v2_score_audit_evidence(100)',
            );
            await waitUntilLockBlocked(barrier, purgePid.rows[0]!.pid);
            const workingSet = second.query(
                'SELECT public.analysis_v2_purge_result_working_set($1, FALSE)',
                [requestId],
            );
            await waitUntilBlockedBy(
                barrier,
                workingSetPid.rows[0]!.pid,
                purgePid.rows[0]!.pid,
            );
            await barrier.query('COMMIT');

            const outcomes = await Promise.allSettled([
                purge.then(async result => {
                    await first.query('COMMIT');
                    return result;
                }).catch(async error => {
                    await first.query('ROLLBACK').catch(() => undefined);
                    throw error;
                }),
                workingSet.then(async result => {
                    await second.query('COMMIT');
                    return result;
                }).catch(async error => {
                    await second.query('ROLLBACK').catch(() => undefined);
                    throw error;
                }),
            ]);
            const outcomeDetails = outcomes.map(outcome => (
                outcome.status === 'fulfilled'
                    ? outcome.status
                    : `${outcome.status}: ${outcome.reason instanceof Error
                        ? `${outcome.reason.name}: ${outcome.reason.message}`
                        : String(outcome.reason)}`
            ));
            expect(outcomeDetails, outcomeDetails.join('; ')).toEqual([
                'fulfilled',
                'fulfilled',
            ]);
        } finally {
            await barrier.query('ROLLBACK').catch(() => undefined);
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            await barrier.query(`
                DROP TRIGGER IF EXISTS ${triggerName}
                    ON public.analysis_v2_score_audit_runs;
                DROP FUNCTION IF EXISTS public.${triggerFunction}();
            `).catch(() => undefined);
        }
    }, 30_000);

    it('does not deadlock claim and working-set cleanup when they interleave', async () => {
        const requestId = randomUUID();
        const resultHash = 'f'.repeat(64);
        const triggerName = 'score_audit_test_wait_for_claim_barrier';
        const triggerFunction = 'score_audit_test_wait_for_claim_barrier';

        await barrier.query(`
            CREATE OR REPLACE FUNCTION public.${triggerFunction}()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                PERFORM pg_catalog.pg_advisory_xact_lock(${lockBarrierKey.toString()});
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER ${triggerName}
            BEFORE INSERT ON public.analysis_v2_score_audit_runs
            FOR EACH ROW EXECUTE FUNCTION public.${triggerFunction}();
        `);

        try {
            await first.query(
                `INSERT INTO public.analysis_requests VALUES (
                    $1, 'completed', 'v2',
                    '{"risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'
                 )`,
                [requestId],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints
                 VALUES (
                    $1, 'final_score', -1, $2,
                    '${finalScoreCheckpointPayload}', DEFAULT
                 )`,
                [requestId, resultHash],
            );
            await first.query(
                `INSERT INTO public.analysis_v2_result_summaries
                 VALUES ($1, 'risk-policy-v2.4', 0, clock_timestamp())`,
                [requestId],
            );

            await barrier.query('BEGIN');
            await barrier.query(
                'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
                [lockBarrierKey.toString()],
            );
            await Promise.all([
                first.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                             SET LOCAL statement_timeout = '8s';
                             SET LOCAL deadlock_timeout = '100ms'`),
                second.query(`BEGIN; SET LOCAL lock_timeout = '5s';
                              SET LOCAL statement_timeout = '8s';
                              SET LOCAL deadlock_timeout = '100ms'`),
            ]);

            const claimPid = await first.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            );
            const workingSetPid = await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
            );
            const claim = first.query(
                'SELECT public.claim_analysis_v2_score_audit($1) AS result',
                [requestId],
            );
            await waitUntilLockBlocked(barrier, claimPid.rows[0]!.pid);
            const workingSet = second.query(
                'SELECT public.analysis_v2_purge_result_working_set($1, FALSE)',
                [requestId],
            );
            await waitUntilBlockedBy(
                barrier,
                workingSetPid.rows[0]!.pid,
                claimPid.rows[0]!.pid,
            );
            await barrier.query('COMMIT');

            const claimResult = await claim;
            expect(claimResult.rows[0]?.result).toMatchObject({
                leaseToken: expect.any(String),
                sourceResultHash: resultHash,
                sourceGeneration: 1,
            });
            await first.query('COMMIT');
            await workingSet;
            await second.query('COMMIT');

            const finalState = await first.query<{
                summary_present: boolean;
                run_present: boolean;
                checkpoint_count: number;
            }>(
                `SELECT EXISTS (
                            SELECT 1 FROM public.analysis_v2_result_summaries
                            WHERE request_id = $1
                        ) AS summary_present,
                        EXISTS (
                            SELECT 1 FROM public.analysis_v2_score_audit_runs
                            WHERE request_id = $1
                        ) AS run_present,
                        (SELECT count(*)::int
                         FROM public.analysis_v2_ai_scoring_stage_checkpoints
                         WHERE request_id = $1) AS checkpoint_count`,
                [requestId],
            );
            expect(finalState.rows[0]).toEqual({
                summary_present: false,
                run_present: false,
                checkpoint_count: 0,
            });
        } finally {
            await barrier.query('ROLLBACK').catch(() => undefined);
            await first.query('ROLLBACK').catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            await barrier.query(`
                DROP TRIGGER IF EXISTS ${triggerName}
                    ON public.analysis_v2_score_audit_runs;
                DROP FUNCTION IF EXISTS public.${triggerFunction}();
            `).catch(() => undefined);
        }
    }, 30_000);
});
