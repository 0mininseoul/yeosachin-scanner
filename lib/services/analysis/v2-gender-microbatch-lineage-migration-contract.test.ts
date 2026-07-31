import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731140000_accept_gender_microbatch_candidate_lineage.sql',
        import.meta.url
    ),
    'utf8'
);

describe('gender microbatch candidate-lineage migration contract', () => {
    it('accepts only a matching ready same-job gender scheduler envelope', () => {
        expect(migration).toContain('scheduler.request_id = p_request_id');
        expect(migration).toContain('scheduler.job_key = p_job_key');
        expect(migration).toContain("scheduler.stage = ''genderTriage''");
        expect(migration).toContain("scheduler.status = ''ready''");
        expect(migration).toContain("= item.value->>''genderOperationKey''");
        expect(migration).toContain(
            "p_result->>'operationKey' IS DISTINCT FROM p_expected_operation_key"
        );
        expect(migration).toContain("NOT p_result ?& ARRAY['operationKey', 'results']");
        expect(migration).toContain('FROM pg_catalog.jsonb_object_keys(p_result)');
        expect(migration).toContain("item.value->>'source' IN ('checkpoint', 'safe_fallback')");
        expect(migration).not.toContain('SECURITY DEFINER');
    });

    it('keeps canonicalization bounded, immutable, and inaccessible over Data API roles', () => {
        expect(migration).toContain('IMMUTABLE');
        expect(migration).toContain('p_depth NOT BETWEEN 0 AND 32');
        expect(migration).toContain("jsonb_array_length(p_result->'results') NOT BETWEEN 1 AND 64");
        expect(migration).toContain('pg_catalog.octet_length(p_result::TEXT) > 524288');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_ai_canonical_json_text(JSONB, INTEGER)'
        );
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_gender_scheduler_contains_hash(JSONB, TEXT, TEXT)'
        );
        expect(migration).toContain(
            'ANALYSIS_V2_GENDER_MICROBATCH_LINEAGE_MIGRATION_DRIFT_'
        );
    });
});
