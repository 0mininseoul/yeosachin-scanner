import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260714060239_fix_analysis_v2_candidate_feature_validation.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 candidate feature validation correction', () => {
    it('parenthesizes the extracted JSONB feature object before key subtraction', () => {
        const definition = functionDefinition(
            'analysis_v2_checkpoint_candidate_features_complete'
        );

        expect(definition).toContain(
            "OR (item.value->'feature') - ARRAY["
        );
        expect(definition).not.toContain(
            "OR item.value->'feature' - ARRAY["
        );
        expect(definition.match(/\]::TEXT\[\] <> '\{\}'::JSONB/g)).toHaveLength(2);
    });

    it('retains the job fence and immutable staging writes', () => {
        const definition = functionDefinition(
            'analysis_v2_checkpoint_candidate_features_complete'
        );

        expect(definition).toContain('analysis_v2_assert_result_job_fence');
        expect(definition).toContain(
            'INSERT INTO public.analysis_v2_candidate_feature_manifests'
        );
        expect(definition).toContain(
            'INSERT INTO public.analysis_v2_candidate_feature_rows'
        );
        expect(definition).toContain("SET search_path = ''");
    });
});
