import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731100000_rearm_zero_spend_adoption_policy_failure.sql',
        import.meta.url
    ),
    'utf8'
);

describe('zero-spend adoption policy failure rearm migration', () => {
    it('admits only the exact audited r1 failure topology', () => {
        expect(migration).toContain("v_fulfillment.status <> 'manual_review'");
        expect(migration).toContain(
            "v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'"
        );
        expect(migration).toContain('v_fulfillment.attempt_count <> 5');
        expect(migration).toContain(
            "v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'"
        );
        expect(migration).toContain(
            "job.job_key = 'track:relationships:collect'"
        );
        expect(migration).toContain('job.attempt_count = 1');
        expect(migration).toContain(
            "job.job_key = 'track:target-evidence:collect'"
        );
        expect(migration).toContain(
            "job.last_error_code = 'REQUEST_TERMINATED'"
        );
        expect(migration).toContain(
            'public.analysis_v2_valid_recovery_adoption_preflights('
        );
        expect(migration).toContain('v_normalized_preflight.target_instagram_id');
        expect(migration).toContain('expected_manual_review_at');
        expect(migration).toContain('OR 3 <> (');
        expect(migration).toContain("job.track = 'target_evidence'");
        expect(migration).toContain("job.kind = 'bootstrap'");
    });

    it('requires zero spend, evidence, and adoption on the failed r1 request', () => {
        expect(migration).toContain('public.analysis_v2_provider_runs');
        expect(migration).toContain(
            'public.analysis_v2_recovery_provider_run_adoptions'
        );
        expect(migration).toContain('public.analysis_provider_cost_ledger');
        expect(migration).toContain('public.analysis_v2_ai_attempts');
        expect(migration).toContain('public.analysis_v2_relationship_sides');
        expect(migration).toContain(
            'public.analysis_v2_target_evidence_manifests'
        );
    });

    it('records immutable provenance and never mutates the failed request', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_adoption_policy_failure_rearms'
        );
        expect(migration).toContain(
            'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_IMMUTABLE'
        );
        expect(migration).not.toMatch(
            /UPDATE\s+public\.analysis_requests/iu
        );
        expect(migration).toContain("v_base_preflight_key || '.r2'");
    });

    it('exposes the operator RPC to service_role only', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure'
        );
        expect(migration).toContain(
            ') FROM PUBLIC, anon, authenticated, service_role;'
        );
        expect(migration).toContain(
            ') TO service_role;'
        );
    });
});
