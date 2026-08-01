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
        expect(migration).toContain('1486eec1954681d6da029172d1976d2e');
        expect(migration).toContain('cca684d93ea8d4e234ef6fe0f049f920');
        expect(migration).toContain('v_expected_new_definition_hash');
        expect(migration).toContain('v_expected_old_definition_hash');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_BLOCK_MISMATCH');
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(migration).not.toContain('ALTER FUNCTION');
        expect(migration).not.toContain('CREATE TABLE');
    });

    it('retains the resolver security and service-only grants', () => {
        expect(migration).toContain('COALESCE(\'search_path=""\' = ANY(proc.proconfig), FALSE)');
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')"
        );
        expect(migration).toContain(
            "NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')"
        );
        expect(migration).toContain(
            'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id'
        );
        expect(migration).toContain(
            'source_run.actual_usage_usd <= source_run.max_charge_usd + 0.000000001'
        );
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_SHAPE_MISMATCH');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_ADOPTION_SOURCE_COUNT_REWRITE_MISMATCH');
    });
});
