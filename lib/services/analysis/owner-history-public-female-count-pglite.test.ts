import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260729090000_add_owner_history_public_female_count.sql',
    import.meta.url
);

const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER_ID = '20000000-0000-4000-8000-000000000002';
const PENDING_V2_ID = '90000000-0000-4000-8000-000000000009';
const COMPLETED_V2_ID = '30000000-0000-4000-8000-000000000003';
const PROCESSING_V2_ID = '40000000-0000-4000-8000-000000000004';
const V1_ID = '50000000-0000-4000-8000-000000000005';
const MISSING_SUMMARY_V2_ID = '60000000-0000-4000-8000-000000000006';
const FAILED_V2_ID = '70000000-0000-4000-8000-000000000007';
const OTHER_OWNER_V2_ID = '80000000-0000-4000-8000-000000000008';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    target_instagram_id TEXT,
    status TEXT NOT NULL,
    pipeline_version TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    plan_type TEXT
);

CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
    target_instagram_id TEXT,
    female_count SMALLINT
);

CREATE TABLE public.analysis_v2_female_results (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    candidate_id TEXT NOT NULL
);
`;

interface HistoryPayload {
    schemaVersion: number;
    items: Array<{
        id: string;
        targetInstagramId: string | null;
        status: string;
        publicFemaleCount: number | null;
    }>;
}

let db: PGlite;

async function loadHistoryForOwner(ownerId: string): Promise<HistoryPayload> {
    await db.exec('SET ROLE authenticated');
    try {
        await db.query(
            `SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, FALSE)`,
            [ownerId]
        );
        const result = await db.query<{ history: HistoryPayload }>(
            'SELECT public.load_analysis_owner_history_v1() AS history'
        );
        return result.rows[0]!.history;
    } finally {
        await db.exec('RESET ROLE');
    }
}

describe('owner history public female count migration PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
    });

    afterAll(async () => {
        await db.close();
    });

    it('returns only the durable completed V2 female aggregate after candidate identifiers are scrubbed', async () => {
        expect(existsSync(migrationUrl)).toBe(true);
        const migration = readFileSync(migrationUrl, 'utf8');
        await db.exec(migration);

        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, created_at, plan_type
             ) VALUES
                ($1, $2, 'retained.completed', 'completed', 'v2', '2026-07-29T00:06:00Z', 'standard'),
                ($3, $2, 'processing.target', 'processing', 'v2', '2026-07-29T00:05:00Z', 'standard'),
                ($4, $2, 'legacy.target', 'completed', 'v1', '2026-07-29T00:04:00Z', 'basic'),
                ($5, $2, 'retained.missing', 'completed', 'v2', '2026-07-29T00:03:00Z', 'standard'),
                ($6, $2, 'retained.failed', 'failed', 'v2', '2026-07-29T00:02:00Z', 'standard'),
                ($7, $8, 'retained.other', 'completed', 'v2', '2026-07-29T00:01:00Z', 'standard')`,
            [
                COMPLETED_V2_ID,
                OWNER_ID,
                PROCESSING_V2_ID,
                V1_ID,
                MISSING_SUMMARY_V2_ID,
                FAILED_V2_ID,
                OTHER_OWNER_V2_ID,
                OTHER_OWNER_ID,
            ]
        );
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, created_at, plan_type
             ) VALUES ($1, $2, 'pending.target', 'pending', 'v2', '2026-07-29T00:07:00Z', 'standard')`,
            [PENDING_V2_ID, OWNER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries (
                request_id, target_instagram_id, female_count
             ) VALUES
                ($1, 'final.completed', 7),
                ($2, 'final.processing', 9),
                ($3, 'final.failed', 6),
                ($4, 'final.other', 5)`,
            [COMPLETED_V2_ID, PROCESSING_V2_ID, FAILED_V2_ID, OTHER_OWNER_V2_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries (
                request_id, target_instagram_id, female_count
             ) VALUES ($1, 'final.pending', 8)`,
            [PENDING_V2_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_female_results (request_id, candidate_id)
             VALUES ($1, 'scrubbed-candidate-identifier')`,
            [COMPLETED_V2_ID]
        );
        await db.query(
            'DELETE FROM public.analysis_v2_female_results WHERE request_id = $1',
            [COMPLETED_V2_ID]
        );

        await expect(loadHistoryForOwner(OWNER_ID)).resolves.toMatchObject({
            schemaVersion: 1,
            items: [
                {
                    id: PENDING_V2_ID,
                    targetInstagramId: 'pending.target',
                    status: 'pending',
                    publicFemaleCount: null,
                },
                {
                    id: COMPLETED_V2_ID,
                    targetInstagramId: 'final.completed',
                    status: 'completed',
                    publicFemaleCount: 7,
                },
                {
                    id: PROCESSING_V2_ID,
                    targetInstagramId: 'processing.target',
                    status: 'processing',
                    publicFemaleCount: null,
                },
                {
                    id: V1_ID,
                    targetInstagramId: 'legacy.target',
                    status: 'completed',
                    publicFemaleCount: null,
                },
                {
                    id: MISSING_SUMMARY_V2_ID,
                    targetInstagramId: null,
                    status: 'completed',
                    publicFemaleCount: null,
                },
            ],
        });
    }, 30_000);
});
