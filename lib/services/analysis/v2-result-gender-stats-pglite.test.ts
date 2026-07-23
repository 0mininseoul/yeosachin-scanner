import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260723191547_persist_analysis_v2_gender_stats.sql',
        import.meta.url
    ),
    'utf8'
);

const LEGACY_REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const NEW_REQUEST_ID = '10000000-0000-4000-8000-000000000002';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    gender_stats JSONB
);

CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    terminal_classification TEXT NOT NULL,
    PRIMARY KEY (request_id, candidate_id)
);

CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    target_instagram_id TEXT NOT NULL,
    target_profile_image_url TEXT,
    plan_id TEXT NOT NULL,
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    exclusion_applied BOOLEAN NOT NULL,
    score_policy_version TEXT NOT NULL,
    finalizer_input_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    analysis_unavailable_count SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE public.analysis_v2_female_results (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    PRIMARY KEY (request_id, candidate_id)
);
`;

interface GenderRow {
    male_count: number;
    female_count: number;
    unknown_count: number;
}

interface SummaryJsonRow {
    summary: {
        genderStats: {
            male: number;
            female: number;
            unknown: number;
        };
    };
}

async function createLegacyDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    await db.exec(bootstrap);
    return db;
}

async function insertSummary(db: PGlite, requestId: string, screened: number): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_v2_result_summaries (
            request_id, target_instagram_id, target_profile_image_url, plan_id,
            followers_declared, followers_collected,
            following_declared, following_collected,
            detected_mutuals, public_mutuals, private_mutuals,
            screened_mutuals, not_screened_mutuals,
            fetch_unavailable_count, media_unavailable_count,
            exclusion_applied, score_policy_version, finalizer_input_hash
        ) VALUES (
            $1, 'target.account', NULL, 'basic',
            10, 10, 10, 10, $2, $2, 0, $2, 0, 0, 0,
            FALSE, 'risk-policy-v2.2', $3
        )`,
        [requestId, screened, 'a'.repeat(64)]
    );
}

describe('analysis V2 result gender stats migration PGlite regression', () => {
    it('backfills an existing summary from a coherent legacy gender snapshot', async () => {
        const db = await createLegacyDatabase();
        try {
            await db.query(
                `INSERT INTO public.analysis_requests (id, gender_stats)
                 VALUES ($1, '{"male": 2, "female": 1, "unknown": 1}'::JSONB)`,
                [LEGACY_REQUEST_ID]
            );
            await insertSummary(db, LEGACY_REQUEST_ID, 4);

            await db.exec(migration);

            const stored = await db.query<GenderRow>(
                `SELECT male_count, female_count, unknown_count
                 FROM public.analysis_v2_result_summaries
                 WHERE request_id = $1`,
                [LEGACY_REQUEST_ID]
            );
            expect(stored.rows).toEqual([{
                male_count: 2,
                female_count: 1,
                unknown_count: 1,
            }]);
        } finally {
            await db.close();
        }
    }, 30_000);

    it('uses finalized female rows and an unknown remainder for invalid legacy data', async () => {
        const db = await createLegacyDatabase();
        try {
            await db.query(
                `INSERT INTO public.analysis_requests (id, gender_stats)
                 VALUES ($1, '{"male": "invalid", "female": 9, "unknown": 0}'::JSONB)`,
                [LEGACY_REQUEST_ID]
            );
            await insertSummary(db, LEGACY_REQUEST_ID, 3);
            await db.query(
                `INSERT INTO public.analysis_v2_female_results (request_id, candidate_id)
                 VALUES ($1, 'female-1'), ($1, 'female-2')`,
                [LEGACY_REQUEST_ID]
            );

            await db.exec(migration);

            const stored = await db.query<GenderRow>(
                `SELECT male_count, female_count, unknown_count
                 FROM public.analysis_v2_result_summaries
                 WHERE request_id = $1`,
                [LEGACY_REQUEST_ID]
            );
            expect(stored.rows).toEqual([{
                male_count: 0,
                female_count: 2,
                unknown_count: 1,
            }]);
        } finally {
            await db.close();
        }
    }, 30_000);

    it('maps terminal classifications on insert and serializes the aggregate', async () => {
        const db = await createLegacyDatabase();
        try {
            await db.exec(migration);
            await db.query(
                'INSERT INTO public.analysis_requests (id, gender_stats) VALUES ($1, NULL)',
                [NEW_REQUEST_ID]
            );
            await db.query(
                `INSERT INTO public.analysis_v2_candidate_feature_rows (
                    request_id, candidate_id, terminal_classification
                 ) VALUES
                    ($1, 'female-1', 'verified_female'),
                    ($1, 'female-2', 'verified_female'),
                    ($1, 'male-1', 'verified_non_female'),
                    ($1, 'unknown-1', 'unresolved'),
                    ($1, 'unknown-2', 'media_unavailable')`,
                [NEW_REQUEST_ID]
            );
            await insertSummary(db, NEW_REQUEST_ID, 5);

            const stored = await db.query<GenderRow>(
                `SELECT male_count, female_count, unknown_count
                 FROM public.analysis_v2_result_summaries
                 WHERE request_id = $1`,
                [NEW_REQUEST_ID]
            );
            expect(stored.rows).toEqual([{
                male_count: 1,
                female_count: 2,
                unknown_count: 2,
            }]);

            const serialized = await db.query<SummaryJsonRow>(
                `SELECT public.analysis_v2_result_summary_json(summary) AS summary
                 FROM public.analysis_v2_result_summaries AS summary
                 WHERE summary.request_id = $1`,
                [NEW_REQUEST_ID]
            );
            expect(serialized.rows[0]?.summary.genderStats).toEqual({
                male: 1,
                female: 2,
                unknown: 2,
            });
        } finally {
            await db.close();
        }
    }, 30_000);

    it('rejects a final summary when staged classifications are incomplete', async () => {
        const db = await createLegacyDatabase();
        try {
            await db.exec(migration);
            await db.query(
                'INSERT INTO public.analysis_requests (id, gender_stats) VALUES ($1, NULL)',
                [NEW_REQUEST_ID]
            );
            await db.query(
                `INSERT INTO public.analysis_v2_candidate_feature_rows (
                    request_id, candidate_id, terminal_classification
                 ) VALUES
                    ($1, 'female-1', 'verified_female'),
                    ($1, 'male-1', 'verified_non_female')`,
                [NEW_REQUEST_ID]
            );

            await expect(insertSummary(db, NEW_REQUEST_ID, 3))
                .rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
        } finally {
            await db.close();
        }
    }, 30_000);
});
