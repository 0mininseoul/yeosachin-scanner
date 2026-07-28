import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignRelativeRiskTiersV25 } from '@/lib/domain/analysis/relative-risk-policy';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728180000_add_risk_policy_v25.sql',
        import.meta.url
    ),
    'utf8'
);
const schedulerMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728110000_add_ai_stage_policy_v210.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinitionFrom(source: string, name: string, occurrence = 0): string {
    const replaceMarker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const createMarker = `CREATE FUNCTION public.${name}(`;
    const marker = source.includes(replaceMarker) ? replaceMarker : createMarker;
    let start = -1;
    for (let index = 0; index <= occurrence; index += 1) {
        start = source.indexOf(marker, start + 1);
    }
    if (start < 0) throw new Error(`Missing function ${name}`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`Unbounded function ${name}`);
    return source.slice(start, end + 4);
}

function functionDefinition(name: string, occurrence = 0): string {
    return functionDefinitionFrom(migration, name, occurrence);
}

function migrationBlock(marker: string): string {
    const start = migration.indexOf(marker);
    if (start < 0) throw new Error(`Missing migration block ${marker}`);
    const blockStart = migration.indexOf('DO $migration$', start);
    const end = migration.indexOf('\n$migration$;', blockStart);
    if (blockStart < 0 || end < 0) throw new Error(`Unbounded migration block ${marker}`);
    return migration.slice(blockStart, end + '\n$migration$;'.length);
}

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(functionDefinition('analysis_v2_expected_relative_risk_rows_v25'));
});

afterAll(async () => {
    await db.close();
});

async function expected(rows: readonly Record<string, unknown>[], strongIds: string[] = []) {
    return (await db.query<{
        candidate_id: string;
        display_score: number;
        risk_band: string;
        relative_tier_applied: boolean;
    }>(
        `SELECT candidate_id, display_score::FLOAT8 AS display_score,
                risk_band, relative_tier_applied
         FROM public.analysis_v2_expected_relative_risk_rows_v25(
            $1::JSONB, $2::TEXT[]
         )
         ORDER BY candidate_id`,
        [JSON.stringify(rows), strongIds]
    )).rows;
}

describe('risk-policy v2.5 database replay', () => {
    it('assigns a two-person floor while preserving two caution rows', async () => {
        const rows = await expected([
            { candidateId: 'a', publicScore: 4.1, components: {} },
            { candidateId: 'b', publicScore: 3.1, components: {} },
            { candidateId: 'c', publicScore: 2.1, components: {} },
            { candidateId: 'd', publicScore: 1.1, components: {} },
        ]);

        expect(rows.filter(row => row.risk_band === 'high_risk')).toHaveLength(2);
        expect(rows.filter(row => row.risk_band === 'caution')).toHaveLength(2);
    });

    it('uses three only when the third high-pool score reaches 4.2', async () => {
        const qualified = await expected([
            { candidateId: 'a', publicScore: 7.1, components: {} },
            { candidateId: 'b', publicScore: 6.1, components: {} },
            { candidateId: 'c', publicScore: 4.2, components: {} },
            { candidateId: 'd', publicScore: 3.1, components: {} },
            { candidateId: 'e', publicScore: 2.1, components: {} },
        ]);
        const below = await expected([
            { candidateId: 'a', publicScore: 7.1, components: {} },
            { candidateId: 'b', publicScore: 6.1, components: {} },
            { candidateId: 'c', publicScore: 4.1, components: {} },
            { candidateId: 'd', publicScore: 3.1, components: {} },
            { candidateId: 'e', publicScore: 2.1, components: {} },
        ]);

        expect(qualified.filter(row => row.risk_band === 'high_risk')).toHaveLength(3);
        expect(below.filter(row => row.risk_band === 'high_risk')).toHaveLength(2);
    });

    it('keeps inbound and official/partner exclusions exact', async () => {
        const rows = await expected([
            { candidateId: 'official', publicScore: 9, accountContext: 'official_group_or_brand', components: { candidateToTargetLikes: 24 } },
            { candidateId: 'partner', publicScore: 3.4, components: { candidateToTargetLikes: 24 } },
            { candidateId: 'no-inbound', publicScore: 7, components: {} },
            { candidateId: 'inbound', publicScore: 2, components: { candidateToTargetComments: 2.5 } },
            { candidateId: 'low-a', publicScore: 1.5, components: {} },
            { candidateId: 'low-b', publicScore: 1.2, components: {} },
        ], ['partner']);

        expect(rows.filter(row => row.risk_band === 'high_risk')).toEqual([
            expect.objectContaining({ candidate_id: 'inbound' }),
        ]);
        expect(rows.find(row => row.candidate_id === 'official')?.risk_band).toBe('normal');
        expect(rows.find(row => row.candidate_id === 'partner')?.relative_tier_applied).toBe(false);
    });

    it('matches the TypeScript policy across deterministic boundary cohorts', async () => {
        const cohorts = [
            [4.2, 4.1, 3, 2, 1],
            [7, 6.8, 6.7, 4.2, 4.1, 1],
            Array.from({ length: 16 }, (_, index) => Math.max(1, 8 - index * 0.4)),
        ];
        for (const [cohortIndex, scores] of cohorts.entries()) {
            const source = scores.map((publicScore, index) => ({
                candidateId: `c${cohortIndex}-${index}`,
                publicScore,
                accountContext: index === scores.length - 1
                    ? 'official_group_or_brand'
                    : 'personal',
                components: index % 2 === 0 ? { candidateToTargetLikes: 6 } : {},
            }));
            const sqlRows = await expected(source);
            const tsRows = assignRelativeRiskTiersV25(source.map(row => ({
                candidateId: row.candidateId,
                naturalPublicScore: row.publicScore,
                naturalDisplayScore: Math.round(row.publicScore * 10) / 10,
                naturalRiskBand: row.publicScore < 4.2
                    ? 'normal' as const
                    : row.publicScore < 6.8 ? 'caution' as const : 'high_risk' as const,
                partnerCapApplied: false,
                isInbound: (row.components.candidateToTargetLikes ?? 0) > 0,
                personalRiskEligible: row.accountContext !== 'official_group_or_brand',
            }))).slice().sort((left, right) => left.candidateId.localeCompare(right.candidateId));

            expect(sqlRows).toEqual(tsRows.map(row => ({
                candidate_id: row.candidateId,
                display_score: row.displayScore,
                risk_band: row.riskBand,
                relative_tier_applied: row.relativeTierApplied,
            })));
        }
    });

    it('declares forward-only snapshot, checkpoint, claim, finalization, and audit support', () => {
        expect(migration).toContain("'risk-policy-v2.5'");
        expect(migration).toContain('analysis_v2_expected_relative_risk_rows_v25');
        expect(migration).toContain('checkpoint_analysis_v2_preliminary_scores_v24');
        expect(migration).toContain('checkpoint_analysis_v2_candidate_scores');
        expect(migration).toContain('claim_analysis_v2_scheduler_operation');
        expect(migration).toContain('analysis_v2_complete_result_and_purge_before_v28_tone');
        expect(migration).toContain('analysis_v2_score_audit_expected_v25_components');
        expect(migration).toContain('materialize_analysis_v2_score_audit');
        expect(migration).not.toContain('UPDATE public.analysis_requests SET policy_versions_snapshot');
    });

    it('patches the current scheduler claim with exact v2.5 snapshot twins', async () => {
        const patchDb = await PGlite.create();
        try {
            await patchDb.exec(`
                SET check_function_bodies = false;
                CREATE TABLE public.analysis_requests (
                    id uuid, status text, pipeline_version text,
                    policy_versions_snapshot jsonb
                );
                CREATE TABLE public.analysis_pipeline_jobs (
                    request_id uuid, job_key text, status text, lease_token uuid,
                    lease_expires_at timestamptz
                );
                CREATE TABLE public.analysis_v2_scheduler_operations (
                    request_id uuid, job_key text, operation_key text, stage text,
                    status text, claim_token uuid, lease_expires_at timestamptz,
                    not_before_at timestamptz, recovery_deadline_at timestamptz,
                    result_json jsonb, updated_at timestamptz
                );
                CREATE TABLE public.analysis_v2_ai_result_checkpoints (
                    request_id uuid, job_key text, operation_key text, stage text
                );
                CREATE TABLE public.analysis_v2_ai_attempts (
                    request_id uuid, job_key text, operation_key text, status text
                );
                CREATE TABLE public.analysis_v2_gemini_leases (request_id uuid);
            `);
            await patchDb.exec(functionDefinitionFrom(
                schedulerMigration,
                'claim_analysis_v2_scheduler_operation',
            ));
            await patchDb.exec(migrationBlock(
                '-- Scheduler claims use exact immutable snapshots.',
            ));
            const definition = await patchDb.query<{ definition: string }>(
                `SELECT pg_catalog.pg_get_functiondef(
                    'public.claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)'
                        ::regprocedure
                ) AS definition`
            );
            expect(
                definition.rows[0]?.definition.match(/risk-policy-v2\.5/g)
            ).toHaveLength(3);
            expect(
                definition.rows[0]?.definition.match(/risk-policy-v2\.4/g)
            ).toHaveLength(3);

            await patchDb.exec(functionDefinitionFrom(
                readFileSync(new URL(
                    '../../../supabase/migrations/20260727034000_add_analysis_v2_scheduler_live_operations.sql',
                    import.meta.url
                ), 'utf8'),
                'acquire_analysis_v2_scheduler_gemini_lease_v1',
            ));
            await patchDb.exec(migrationBlock(
                '-- The scheduler-specific Gemini admission RPC',
            ));
            const leaseDefinition = await patchDb.query<{ definition: string }>(
                `SELECT pg_catalog.pg_get_functiondef(
                    'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'
                        ::regprocedure
                ) AS definition`
            );
            expect(
                leaseDefinition.rows[0]?.definition.match(/risk-policy-v2\.5/g)
            ).toHaveLength(3);
            expect(
                leaseDefinition.rows[0]?.definition.match(/risk-policy-v2\.4/g)
            ).toHaveLength(3);
        } finally {
            await patchDb.close();
        }
    });
});
