import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724111000_deduplicate_analysis_v2_result_overviews.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 result overview deduplication migration', () => {
    it('makes future finalized overview copy unique per account', () => {
        expect(migration).toMatch(
            /count\(\*\) OVER \(\s*PARTITION BY feature\.one_line_overview\s*\) > 1/
        );
        expect(migration).toMatch(
            /feature\.instagram_id\s*\|\| ' 계정은 위험도 '/
        );
        expect(migration).toContain('pg_catalog.round(score.display_score)');
        expect(migration).toContain(
            "'public.analysis_v2_complete_result_and_purge_internal("
        );
    });

    it('offers a bounded idempotent repair only for recent completed test results', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.repair_analysis_v2_duplicate_overviews'
        );
        expect(migration).toContain(
            "v_request.plan_access_mode_snapshot <> 'test_entitlement'"
        );
        expect(migration).toContain(
            "v_request.completed_at < v_now - INTERVAL '24 hours'"
        );
        expect(migration).toContain('HAVING pg_catalog.count(*) > 1');
        expect(migration).toContain("'updatedCount'");
        expect(migration).toContain("'uniqueCount'");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.repair_analysis_v2_duplicate_overviews\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.repair_analysis_v2_duplicate_overviews\(UUID\)[\s\S]*?TO service_role/
        );
    });
});
