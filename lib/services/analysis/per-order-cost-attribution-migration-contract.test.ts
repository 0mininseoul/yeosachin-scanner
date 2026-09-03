import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
    'supabase/migrations/20260904110000_add_analysis_v2_cost_attribution.sql';

function migration(): string {
    return readFileSync(migrationPath, 'utf8');
}

describe('per-request/order cost attribution migration contract', () => {
    it('extends existing ledgers with an idempotent, PII-free attribution map and rollup', () => {
        const sql = migration();

        expect(sql).toContain('CREATE TABLE public.analysis_v2_cost_attributions');
        expect(sql).toContain('PRIMARY KEY (request_id, source_kind, source_operation_key)');
        expect(sql).toContain('UNIQUE (preflight_id, source_kind, source_operation_key)');
        expect(sql).toContain('analysis_v2_sync_cost_attributions');
        expect(sql).toContain('AFTER UPDATE OF consumed_request_id, status ON public.analysis_preflights');
        expect(sql).toContain('AFTER INSERT OR UPDATE OF operation_key, run_id, status, actual_usage_usd, usage_reconciled_at');
        expect(sql).toContain('ON CONFLICT (request_id, source_kind, source_operation_key)');
        expect(sql).toContain('CREATE VIEW public.analysis_v2_cost_rollups');
        expect(sql.match(/CREATE VIEW public\.analysis_v2_cost_rollups AS/g)).toHaveLength(1);
        expect(sql).toContain('metered_estimated_cost_usd');
        expect(sql).toContain('usage_unknown');
        expect(sql).toContain('cache_hit_count');
        expect(sql).toContain('no_call_count');
        expect(sql).toContain('pricing_version');
        expect(sql).toContain('canonical_model_name');
        expect(sql).toContain('model_location');
        expect(sql).toContain('GRANT SELECT ON public.analysis_v2_cost_rollups TO service_role');
        expect(sql).toContain('analysis_v2_cost_rollup_snapshots');
        expect(sql).toContain('analysis_v2_capture_cost_rollup_before_request_delete');
        expect(sql).toContain('analysis_v2_capture_cost_rollup_before_preflight_delete');
        expect(sql).toContain('BEFORE DELETE ON public.analysis_requests');
        expect(sql).toContain('BEFORE DELETE ON public.analysis_preflights');
        expect(sql).not.toMatch(/FROM public\.analysis_v2_cost_rollups[\s\S]*?;\s*ON CONFLICT/);
        expect(sql.match(/ON public\.analysis_v2_cost_attributions\(order_id, request_id\)/g))
            .toHaveLength(1);
    });

    it('covers both access modes and all three catalog plans without invoice mislabeling', () => {
        const sql = migration();

        expect(sql).toContain("access_mode IN ('production', 'test_entitlement')");
        expect(sql).toContain("plan_id IN ('basic', 'standard', 'plus')");
        expect(sql).toContain('apify_actual_charge_usd');
        expect(sql).not.toContain('actual_provider_charge');
        expect(sql).not.toContain('vertex_actual');
        expect(sql).toContain('provider_actual_usd');
        expect(sql).toContain('provider_conservative_usd');
        expect(sql).toContain("cost_scope = 'analysis-v2-direct-provider-and-vertex-metered-v1'");
        expect(sql).toContain('infrastructure_included = FALSE');
        expect(sql).toContain('excludes shared Cloud Run, Cloud Tasks, Supabase, Vercel, and email overhead');
    });

    it('keeps the read boundary service-role-only and exposes completeness flags', () => {
        const sql = migration();

        expect(sql).toMatch(
            /REVOKE ALL ON (?:(?:TABLE|VIEW) )?public\.analysis_v2_cost_rollups\s+FROM PUBLIC, anon, authenticated/
        );
        expect(sql).toContain('load_analysis_v2_cost_rollup');
        expect(sql).toContain('directly_attributable_cost_complete');
        expect(sql).not.toMatch(/\bAS cost_complete\b/);
        expect(sql).toContain('provider_usage_unknown_count');
        expect(sql).toContain('ai_usage_unknown_count');
        expect(sql).toContain('preflight_usage_unknown_count');
        expect(sql).toContain('vertex_budget_unmatched_count');
        expect(sql).toContain('vertex_budget_mismatch_count');
        expect(sql).toContain('selfhosted_no_paid_provider_count');
        expect(sql).toContain('load_analysis_v2_cost_rollup');
        expect(sql).toContain('TG_OP = \'UPDATE\'');
        expect(sql).not.toContain('security_invoker');
        expect(sql).toContain('preflight.provider_selector = \'selfhosted_auth\'');
        expect(sql).toContain('reservation.estimated_cost_usd');
        expect(sql).toContain('vertex_budget_conservative_fallback_usd');
        expect(sql).toContain('IS DISTINCT FROM \'ai-stage-policy-v2.12\'');
        expect(sql).toContain('analysis_v2_canonical_gemini_model');
        expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.analysis_v2_ai_attempt_json');
        expect(sql).not.toMatch(/DROP CONSTRAINT(?: IF EXISTS)?\s+analysis_v2_ai_attempt_model_check/);
        expect(sql).not.toMatch(/DROP CONSTRAINT(?: IF EXISTS)?\s+analysis_v2_ai_attempt_usage_check/);
        expect(sql).not.toMatch(
            /CREATE OR REPLACE FUNCTION public\.analysis_v2_valid_ai_reservation_metadata/
        );
        expect(sql).not.toContain('pg_get_functiondef');
    });

    it('keeps durable snapshots free of cascading source foreign keys and labels cache/no-call evidence', () => {
        const sql = migration();
        const snapshotStart = sql.indexOf('CREATE TABLE public.analysis_v2_cost_rollup_snapshots');
        const snapshotEnd = sql.indexOf('\n);', snapshotStart);
        expect(snapshotStart).toBeGreaterThanOrEqual(0);
        expect(snapshotEnd).toBeGreaterThan(snapshotStart);
        expect(sql.slice(snapshotStart, snapshotEnd)).not.toContain('REFERENCES public.');
        expect(sql).toContain("'sourceKind', 'selfhosted_auth'");
        expect(sql).toContain("'chargeKind', 'no_paid_provider'");
        expect(sql).toContain("checkpoint.source = 'global_cache'");
        expect(sql).toContain("'noCall',");
        expect(sql).toContain('reservation.state <> \'cancelled\'');
        expect(sql).toContain('metered response estimate used to settle a reservation');
    });
});
