import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const checkpointMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql',
        import.meta.url
    ),
    'utf8'
);
const repairMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260720130000_add_analysis_v2_profile_repair_attempt.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const OTHER_CLAIM_TOKEN = '44444444-4444-4444-8444-444444444444';
const JOB_KEY = 'track:profiles:batch:0';
const INPUT_HASH = 'a'.repeat(64);

const REQUESTED = [
    'alpha.one',
    'beta.two',
    'gamma.three',
    'delta.four',
    'epsilon.five',
] as const;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    pipeline_version TEXT
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    consumed_request_id UUID UNIQUE REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    status TEXT NOT NULL
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    input_hash VARCHAR(64) NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);
`;

interface ProfileSnapshot {
    username: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
    isPrivate: boolean;
    isVerified: boolean;
}

interface OutcomeSpec {
    username: string;
    source: 'cache' | 'selfhosted' | 'apify';
    status: 'success' | 'unavailable' | 'failed';
    failureCategory?: string;
    httpStatus?: number;
    latencyMs?: number;
}

interface Outcome {
    username: string;
    source: string;
    status: string;
    failure_category: string | null;
    http_status: number | null;
    request_count: number;
    latency_ms: number;
    captured_at: string;
    profile: ProfileSnapshot | null;
}

function profileSnapshot(username: string): ProfileSnapshot {
    return {
        username,
        followersCount: 120,
        followingCount: 80,
        postsCount: 12,
        isPrivate: false,
        isVerified: false,
    };
}

function outcome(spec: OutcomeSpec): Outcome {
    return {
        username: spec.username,
        source: spec.source,
        status: spec.status,
        failure_category: spec.failureCategory ?? null,
        http_status: spec.httpStatus ?? null,
        request_count: 1,
        latency_ms: spec.latencyMs ?? 120,
        captured_at: '2026-07-20T10:00:00.000Z',
        profile: spec.status === 'success' ? profileSnapshot(spec.username) : null,
    };
}

// alpha resolves on the primary attempt; the other four freeze as unresolved.
const PRIMARY_OUTCOMES: readonly Outcome[] = [
    outcome({ username: 'alpha.one', source: 'selfhosted', status: 'success' }),
    outcome({
        username: 'beta.two',
        source: 'selfhosted',
        status: 'failed',
        failureCategory: 'timeout',
    }),
    outcome({
        username: 'gamma.three',
        source: 'selfhosted',
        status: 'failed',
        failureCategory: 'transport',
    }),
    outcome({
        username: 'delta.four',
        source: 'selfhosted',
        status: 'failed',
        failureCategory: 'http',
        httpStatus: 500,
    }),
    outcome({
        username: 'epsilon.five',
        source: 'selfhosted',
        status: 'failed',
        failureCategory: 'unknown',
    }),
];

// beta and epsilon stay failed (repairable); gamma merges to unavailable and delta to success.
const FALLBACK_OUTCOMES: readonly Outcome[] = [
    outcome({
        username: 'beta.two',
        source: 'apify',
        status: 'failed',
        failureCategory: 'rate_limit',
        httpStatus: 429,
    }),
    outcome({
        username: 'gamma.three',
        source: 'apify',
        status: 'unavailable',
        failureCategory: 'not_found',
        httpStatus: 404,
    }),
    outcome({ username: 'delta.four', source: 'apify', status: 'success' }),
    outcome({
        username: 'epsilon.five',
        source: 'apify',
        status: 'failed',
        failureCategory: 'auth',
        httpStatus: 401,
    }),
];

const REPAIR_OUTCOMES: readonly Outcome[] = [
    outcome({ username: 'beta.two', source: 'apify', status: 'success' }),
    outcome({
        username: 'epsilon.five',
        source: 'apify',
        status: 'failed',
        failureCategory: 'timeout',
    }),
];

let db: PGlite;

async function seedJob(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (id, status, pipeline_version)
         VALUES ($1, 'processing', 'v2')`,
        [REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (id, consumed_request_id, status)
         VALUES ($1, $2, 'consumed')`,
        [PREFLIGHT_ID, REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, input_hash, lease_token, lease_expires_at
         ) VALUES ($1, $2, 'processing', $3, $4, pg_catalog.clock_timestamp() + INTERVAL '10 minutes')`,
        [REQUEST_ID, JOB_KEY, INPUT_HASH, CLAIM_TOKEN]
    );
}

async function checkpointPrimary(): Promise<void> {
    await db.query(
        `SELECT public.checkpoint_analysis_v2_profile_primary(
            $1, $2, $3, $4, $5::TEXT[], $6::JSONB
         )`,
        [
            REQUEST_ID,
            JOB_KEY,
            CLAIM_TOKEN,
            INPUT_HASH,
            `{${REQUESTED.join(',')}}`,
            JSON.stringify(PRIMARY_OUTCOMES),
        ]
    );
}

async function checkpointFallback(): Promise<void> {
    await db.query(
        `SELECT public.checkpoint_analysis_v2_profile_fallback($1, $2, $3, $4, $5::JSONB)`,
        [REQUEST_ID, JOB_KEY, CLAIM_TOKEN, INPUT_HASH, JSON.stringify(FALLBACK_OUTCOMES)]
    );
}

async function checkpointRepair(
    outcomes: readonly Outcome[] = REPAIR_OUTCOMES,
    claimToken: string = CLAIM_TOKEN
) {
    return db.query<{ snapshot: Record<string, unknown> }>(
        `SELECT public.checkpoint_analysis_v2_profile_repair(
            $1, $2, $3, $4, $5::JSONB
         ) AS snapshot`,
        [REQUEST_ID, JOB_KEY, claimToken, INPUT_HASH, JSON.stringify(outcomes)]
    );
}

async function repairUsernameSet(): Promise<string[]> {
    const result = await db.query<{ usernames: string[] }>(
        'SELECT public.analysis_v2_profile_repair_username_set($1, $2) AS usernames',
        [REQUEST_ID, JOB_KEY]
    );
    return result.rows[0]?.usernames ?? [];
}

describe('analysis V2 profile repair attempt PGlite migration', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(checkpointMigration);
        await db.exec(repairMigration);
    }, 60_000);

    afterAll(async () => {
        await db.close();
    });

    beforeEach(async () => {
        await db.exec('DELETE FROM public.analysis_requests');
        await seedJob();
    });

    it('rejects a repair outcome row that carries a self-hosted source', async () => {
        await checkpointPrimary();
        await expect(db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes (
                request_id, job_key, attempt, ordinal, username, source, status,
                failure_category, http_status, request_count, latency_ms, captured_at
             ) VALUES (
                $1, $2, 'repair', 1, 'beta.two', 'selfhosted', 'failed',
                'timeout', NULL, 1, 120, '2026-07-20T10:00:00Z'
             )`,
            [REQUEST_ID, JOB_KEY]
        )).rejects.toThrow(/analysis_v2_profile_outcomes_source_check/);
    });

    it('accepts a repair outcome row sourced from apify', async () => {
        await checkpointPrimary();
        await expect(db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes (
                request_id, job_key, attempt, ordinal, username, source, status,
                failure_category, http_status, request_count, latency_ms, captured_at
             ) VALUES (
                $1, $2, 'repair', 1, 'beta.two', 'apify', 'failed',
                'timeout', NULL, 1, 120, '2026-07-20T10:00:00Z'
             )`,
            [REQUEST_ID, JOB_KEY]
        )).resolves.toBeDefined();

        const stored = await db.query<{ attempt: string; source: string }>(
            `SELECT attempt, source
             FROM public.analysis_v2_profile_fetch_outcomes
             WHERE request_id = $1 AND attempt = 'repair'`,
            [REQUEST_ID]
        );
        expect(stored.rows).toEqual([{ attempt: 'repair', source: 'apify' }]);
    });

    it('derives the repair set as the merged failed usernames in requested order', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        await expect(repairUsernameSet()).resolves.toEqual(['beta.two', 'epsilon.five']);
    });

    it('never admits a merged unavailable outcome into the repair set', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        const set = await repairUsernameSet();
        expect(set).not.toContain('gamma.three');
        expect(set).not.toContain('delta.four');
        expect(set).not.toContain('alpha.one');
    });

    it('rejects a repair checkpoint before the fallback attempt completed', async () => {
        await checkpointPrimary();
        await expect(checkpointRepair()).rejects.toThrow(
            /ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY/
        );
    });

    it('rejects outcomes for a username outside the server-derived repair set', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        // Same cardinality as the derived set, but swaps in a merged-unavailable username.
        await expect(checkpointRepair([
            REPAIR_OUTCOMES[0],
            outcome({
                username: 'gamma.three',
                source: 'apify',
                status: 'failed',
                failureCategory: 'timeout',
            }),
        ])).rejects.toThrow(/ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY/);
    });

    it('rejects outcomes that omit a username in the server-derived repair set', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        await expect(checkpointRepair([REPAIR_OUTCOMES[0]])).rejects.toThrow(
            /ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY/
        );
    });

    it('fences a repair checkpoint behind the live lease and claim token', async () => {
        await checkpointPrimary();
        await checkpointFallback();

        await expect(checkpointRepair(REPAIR_OUTCOMES, OTHER_CLAIM_TOKEN)).rejects.toThrow(
            /ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH/
        );

        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
             WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, JOB_KEY]
        );
        await expect(checkpointRepair()).rejects.toThrow(
            /ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH/
        );
    });

    it('persists exactly one repair attempt and replays it idempotently', async () => {
        await checkpointPrimary();
        await checkpointFallback();

        const first = await checkpointRepair();
        const snapshot = first.rows[0]?.snapshot as Record<string, unknown>;
        expect(snapshot.repairUsernames).toEqual(['beta.two', 'epsilon.five']);
        expect(snapshot.repairCapturedAt).toBeTruthy();
        expect(snapshot.repairResults).toHaveLength(2);

        const replay = await checkpointRepair();
        expect(replay.rows[0]?.snapshot).toEqual(snapshot);

        const stored = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_profile_fetch_outcomes
             WHERE request_id = $1 AND attempt = 'repair'`,
            [REQUEST_ID]
        );
        expect(stored.rows[0]?.count).toBe(2);
    });

    it('fails closed when a divergent repair payload replays', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        await checkpointRepair();

        await expect(checkpointRepair([
            REPAIR_OUTCOMES[0],
            outcome({
                username: 'epsilon.five',
                source: 'apify',
                status: 'failed',
                failureCategory: 'timeout',
                latencyMs: 999,
            }),
        ])).rejects.toThrow(/ANALYSIS_V2_PROFILE_REPAIR_CONFLICT/);
    });

    it('cascade-deletes repair rows when the terminal purge drops the batch', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        await checkpointRepair();

        await db.query(
            "UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1",
            [REQUEST_ID]
        );
        await db.query(
            'SELECT public.purge_analysis_v2_profile_fetch_checkpoints($1)',
            [REQUEST_ID]
        );

        const remaining = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_profile_fetch_outcomes
             WHERE request_id = $1 AND attempt = 'repair'`,
            [REQUEST_ID]
        );
        expect(remaining.rows[0]?.count).toBe(0);
    });

    it('rejects a repair completion that precedes the fallback completion', async () => {
        await checkpointPrimary();
        await checkpointFallback();
        await checkpointRepair();

        await expect(db.query(
            `UPDATE public.analysis_v2_profile_fetch_batches
             SET repair_completed_at = fallback_completed_at - INTERVAL '1 second'
             WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, JOB_KEY]
        )).rejects.toThrow(/analysis_v2_profile_batches_repair_order_check/);
    });
});
