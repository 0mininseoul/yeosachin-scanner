import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const fixMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731170000_remove_final_score_policy_argument_ambiguity.sql',
        import.meta.url
    ),
    'utf8'
);
const baseMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713185711_add_analysis_v2_result_finalization.sql',
        import.meta.url
    ),
    'utf8'
);
const v23Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123400_add_relative_risk_policy_v23.sql',
        import.meta.url
    ),
    'utf8'
);
const v24Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260726090000_add_risk_policy_v24.sql',
        import.meta.url
    ),
    'utf8'
);
const v25Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728180000_add_risk_policy_v25.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinitionFrom(source: string, name: string, last = false): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = last ? source.lastIndexOf(marker) : source.indexOf(marker);
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

function migrationBlockFrom(source: string, marker: string): string {
    const markerStart = source.indexOf(marker);
    if (markerStart < 0) throw new Error(`Missing migration block ${marker}`);
    const start = marker.startsWith('--')
        ? source.indexOf('DO $migration$', markerStart)
        : source.lastIndexOf('DO $migration$', markerStart);
    const end = source.indexOf('\n$migration$;', start);
    if (start < 0 || end < 0) throw new Error(`Unbounded migration block ${marker}`);
    return source.slice(start, end + '\n$migration$;'.length);
}

async function currentDefinition(db: PGlite): Promise<string> {
    const result = await db.query<{ definition: string }>(`
        SELECT pg_catalog.pg_get_functiondef(
            'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                ::pg_catalog.regprocedure
        ) AS definition
    `);
    return result.rows[0]!.definition;
}

describe('final-score policy argument ambiguity repair', () => {
    it('patches the actual v2.4 plus v2.5 predecessor without removing the helper argument', async () => {
        const db = await PGlite.create();
        try {
            await db.exec(`
                SET check_function_bodies = false;
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE TABLE public.analysis_pipeline_jobs (
                    job_key TEXT, track TEXT, kind TEXT, batch INTEGER
                );
                CREATE TABLE public.analysis_v2_candidate_score_manifests (
                    request_id UUID, producer_job_key TEXT, producer_input_hash TEXT,
                    producer_claim_token UUID, risk_policy_version TEXT,
                    item_count INTEGER, result_hash TEXT
                );
            `);
            await db.exec(functionDefinitionFrom(
                baseMigration, 'checkpoint_analysis_v2_candidate_scores', true
            ));
            await db.exec(functionDefinitionFrom(
                v23Migration, 'analysis_v2_expected_relative_risk_rows'
            ));
            await db.exec(migrationBlockFrom(
                v23Migration, 'v_old_display_check TEXT := $old$'
            ));
            await db.exec(functionDefinitionFrom(
                v24Migration, 'analysis_v2_expected_relative_risk_rows_v23'
            ));
            await db.exec(functionDefinitionFrom(
                v24Migration, 'analysis_v2_expected_relative_risk_rows'
            ));
            await db.exec(migrationBlockFrom(
                v24Migration, 'v_tag_component_pattern TEXT := $pattern$'
            ));
            await db.exec(functionDefinitionFrom(
                v25Migration, 'analysis_v2_expected_relative_risk_rows_v25'
            ));
            await db.exec(functionDefinitionFrom(
                v25Migration, 'analysis_v2_expected_relative_risk_rows'
            ));
            await db.exec(migrationBlockFrom(
                v25Migration, '-- Patch only the version gates in the audited candidate checkpoint.'
            ));

            const before = await currentDefinition(db);
            expect(before).toContain(
                ')) AS expected_raw_score\n        , p_risk_policy_version\n        ) AS expected_score'
            );

            await expect(db.exec(fixMigration)).resolves.toBeDefined();

            const after = await currentDefinition(db);
            expect(after).not.toContain(
                ')) AS expected_raw_score\n        , p_risk_policy_version\n        ) AS expected_score'
            );
            expect(after.match(/, p_risk_policy_version\n        \) AS expected/g)).toHaveLength(2);
            expect(after).toContain(
                ')\n        , p_risk_policy_version\n        ) AS expected\n'
            );
            expect(after).toContain(
                "p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5')"
            );
            expect(after).toContain('SECURITY DEFINER');
            expect(after).toContain("SET search_path TO ''");
        } finally {
            await db.close();
        }
    });

    it('removes the output-column collision so an unqualified helper argument resolves', async () => {
        const db = await PGlite.create();
        try {
            await db.exec(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE FUNCTION public.analysis_v2_expected_relative_risk_rows(
                    JSONB, TEXT[], TEXT
                ) RETURNS TABLE(candidate_id TEXT)
                LANGUAGE sql IMMUTABLE AS $function$ SELECT 'candidate'::TEXT $function$;
                CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    p_request_id UUID,
                    p_job_key TEXT,
                    p_claim_token UUID,
                    p_job_input_hash TEXT,
                    p_rows JSONB,
                    p_risk_policy_version TEXT
                ) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
                DECLARE v_candidate_id TEXT;
                BEGIN
                    IF p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5')
                    THEN RAISE EXCEPTION 'policy'; END IF;
                    SELECT expected.candidate_id INTO v_candidate_id
                    FROM (VALUES (1)) AS item(value)
                    CROSS JOIN LATERAL (
                        SELECT
                GREATEST(0, LEAST(
                    item.value,
                    100
                )) AS expected_raw_score
        , p_risk_policy_version
        ) AS expected_score
                    CROSS JOIN LATERAL (
                        SELECT pg_catalog.row_number() OVER (
                            ORDER BY item.value
        , p_risk_policy_version
        ) AS expected_rank
                    ) AS ranked
                    JOIN public.analysis_v2_expected_relative_risk_rows(
                            p_rows,
                            ARRAY(
                                SELECT 'candidate'::TEXT
                            )
                        , p_risk_policy_version
        ) AS expected ON TRUE;
                    RETURN pg_catalog.jsonb_build_object('candidateId', v_candidate_id);
                END;
                $function$;
                REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    UUID, TEXT, UUID, TEXT, JSONB, TEXT
                ) FROM PUBLIC, anon, authenticated, service_role;
                GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
                    UUID, TEXT, UUID, TEXT, JSONB, TEXT
                ) TO service_role;
            `);
            const invoke = () => db.query(`
                SELECT public.checkpoint_analysis_v2_candidate_scores(
                    '10000000-0000-4000-8000-000000000001', 'coordinator:join:final-score',
                    '20000000-0000-4000-8000-000000000001', 'input', '[]'::JSONB,
                    'risk-policy-v2.5'
                )
            `);

            await expect(invoke()).rejects.toThrow(/ambiguous/i);
            await db.exec(fixMigration);
            await expect(invoke()).resolves.toBeDefined();

            const acl = await db.query<{ acl: string[] | null }>(`
                SELECT proc.proacl::TEXT[] AS acl
                FROM pg_catalog.pg_proc AS proc
                WHERE proc.oid =
                    'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
                        ::pg_catalog.regprocedure
            `);
            expect(acl.rows[0]!.acl).toContain('service_role=X/postgres');
            expect(acl.rows[0]!.acl).not.toEqual(expect.arrayContaining([
                expect.stringMatching(/^(PUBLIC|anon|authenticated)=/),
            ]));
        } finally {
            await db.close();
        }
    });
});
