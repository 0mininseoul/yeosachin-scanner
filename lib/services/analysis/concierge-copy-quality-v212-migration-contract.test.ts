import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260815160000_concierge_v212_copy_quality_correction.sql',
    import.meta.url,
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('v2.12 concierge copy correction migration contract', () => {
    it('is a forward-only, service-role-only correction chained to the immutable v2.11 correction', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815141000');
        expect(migration).toContain('CREATE TABLE public.earlybird_v212_concierge_copy_corrections');
        expect(migration).toContain('CREATE FUNCTION public.correct_earlybird_v212_concierge_copy');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('TO service_role');
        expect(migration).toContain('prior_correction_result_hash');
        expect(migration).toContain('CONCIERGE_COPY_V212_PRIOR_CORRECTION_CONFLICT');
    });

    it('binds every update to the prior published copy and changes only copy fields', () => {
        expect(migration).toContain('current_row.one_line_overview IS DISTINCT FROM item->>\'oneLineOverview\'');
        expect(migration).toContain('current_row.risk_analysis IS DISTINCT FROM item->\'riskAnalysis\'');
        expect(migration).toContain('UPDATE public.analysis_results');
        expect(migration).toContain('SET one_line_overview');
        expect(migration).toContain('v212CopyCorrection');
        expect(migration).not.toContain('DELETE FROM public.analysis_results');
        expect(migration).not.toContain('UPDATE public.earlybird_orders');
    });
});
