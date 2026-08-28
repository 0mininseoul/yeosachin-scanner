import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

// This is intentionally the complete forward migration under test, not a
// hand-copied fragment: every accept/reject case below exercises the exact
// SQL this PR ships.
const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260829110000_admit_bounded_direct_fresh_apify_consumer.sql',
        import.meta.url
    ),
    'utf8'
);

const HASH = (seed: string): string => seed.repeat(64).slice(0, 64);
const CONSUMER_INPUT_HASH = HASH('a');
const PRODUCER_INPUT_HASH = HASH('b');
const PRIMARY_PAYLOAD_HASH = HASH('c');
const FALLBACK_PAYLOAD_HASH = HASH('d');
const REPAIR_PAYLOAD_HASH = HASH('e');

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '20000000-0000-4000-8000-000000000001';
const PRODUCER_JOB_KEY = 'track:profiles:batch:0';
const CONSUMER_JOB_KEY = 'track:profile-ai:batch:0';

// Every fence/consumer path this RPC also serves (assert_result_job_fence's
// candidate-feature/preliminary-score/reverse-like/partner-safety/candidate-
// score/private-name/narrative manifest bookkeeping) is a minimal, real-
// shaped stand-in for the analysis-v2 working-set tables so the exact
// production fence function runs unmodified, not a stub.
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
    consumed_request_id UUID
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    input_hash TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    track TEXT,
    kind TEXT,
    batch INTEGER,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_candidate_feature_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_preliminary_score_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_reverse_like_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_partner_safety_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_private_name_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);
CREATE TABLE public.analysis_v2_narrative_manifests (
    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT, producer_claim_token UUID
);

CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    requested_usernames TEXT[] NOT NULL,
    frozen_unresolved_usernames TEXT[] NOT NULL,
    primary_payload_hash TEXT NOT NULL,
    primary_completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fallback_payload_hash TEXT,
    fallback_completed_at TIMESTAMPTZ,
    repair_usernames TEXT[],
    repair_payload_hash TEXT,
    repair_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT batches_fallback_pair_check CHECK (
        (fallback_payload_hash IS NULL AND fallback_completed_at IS NULL)
        OR (fallback_payload_hash IS NOT NULL AND fallback_completed_at IS NOT NULL)
    ),
    CONSTRAINT batches_repair_pair_check CHECK (
        (repair_usernames IS NULL AND repair_payload_hash IS NULL AND repair_completed_at IS NULL)
        OR (repair_usernames IS NOT NULL AND repair_payload_hash IS NOT NULL AND repair_completed_at IS NOT NULL)
    )
);
CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    attempt TEXT NOT NULL,
    ordinal SMALLINT NOT NULL,
    username TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_category TEXT,
    http_status SMALLINT,
    request_count SMALLINT NOT NULL DEFAULT 1,
    latency_ms INTEGER NOT NULL DEFAULT 100,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    profile_snapshot JSONB,
    PRIMARY KEY (request_id, job_key, attempt, username),
    UNIQUE (request_id, job_key, attempt, ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_profile_fetch_batches(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT outcomes_ordinal_check CHECK (ordinal BETWEEN 1 AND 30),
    CONSTRAINT outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback', 'repair', 'fresh_apify')
    ),
    CONSTRAINT outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt IN ('fallback', 'repair', 'fresh_apify') AND source = 'apify')
    ),
    CONSTRAINT outcomes_status_check CHECK (status IN ('success', 'unavailable', 'failed')),
    CONSTRAINT outcomes_result_check CHECK (
        (status = 'success' AND failure_category IS NULL AND profile_snapshot IS NOT NULL)
        OR (status = 'unavailable' AND failure_category IN ('not_found', 'empty_user')
            AND profile_snapshot IS NULL)
        OR (status = 'failed' AND failure_category IN (
                'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                'transport', 'http', 'unknown'
            ) AND profile_snapshot IS NULL)
    )
);

-- Byte-for-byte the production fence (20260713213000_harden_analysis_v2_
-- result_runtime_boundary.sql), against the minimal manifest stand-ins above.
CREATE OR REPLACE FUNCTION public.analysis_v2_assert_result_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS public.analysis_pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_candidate_feature_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_preliminary_score_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_reverse_like_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_partner_safety_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_candidate_score_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_private_name_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_narrative_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;

    RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_assert_result_job_fence(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- Byte-for-byte the production snapshot (20260811090000_harden_fresh_
-- provenance.sql): fresh_apify outcomes stand in for 'primaryResults'
-- whenever any exist for the batch, exactly like the real function.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', batch.request_id,
        'jobKey', batch.job_key,
        'requestedUsernames', pg_catalog.to_jsonb(batch.requested_usernames),
        'frozenUnresolvedUsernames',
            pg_catalog.to_jsonb(batch.frozen_unresolved_usernames),
        'primaryResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = CASE WHEN EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_outcomes AS fresh_outcome
                    WHERE fresh_outcome.request_id = batch.request_id
                      AND fresh_outcome.job_key = batch.job_key
                      AND fresh_outcome.attempt = 'fresh_apify'
                ) THEN 'fresh_apify' ELSE 'primary' END
        ), '[]'::JSONB),
        'fallbackResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'fallback'
        ), '[]'::JSONB),
        'repairResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'repair'
        ), '[]'::JSONB),
        'primaryCapturedAt', batch.primary_completed_at,
        'fallbackCapturedAt', batch.fallback_completed_at,
        'repairUsernames', pg_catalog.to_jsonb(batch.repair_usernames),
        'repairCapturedAt', batch.repair_completed_at
    )
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_profile_checkpoint_snapshot(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
`;

const databases: PGlite[] = [];

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(migration);
    return db;
}

afterEach(async () => {
    while (databases.length > 0) {
        const db = databases.pop();
        await db?.close();
    }
});

async function asService<T>(db: PGlite, sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

function usernames(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `user${String(i + 1).padStart(3, '0')}`);
}

type OutcomeRow = {
    ordinal: number;
    username: string;
    attempt?: string;
    source?: string;
    status: 'success' | 'unavailable' | 'failed';
    failureCategory?: string | null;
};

async function seedRequestAndJobs(
    db: PGlite,
    options: { producerStatus?: string } = {}
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests(id, pipeline_version, status)
         VALUES ($1, 'v2', 'processing')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights(id, consumed_request_id)
         VALUES (pg_catalog.gen_random_uuid(), $1)`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(
             request_id, job_key, status, input_hash, lease_token, lease_expires_at,
             track, kind, batch
         ) VALUES
             ($1, $2, $3, $4, NULL, NULL, 'profiles', 'profile_fetch', 0),
             ($1, $5, 'processing', $6, $7, clock_timestamp() + interval '10 minutes',
              'profile_ai', 'ai', 0)`,
        [
            REQUEST_ID, PRODUCER_JOB_KEY, options.producerStatus ?? 'completed',
            PRODUCER_INPUT_HASH, CONSUMER_JOB_KEY, CONSUMER_INPUT_HASH, CLAIM_TOKEN,
        ]
    );
}

async function seedBatch(
    db: PGlite,
    options: {
        requestedUsernames: string[];
        frozenUnresolvedUsernames: string[];
        outcomes: OutcomeRow[];
        fallback?: boolean;
        repair?: boolean;
    }
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_profile_fetch_batches(
             request_id, job_key, requested_usernames, frozen_unresolved_usernames,
             primary_payload_hash, fallback_payload_hash, fallback_completed_at,
             repair_usernames, repair_payload_hash, repair_completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            REQUEST_ID, PRODUCER_JOB_KEY, options.requestedUsernames,
            options.frozenUnresolvedUsernames, PRIMARY_PAYLOAD_HASH,
            options.fallback ? FALLBACK_PAYLOAD_HASH : null,
            options.fallback ? '2026-08-28T00:00:00.000Z' : null,
            options.repair ? options.frozenUnresolvedUsernames : null,
            options.repair ? REPAIR_PAYLOAD_HASH : null,
            options.repair ? '2026-08-28T01:00:00.000Z' : null,
        ]
    );
    for (const row of options.outcomes) {
        const success = row.status === 'success';
        await db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes(
                 request_id, job_key, attempt, ordinal, username, source, status,
                 failure_category, profile_snapshot
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                REQUEST_ID, PRODUCER_JOB_KEY, row.attempt ?? 'fresh_apify', row.ordinal,
                row.username, row.source ?? (row.attempt && row.attempt !== 'fresh_apify' ? 'cache' : 'apify'),
                row.status,
                row.failureCategory ?? (success ? null : row.status === 'unavailable' ? 'not_found' : 'incomplete'),
                success ? JSON.stringify({ username: row.username }) : null,
            ]
        );
    }
}

async function loadForConsumer(db: PGlite, expectedItemCount: number) {
    return asService<{ snapshot: unknown }>(
        db,
        `SELECT public.load_analysis_v2_profile_fetch_for_consumer(
             $1, $2, $3, $4, $5, $6, $7
         ) AS snapshot`,
        [
            REQUEST_ID, CONSUMER_JOB_KEY, CLAIM_TOKEN, CONSUMER_INPUT_HASH,
            PRODUCER_JOB_KEY, PRODUCER_INPUT_HASH, expectedItemCount,
        ]
    );
}

/**
 * Builds N outcome rows with `failedCount` failed(incomplete) rows and
 * `unavailableCount` unavailable(not_found) rows, the rest success, all
 * attempt='fresh_apify'/source='apify' and aligned to `names`.
 */
function buildOutcomes(
    names: string[],
    failedCount: number,
    unavailableCount = 0
): { outcomes: OutcomeRow[]; frozenUnresolvedUsernames: string[] } {
    const outcomes: OutcomeRow[] = names.map((username, index) => {
        if (index < failedCount) {
            return { ordinal: index + 1, username, status: 'failed', failureCategory: 'incomplete' };
        }
        if (index < failedCount + unavailableCount) {
            return { ordinal: index + 1, username, status: 'unavailable', failureCategory: 'not_found' };
        }
        return { ordinal: index + 1, username, status: 'success' };
    });
    const frozenUnresolvedUsernames = outcomes
        .filter(row => row.status !== 'success')
        .map(row => row.username);
    return { outcomes, frozenUnresolvedUsernames };
}

describe('bounded direct fresh_apify consumer (PGlite)', () => {
    it('accepts an all-success direct fresh_apify batch (baseline, unaffected by this change)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 0);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 5);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(5);
    });

    it('accepts the production-shaped 29 success + 1 incomplete failure of 30', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(30);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 30);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([names[0]]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(30);
    });

    it('accepts the production-shaped 26 success + 1 schema failure of 27', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(27);
        const outcomes: OutcomeRow[] = names.map((username, index) => (
            index === 0
                ? { ordinal: 1, username, status: 'failed', failureCategory: 'schema' }
                : { ordinal: index + 1, username, status: 'success' }
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames: [names[0]],
            outcomes,
        });

        const result = await loadForConsumer(db, 27);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual([names[0]]);
        expect((snapshot.primaryResults as unknown[]).length).toBe(27);
    });

    it('accepts unbounded unavailable rows with zero failed rows (unavailable is never bounded or rejected)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // 7 unavailable, 3 success, 0 failed -- far past the failed bound
        // (which would be 1 for N=10) but unavailable does not count against
        // it at all, matching evaluateProfileBatchCompleteness.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 0, 7);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 10);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual(names.slice(0, 7));
    });

    it('accepts unavailable rows mixed with an in-bound number of failed rows', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // bound for N=10 is 10 - ceil(9) = 1; exactly 1 failed + 3 unavailable.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1, 3);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        const result = await loadForConsumer(db, 10);
        const snapshot = result.rows[0].snapshot as Record<string, unknown>;
        expect(snapshot.frozenUnresolvedUsernames).toEqual(names.slice(0, 4));
    });

    it('rejects a transient failure category (timeout) even within the count bound', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        const outcomes: OutcomeRow[] = names.map((username, index) => (
            index === 0
                ? { ordinal: 1, username, status: 'failed', failureCategory: 'timeout' }
                : { ordinal: index + 1, username, status: 'success' }
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames: [names[0]],
            outcomes,
        });

        await expect(loadForConsumer(db, 10)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects excessive failed rows beyond the requested_count - CEIL(0.9x) bound', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(10);
        // bound is 1; 2 failed rows exceeds it.
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 2);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        await expect(loadForConsumer(db, 10)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects malformed/misaligned evidence (username does not match its requested ordinal)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Swap the (both-success) ordinal-2/ordinal-3 usernames so stored
        // outcome rows no longer match batch.requested_usernames at their
        // ordinal, while every other property (count, frozen set, bound)
        // still looks admissible.
        const swapped = outcomes.map(row => {
            if (row.ordinal === 2) return { ...row, username: names[2] };
            if (row.ordinal === 3) return { ...row, username: names[1] };
            return row;
        });
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: swapped,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects an incomplete row set (fewer outcome rows than requested)', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Drop the last (success) row entirely: 4 physical rows for 5 requested.
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: outcomes.slice(0, 4),
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects a wrong-attempt/wrong-source row mixed into an otherwise valid batch', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        // Replace the one failed row's attempt/source with a legacy primary
        // row instead of fresh_apify/apify.
        const corrupted = outcomes.map(row => (
            row.ordinal === 1
                ? { ...row, attempt: 'primary', source: 'cache' }
                : row
        ));
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes: corrupted,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects when repair state exists on the batch, even with otherwise-bounded fresh_apify rows', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db);
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, {
            requestedUsernames: names,
            frozenUnresolvedUsernames,
            outcomes,
            repair: true,
        });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });

    it('rejects when the producer job has not completed', async () => {
        const db = await createDb();
        await seedRequestAndJobs(db, { producerStatus: 'processing' });
        const names = usernames(5);
        const { outcomes, frozenUnresolvedUsernames } = buildOutcomes(names, 1);
        await seedBatch(db, { requestedUsernames: names, frozenUnresolvedUsernames, outcomes });

        await expect(loadForConsumer(db, 5)).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY'
        );
    });
});
