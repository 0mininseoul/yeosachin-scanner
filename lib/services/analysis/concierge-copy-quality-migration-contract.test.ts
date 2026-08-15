import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260815130000_concierge_v211_copy_quality_correction.sql', import.meta.url),
    'utf8',
);

describe('v2.11 concierge copy correction migration contract', () => {
    it('is forward-only, service-role-only, empty-search-path, and CAS-bound', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815113000');
        expect(migration).toContain('CREATE TABLE public.earlybird_v211_concierge_copy_corrections');
        expect(migration).toContain('CREATE FUNCTION public.correct_earlybird_v211_concierge_copy');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.correct_earlybird_v211_concierge_copy');
        expect(migration).toContain('TO service_role');
        expect(migration).toContain('published_source_fingerprint IS DISTINCT FROM p_source_fingerprint');
        expect(migration).toContain('published_result_hash IS DISTINCT FROM p_expected_published_result_hash');
        expect(migration).toContain('CONCIERGE_COPY_CORRECTION_REFUND_REJECTED');
        expect(migration).toContain('CONCIERGE_COPY_CORRECTION_IMMUTABLE');
    });

    it('rejects the exact v2.11 generic copies and does not broaden row scope', () => {
        expect(migration).toContain('사진과 소개에 드러난 개인 기록의 결이 선명해서');
        expect(migration).toContain('공개 프로필과 최근 피드, 맞팔 흐름은');
        expect(migration).toContain("v_result_count IS DISTINCT FROM 16");
        expect(migration).toContain("v_high_risk_count IS DISTINCT FROM 2");
        expect(migration).toContain("current_row.risk_grade IS DISTINCT FROM item->>'riskGrade'");
        expect(migration).toContain('UPDATE public.analysis_results');
        expect(migration).toContain('SET one_line_overview');
        expect(migration).toContain('risk_analysis = v_row');
        expect(migration).not.toContain('DELETE FROM public.analysis_results');
        expect(migration).not.toContain('UPDATE public.earlybird_v211_concierge_replays');
    });
});
