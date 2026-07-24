import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724104500_fix_analysis_v2_finalizer_exclusion_hash.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 finalizer exclusion hash migration', () => {
    it('replaces the cross-domain relationship hash comparison in both finalizer gates', () => {
        expect(migration).toContain(
            "'public.analysis_v2_complete_result_and_purge_internal("
        );
        expect(migration).toContain(
            "'public.load_analysis_v2_finalizer_readiness("
        );
        expect(migration).toContain(
            "'scope.exclusion_decision_hash = v_relationship.exclusion_decision_hash'"
        );
        expect(migration).toContain(
            "'relationship.exclusion_decision_hash'"
        );
        expect(migration.match(/analysis-v2-exclusion-decision-v1/g)).toHaveLength(2);
        expect(migration.match(/analysis_v2_dag_hash_json/g)).toHaveLength(2);
    });

    it('guards every dynamic replacement against definition drift', () => {
        expect(migration.match(/pg_catalog\.strpos\(v_definition, v_old\) = 0/g))
            .toHaveLength(2);
        expect(migration.match(/ANALYSIS_V2_FINALIZER_EXCLUSION_HASH_MIGRATION_DRIFT/g))
            .toHaveLength(2);
    });
});
