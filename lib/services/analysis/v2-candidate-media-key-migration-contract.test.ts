import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260714063833_fix_analysis_v2_candidate_media_key.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 candidate media key correction', () => {
    it('parenthesizes JSON text extraction before concatenating the media bundle key', () => {
        const definition = functionDefinition(
            'analysis_v2_checkpoint_candidate_features_complete'
        );

        expect(definition).toContain(
            "|| (item.value->'mediaContext'->>'bundleId')"
        );
        expect(definition).not.toContain(
            "|| item.value->'mediaContext'->>'bundleId'"
        );
    });

    it('retains both prior runtime parser corrections', () => {
        const definition = functionDefinition(
            'analysis_v2_checkpoint_candidate_features_complete'
        );

        expect(definition).toContain(
            "OR (item.value->'feature') - ARRAY["
        );
        expect(definition).toContain(
            ']::TEXT[] <> \'{}\'::JSONB'
        );
        expect(definition).toContain('analysis_v2_assert_result_job_fence');
        expect(definition).toContain("SET search_path = ''");
    });
});
