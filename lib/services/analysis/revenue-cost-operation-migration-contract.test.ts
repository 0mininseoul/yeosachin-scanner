import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');

describe('revenue cost-operation migration contract', () => {
    it('freezes pricing, separates billed and economic cost, and keeps a child audit ledger', () => {
        expect(source).toContain("'revenue-e2e-cost-2026-08-10-v1'");
        expect(source).toContain('economic_actual_usd');
        expect(source).toContain('billed_actual_usd');
        expect(source).toContain('CREATE TABLE public.analysis_revenue_cost_operations');
        expect(source).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('uses service-only, search-path-fenced lifecycle and finalization RPCs', () => {
        for (const name of [
            'begin_analysis_revenue_cost_ledger_v1',
            'reserve_analysis_revenue_cost_operation_v1',
            'mark_analysis_revenue_cost_operation_started_v1',
            'settle_analysis_revenue_cost_operation_v1',
            'release_analysis_revenue_cost_operation_v1',
            'mark_analysis_revenue_manual_review_v1',
            'read_analysis_revenue_cost_reconciliation_v1',
        ]) {
            expect(source).toContain(`FUNCTION public.${name}`);
        }
        expect(source).toContain("SET search_path = ''");
        expect(source).toContain('REVOKE ALL ON FUNCTION');
        expect(source).toContain('GRANT EXECUTE ON FUNCTION');
    });

    it('keeps target profile exposure to fallback plus fresh admission generation one', () => {
        expect(source).toContain("'target-profile-fallback'");
        expect(source).toContain("'target-profile-fresh-admission:g1'");
        expect(source).toContain('v_exposure_count > 2');
    });

    it('binds detail work to the selected manifest scope and keeps terminality explicit', () => {
        expect(source).toContain('selected_manifest_scope_hash');
        expect(source).toContain("status IN ('reserved', 'started', 'settled', 'released', 'ambiguous', 'denied')");
        expect(source).toContain('nonterminal_or_ambiguous');
    });
});
