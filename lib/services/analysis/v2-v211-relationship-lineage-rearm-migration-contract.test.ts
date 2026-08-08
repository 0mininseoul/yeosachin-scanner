import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808190000_rearm_v211_relationship_lineage_failure.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 relationship-lineage failure rearm migration contract', () => {
    it('depends on the fresh-count completion and records one immutable r5 rearm', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808180000');
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_v211_relationship_lineage_failure_rearms'
        );
        expect(migration).toContain('BEFORE UPDATE OR DELETE');
        expect(migration).toContain("v_base_preflight_key || '.r4'");
        expect(migration).toContain("v_base_preflight_key || '.r5'");
        expect(migration).toContain(
            'INSERT INTO public.earlybird_v211_relationship_lineage_failure_rearms'
        );
    });

    it('requires the exact paid v2.11 incident and zero-side-effect successor failure', () => {
        expect(migration).toContain('v_order.seller_reference_confirmed_at IS NULL');
        expect(migration).toContain('v_order.payment_id IS NULL');
        expect(migration).toContain('v_order.actual_amount_krw <> 990');
        expect(migration).toContain(
            'public.earlybird_v211_lease_policy_failure_rearms'
        );
        expect(migration).toContain('public.earlybird_schema_failure_recoveries');
        expect(migration).toContain("'aiStage', 'ai-stage-policy-v2.11'");
        expect(migration).toContain("job.job_key = 'track:relationships:collect'");
        expect(migration).toContain("job.status = 'failed'");
        expect(migration).toContain('public.analysis_v2_provider_runs');
        expect(migration).toContain(
            'public.analysis_v2_recovery_provider_run_adoptions'
        );
        expect(migration).toContain('public.analysis_provider_cost_ledger');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
    });

    it('admits the descendant only through the audited readiness and exact-resolver fences', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.earlybird_v211_relationship_lineage_rearm_ready'
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.earlybird_provider_run_adoption_ready'
        );
        expect(migration).toContain(
            'public.earlybird_v211_relationship_lineage_rearm_ready('
        );
        expect(migration).toContain(
            "'public.resolve_analysis_v2_exact_recovery_provider_run('"
        );
        expect(migration).toContain(
            'ANALYSIS_V2_V211_RELATIONSHIP_EXACT_RESOLVER_OLD_SHAPE_MISMATCH'
        );
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'
        );
    });

    it('keeps audit and helper internals private and exposes only the operator RPC', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.earlybird_v211_relationship_lineage_failure_rearms[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_v211_relationship_lineage_rearm_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rearm_earlybird_v211_relationship_lineage_failure\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rearm_earlybird_v211_relationship_lineage_failure\([\s\S]*?TO service_role;/
        );
    });
});
