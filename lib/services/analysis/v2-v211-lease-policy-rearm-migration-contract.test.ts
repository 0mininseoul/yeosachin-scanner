import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260808160000_rearm_v211_lease_policy_failure.sql',
        import.meta.url
    ),
    'utf8'
);

describe('v2.11 lease-policy failure rearm migration contract', () => {
    it('requires independent payment evidence and the exact launch policy failure', () => {
        expect(migration).toContain('v_order.seller_reference_confirmed_at IS NULL');
        expect(migration).toContain('v_order.payment_id IS NULL');
        expect(migration).toContain('v_order.actual_amount_krw <> 990');
        expect(migration).toContain(
            "v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'"
        );
        expect(migration).toContain(
            "'aiStage', 'ai-stage-policy-v2.11'"
        );
        expect(migration).toContain(
            "receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'"
        );
    });

    it('proves no Gemini attempt happened before admitting a new generation', () => {
        expect(migration).toContain("job.track = 'profile_ai'");
        expect(migration).toContain("job.kind = 'ai'");
        expect(migration).toContain("job.status = 'failed'");
        expect(migration).toContain('job.attempt_count = 1');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(migration).toContain('public.analysis_v2_gemini_leases');
        expect(migration).toContain('OR 7 <> (');
        expect(migration).toContain("operation.status = 'claimed'");
    });

    it('requires settled provider work and creates only the exact r4 preflight', () => {
        expect(migration).toContain('public.analysis_v2_provider_runs');
        expect(migration).toContain("provider_run.status = 'succeeded'");
        expect(migration).toContain("provider_run.status = 'aborted'");
        expect(migration).toContain('provider_run.usage_reconciled_at IS NULL');
        expect(migration).toContain('public.analysis_v2_provider_cleanup_intents');
        expect(migration).toContain("v_base_preflight_key || '.r3'");
        expect(migration).toContain("v_base_preflight_key || '.r4'");
        expect(migration).toContain(
            'v_preflight.target_followers_count, v_preflight.target_following_count'
        );
        expect(migration).toContain(
            "SET status = 'paid', preflight_id = v_new_preflight_id"
        );
        expect(migration).toContain(
            "SET status = 'admission_pending', request_id = NULL"
        );
    });

    it('preserves an immutable audit and exposes only a service-role operator RPC', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_v211_lease_policy_failure_rearms'
        );
        expect(migration).toContain('BEFORE UPDATE OR DELETE');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rearm_earlybird_v211_lease_policy_failure\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rearm_earlybird_v211_lease_policy_failure\([\s\S]*?\) TO service_role;/
        );
    });
});
