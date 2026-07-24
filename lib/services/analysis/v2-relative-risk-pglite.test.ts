import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123400_add_relative_risk_policy_v23.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = migration.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = migration.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return migration.slice(start, end + 4);
}

interface ExpectedRow {
    candidate_id: string;
    display_score: number;
    risk_band: 'normal' | 'caution' | 'high_risk';
    relative_tier_applied: boolean;
}

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(functionDefinition('analysis_v2_expected_relative_risk_rows'));
    await db.exec(functionDefinition('analysis_v2_relative_overview_fallback'));
});

afterAll(async () => {
    await db.close();
});

async function expected(
    scores: readonly number[],
    strongCandidateIds: readonly string[] = []
): Promise<ExpectedRow[]> {
    const rows = scores.map((publicScore, index) => ({
        candidateId: `candidate:${String(index).padStart(3, '0')}`,
        publicScore,
    }));
    const result = await db.query<ExpectedRow>(
        `SELECT candidate_id, display_score::FLOAT8 AS display_score,
                risk_band, relative_tier_applied
         FROM public.analysis_v2_expected_relative_risk_rows(
            $1::JSONB,
            $2::TEXT[]
         )
         ORDER BY candidate_id`,
        [JSON.stringify(rows), strongCandidateIds]
    );
    return result.rows;
}

describe('relative risk policy v2.3 SQL helper', () => {
    it.each([
        { scores: [] },
        { scores: [2.1] },
        { scores: [3.1, 2.1] },
    ])('preserves natural tiers below three eligible rows: $scores', async ({ scores }) => {
        const rows = await expected(scores);
        expect(rows).toEqual(scores.map((score, index) => ({
            candidate_id: `candidate:${String(index).padStart(3, '0')}`,
            display_score: score,
            risk_band: 'normal',
            relative_tier_applied: false,
        })));
    });

    it('assigns one high-risk and two caution rows to three all-normal scores', async () => {
        const rows = await expected([3.3, 2.2, 1.1]);
        expect(rows.map(row => row.risk_band))
            .toEqual(['high_risk', 'caution', 'caution']);
        expect(rows.map(row => row.display_score)).toEqual([6.8, 4.2, 4.2]);
        expect(rows.every(row => row.relative_tier_applied)).toBe(true);
    });

    it('reserves two caution rows when every natural row is high-risk', async () => {
        const rows = await expected([9.8, 9.1, 8.4]);
        expect(rows.map(row => row.risk_band))
            .toEqual(['high_risk', 'caution', 'caution']);
        expect(rows.map(row => row.display_score)).toEqual([9.8, 6.7, 6.7]);
    });

    it('excludes strong-partner rows from the minimum eligible pool', async () => {
        const rows = await expected(
            [3.4, 3.3, 3.2],
            ['candidate:000']
        );
        expect(rows.map(row => row.risk_band)).toEqual(['normal', 'normal', 'normal']);
        expect(rows.every(row => row.relative_tier_applied === false)).toBe(true);
    });

    it('keeps large all-normal manifests deterministically bounded', async () => {
        const scores = Array.from({ length: 77 }, (_, index) =>
            Math.max(1, Math.round((4 - index * 0.05) * 10) / 10));
        const rows = await expected(scores);

        expect(rows.filter(row => row.risk_band === 'high_risk')).toHaveLength(1);
        expect(rows.filter(row => row.risk_band === 'caution')).toHaveLength(2);
        expect(rows.filter(row => row.risk_band === 'normal')).toHaveLength(74);
    });

    it('produces 900 unique identifier-free duplicate-overview fallbacks', async () => {
        const result = await db.query<{
            total: number;
            unique_count: number;
            shortest: number;
            longest: number;
            unsafe: number;
        }>(
            `SELECT
                pg_catalog.count(*)::INTEGER AS total,
                pg_catalog.count(DISTINCT copy)::INTEGER AS unique_count,
                pg_catalog.min(pg_catalog.char_length(copy))::INTEGER AS shortest,
                pg_catalog.max(pg_catalog.char_length(copy))::INTEGER AS longest,
                pg_catalog.count(*) FILTER (
                    WHERE copy ~ '[[:digit:]@]'
                       OR copy LIKE '%개인 계정입니다%'
                       OR copy LIKE '%일반 단계로 판독됐어요%'
                )::INTEGER AS unsafe
             FROM (
                SELECT public.analysis_v2_relative_overview_fallback(
                    ordinal
                ) AS copy
                FROM pg_catalog.generate_series(1, 900) AS ordinal
             ) AS generated`
        );

        expect(result.rows[0]).toMatchObject({
            total: 900,
            unique_count: 900,
            unsafe: 0,
        });
        expect(result.rows[0]!.shortest).toBeGreaterThanOrEqual(25);
        expect(result.rows[0]!.longest).toBeLessThanOrEqual(110);
    });

    it('patches the live checkpoint and finalizer definitions without SQL drift', async () => {
        const migrationDb = await PGlite.create();
        try {
            await migrationDb.exec(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;

                CREATE TABLE public.analysis_v2_partner_safety_rows (
                    request_id UUID NOT NULL,
                    candidate_id TEXT NOT NULL,
                    has_strong_partner_evidence BOOLEAN NOT NULL
                );
                CREATE TABLE public.analysis_v2_candidate_feature_rows (
                    candidate_id TEXT NOT NULL,
                    one_line_overview TEXT NOT NULL,
                    instagram_id TEXT NOT NULL
                );
                CREATE TABLE public.analysis_v2_candidate_score_rows (
                    candidate_id TEXT NOT NULL,
                    display_score NUMERIC NOT NULL,
                    risk_band TEXT NOT NULL
                );

                CREATE OR REPLACE FUNCTION public.analysis_v2_result_staging_hash(
                    p_kind TEXT, p_batch INTEGER, p_rows JSONB
                )
                RETURNS TEXT
                LANGUAGE sql
                IMMUTABLE
                SET search_path = ''
                AS $function$
                    SELECT pg_catalog.md5(
                        p_kind || COALESCE(p_batch::TEXT, '') || p_rows::TEXT
                    )
                $function$;

                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_rows JSONB,
                    p_risk_policy_version TEXT
                )
                RETURNS JSONB
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = ''
                AS $function$
                DECLARE
                    v_rows JSONB := p_rows;
                    v_hash TEXT;
                BEGIN
                    IF p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.2' THEN
                        RAISE EXCEPTION 'legacy';
                    END IF;
                    IF EXISTS (
                        SELECT 1
                        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
                        WHERE FALSE
                           OR pg_catalog.abs(
                                (item.value->>'displayScore')::NUMERIC
                                - pg_catalog.round((item.value->>'publicScore')::NUMERIC, 1)
                           ) > 0.0001
                           OR item.value->>'riskBand' IS DISTINCT FROM CASE
                                WHEN (item.value->>'publicScore')::NUMERIC < 4.2 THEN 'normal'
                                WHEN (item.value->>'publicScore')::NUMERIC < 6.8 THEN 'caution'
                                ELSE 'high_risk'
                              END
                    ) THEN
                        RAISE EXCEPTION 'legacy';
                    END IF;
                    v_hash := public.analysis_v2_result_staging_hash('candidate_scores_v2', NULL, v_rows);
                    RETURN pg_catalog.jsonb_build_object('hash', v_hash);
                END;
                $function$;

                CREATE OR REPLACE FUNCTION public.analysis_v2_complete_result_and_purge_internal(
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_target_profile_image_url TEXT
                )
                RETURNS JSONB
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = ''
                AS $function$
                DECLARE
                    v_policy TEXT := 'risk-policy-v2.2';
                    v_overview TEXT;
                BEGIN
                    SELECT CASE
                        WHEN pg_catalog.count(*) OVER (
                                    PARTITION BY feature.one_line_overview
                                ) > 1 THEN
                            pg_catalog.left(feature.one_line_overview, 105)
                            || ' · ' || COALESCE(
                                NULLIF(
                                    pg_catalog.regexp_replace(
                                        feature.instagram_id, '[0-9]', '', 'g'
                                    ),
                                    ''
                                ),
                                '해당'
                            )
                            || ' 계정은 '
                            || CASE score.risk_band
                                WHEN 'normal' THEN '일반'
                                WHEN 'caution' THEN '주의'
                                WHEN 'high_risk' THEN '고위험'
                            END
                            || ' 단계로 판독됐어요.'
                                ELSE feature.one_line_overview
                    END
                    INTO v_overview
                    FROM public.analysis_v2_candidate_feature_rows AS feature
                    JOIN public.analysis_v2_candidate_score_rows AS score
                      ON score.candidate_id = feature.candidate_id
                    LIMIT 1;
                    RETURN pg_catalog.jsonb_build_object(
                        'policy', v_policy,
                        'overview', v_overview
                    );
                END;
                $function$;
            `.replace(/^ {16}/gm, ''));

            await migrationDb.exec(migration);

            const definitions = await migrationDb.query<{
                checkpoint: string;
                finalizer: string;
            }>(
                `SELECT
                    pg_catalog.pg_get_functiondef(
                        'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                            ::pg_catalog.regprocedure
                    ) AS checkpoint,
                    pg_catalog.pg_get_functiondef(
                        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
                            ::pg_catalog.regprocedure
                    ) AS finalizer`
            );
            expect(definitions.rows[0]!.checkpoint)
                .toContain('analysis_v2_expected_relative_risk_rows');
            expect(definitions.rows[0]!.checkpoint).toContain('risk-policy-v2.3');
            expect(definitions.rows[0]!.checkpoint).not.toContain(
                "- pg_catalog.round((item.value->>'publicScore')::NUMERIC, 1)"
            );
            expect(definitions.rows[0]!.finalizer)
                .toContain('analysis_v2_relative_overview_fallback');
            expect(definitions.rows[0]!.finalizer).toContain('risk-policy-v2.3');
            expect(definitions.rows[0]!.finalizer)
                .not.toContain('일반 단계로 판독됐어요');
        } finally {
            await migrationDb.close();
        }
    });
});
