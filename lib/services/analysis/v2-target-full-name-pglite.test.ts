import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728190000_persist_analysis_v2_target_full_name.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_ID = '223e4567-e89b-42d3-a456-426614174000';
let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY,
            consumed_request_id UUID,
            target_full_name VARCHAR(200)
        );
        CREATE TABLE public.analysis_v2_result_summaries (
            request_id UUID PRIMARY KEY,
            target_instagram_id TEXT NOT NULL,
            target_profile_image_url TEXT,
            plan_id TEXT NOT NULL,
            followers_declared INTEGER NOT NULL,
            followers_collected INTEGER NOT NULL,
            following_declared INTEGER NOT NULL,
            following_collected INTEGER NOT NULL,
            detected_mutuals INTEGER NOT NULL,
            public_mutuals INTEGER NOT NULL,
            private_mutuals INTEGER NOT NULL,
            screened_mutuals INTEGER NOT NULL,
            male_count INTEGER NOT NULL,
            female_count INTEGER NOT NULL,
            unknown_count INTEGER NOT NULL,
            fetch_unavailable_count INTEGER NOT NULL,
            media_unavailable_count INTEGER NOT NULL,
            analysis_unavailable_count INTEGER NOT NULL,
            not_screened_mutuals INTEGER NOT NULL,
            exclusion_applied BOOLEAN NOT NULL,
            score_policy_version TEXT NOT NULL
        );
    `);
    await db.exec(migration);
});

afterEach(async () => {
    await db.close();
});

describe('analysis V2 target full-name persistence', () => {
    it('copies a current preflight full name into a new summary', async () => {
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, consumed_request_id, target_full_name
            ) VALUES ($1, $2, '김준호')`,
            [PREFLIGHT_ID, REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries (
                request_id, target_instagram_id, target_profile_image_url,
                plan_id, followers_declared, followers_collected,
                following_declared, following_collected, detected_mutuals,
                public_mutuals, private_mutuals, screened_mutuals,
                male_count, female_count, unknown_count,
                fetch_unavailable_count, media_unavailable_count,
                analysis_unavailable_count, not_screened_mutuals,
                exclusion_applied, score_policy_version
            ) VALUES (
                $1, 'target', NULL, 'standard', 1, 1, 1, 1, 1, 1, 0, 1,
                0, 1, 0, 0, 0, 0, 0, FALSE, 'risk-policy-v2.4'
            )`,
            [REQUEST_ID]
        );

        const result = await db.query<{
            target_full_name: string | null;
            summary: { targetFullName: string | null };
        }>(
            `SELECT target_full_name,
                    public.analysis_v2_result_summary_json(summary.*) AS summary
             FROM public.analysis_v2_result_summaries AS summary
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(result.rows[0]).toMatchObject({
            target_full_name: '김준호',
            summary: { targetFullName: '김준호' },
        });
    });

    it('keeps historical rows null and permits a missing source name', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries (
                request_id, target_instagram_id, target_profile_image_url,
                plan_id, followers_declared, followers_collected,
                following_declared, following_collected, detected_mutuals,
                public_mutuals, private_mutuals, screened_mutuals,
                male_count, female_count, unknown_count,
                fetch_unavailable_count, media_unavailable_count,
                analysis_unavailable_count, not_screened_mutuals,
                exclusion_applied, score_policy_version
            ) VALUES (
                $1, 'target', NULL, 'standard', 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, FALSE, 'risk-policy-v2.4'
            )`,
            [REQUEST_ID]
        );
        const result = await db.query<{ target_full_name: string | null }>(
            `SELECT target_full_name
             FROM public.analysis_v2_result_summaries
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(result.rows[0]?.target_full_name).toBeNull();
    });
});
