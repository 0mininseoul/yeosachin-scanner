import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808180000_complete_v211_rearm_with_fresh_counts.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 rearm fresh-count completion migration contract', () => {
    it('depends on the admission bridge and replaces only the completion wrapper', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808170000');
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight_admission'
        );
        expect(migration).toContain(
            'public.complete_analysis_v2_preflight_admission_core_20260730140000'
        );
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight_admission_core_20260730140000'
        );
    });

    it('routes only the immutable v2.11 r4 incident through fresh-count recomputation', () => {
        expect(migration).toContain(
            'public.earlybird_v211_lease_policy_failure_rearms AS incident'
        );
        expect(migration).toContain(
            'public.earlybird_schema_failure_recoveries AS recovery'
        );
        expect(migration).toContain(
            "|| '.r4'"
        );
        expect(migration).toContain("'aiStage', 'ai-stage-policy-v2.11'");
        expect(migration).toContain(
            "failed_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'"
        );
        expect(migration).toContain('recovery.prior_attempt_count = 1');
    });

    it('retains exact paid-order, zero-Gemini, and settled-provider fences', () => {
        expect(migration).toContain('earlybird_order.payment_id IS NOT NULL');
        expect(migration).toContain(
            'earlybird_order.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(migration).toContain('earlybird_order.actual_amount_krw = 990');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
        expect(migration).toContain('provider_run.status = \'succeeded\'');
        expect(migration).toContain('provider_run.status = \'aborted\'');
        expect(migration).toContain('cleanup.completed_at IS NULL');
    });

    it('preserves the approved-entitlement branch for every other recovery', () => {
        expect(migration).toContain(
            'v_preflight.target_followers_count\n            IS DISTINCT FROM v_order.target_followers_count'
        );
        expect(migration).toContain(
            "v_fulfillment.status <> 'admission_pending'"
        );
        expect(migration).toContain(
            "v_status := 'blocked'"
        );
        expect(migration).toContain(
            "v_error_code := 'ANALYSIS_V2_PLAN_NOT_ALLOWED'"
        );
    });

    it('keeps the completion RPC service-role-only', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.complete_analysis_v2_preflight_admission\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.complete_analysis_v2_preflight_admission\([\s\S]*?TO service_role;/
        );
    });
});
