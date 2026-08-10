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

    it('imports exactly the two reconciled preflight source rows with opaque provenance', () => {
        expect(source).toContain("'target-profile-fallback'");
        expect(source).toContain("'target-profile-fresh-admission:g1'");
        expect(source).toContain('v_exposure_count <> 2');
        expect(source).toContain('actual_usage_usd IS NULL');
        expect(source).toContain('usage_reconciled_at IS NULL');
        expect(source).toContain('target_input_hash');
        expect(source).not.toContain("digest(convert_to(lower(v_request.target_instagram_id)");
    });

    it('uses the canonical runner function, a parent FK, strict ACLs, and manifest-derived scopes', () => {
        expect(source).toContain('public.load_e2e_test_runner_v1(v_request.user_id)');
        expect(source).toContain('REFERENCES public.analysis_revenue_run_ledgers(request_id)');
        expect(source).toContain('REVOKE ALL ON TABLE public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role');
        expect(source).toContain('REVOKE ALL ON FUNCTION');
        expect(source).toContain('FROM public.analysis_v2_gender_routing_manifests AS manifest');
        expect(source).toContain('FROM public.analysis_v2_gender_routing_candidates AS candidate');
        expect(source).toContain("status = 'complete'");
    });

    it('uses parent-first lock ordering and finalizer-bound reconciliation', () => {
        expect(source).toContain('SELECT * INTO v_ledger FROM public.analysis_revenue_run_ledgers WHERE request_id = p_request_id FOR UPDATE');
        expect(source).toContain('p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT');
        expect(source).toContain("p_job_key IS DISTINCT FROM 'coordinator:finalize'");
        expect(source).toContain('missing_fresh_import');
        expect(source).toContain('provider_source_unmatched');
        expect(source).toContain('ai_source_unmatched');
    });

    it('binds detail work to the selected manifest scope and keeps terminality explicit', () => {
        expect(source).toContain('selected_manifest_scope_hash');
        expect(source).toContain("status IN ('reserved', 'started', 'settled', 'released', 'ambiguous', 'denied')");
        expect(source).toContain('nonterminal_or_ambiguous');
    });
});
