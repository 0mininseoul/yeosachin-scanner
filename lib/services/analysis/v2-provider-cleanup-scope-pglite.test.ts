import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260830103000_scope_analysis_v2_provider_cleanup.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const FAILED_JOB = 'profile-batch:failed';
const UNRELATED_JOB = 'profile-batch:unrelated';
const FAILED_JOB_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROVIDER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLAIM_TOKEN = '223e4567-e89b-42d3-a456-426614174000';
const FAILED_RESERVATION = '323e4567-e89b-42d3-a456-426614174000';
const UNRELATED_RESERVATION = '423e4567-e89b-42d3-a456-426614174000';
const FAILED_OPERATION = 'target-profile:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNRELATED_OPERATION = 'target-profile:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const PGLITE_TEST_TIMEOUT_MS = 30_000;
const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;

        CREATE TABLE public.analysis_pipeline_jobs (
            request_id UUID NOT NULL,
            job_key TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'processing',
            lease_token UUID,
            lease_expires_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (request_id, job_key)
        );
        CREATE TABLE public.analysis_v2_provider_cleanup_intents (
            request_id UUID PRIMARY KEY,
            failed_job_key TEXT NOT NULL,
            failed_job_input_hash TEXT NOT NULL,
            failed_claim_token UUID NOT NULL,
            error_code TEXT NOT NULL,
            completed_at TIMESTAMP WITH TIME ZONE
        );
        CREATE TABLE public.analysis_v2_provider_runs (
            request_id UUID NOT NULL,
            job_key TEXT NOT NULL,
            operation_key TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            job_claim_token UUID NOT NULL,
            reservation_token UUID NOT NULL,
            logical_provider TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            credential_slot TEXT NOT NULL,
            max_charge_usd NUMERIC NOT NULL,
            status TEXT NOT NULL DEFAULT 'starting',
            run_id TEXT,
            actual_usage_usd NUMERIC,
            reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
            run_started_at TIMESTAMP WITH TIME ZONE,
            terminalized_at TIMESTAMP WITH TIME ZONE,
            usage_reconciled_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY (request_id, job_key, operation_key),
            UNIQUE (reservation_token)
        );
        CREATE FUNCTION public.analysis_v2_provider_run_json(
            p_run public.analysis_v2_provider_runs
        ) RETURNS JSONB LANGUAGE sql STABLE AS $$
            SELECT pg_catalog.jsonb_build_object(
                'requestId', p_run.request_id,
                'jobKey', p_run.job_key,
                'operationKey', p_run.operation_key,
                'inputHash', p_run.input_hash,
                'reservationToken', p_run.reservation_token,
                'status', p_run.status,
                'runId', p_run.run_id
            )
        $$;

        CREATE FUNCTION public.analysis_v2_reserve_provider_run_internal(
            p_request_id UUID,
            p_job_key TEXT,
            p_claim_token UUID,
            p_operation_key TEXT,
            p_input_hash TEXT,
            p_logical_provider TEXT,
            p_actor_id TEXT,
            p_credential_slot TEXT,
            p_max_charge_usd NUMERIC,
            p_reservation_token UUID
        ) RETURNS JSONB LANGUAGE plpgsql AS $$
        DECLARE
            v_run public.analysis_v2_provider_runs;
        BEGIN
            INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd
            ) VALUES (
                p_request_id, p_job_key, p_operation_key, p_input_hash, p_claim_token,
                p_reservation_token, p_logical_provider, p_actor_id, p_credential_slot,
                p_max_charge_usd
            ) RETURNING * INTO v_run;
            RETURN pg_catalog.jsonb_build_object(
                'created', TRUE,
                'run', public.analysis_v2_provider_run_json(v_run)
            );
        END;
        $$;

        CREATE FUNCTION public.reserve_analysis_v2_provider_run(
            UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
        ) RETURNS JSONB LANGUAGE plpgsql AS $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM public.analysis_v2_provider_cleanup_intents AS intent
                WHERE intent.request_id = $1
                  AND intent.completed_at IS NULL
            ) THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
                    ERRCODE = 'P0001';
            END IF;
            RETURN public.analysis_v2_reserve_provider_run_internal(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            );
        END;
        $$;
        CREATE FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
            UUID, INTEGER
        ) RETURNS JSONB LANGUAGE plpgsql AS $$
        DECLARE
            v_starting_count INTEGER;
            v_runs JSONB;
        BEGIN
            SELECT pg_catalog.count(*)::INTEGER INTO v_starting_count
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = $1
              AND provider_run.status = 'starting'
              AND EXISTS (
                  SELECT 1
                  FROM public.analysis_v2_provider_cleanup_intents AS intent
                  WHERE intent.request_id = provider_run.request_id
                    AND intent.completed_at IS NULL
              );
            SELECT COALESCE(
                pg_catalog.jsonb_agg(
                    public.analysis_v2_provider_run_json(candidate)
                    ORDER BY candidate.job_key, candidate.operation_key
                ),
                '[]'::JSONB
            ) INTO v_runs
            FROM (
                SELECT provider_run.*
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = $1
                  AND provider_run.status = 'running'
                  AND EXISTS (
                      SELECT 1
                      FROM public.analysis_v2_provider_cleanup_intents AS intent
                      WHERE intent.request_id = provider_run.request_id
                        AND intent.completed_at IS NULL
                  )
                LIMIT $2
            ) AS candidate;
            RETURN pg_catalog.jsonb_build_object(
                'startingCount', v_starting_count,
                'runs', v_runs
            );
        END;
        $$;
        CREATE FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
            UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
        ) RETURNS JSONB LANGUAGE plpgsql AS $$
        DECLARE
            v_run public.analysis_v2_provider_runs;
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_provider_cleanup_intents AS intent
                WHERE intent.request_id = (
                    SELECT provider_run.request_id
                    FROM public.analysis_v2_provider_runs AS provider_run
                    WHERE provider_run.reservation_token = $1
                )
                  AND intent.completed_at IS NULL
            ) THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY',
                    ERRCODE = 'P0001';
            END IF;
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET status = $7,
                run_id = $2,
                actual_usage_usd = $8,
                terminalized_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE provider_run.reservation_token = $1
            RETURNING * INTO v_run;
            RETURN public.analysis_v2_provider_run_json(v_run);
        END;
        $$;
    `);

    await db.exec(migration);
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(
            request_id, job_key, input_hash, lease_token, lease_expires_at
         ) VALUES
            ($1, $2, $3, $4, clock_timestamp() + INTERVAL '10 minutes'),
            ($1, $5, $6, $4, clock_timestamp() + INTERVAL '10 minutes')`,
        [
            REQUEST_ID,
            FAILED_JOB,
            FAILED_JOB_HASH,
            CLAIM_TOKEN,
            UNRELATED_JOB,
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ],
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_cleanup_intents(
            request_id, failed_job_key, failed_job_input_hash, failed_claim_token,
            error_code
         ) VALUES ($1, $2, $3, $4, 'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR')`,
        [REQUEST_ID, FAILED_JOB, FAILED_JOB_HASH, CLAIM_TOKEN],
    );
    return db;
}

async function seedActiveRuns(db: PGlite): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
            request_id, job_key, operation_key, input_hash, job_claim_token,
            reservation_token, logical_provider, actor_id, credential_slot,
            max_charge_usd, status, run_id, run_started_at
         ) VALUES
            ($1, $2, $3, $4, $5, $6, 'apify', 'actor-profile', 'primary',
             0.01, 'running', 'FailedRun1', clock_timestamp()),
            ($1, $7, $8, $4, $5, $9, 'apify', 'actor-profile', 'primary',
             0.01, 'running', 'Unrelated1', clock_timestamp())`,
        [
            REQUEST_ID,
            FAILED_JOB,
            FAILED_OPERATION,
            PROVIDER_HASH,
            CLAIM_TOKEN,
            FAILED_RESERVATION,
            UNRELATED_JOB,
            UNRELATED_OPERATION,
            UNRELATED_RESERVATION,
        ],
    );
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('analysis V2 provider cleanup scope migration', () => {
    it('keeps request-wide provider safety and exact job admission when hash domains differ', async () => {
        const db = await createDatabase();

        const exactFailedIntent = await db.query<{
            load_analysis_v2_provider_run_cleanup_intent_for_job: {
                requestId: string;
                jobKey: string;
                jobInputHash: string;
                errorCode: string;
            } | null;
        }>(
            `SELECT public.load_analysis_v2_provider_run_cleanup_intent_for_job(
                $1, $2, $3
             )`,
            [REQUEST_ID, FAILED_JOB, FAILED_JOB_HASH],
        );
        expect(exactFailedIntent.rows[0]
            ?.load_analysis_v2_provider_run_cleanup_intent_for_job)
            .toMatchObject({
                requestId: REQUEST_ID,
                jobKey: FAILED_JOB,
                jobInputHash: FAILED_JOB_HASH,
                errorCode: 'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR',
            });

        const providerHashIsNotAJobFence = await db.query<{
            load_analysis_v2_provider_run_cleanup_intent_for_job: {
                requestId: string;
                jobKey: string;
                jobInputHash: string;
                errorCode: string;
            } | null;
        }>(
            `SELECT public.load_analysis_v2_provider_run_cleanup_intent_for_job(
                $1, $2, $3
             )`,
            [REQUEST_ID, FAILED_JOB, PROVIDER_HASH],
        );
        expect(providerHashIsNotAJobFence.rows[0]
            ?.load_analysis_v2_provider_run_cleanup_intent_for_job)
            .toBeNull();

        const unrelatedIntent = await db.query<{
            load_analysis_v2_provider_run_cleanup_intent_for_job: {
                requestId: string;
                jobKey: string;
                jobInputHash: string;
                errorCode: string;
            } | null;
        }>(
            `SELECT public.load_analysis_v2_provider_run_cleanup_intent_for_job(
                $1, $2, $3
             )`,
            [
                REQUEST_ID,
                UNRELATED_JOB,
                'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            ],
        );
        expect(unrelatedIntent.rows[0]
            ?.load_analysis_v2_provider_run_cleanup_intent_for_job)
            .toBeNull();

        await expect(db.query(
            `SELECT public.reserve_analysis_v2_provider_run(
                $1, $2, $3, $4, $5, 'apify', 'actor-profile', 'primary', 0.01, $6
             )`,
            [
                REQUEST_ID,
                FAILED_JOB,
                CLAIM_TOKEN,
                FAILED_OPERATION,
                PROVIDER_HASH,
                '623e4567-e89b-42d3-a456-426614174000',
            ],
        )).rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED/);

        await expect(db.query(
            `SELECT public.reserve_analysis_v2_provider_run(
                $1, $2, $3, $4, $5, 'apify', 'actor-profile', 'primary', 0.01, $6
             )`,
            [
                REQUEST_ID,
                UNRELATED_JOB,
                CLAIM_TOKEN,
                UNRELATED_OPERATION,
                PROVIDER_HASH,
                UNRELATED_RESERVATION,
            ],
        )).rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED/);

        await seedActiveRuns(db);
        const active = await db.query<{
            list_analysis_v2_active_provider_runs_for_cleanup: {
                startingCount: number;
                runs: Array<{ jobKey: string }>;
            };
        }>(
            `SELECT public.list_analysis_v2_active_provider_runs_for_cleanup($1, 64)`,
            [REQUEST_ID],
        );
        const activePayload = active.rows[0]?.list_analysis_v2_active_provider_runs_for_cleanup;
        expect(activePayload?.startingCount).toBe(0);
        expect(activePayload?.runs.map(run => run.jobKey).sort())
            .toEqual([FAILED_JOB, UNRELATED_JOB].sort());

        const settled = await db.query<{ settle_analysis_v2_provider_run_for_cleanup: {
            status: string;
            runId: string;
        } }>(
            `SELECT public.settle_analysis_v2_provider_run_for_cleanup(
                $1, 'FailedRun1', 'apify', 'actor-profile', 'primary',
                0.01, 'succeeded', 0.01
             )`,
            [FAILED_RESERVATION],
        );
        expect(settled.rows[0]?.settle_analysis_v2_provider_run_for_cleanup).toMatchObject({
            status: 'succeeded',
            runId: 'FailedRun1',
        });
    }, PGLITE_TEST_TIMEOUT_MS);
});
