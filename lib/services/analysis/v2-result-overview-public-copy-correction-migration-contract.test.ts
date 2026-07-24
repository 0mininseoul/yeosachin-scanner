import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724112000_correct_analysis_v2_overview_public_copy.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 overview public-copy correction migration', () => {
    it('uses account-specific Korean risk bands without exposing numeric metrics', () => {
        expect(migration).toContain("WHEN 'normal' THEN '일반'");
        expect(migration).toContain("WHEN 'caution' THEN '주의'");
        expect(migration).toContain("WHEN 'high_risk' THEN '고위험'");
        expect(migration).toContain("|| ' 단계로 판독됐어요.'");
        expect(migration).toContain(
            "'public.analysis_v2_complete_result_and_purge_internal("
        );
    });

    it('repairs the already completed authorized sample idempotently', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.repair_analysis_v2_duplicate_overviews'
        );
        expect(migration).toMatch(
            /LIKE\s+'% · '\s*\|\| female\.instagram_id/
        );
        expect(migration).toContain(
            "v_request.plan_access_mode_snapshot <> 'test_entitlement'"
        );
        expect(migration).toContain("'updatedCount'");
        expect(migration).toContain("'uniqueCount'");
    });
});
