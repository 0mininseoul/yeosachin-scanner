import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731120000_populate_adopted_evidence_provider_composites.sql',
        import.meta.url
    ),
    'utf8'
);

describe('adopted evidence provider composite migration', () => {
    it('loads the exact four-column adopted source under the destination identity', () => {
        expect(migration).toContain(
            'provider_run.operation_key = adoption.source_operation_key'
        );
        expect(migration).toContain(
            'provider_run.run_id = adoption.source_run_id'
        );
        expect(migration).toContain(
            'adoption.destination_input_hash = p_input_hash'
        );
        expect(migration).toContain("provider_run.status = 'succeeded'");
        expect(migration).toContain(
            'provider_run.usage_reconciled_at IS NOT NULL'
        );
        expect(migration).toContain('FOR UPDATE OF provider_run');
        expect(migration).toContain('FOR UPDATE;');
        expect(migration).toContain(
            'adoption.destination_input_hash = p_input_hash'
        );
        expect(migration).toContain('direct_run.request_id = p_request_id');
    });

    it('repopulates every composite after the boolean fence', () => {
        expect(migration).toContain('INTO STRICT v_provider_run');
        expect(migration).toContain('INTO STRICT v_liker_provider_run');
        expect(migration).toContain('INTO STRICT v_comment_provider_run');
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_EVIDENCE_SOURCE_INVALID'
        );
    });

    it('preserves public writer ABI and service-role-only ACL', () => {
        expect(migration).toContain(
            'public.checkpoint_analysis_v2_relationship_side('
        );
        expect(migration).toContain(
            'public.checkpoint_analysis_v2_target_evidence('
        );
        expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
        expect(migration).toContain('TO service_role');
        expect(migration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role'
        );
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_COMPOSITE_TARGET_MARKER_COUNT_MISMATCH'
        );
        expect(migration).toContain(
            "pg_catalog.length('INTO STRICT v_liker_provider_run') <> 1"
        );
    });
});
