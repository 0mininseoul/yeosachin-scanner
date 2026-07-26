import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260726090000_add_risk_policy_v24.sql',
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

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(functionDefinition('analysis_v2_expected_relative_risk_rows'));
});

afterAll(async () => {
    await db.close();
});

async function expected(rows: readonly Record<string, unknown>[]) {
    return (await db.query<{
        candidate_id: string;
        display_score: number;
        risk_band: string;
        relative_tier_applied: boolean;
    }>(
        `SELECT candidate_id, display_score::FLOAT8 AS display_score,
                risk_band, relative_tier_applied
         FROM public.analysis_v2_expected_relative_risk_rows($1::JSONB, ARRAY[]::TEXT[])
         ORDER BY candidate_id`,
        [JSON.stringify(rows)]
    )).rows;
}

describe('risk-policy v2.4 database replay', () => {
    it('keeps official accounts normal and out of personal tiers despite directional tags', async () => {
        const rows = await expected([
            {
                candidateId: 'official', publicScore: 9, accountContext: 'official_group_or_brand',
                components: { candidateToTargetTagOrCaptionMention: 12 },
            },
            { candidateId: 'a', publicScore: 3, components: {} },
            { candidateId: 'b', publicScore: 2, components: {} },
            { candidateId: 'c', publicScore: 1, components: {} },
        ]);

        expect(rows).toContainEqual({
            candidate_id: 'official', display_score: 4.1, risk_band: 'normal',
            relative_tier_applied: false,
        });
        expect(rows.filter(row => row.risk_band === 'high_risk')).toHaveLength(1);
    });

    it('uses directional inbound evidence for high selection and caps tiers at 3/10', async () => {
        const rows = await expected([
            { candidateId: 'no-inbound', publicScore: 9, components: {} },
            {
                candidateId: 'inbound', publicScore: 2,
                components: { candidateToTargetTagOrCaptionMention: 12 },
            },
            ...Array.from({ length: 18 }, (_, index) => ({
                candidateId: `normal-${index}`, publicScore: 1, components: {},
            })),
        ]);

        expect(rows.find(row => row.candidate_id === 'inbound')?.risk_band).toBe('high_risk');
        expect(rows.filter(row => row.risk_band === 'high_risk')).toHaveLength(1);
        expect(rows.filter(row => row.risk_band === 'caution')).toHaveLength(2);
    });

    it('declares v2.4 constraints and five-point reverse-like finalization', () => {
        expect(migration).toContain("'risk-policy-v2.4'");
        expect(migration).toContain("candidateToTargetTagOrCaptionMention");
        expect(migration).toContain("targetToCandidateTagOrCaptionMention");
        expect(migration).toContain("+ 5, 100");
        expect(migration).toContain("expected_rank <= 10");
    });

    it('patches v2.3 finalization definitions forward without rewriting history', async () => {
        const migrationDb = await PGlite.create();
        try {
            await migrationDb.exec(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE TABLE public.analysis_v2_candidate_score_manifests (
                    risk_policy_version TEXT NOT NULL,
                    CONSTRAINT analysis_v2_candidate_score_manifests_risk_policy_version_check
                        CHECK (risk_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3'))
                );
                CREATE TABLE public.analysis_v2_result_summaries (
                    score_policy_version TEXT NOT NULL,
                    CONSTRAINT analysis_v2_result_summaries_score_policy_version_check
                        CHECK (score_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3'))
                );
                CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_ref_list(TEXT[], INTEGER)
                RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $function$ SELECT TRUE $function$;
                CREATE TABLE public.analysis_v2_reverse_like_rows (
                    reverse_like_status TEXT NOT NULL,
                    component_score NUMERIC NOT NULL CHECK (component_score IN (0, 3)),
                    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}',
                    CONSTRAINT analysis_v2_reverse_like_evidence_check CHECK (
                        reverse_like_status <> 'observed' OR component_score = 3
                    )
                );
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_reverse_likes(
                    UUID, TEXT, UUID, TEXT, JSONB
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE v_note TEXT := $note$componentScore' NOT IN ('0', '3')
                    componentScore' <> '3'$note$;
                BEGIN
                    IF v_note = '' THEN NULL; END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
                    UUID, TEXT, UUID, TEXT, JSONB, TEXT
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE v_note TEXT := $note$
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    NOT BETWEEN 0 AND 97
                    + 3, 100$note$;
                BEGIN
                    IF v_note = 'risk-policy-v2.3' THEN NULL; END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    UUID, TEXT, UUID, TEXT, JSONB, TEXT
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE v_note TEXT := $note$
                    + (item.value->'components'->>'targetToCandidateLike')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    , 97 + 3,$note$;
                BEGIN
                    IF v_note = 'risk-policy-v2.3' THEN NULL; END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
                CREATE OR REPLACE FUNCTION public.analysis_v2_complete_result_and_purge_internal(
                    UUID, TEXT, UUID, TEXT, TEXT
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE v_value TEXT := $body$ranked.risk_band = 'caution' AND ranked.expected_rank <= 15$body$;
                BEGIN
                    IF v_value = 'risk-policy-v2.3' THEN NULL; END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
            `);

            await expect(migrationDb.exec(migration)).resolves.toBeDefined();
            const definitions = await migrationDb.query<{ definition: string }>(
                `SELECT pg_catalog.pg_get_functiondef(
                    'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
                        ::pg_catalog.regprocedure
                ) AS definition`
            );
            expect(definitions.rows[0]!.definition).toContain('risk-policy-v2.4');
            expect(definitions.rows[0]!.definition).toContain('expected_rank <= 10');
        } finally {
            await migrationDb.close();
        }
    });
});
