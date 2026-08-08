import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808170000_bridge_v211_lease_rearm_admission_lineage.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 lease-policy rearm admission bridge migration contract', () => {
    it('requires the immutable v2.11 rearm and exact paid failure lineage', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808160000');
        expect(migration).toContain(
            'public.earlybird_v211_lease_policy_failure_rearms'
        );
        expect(migration).toMatch(
            /failed_request\.error_message\s*=\s*'ANALYSIS_V2_JOB_HANDLER_FAILED'/
        );
        expect(migration).toContain("'aiStage', 'ai-stage-policy-v2.11'");
        expect(migration).toContain('earlybird_order.actual_amount_krw = 990');
        expect(migration).toContain('earlybird_order.payment_id IS NOT NULL');
        expect(migration).toMatch(
            /earlybird_order\.seller_reference_confirmed_at\s+IS NOT NULL/
        );
    });

    it('allows only the settled six-success one-abort provider topology', () => {
        expect(migration).toContain("source_run.status NOT IN ('succeeded', 'aborted')");
        expect(migration).toContain("source_run.status = 'aborted'");
        expect(migration).toContain("provider_run.status = 'succeeded'");
        expect(migration).toContain("provider_run.status = 'aborted'");
        expect(migration).toContain('OR 7 <> (');
        expect(migration).toContain('OR 6 <> (');
        expect(migration).toContain('OR 1 <> (');
        expect(migration).toContain('source_run.run_id IS NULL');
        expect(migration).toContain('source_run.actual_usage_usd IS NULL');
        expect(migration).toContain('source_run.usage_reconciled_at IS NULL');
        expect(migration).toContain('provider_run.run_id IS NOT NULL');
        expect(migration).toContain('cleanup.completed_at IS NULL');
    });

    it('proves the failure had no Gemini side effect before bridging it', () => {
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
        expect(migration).toContain('public.analysis_v2_failure_receipts');
    });

    it('bridges the immutable lineage and rearms only the exact conflict', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.bridge_earlybird_v211_lease_rearm_admission'
        );
        expect(migration).toContain(
            "v_fulfillment.last_error_code <> 'REQUEST_CONFLICT'"
        );
        expect(migration).toContain(
            'p_expected_request_conflict_at TIMESTAMP WITH TIME ZONE'
        );
        expect(migration).toContain(
            'INSERT INTO public.earlybird_schema_failure_recoveries'
        );
        expect(migration).toContain(
            "SET status = 'admission_pending', attempt_count = 0"
        );
        expect(migration).toContain('FOR UPDATE');
    });

    it('keeps the operator bridge service-role-only and the readiness helper private', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_provider_run_adoption_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.bridge_earlybird_v211_lease_rearm_admission\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.bridge_earlybird_v211_lease_rearm_admission\([\s\S]*?TO service_role;/
        );
    });
});
