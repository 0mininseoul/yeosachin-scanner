import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260830102000_add_analysis_v2_terminal_failure_takeover.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const DISPATCH_TOKEN = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';
const RETRY_CLAIM_TOKEN = '55555555-5555-4555-8555-555555555555';
const OTHER_RETRY_CLAIM_TOKEN = '66666666-6666-4666-8666-666666666666';
const RESERVATION_TOKEN = '77777777-7777-4777-8777-777777777777';
const JOB_KEY = 'track:profiles:batch:0';
const INPUT_HASH = 'a'.repeat(64);

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
    dispatch_generation INTEGER NOT NULL,
    dispatch_reservation_token UUID NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    track TEXT NOT NULL,
    kind TEXT NOT NULL,
    batch INTEGER,
    input_hash TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID PRIMARY KEY,
    failed_job_key TEXT NOT NULL,
    failed_job_input_hash TEXT NOT NULL,
    failed_claim_token UUID NOT NULL,
    error_code TEXT NOT NULL,
    completed_at TIMESTAMPTZ,
    terminalization_takeover_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    reservation_token UUID PRIMARY KEY,
    status TEXT NOT NULL,
    run_id TEXT
);
CREATE TABLE public.analysis_v2_unconfirmed_start_resolutions (
    reservation_token UUID PRIMARY KEY
);

CREATE FUNCTION public.fail_analysis_v2_request_from_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE public.analysis_pipeline_jobs
    SET status = 'failed'
    WHERE request_id = p_request_id AND job_key = p_job_key;
    UPDATE public.analysis_requests
    SET status = 'failed'
    WHERE id = p_request_id;
END;
$$;

-- Minimal predecessor used to prove that the additive migration patches the
-- historical max-attempt terminalization branch before the takeover tests run.
CREATE FUNCTION public.claim_analysis_v2_job_unfenced_20260811(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120,
    p_max_attempts INTEGER DEFAULT 7
)
RETURNS TABLE(
    claimed BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    lease_expires_at TIMESTAMPTZ,
    track TEXT,
    job_kind TEXT,
    batch INTEGER,
    input_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;

    IF v_job.attempt_count >= p_max_attempts THEN
        PERFORM public.fail_analysis_v2_request_from_job(
            p_request_id,
            p_job_key,
            'JOB_ATTEMPTS_EXHAUSTED'
        );
        SELECT job.* INTO v_job
        FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_request_id AND job.job_key = p_job_key;
        RETURN QUERY SELECT
            FALSE,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_job.lease_expires_at,
            v_job.track::TEXT,
            v_job.kind::TEXT,
            v_job.batch,
            v_job.input_hash::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        v_job.status::TEXT,
        v_job.attempt_count,
        v_job.lease_expires_at,
        v_job.track::TEXT,
        v_job.kind::TEXT,
        v_job.batch,
        v_job.input_hash::TEXT;
END;
$$;

CREATE FUNCTION public.claim_analysis_v2_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120,
    p_max_attempts INTEGER DEFAULT 7
)
RETURNS TABLE(
    claimed BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    lease_expires_at TIMESTAMPTZ,
    track TEXT,
    job_kind TEXT,
    batch INTEGER,
    input_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.claim_analysis_v2_job_unfenced_20260811(
        p_request_id,
        p_job_key,
        p_dispatch_generation,
        p_dispatch_token,
        p_claim_token,
        p_lease_seconds,
        p_max_attempts
    );
END;
$$;
`;

let db: PGlite;

async function serviceQuery<T>(sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function takeover(claimToken: string) {
    return serviceQuery<{
        claimed: boolean;
        job_status: string;
        attempt_count: number;
    }>(
        `SELECT claimed, job_status, attempt_count
         FROM public.takeover_analysis_v2_terminal_failure(
            $1::uuid, $2::text, $3::integer, $4::uuid, $5::uuid, $6::integer
         )`,
        [REQUEST_ID, JOB_KEY, 1, DISPATCH_TOKEN, claimToken, 600],
    );
}

async function claimAfterLeaseExpiry() {
    return serviceQuery<{
        claimed: boolean;
        job_status: string;
        attempt_count: number;
    }>(
        `SELECT claimed, job_status, attempt_count
         FROM public.claim_analysis_v2_job(
            $1::uuid, $2::text, $3::integer, $4::uuid, $5::uuid, $6::integer, $7::integer
         )`,
        [REQUEST_ID, JOB_KEY, 1, DISPATCH_TOKEN, RETRY_CLAIM_TOKEN, 600, 2],
    );
}

async function seed(): Promise<void> {
    await db.exec(`
        INSERT INTO public.analysis_requests(id, pipeline_version, status)
        VALUES ('${REQUEST_ID}', 'v2', 'processing');
        INSERT INTO public.analysis_preflights(id, consumed_request_id)
        VALUES ('${PREFLIGHT_ID}', '${REQUEST_ID}');
        INSERT INTO public.analysis_pipeline_jobs(
            request_id, job_key, status, dispatch_generation,
            dispatch_reservation_token, lease_token, lease_expires_at,
            track, kind, batch, input_hash, attempt_count
        ) VALUES (
            '${REQUEST_ID}', '${JOB_KEY}', 'processing', 1,
            '${DISPATCH_TOKEN}', '${ORIGINAL_CLAIM_TOKEN}',
            clock_timestamp() + interval '10 minutes',
            'profiles', 'profile_fetch', 0, '${INPUT_HASH}', 2
        );
        INSERT INTO public.analysis_v2_provider_cleanup_intents(
            request_id, failed_job_key, failed_job_input_hash,
            failed_claim_token, error_code
        ) VALUES (
            '${REQUEST_ID}', '${JOB_KEY}', '${INPUT_HASH}',
            '${ORIGINAL_CLAIM_TOKEN}', 'JOB_ATTEMPTS_EXHAUSTED'
        );
    `);
}

describe('terminal failure intent takeover crash window', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE public.analysis_v2_unconfirmed_start_resolutions,
            public.analysis_v2_provider_runs,
            public.analysis_v2_provider_cleanup_intents,
            public.analysis_pipeline_jobs,
            public.analysis_preflights,
            public.analysis_requests`);
        await seed();
    });

    afterAll(async () => { await db.close(); });

    it('takes over immediately when the intent owns a crash-window job and no provider is active', async () => {
        const first = await takeover(RETRY_CLAIM_TOKEN);
        expect(first.rows).toEqual([{
            claimed: true,
            job_status: 'processing',
            attempt_count: 2,
        }]);

        // Duplicate delivery with the same current owner is idempotent.
        await expect(takeover(RETRY_CLAIM_TOKEN)).resolves.toEqual(first);

        const owner = await db.query<{ lease_token: string; failed_claim_token: string }>(
            `SELECT job.lease_token::text,
                    intent.failed_claim_token::text
             FROM public.analysis_pipeline_jobs AS job
             JOIN public.analysis_v2_provider_cleanup_intents AS intent
               ON intent.request_id = job.request_id
             WHERE job.request_id = $1 AND job.job_key = $2`,
            [REQUEST_ID, JOB_KEY],
        );
        expect(owner.rows[0]).toEqual({
            lease_token: RETRY_CLAIM_TOKEN,
            failed_claim_token: RETRY_CLAIM_TOKEN,
        });
    });

    it('keeps an expired max-attempt job resumable until the intent finalizer takes ownership', async () => {
        await db.exec(`
            UPDATE public.analysis_pipeline_jobs
            SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE request_id = '${REQUEST_ID}' AND job_key = '${JOB_KEY}'
        `);

        // The historical claim branch must not fail the request merely because
        // the original owner's lease has expired.
        const claim = await claimAfterLeaseExpiry();
        expect(claim.rows).toEqual([
            { claimed: false, job_status: 'processing', attempt_count: 2 },
        ]);
        const request = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_requests WHERE id = $1',
            [REQUEST_ID],
        );
        expect(request.rows).toEqual([{ status: 'processing' }]);

        const resumed = await takeover(RETRY_CLAIM_TOKEN);
        expect(resumed.rows).toEqual([
            { claimed: true, job_status: 'processing', attempt_count: 2 },
        ]);
    });

    it('keeps one current failure owner under concurrent takeover attempts', async () => {
        const results = await Promise.allSettled([
            takeover(RETRY_CLAIM_TOKEN),
            takeover(OTHER_RETRY_CLAIM_TOKEN),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        const owner = await db.query<{ lease_token: string; failed_claim_token: string }>(
            `SELECT job.lease_token::text, intent.failed_claim_token::text
             FROM public.analysis_pipeline_jobs AS job
             JOIN public.analysis_v2_provider_cleanup_intents AS intent
               ON intent.request_id = job.request_id
             WHERE job.request_id = $1 AND job.job_key = $2`,
            [REQUEST_ID, JOB_KEY],
        );
        expect(owner.rows[0]?.lease_token).toBe(owner.rows[0]?.failed_claim_token);
    });

    it('fails closed while a running or unconfirmed provider row remains', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, reservation_token, status, run_id
             ) VALUES ($1, $2, 'profile-fallback:abc', $3, 'running', 'remote-run')`,
            [REQUEST_ID, JOB_KEY, RESERVATION_TOKEN],
        );
        await expect(takeover(RETRY_CLAIM_TOKEN)).rejects.toThrow(
            'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_ACTIVE_PROVIDER'
        );

        await db.query('DELETE FROM public.analysis_v2_provider_runs');
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, reservation_token, status
             ) VALUES ($1, $2, 'profile-fallback:def', $3, 'starting')`,
            [REQUEST_ID, JOB_KEY, RESERVATION_TOKEN],
        );
        await expect(takeover(RETRY_CLAIM_TOKEN)).rejects.toThrow(
            'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_ACTIVE_PROVIDER'
        );
    });
});
