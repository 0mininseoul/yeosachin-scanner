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
const riskPolicyV25Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728180000_add_risk_policy_v25.sql',
        import.meta.url
    ),
    'utf8'
);
const baseFinalizationMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713185711_add_analysis_v2_result_finalization.sql',
        import.meta.url
    ),
    'utf8'
);
const relativeRiskMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123400_add_relative_risk_policy_v23.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    return functionDefinitionFrom(migration, name);
}

function functionDefinitionFrom(source: string, name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

function latestBaseFunctionDefinition(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = baseFinalizationMigration.lastIndexOf(marker);
    if (start < 0) throw new Error(`Missing base function ${name}`);
    const end = baseFinalizationMigration.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded base function ${name}`);
    return baseFinalizationMigration.slice(start, end + 4);
}

function migrationBlock(marker: string): string {
    return migrationBlockFrom(migration, marker);
}

function migrationBlockFrom(source: string, marker: string): string {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing migration block ${marker}`);
    const end = source.indexOf('\n$migration$;', start);
    if (end < 0) throw new Error(`Unbounded migration block ${marker}`);
    return source.slice(start, end + '\n$migration$;'.length);
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
        const predecessor = latestBaseFunctionDefinition('checkpoint_analysis_v2_candidate_scores');
        expect(migration).toContain("'risk-policy-v2.4'");
        expect(migration).toContain("candidateToTargetTagOrCaptionMention");
        expect(migration).toContain("targetToCandidateTagOrCaptionMention");
        expect(migration).toContain("+ 5, 100");
        expect(migration).toContain("WHEN p_risk_policy_version = 'risk-policy-v2.3' THEN 15");
        expect(migration).toContain('FUNCTION public.load_analysis_v2_risk_policy_version');
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_risk_policy_version\(UUID\)\s+TO service_role;/
        );
        expect(migration).toContain('ELSE 10');
        expect(predecessor).toContain('component_sum.preliminary_component_total');
        expect(predecessor).toContain('                    97\n                )) AS expected_pre_score');
        expect(predecessor).toContain('                    100\n                )) AS expected_raw_score');
        expect(predecessor).toContain("ranked.expected_rank <= 15");
    });

    it('patches the actual final-score predecessor body, not a rewritten fixture', async () => {
        const predecessorDb = await PGlite.create();
        try {
            await predecessorDb.exec('SET check_function_bodies = false');
            await predecessorDb.exec(latestBaseFunctionDefinition(
                'checkpoint_analysis_v2_candidate_scores'
            ));
            await predecessorDb.exec(functionDefinitionFrom(
                relativeRiskMigration, 'analysis_v2_expected_relative_risk_rows'
            ));
            await predecessorDb.exec(migrationBlockFrom(
                relativeRiskMigration,
                'DO $migration$\nDECLARE\n    v_definition TEXT;\n    v_old_display_check'
            ));
            await predecessorDb.exec(migrationBlock(
                'DO $migration$\nDECLARE\n    v_definition TEXT;\n    v_tag_component_pattern'
            ));
            const patched = await predecessorDb.query<{ definition: string }>(`
                SELECT pg_catalog.pg_get_functiondef(
                    'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                        ::pg_catalog.regprocedure
                ) AS definition
            `);
            expect(patched.rows[0]?.definition).toContain(
                "p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4')"
            );
            expect(patched.rows[0]?.definition).toContain('THEN 97 ELSE 95 END');
            expect(patched.rows[0]?.definition).toContain(
                "candidateToTargetTagOrCaptionMention"
            );
        } finally {
            await predecessorDb.close();
        }
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
                CREATE TABLE public.analysis_v2_candidate_score_rows (
                    candidate_id TEXT PRIMARY KEY,
                    risk_band TEXT NOT NULL,
                    display_score NUMERIC NOT NULL,
                    featured_rank SMALLINT NULL
                );
                CREATE TABLE public.analysis_v2_preliminary_score_rows (
                    candidate_id TEXT PRIMARY KEY,
                    pre_score NUMERIC NOT NULL CHECK (pre_score BETWEEN 0 AND 97),
                    components JSONB NOT NULL DEFAULT '{}'::JSONB,
                    possible_upper_bound NUMERIC NOT NULL CONSTRAINT
                        analysis_v2_preliminary_score_rows_possible_upper_bound_check CHECK (
                        possible_upper_bound BETWEEN pre_score AND pre_score + 3
                        AND possible_upper_bound <= 100
                    )
                );
                CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_ref_list(TEXT[], INTEGER)
                RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $function$ SELECT TRUE $function$;
                CREATE TABLE public.analysis_v2_reverse_like_rows (
                    candidate_id TEXT NOT NULL,
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
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_rows JSONB
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE
                    v_row JSONB := p_rows->0;
                    v_note TEXT := $note$
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    $note$;
                BEGIN
                    IF (v_row->>'preScore')::NUMERIC NOT BETWEEN 0 AND 97
                       OR (v_row->>'possibleUpperBound')::NUMERIC NOT BETWEEN 0 AND 100
                       OR (v_row->>'possibleUpperBound')::NUMERIC
                            <> LEAST((v_row->>'preScore')::NUMERIC + 3, 100) THEN
                        RAISE EXCEPTION 'bounds';
                    END IF;
                    INSERT INTO public.analysis_v2_preliminary_score_rows(
                        candidate_id, pre_score, possible_upper_bound
                    ) VALUES (
                        v_row->>'candidateId', (v_row->>'preScore')::NUMERIC,
                        (v_row->>'possibleUpperBound')::NUMERIC
                    );
                    RETURN '{}'::JSONB;
                END;
                $function$;
                REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
                    UUID, TEXT, UUID, TEXT, JSONB
                ) FROM PUBLIC, anon, authenticated, service_role;
                GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
                    UUID, TEXT, UUID, TEXT, JSONB
                ) TO service_role;
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_rows JSONB,
                    p_risk_policy_version TEXT
                ) RETURNS JSONB LANGUAGE plpgsql AS $function$
                DECLARE
                    v_rows JSONB := p_rows;
                    v_count INTEGER;
                    v_note TEXT := $note$
                    + (item.value->'components'->>'targetToCandidateLike')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    GREATEST(0, LEAST(
                        component_sum.preliminary_component_total
                            + (item.value->>'weakPartnerAdjustment')::NUMERIC,
                        97
                    )) AS expected_pre_score
                    GREATEST(0, LEAST(
                        component_sum.component_total,
                        100
                    )) AS expected_raw_score
                    expected_score.expected_pre_score + 3, 100$note$;
                BEGIN
                    IF p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.3' THEN
                        RAISE EXCEPTION 'policy';
                    END IF;
                    IF EXISTS (
                        SELECT 1
                        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
                        WHERE item.value->>'candidateId' LIKE 'structural:%'
                          AND (
                            FALSE
                            OR NOT (item.value ?& ARRAY[
                                'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                                'recentMutualRank', 'verificationShortlistRank',
                                'partnerSafetySource', 'partnerSafetyOperationKey',
                                'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                                'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                                'weakPartnerAdjustment', 'partnerCapApplied',
                                'partnerEvidenceSelectionIds'
                            ])
                            OR item.value - ARRAY[
                                'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                                'recentMutualRank', 'verificationShortlistRank',
                                'partnerSafetySource', 'partnerSafetyOperationKey',
                                'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                                'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                                'weakPartnerAdjustment', 'partnerCapApplied',
                                'partnerEvidenceSelectionIds'
                            ] <> '{}'::JSONB
                          )
                    ) THEN
                        RAISE EXCEPTION 'structural replay';
                    END IF;
                    v_count := pg_catalog.jsonb_array_length(v_rows);
                    IF v_count < 0 THEN RAISE EXCEPTION 'count'; END IF;
                    IF EXISTS (
                        SELECT 1
                        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
                        JOIN public.analysis_v2_expected_relative_risk_rows(
                            v_rows,
                            ARRAY[]::TEXT[]
                        ) AS expected
                          ON expected.candidate_id = item.value->>'candidateId'
                        WHERE (
                            item.value->>'candidateId' LIKE 'relative:%'
                            OR item.value->>'candidateId' = 'structural:official'
                        )
                          AND (
                            pg_catalog.abs(
                                (item.value->>'displayScore')::NUMERIC - expected.display_score
                            ) > 0.0001
                            OR item.value->>'riskBand' IS DISTINCT FROM expected.risk_band
                          )
                    ) THEN
                        RAISE EXCEPTION 'relative replay';
                    END IF;
                    IF EXISTS (
                        SELECT 1
                        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
                        INNER JOIN public.analysis_v2_preliminary_score_rows AS preliminary
                            ON preliminary.candidate_id = item.value->>'candidateId'
                        INNER JOIN public.analysis_v2_reverse_like_rows AS reverse_like
                            ON reverse_like.candidate_id = preliminary.candidate_id
                        WHERE item.value->>'candidateId' = 'mixed'
                          AND item.value->'components' IS DISTINCT FROM pg_catalog.jsonb_set(
                            preliminary.components,
                            ARRAY['targetToCandidateLike'],
                            pg_catalog.to_jsonb(reverse_like.component_score),
                            TRUE
                          )
                    ) THEN
                        RAISE EXCEPTION 'reverse like component';
                    END IF;
                    DELETE FROM public.analysis_v2_candidate_score_rows;
                    INSERT INTO public.analysis_v2_candidate_score_rows(
                        candidate_id, risk_band, display_score, featured_rank
                    )
                    SELECT item.value->>'candidateId', item.value->>'riskBand',
                        (item.value->>'displayScore')::NUMERIC,
                        CASE WHEN item.value->'featuredRank' = 'null'::JSONB THEN NULL
                            ELSE (item.value->>'featuredRank')::SMALLINT END
                    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
                    IF EXISTS (
                        SELECT 1
                        FROM (
                            SELECT score.candidate_id, score.risk_band, score.featured_rank,
                                pg_catalog.row_number() OVER (
                                    PARTITION BY score.risk_band
                                    ORDER BY score.display_score DESC, score.candidate_id
                                ) AS expected_rank
                            FROM public.analysis_v2_candidate_score_rows AS score
                            WHERE score.risk_band IN ('high_risk', 'caution')
                        ) AS ranked
                        WHERE ranked.featured_rank IS DISTINCT FROM CASE
                            WHEN ranked.risk_band = 'high_risk' AND ranked.expected_rank <= 3
                                THEN ranked.expected_rank::SMALLINT
                            WHEN ranked.risk_band = 'caution' AND ranked.expected_rank <= 15
                                THEN ranked.expected_rank::SMALLINT
                            ELSE NULL
                        END
                    ) THEN
                        RAISE EXCEPTION 'featured ranks';
                    END IF;
                    RETURN '{}'::JSONB;
                END;
                $function$;
            `);

            await migrationDb.exec(`
                INSERT INTO public.analysis_v2_reverse_like_rows(
                    candidate_id, reverse_like_status, component_score, evidence_ref_ids
                ) VALUES ('mixed', 'observed', 3, ARRAY['like:legacy'])
            `);

            await migrationDb.exec('SET check_function_bodies = false');
            await expect(migrationDb.exec(migration)).resolves.toBeDefined();
            const preliminaryContracts = await migrationDb.query<{
                identity_arguments: string;
                acl: string[] | null;
            }>(`
                SELECT pg_catalog.pg_get_function_identity_arguments(proc.oid) AS identity_arguments,
                       proc.proacl::TEXT[] AS acl
                FROM pg_catalog.pg_proc AS proc
                WHERE proc.oid IN (
                    'public.checkpoint_analysis_v2_preliminary_scores(uuid,text,uuid,text,jsonb)'
                        ::pg_catalog.regprocedure,
                    'public.checkpoint_analysis_v2_preliminary_scores_v24(uuid,text,uuid,text,jsonb,text)'
                        ::pg_catalog.regprocedure
                )
                ORDER BY identity_arguments
            `);
            expect(preliminaryContracts.rows.map(row => row.identity_arguments)).toEqual([
                'p_request_id uuid, p_job_key text, p_claim_token uuid, p_job_input_hash text, p_rows jsonb',
                'p_request_id uuid, p_job_key text, p_claim_token uuid, p_job_input_hash text, p_rows jsonb, p_risk_policy_version text',
            ]);
            for (const contract of preliminaryContracts.rows) {
                expect(contract.acl).toContain('service_role=X/postgres');
                expect(contract.acl).not.toEqual(expect.arrayContaining([
                    expect.stringMatching(/^(PUBLIC|anon|authenticated)=/),
                ]));
            }
            /*
             * Do not use a six-argument overload of the legacy name: the exact old
             * signature must remain callable by draining v2.3 workers.
             */
            expect(preliminaryContracts.rows).toHaveLength(2);
            await migrationDb.exec(`
                CREATE TABLE public.analysis_pipeline_jobs (
                    job_key TEXT NOT NULL,
                    track TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    batch INTEGER NULL
                );
                CREATE TABLE public.analysis_requests (
                    id UUID PRIMARY KEY,
                    policy_versions_snapshot JSONB NOT NULL
                );
                CREATE TABLE public.analysis_v2_candidate_feature_rows (
                    request_id UUID NOT NULL,
                    candidate_id TEXT NOT NULL,
                    terminal_classification TEXT NOT NULL
                );
                CREATE TABLE public.analysis_v2_preliminary_score_manifests (
                    request_id UUID PRIMARY KEY,
                    producer_job_key TEXT NOT NULL,
                    producer_input_hash TEXT NOT NULL,
                    producer_claim_token UUID NOT NULL,
                    item_count INTEGER NOT NULL,
                    result_hash TEXT NOT NULL
                );
                ALTER TABLE public.analysis_v2_preliminary_score_rows
                    ADD COLUMN request_id UUID,
                    ADD COLUMN recent_mutual_rank SMALLINT,
                    ADD COLUMN verification_shortlist_rank SMALLINT;
                CREATE FUNCTION public.analysis_v2_assert_result_job_fence(
                    UUID, TEXT, UUID, TEXT
                ) RETURNS public.analysis_pipeline_jobs LANGUAGE sql AS $function$
                    SELECT ROW('coordinator:candidate-screening', 'coordinator', 'screening', NULL)
                        ::public.analysis_pipeline_jobs
                $function$;
                CREATE FUNCTION public.analysis_v2_result_staging_hash(TEXT, INTEGER, JSONB)
                RETURNS TEXT LANGUAGE sql IMMUTABLE AS $function$ SELECT 'v24-hash' $function$;
                CREATE FUNCTION public.analysis_v2_result_checkpoint_json(
                    UUID, TEXT, INTEGER, INTEGER, INTEGER, TEXT
                ) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $function$ SELECT '{}'::JSONB $function$;
                INSERT INTO public.analysis_requests(id, policy_versions_snapshot)
                VALUES (
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    '{"risk":"risk-policy-v2.4"}'::JSONB
                );
                INSERT INTO public.analysis_v2_candidate_feature_rows(
                    request_id, candidate_id, terminal_classification
                ) VALUES (
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'v24-preliminary', 'verified_female'
                );
            `);
            const componentSchemas = await migrationDb.query<{ valid: boolean }>(
                `SELECT public.analysis_v2_result_valid_score_components($1::JSONB) AS valid`,
                [JSON.stringify({
                    candidateToTargetLikes: 0,
                    candidateToTargetComments: 0,
                    targetToCandidateLike: 3,
                    tagOrCaptionMention: 0,
                    recentMutual: 0,
                    appearanceExposure: 0,
                })]
            );
            expect(componentSchemas.rows).toEqual([{ valid: true }]);
            const directionalComponents = await migrationDb.query<{ valid: boolean }>(
                `SELECT public.analysis_v2_result_valid_score_components($1::JSONB) AS valid`,
                [JSON.stringify({
                    candidateToTargetLikes: 0,
                    candidateToTargetComments: 0,
                    candidateToTargetTagOrCaptionMention: 0,
                    targetToCandidateTagOrCaptionMention: 0,
                    targetToCandidateLike: 5,
                    recentMutual: 0,
                    appearanceExposure: 0,
                })]
            );
            expect(directionalComponents.rows).toEqual([{ valid: true }]);
            const mixedComponentSchema = await migrationDb.query<{ valid: boolean }>(
                `SELECT public.analysis_v2_result_valid_score_components($1::JSONB) AS valid`,
                [JSON.stringify({
                    candidateToTargetLikes: 0,
                    candidateToTargetComments: 0,
                    tagOrCaptionMention: 0,
                    targetToCandidateTagOrCaptionMention: 0,
                    targetToCandidateLike: 3,
                    recentMutual: 0,
                    appearanceExposure: 0,
                })]
            );
            expect(mixedComponentSchema.rows).toEqual([{ valid: false }]);
            await expect(migrationDb.exec(`
                INSERT INTO public.analysis_v2_reverse_like_rows(
                    candidate_id, reverse_like_status, component_score, evidence_ref_ids
                ) VALUES
                    ('rolling-old', 'observed', 3, ARRAY['like:rolling-old']),
                    ('v24', 'observed', 5, ARRAY['like:v24'])
            `)).resolves.toBeDefined();
            await expect(migrationDb.exec(`
                INSERT INTO public.analysis_v2_reverse_like_rows(
                    candidate_id, reverse_like_status, component_score, evidence_ref_ids
                ) VALUES ('invalid', 'observed', 4, ARRAY['like:invalid'])
            `)).rejects.toThrow();
            await expect(migrationDb.exec(`
                INSERT INTO public.analysis_v2_reverse_like_rows(
                    candidate_id, reverse_like_status, component_score, evidence_ref_ids
                ) VALUES ('invalid', 'not_observed', 3, ARRAY[]::TEXT[])
            `)).rejects.toThrow();
            await expect(migrationDb.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows(
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('boundary', 95, 100)
            `)).resolves.toBeDefined();
            await migrationDb.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows(
                    candidate_id, pre_score, components, possible_upper_bound
                ) VALUES ('mixed', 50, '{}'::JSONB, 55)
            `);
            const checkpointScoreRows = (rows: readonly Record<string, unknown>[], policy: string) => (
                migrationDb.query(
                    `SELECT public.checkpoint_analysis_v2_candidate_scores(
                        '10000000-0000-4000-8000-000000000001'::UUID,
                        'coordinator:final-score',
                        '20000000-0000-4000-8000-000000000001'::UUID,
                        'input',
                        $1::JSONB,
                        $2::TEXT
                    )`,
                    [JSON.stringify(rows), policy]
                )
            );
            const legacyStructuralRow = {
                candidateId: 'structural:v23',
                displayScore: 1,
                riskBand: 'normal',
                featuredRank: null,
                recentMutualRank: null,
                verificationShortlistRank: null,
                partnerSafetySource: 'not_collected',
                partnerSafetyOperationKey: null,
                partnerSafetyResultHash: null,
                components: {
                    candidateToTargetLikes: 0,
                    candidateToTargetComments: 0,
                    targetToCandidateLike: 0,
                    tagOrCaptionMention: 0,
                    recentMutual: 0,
                    appearanceExposure: 0,
                },
                weakPartnerAdjustment: 0,
                preScore: 0,
                rawScore: 0,
                possibleUpperBound: 3,
                publicScore: 1,
                possibleUpperPublicScore: 1,
                partnerCapApplied: false,
                partnerEvidenceSelectionIds: [],
            };
            await expect(checkpointScoreRows(
                [legacyStructuralRow], 'risk-policy-v2.3'
            )).resolves.toBeDefined();
            await expect(checkpointScoreRows(
                [{ ...legacyStructuralRow, accountContext: 'personal' }], 'risk-policy-v2.3'
            )).rejects.toThrow('structural replay');
            await expect(checkpointScoreRows(
                [{
                    ...legacyStructuralRow,
                    components: {
                        ...legacyStructuralRow.components,
                        candidateToTargetTagOrCaptionMention: 0,
                    },
                }], 'risk-policy-v2.3'
            )).rejects.toThrow('structural replay');
            const officialStructuralRow = {
                ...legacyStructuralRow,
                candidateId: 'structural:official',
                accountContext: 'official_group_or_brand',
                displayScore: 4.1,
                publicScore: 9,
                possibleUpperPublicScore: 1.81,
                components: {
                    candidateToTargetLikes: 0,
                    candidateToTargetComments: 0,
                    candidateToTargetTagOrCaptionMention: 0,
                    targetToCandidateTagOrCaptionMention: 0,
                    targetToCandidateLike: 0,
                    recentMutual: 0,
                    appearanceExposure: 0,
                },
                possibleUpperBound: 5,
            };
            await expect(checkpointScoreRows(
                [officialStructuralRow], 'risk-policy-v2.4'
            )).resolves.toBeDefined();
            await expect(checkpointScoreRows(
                [Object.fromEntries(Object.entries(officialStructuralRow)
                    .filter(([key]) => key !== 'accountContext'))],
                'risk-policy-v2.4'
            )).rejects.toThrow('structural replay');
            await expect(checkpointScoreRows(
                [{ ...officialStructuralRow, accountContext: 'not-a-context' }], 'risk-policy-v2.4'
            )).rejects.toThrow('structural replay');
            await expect(checkpointScoreRows(
                [{ ...officialStructuralRow, unexpected: true }], 'risk-policy-v2.4'
            )).rejects.toThrow('structural replay');
            await expect(checkpointScoreRows(
                [{ ...officialStructuralRow, components: legacyStructuralRow.components }], 'risk-policy-v2.4'
            )).rejects.toThrow('structural replay');
            const canonicalMixedRow = [{
                candidateId: 'mixed',
                accountContext: 'personal',
                riskBand: 'normal',
                displayScore: 55,
                featuredRank: null,
                components: { targetToCandidateLike: 5 },
            }];
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.4'
                )`,
                [JSON.stringify(canonicalMixedRow)]
            )).resolves.toBeDefined();
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.4'
                )`,
                [JSON.stringify([{
                    ...canonicalMixedRow[0],
                    components: { targetToCandidateLike: 3 },
                }])]
            )).rejects.toThrow('reverse like component');
            const legacyReverse = await migrationDb.query<{ component_score: number }>(`
                SELECT component_score
                FROM public.analysis_v2_reverse_like_rows
                WHERE candidate_id = 'mixed'
            `);
            expect(legacyReverse.rows).toEqual([{ component_score: '3' }]);
            const { accountContext, ...legacyMixedRow } = canonicalMixedRow[0]!;
            expect(accountContext).toBe('personal');
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.3'
                )`,
                [JSON.stringify([{
                    ...legacyMixedRow,
                    components: { targetToCandidateLike: 3 },
                }])]
            )).resolves.toBeDefined();
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.3'
                )`,
                [JSON.stringify([legacyMixedRow])]
            )).rejects.toThrow('reverse like component');
            const legacyRelativeRows = Array.from({ length: 10 }, (_, index) => ({
                candidateId: `relative:v23-${String(index + 1).padStart(2, '0')}`,
                riskBand: index < 8 ? 'high_risk' : 'caution',
                displayScore: index < 8 ? 9.9 - index / 10 : 6.7,
                publicScore: 9.9 - index / 10,
                featuredRank: index < 3 ? index + 1 : index < 8 ? null : index - 7,
                components: {},
            }));
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.3'
                )`,
                [JSON.stringify(legacyRelativeRows)]
            )).resolves.toBeDefined();
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    '[{"candidateId":"normal","preScore":50,"possibleUpperBound":53}]'::JSONB
                )`
            )).resolves.toBeDefined();
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    '[{"candidateId":"invalid","preScore":50,"possibleUpperBound":54}]'::JSONB
                )`
            )).rejects.toThrow('bounds');
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores_v24(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.4'
                )`,
                [JSON.stringify([{
                    candidateId: 'v24-preliminary',
                    components: {
                        candidateToTargetLikes: 24,
                        candidateToTargetComments: 30,
                        candidateToTargetTagOrCaptionMention: 12,
                        targetToCandidateTagOrCaptionMention: 8,
                        targetToCandidateLike: 0,
                        recentMutual: 5,
                        appearanceExposure: 16,
                    },
                    preScore: 95,
                    possibleUpperBound: 100,
                    recentMutualRank: null,
                    verificationShortlistRank: 1,
                }])]
            )).resolves.toBeDefined();
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores_v24(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.4'
                )`,
                [JSON.stringify([{
                    candidateId: 'v24-preliminary',
                    components: {
                        candidateToTargetLikes: 24,
                        candidateToTargetComments: 30,
                        candidateToTargetTagOrCaptionMention: 12,
                        targetToCandidateTagOrCaptionMention: 8,
                        targetToCandidateLike: 0,
                        recentMutual: 5,
                        appearanceExposure: 16,
                    },
                    preScore: 95,
                    possibleUpperBound: 99,
                    recentMutualRank: null,
                    verificationShortlistRank: 1,
                }])]
            )).rejects.toThrow('ANALYSIS_V2_RESULT_INVALID');
            await expect(migrationDb.exec(`
                INSERT INTO public.analysis_v2_preliminary_score_rows(
                    candidate_id, pre_score, possible_upper_bound
                ) VALUES ('over-cap', 95, 101)
            `)).rejects.toThrow();
            const featuredRows = [
                ...Array.from({ length: 4 }, (_, index) => ({
                    candidateId: `high-${index + 1}`,
                    accountContext: 'personal',
                    riskBand: 'high_risk',
                    displayScore: 10 - index / 10,
                    featuredRank: index < 3 ? index + 1 : null,
                })),
                ...Array.from({ length: 11 }, (_, index) => ({
                    candidateId: `caution-${String(index + 1).padStart(2, '0')}`,
                    accountContext: 'personal',
                    riskBand: 'caution',
                    displayScore: 6.7 - index / 10,
                    featuredRank: index < 10 ? index + 1 : null,
                })),
            ];
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:final-score',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.4'
                )`,
                [JSON.stringify(featuredRows)]
            )).resolves.toBeDefined();
            const storedRanks = await migrationDb.query<{
                candidate_id: string;
                featured_rank: number | null;
            }>(`
                SELECT candidate_id, featured_rank
                FROM public.analysis_v2_candidate_score_rows
                WHERE candidate_id IN ('high-4', 'caution-10', 'caution-11')
                ORDER BY candidate_id
            `);
            expect(storedRanks.rows).toEqual([
                { candidate_id: 'caution-10', featured_rank: 10 },
                { candidate_id: 'caution-11', featured_rank: null },
                { candidate_id: 'high-4', featured_rank: null },
            ]);
            const patchedDefinition = await migrationDb.query<{ definition: string }>(
                `SELECT pg_catalog.pg_get_functiondef(
                    'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                        ::pg_catalog.regprocedure
                ) AS definition`
            );
            expect(patchedDefinition.rows[0]!.definition).toContain(
                "CASE WHEN p_risk_policy_version = 'risk-policy-v2.3'"
            );
            expect(patchedDefinition.rows[0]!.definition).toContain('THEN 97 ELSE 95 END');
            expect(patchedDefinition.rows[0]!.definition).toContain('100\n                    )) AS expected_raw_score');
            expect(patchedDefinition.rows[0]!.definition).toContain("THEN 15\n                                ELSE 10");
            expect(patchedDefinition.rows[0]!.definition).toContain(
                "p_risk_policy_version = 'risk-policy-v2.4'"
            );
            expect(patchedDefinition.rows[0]!.definition).toContain(
                'analysis_v2_expected_relative_risk_rows(\n                            v_rows,'
            );
            expect(patchedDefinition.rows[0]!.definition).toContain(
                ', p_risk_policy_version\n        ) AS expected'
            );
            expect(patchedDefinition.rows[0]!.definition).toContain('expected_rank <= 3');
            expect(patchedDefinition.rows[0]!.definition).not.toContain('expected_rank <= 15');

            await migrationDb.exec(functionDefinitionFrom(
                riskPolicyV25Migration,
                'analysis_v2_expected_relative_risk_rows_v25'
            ));
            await migrationDb.exec(functionDefinitionFrom(
                riskPolicyV25Migration,
                'analysis_v2_expected_relative_risk_rows'
            ));
            await migrationDb.exec(migrationBlockFrom(
                riskPolicyV25Migration,
                '-- The preliminary checkpoint shape and component math'
            ));
            await migrationDb.exec(migrationBlockFrom(
                riskPolicyV25Migration,
                '-- Patch only the version gates in the audited candidate checkpoint.'
            ));
            await migrationDb.exec(`
                UPDATE public.analysis_requests
                SET policy_versions_snapshot = '{"risk":"risk-policy-v2.5"}'::JSONB
                WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
            `);
            await expect(migrationDb.query(
                `SELECT public.checkpoint_analysis_v2_preliminary_scores_v24(
                    '10000000-0000-4000-8000-000000000001'::UUID,
                    'coordinator:candidate-screening',
                    '20000000-0000-4000-8000-000000000001'::UUID,
                    'input',
                    $1::JSONB,
                    'risk-policy-v2.5'
                )`,
                [JSON.stringify([{
                    candidateId: 'v24-preliminary',
                    components: {
                        candidateToTargetLikes: 24,
                        candidateToTargetComments: 30,
                        candidateToTargetTagOrCaptionMention: 12,
                        targetToCandidateTagOrCaptionMention: 8,
                        targetToCandidateLike: 0,
                        recentMutual: 5,
                        appearanceExposure: 16,
                    },
                    preScore: 95,
                    possibleUpperBound: 100,
                    recentMutualRank: null,
                    verificationShortlistRank: 1,
                }])]
            )).resolves.toBeDefined();
            const v25Rows = [
                {
                    candidateId: 'relative:v25-a', publicScore: 4.1,
                    displayScore: 6.8, riskBand: 'high_risk', featuredRank: 1,
                    accountContext: 'personal', components: {},
                },
                {
                    candidateId: 'relative:v25-b', publicScore: 3.1,
                    displayScore: 6.8, riskBand: 'high_risk', featuredRank: 2,
                    accountContext: 'personal', components: {},
                },
                {
                    candidateId: 'relative:v25-c', publicScore: 2.1,
                    displayScore: 4.2, riskBand: 'caution', featuredRank: 1,
                    accountContext: 'personal', components: {},
                },
                {
                    candidateId: 'relative:v25-d', publicScore: 1.1,
                    displayScore: 4.2, riskBand: 'caution', featuredRank: 2,
                    accountContext: 'personal', components: {},
                },
            ];
            await expect(checkpointScoreRows(
                v25Rows, 'risk-policy-v2.5'
            )).resolves.toBeDefined();
            const v25Definition = await migrationDb.query<{ definition: string }>(
                `SELECT pg_catalog.pg_get_functiondef(
                    'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                        ::pg_catalog.regprocedure
                ) AS definition`
            );
            expect(v25Definition.rows[0]?.definition).toContain(
                "'risk-policy-v2.4', 'risk-policy-v2.5'"
            );
        } finally {
            await migrationDb.close();
        }
    });
});
