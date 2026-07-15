import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260715175739_defer_analysis_v2_terminal_cleanup.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const SIBLING_CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';
const OTHER_CLAIM_TOKEN = '55555555-5555-4555-8555-555555555555';
const OWNER_JOB_KEY = 'track:relationships';
const SIBLING_JOB_KEY = 'track:target-evidence';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    consumed_request_id UUID UNIQUE
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID PRIMARY KEY,
    completed_at TIMESTAMP WITH TIME ZONE
);
`;

interface DeferRow {
    released: boolean;
    job_status: string;
    attempt_count: number;
    request_status: string;
}

interface JobRow {
    job_key: string;
    status: string;
    lease_token: string | null;
    lease_expires_at: string | null;
    attempt_count: number;
    last_error_code: string | null;
}

let db: PGlite;

async function serviceQuery<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function deferCleanup(
    jobKey: string,
    claimToken: string
): Promise<Results<DeferRow>> {
    return serviceQuery<DeferRow>(
        'SELECT * FROM public.defer_analysis_v2_terminal_cleanup($1, $2, $3)',
        [REQUEST_ID, jobKey, claimToken]
    );
}

async function seedScope(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (id, pipeline_version, status)
         VALUES ($1, 'v2', 'processing')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (id, consumed_request_id)
         VALUES ($1, $2)`,
        [PREFLIGHT_ID, REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_cleanup_intents (request_id)
         VALUES ($1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, lease_token, lease_expires_at, attempt_count
         ) VALUES
         ($1, $2, 'processing', $3,
          pg_catalog.clock_timestamp() + INTERVAL '5 minutes', 7),
         ($1, $4, 'processing', $5,
          pg_catalog.clock_timestamp() + INTERVAL '5 minutes', 3)`,
        [
            REQUEST_ID,
            OWNER_JOB_KEY,
            OWNER_CLAIM_TOKEN,
            SIBLING_JOB_KEY,
            SIBLING_CLAIM_TOKEN,
        ]
    );
}

describe('analysis V2 terminal cleanup defer PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_provider_cleanup_intents,
                public.analysis_pipeline_jobs,
                public.analysis_preflights,
                public.analysis_requests
        `);
        await seedScope();
    });

    afterAll(async () => {
        await db.close();
    });

    it('defers both the failed owner and sibling without consuming attempts', async () => {
        await expect(deferCleanup(OWNER_JOB_KEY, OWNER_CLAIM_TOKEN)).resolves.toMatchObject({
            rows: [{
                released: true,
                job_status: 'pending',
                attempt_count: 7,
                request_status: 'processing',
            }],
        });
        await expect(deferCleanup(SIBLING_JOB_KEY, SIBLING_CLAIM_TOKEN)).resolves.toMatchObject({
            rows: [{
                released: true,
                job_status: 'pending',
                attempt_count: 3,
                request_status: 'processing',
            }],
        });

        const jobs = await db.query<JobRow>(
            `SELECT job_key, status, lease_token, lease_expires_at,
                    attempt_count, last_error_code
             FROM public.analysis_pipeline_jobs
             ORDER BY job_key`
        );
        expect(jobs.rows).toEqual([
            {
                job_key: OWNER_JOB_KEY,
                status: 'pending',
                lease_token: null,
                lease_expires_at: null,
                attempt_count: 7,
                last_error_code: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
            },
            {
                job_key: SIBLING_JOB_KEY,
                status: 'pending',
                lease_token: null,
                lease_expires_at: null,
                attempt_count: 3,
                last_error_code: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
            },
        ]);
    });

    it('fails closed when cleanup intent is missing or already completed', async () => {
        await db.query(
            'DELETE FROM public.analysis_v2_provider_cleanup_intents WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(deferCleanup(OWNER_JOB_KEY, OWNER_CLAIM_TOKEN)).rejects.toThrow(
            /ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY/
        );

        await db.query(
            `INSERT INTO public.analysis_v2_provider_cleanup_intents (request_id, completed_at)
             VALUES ($1, pg_catalog.clock_timestamp())`,
            [REQUEST_ID]
        );
        await expect(deferCleanup(OWNER_JOB_KEY, OWNER_CLAIM_TOKEN)).rejects.toThrow(
            /ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY/
        );
    });

    it('fails closed on an inactive request or stale claim fence', async () => {
        await expect(deferCleanup(OWNER_JOB_KEY, OTHER_CLAIM_TOKEN)).rejects.toThrow(
            /ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH/
        );
        await db.query(
            "UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1",
            [REQUEST_ID]
        );
        await expect(deferCleanup(OWNER_JOB_KEY, OWNER_CLAIM_TOKEN)).rejects.toThrow(
            /ANALYSIS_V2_TERMINAL_CLEANUP_DEFER_NOT_READY/
        );
    });

    it('denies authenticated callers', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                'SELECT * FROM public.defer_analysis_v2_terminal_cleanup($1, $2, $3)',
                [REQUEST_ID, OWNER_JOB_KEY, OWNER_CLAIM_TOKEN]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
