import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');

describe('revenue cost-operation migration contract', () => {
    it('freezes pricing and makes legacy parent actual cost non-null before pricing enforcement', () => {
        expect(source).toContain("'revenue-e2e-cost-2026-08-10-v1'");
        expect(source).toContain('UPDATE public.analysis_revenue_run_ledgers SET actual_cost_krw = 0 WHERE actual_cost_krw IS NULL');
        expect(source).toContain('ALTER COLUMN actual_cost_krw SET NOT NULL');
        expect(source).toContain('analysis_revenue_run_ledgers_actual_cost_nonnegative_check');
        expect(source).toContain("(plan_id = 'basic' AND cost_cap_krw = 1808 AND margin_target_krw = 904)");
        expect(source).toContain("(plan_id = 'standard' AND cost_cap_krw = 3634 AND margin_target_krw = 1817)");
    });

    it('uses non-null source identities, exact source mapping, lifecycle checks, and service-only child access', () => {
        expect(source).toContain("source_job_key TEXT NOT NULL CHECK (");
        expect(source).toContain("'^[a-z0-9][a-z0-9:._-]{0,159}$'");
        expect(source).toContain('analysis_revenue_cost_operations_source_mapping_check');
        expect(source).toContain("owner_kind = 'preflight_provider_run' AND source_job_key = 'preflight' AND source_attempt = 0 AND operation_kind = 'target_profile'");
        expect(source).toContain('analysis_revenue_cost_operations_lifecycle_check');
        expect(source).toContain('UNIQUE (request_id, owner_kind, source_job_key, source_operation_key_hash, source_attempt)');
        expect(source).toContain('analysis_revenue_cost_operations_source_lookup_idx');
        expect(source).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('imports exactly the two succeeded and reconciled source rows with database-derived opaque hashes', () => {
        expect(source).toContain("'target-profile-fallback'");
        expect(source).toContain("'target-profile-fresh-admission:g1'");
        expect(source).toContain('v_count <> 2');
        expect(source).toContain("v_fallback.status IS DISTINCT FROM 'succeeded'");
        expect(source).toContain('v_fallback.terminalized_at IS NULL');
        expect(source).toContain('v_fallback.usage_reconciled_at IS NULL');
        expect(source).toContain('v_preflight.target_input_hash');
        expect(source).toContain("extensions.digest(pg_catalog.convert_to(v_fallback.operation_key, 'UTF8'), 'sha256')");
        expect(source).not.toContain('target_instagram_id, \'UTF8\')');
    });

    it('locks and verifies every immutable begin replay fact rather than conflict-dropping source evidence', () => {
        expect(source).toContain('consumed preflight -> request -> entitlement');
        expect(source).toContain('v_existing.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at');
        expect(source).toContain('v_existing.request_started_at IS DISTINCT FROM v_request.created_at');
        expect(source).toContain("v_existing.reserved_cost_krw IS DISTINCT FROM 0 OR v_existing.status IS DISTINCT FROM 'running'");
        expect(source).toContain('v_child.selected_manifest_scope_hash IS NULL AND v_child.denial_reason IS NULL');
        expect(source).toContain("'created', FALSE, 'replayed', TRUE");
        expect(source).toContain("'created', TRUE, 'replayed', FALSE");
        expect(source).not.toContain('ON CONFLICT');
    });

    it('retains compiled RPC signatures but fences live operations and bounded reconciliation', () => {
        for (const name of [
            'begin_analysis_revenue_cost_ledger_v1', 'reserve_analysis_revenue_cost_operation_v1',
            'mark_analysis_revenue_cost_operation_started_v1', 'settle_analysis_revenue_cost_operation_v1',
            'release_analysis_revenue_cost_operation_v1', 'mark_analysis_revenue_manual_review_v1',
            'read_analysis_revenue_cost_reconciliation_v1',
        ]) expect(source).toContain(`FUNCTION public.${name}`);
        expect(source).toContain("REVENUE_COST_OPERATION_NOT_READY");
        expect(source).toContain('DROP FUNCTION IF EXISTS public.read_analysis_revenue_cost_reconciliation_v1(UUID)');
        expect(source).toContain("'finalizable', FALSE, 'reason', 'not_ready'");
        expect(source).toContain('REVOKE ALL ON FUNCTION');
        expect(source).toContain('GRANT EXECUTE ON FUNCTION');
    });
});
