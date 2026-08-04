import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260804150000_recover_authenticated_relationship_profile_batch_failure.sql',
        import.meta.url
    ),
    'utf8'
);
const currentFunctionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260804123000_fix_profile_recovery_lineage_conflict.sql',
        import.meta.url
    ),
    'utf8'
);

describe('authenticated relationship/profile-batch earlybird recovery migration', () => {
    it('keeps the existing profile-evidence recovery as the only entry point', () => {
        expect(migration).toContain(
            'recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'
        );
        expect(migration).toContain('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
        expect(migration).not.toContain('SCRAPING_PROVIDER_QUOTA_ERROR');
        expect(migration).not.toContain('JOB_ATTEMPTS_EXHAUSTED');
    });

    it('requires the exact relationship failure receipt and authenticated relationship witnesses', () => {
        expect(migration).toContain("v_request.error_message = 'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain(
            "receipt.failed_job_key = 'track:relationships:collect'"
        );
        expect(migration).toContain("failed_job.status = 'failed'");
        expect(migration).toContain("failed_job.track = 'relationships'");
        expect(migration).toContain("failed_job.kind = 'collection'");
        expect(migration).toContain("failed_job.last_error_code = 'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain('analysis_v2_selfhosted_auth_runs');
        expect(migration).toContain(
            "relationship-(followers|following):[0-9a-f]{64}"
        );
        expect(migration).toContain("auth_run.account_slot = 'primary'");
        expect(migration).toContain('jsonb_array_elements(auth_run.items)');
        expect(migration).toContain('analysis_v2_relationship_sides');
        expect(migration).toContain("side.job_key = 'track:relationships:collect'");
    });

    it('does not invent a durable profile-batch 502 discriminator', () => {
        expect(migration).toContain('profile-batch HTTP 502 is a log-only observation');
        expect(migration).not.toContain('analysis_v2_profile_fetch_outcomes');
        expect(migration).not.toContain('http_status = 502');
    });

    it('documents the residual operator tradeoff for the narrow authenticated receipt proof', () => {
        expect(migration).toContain('generic SCRAPING_INCOMPLETE_ERROR remains rejected');
        expect(migration).toContain('one authenticated relationship receipt');
    });

    it('retains the zero-spend and no-active-work guards and contains no operational UUID', () => {
        expect(migration).toContain('paid provider ledger, cost ledger, and active jobs remain empty');
        expect(migration).toContain('zero-spend/no-live-work guards');
        expect(migration).not.toMatch(
            /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
        );
    });

    it('fails closed when the patch anchor drifts instead of silently changing policy', () => {
        expect(migration).toContain(
            'AUTHENTICATED_RELATIONSHIP_PROFILE_BATCH_RECOVERY_PATCH_MISMATCH'
        );
        expect(currentFunctionMigration).toContain(
            "OR v_request.error_message <> 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'"
        );
        expect(currentFunctionMigration).toContain(
            "AND receipt.error_code = 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'"
        );
    });
});
