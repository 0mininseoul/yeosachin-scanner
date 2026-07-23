import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260723191547_persist_analysis_v2_gender_stats.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = migration.indexOf(marker);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('analysis V2 result gender stats migration contract', () => {
    it('adds durable constrained aggregate columns and backfills legacy results', () => {
        for (const column of ['male_count', 'female_count', 'unknown_count']) {
            expect(migration).toContain(`ADD COLUMN ${column} SMALLINT`);
            expect(migration).toContain(`ALTER COLUMN ${column} SET NOT NULL`);
        }
        expect(migration).toContain(
            'male_count + female_count + unknown_count = screened_mutuals'
        );
        expect(migration).toContain('analysis_request.gender_stats');
        expect(migration).toContain('public.analysis_v2_female_results');
        expect(migration).toContain("pg_catalog.jsonb_typeof(");
    });

    it('derives each terminal classification before a final summary is inserted', () => {
        const populator = functionDefinition('analysis_v2_populate_result_gender_stats');
        expect(populator).toContain(
            "feature.terminal_classification = 'verified_non_female'"
        );
        expect(populator).toContain(
            "feature.terminal_classification = 'verified_female'"
        );
        expect(populator).toContain(
            "feature.terminal_classification NOT IN ("
        );
        expect(populator).toContain("MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY'");
        expect(migration).toContain(
            'BEFORE INSERT ON public.analysis_v2_result_summaries'
        );
        expect(migration).toContain(
            'EXECUTE FUNCTION public.analysis_v2_populate_result_gender_stats()'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_populate_result_gender_stats\(\)/
        );
    });

    it('serializes the persisted aggregate without exposing staging rows', () => {
        const summaryJson = functionDefinition('analysis_v2_result_summary_json');
        expect(summaryJson).toContain("'genderStats'");
        expect(summaryJson).toContain("'male', p_summary.male_count");
        expect(summaryJson).toContain("'female', p_summary.female_count");
        expect(summaryJson).toContain("'unknown', p_summary.unknown_count");
        expect(summaryJson).not.toContain('analysis_v2_candidate_feature_rows');
    });
});
