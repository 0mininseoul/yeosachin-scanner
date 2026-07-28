import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260728190000_persist_analysis_v2_target_full_name.sql',
    import.meta.url
);

describe('analysis V2 target full-name migration contract', () => {
    it('persists a bounded nullable target full name before terminal PII scrubbing', () => {
        const migration = readFileSync(migrationUrl, 'utf8');

        expect(migration).toContain(
            'ADD COLUMN target_full_name VARCHAR(200)'
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_populate_result_target_full_name()'
        );
        expect(migration).toContain(
            'WHERE preflight.consumed_request_id = NEW.request_id'
        );
        expect(migration).toContain(
            'NEW.target_full_name := v_target_full_name'
        );
        expect(migration).toContain(
            "'targetFullName', p_summary.target_full_name"
        );
        expect(migration).not.toMatch(
            /UPDATE public\.analysis_v2_result_summaries[\s\S]*target_full_name/iu
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_populate_result_target_full_name\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/iu
        );
    });
});
