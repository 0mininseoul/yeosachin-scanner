import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260801190000_return_cross_count_relationship_adoption_source_count.sql',
    import.meta.url
), 'utf8');

describe('cross-count relationship adoption source-count migration', () => {
    it('patches only the cross-count resolver return object', () => {
        expect(migration).toContain('RETURN v_exact;');
        expect(migration).toContain('v_source_count := CASE v_side');
        expect(migration).toContain("'relationshipSourceDeclaredCount'', v_source_count");
        expect(migration).toContain(
            'v_rewritten := pg_catalog.replace(v_definition, v_old_return, v_new_return);'
        );
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(migration).not.toContain('ALTER FUNCTION');
        expect(migration).not.toContain('CREATE TABLE');
    });

    it('retains the resolver security and service-only grants', () => {
        expect(migration).toContain('COALESCE(\'search_path=""\' = ANY(proc.proconfig), FALSE)');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_SHAPE_MISMATCH');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_REWRITE_MISMATCH');
    });
});
