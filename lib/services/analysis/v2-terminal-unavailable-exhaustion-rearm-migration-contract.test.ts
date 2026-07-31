import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260731130000_rearm_terminal_unavailable_job_exhaustion.sql',
        import.meta.url
    ),
    'utf8'
);

describe('terminal-unavailable exhaustion rearm migration contract', () => {
    it('requires independent payment evidence and the exact terminal receipt', () => {
        expect(migration).toContain('v_order.seller_reference_confirmed_at IS NULL');
        expect(migration).toContain('v_order.payment_id IS NULL');
        expect(migration).toContain(
            'v_order.actual_groble_product_id'
                + '\n            IS DISTINCT FROM v_order.expected_groble_product_id'
        );
        expect(migration).toContain(
            "v_request.error_message <> 'JOB_ATTEMPTS_EXHAUSTED'"
        );
        expect(migration).toContain(
            "receipt.error_code = 'JOB_ATTEMPTS_EXHAUSTED'"
        );
        expect(migration).toContain(
            "operation.status = 'terminal_unavailable'"
        );
        expect(migration).toContain(
            "operation.stage = 'featureAnalysis'"
        );
    });

    it('admits only the profile-AI result-not-ready failure shape', () => {
        expect(migration).toContain("job.track = 'profile_ai'");
        expect(migration).toContain("job.kind = 'ai'");
        expect(migration).toContain("job.status = 'failed'");
        expect(migration).toContain('job.attempt_count = 7');
        expect(migration).toContain(
            "job.last_error_code = 'ANALYSIS_V2_RESULT_NOT_READY'"
        );
        expect(migration).toContain(
            "job.status IN ('pending', 'processing')"
        );
    });

    it('preserves the paid provider lineage and creates one bounded next preflight', () => {
        expect(migration).toContain(
            'public.analysis_v2_recovery_provider_run_adoptions'
        );
        expect(migration).toContain(
            'adoption.source_request_id'
                + '\n                    IS DISTINCT FROM v_lineage.failed_request_id'
        );
        expect(migration).toContain(
            "source_run.status <> 'succeeded'"
        );
        expect(migration).toContain("'[.]r[1-8]$'");
        expect(migration).toContain(
            "v_base_preflight_key || '.r' || (v_preflight_generation + 1)::TEXT"
        );
        expect(migration).toContain(
            "SET status = 'paid', preflight_id = v_new_preflight_id"
        );
        expect(migration).toContain(
            "SET status = 'admission_pending', request_id = NULL"
        );
    });

    it('keeps the audit immutable and callable only by the service role', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_terminal_unavailable_exhaustion_rearms'
        );
        expect(migration).toContain(
            'BEFORE UPDATE OR DELETE'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rearm_earlybird_terminal_unavailable_job_exhaustion\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rearm_earlybird_terminal_unavailable_job_exhaustion\([\s\S]*?\) TO service_role;/
        );
    });
});
