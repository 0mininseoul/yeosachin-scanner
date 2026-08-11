import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260808230000_authorize_v211_policy_identity_adoption.sql',
), 'utf8');

describe('v2.11 policy-identity adoption authorization migration', () => {
    it('requires the exact r7 failure lineage before authorizing r8', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808220000');
        expect(migration).toContain('earlybird_v211_policy_identity_replay_ready');
        expect(migration).toContain("|| '.r7'");
        expect(migration).toContain("|| '.r8'");
        expect(migration).toContain("track:profile-ai:batch:3");
        expect(migration).toContain("receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'");
        expect(migration).toContain('AND 12 = (');
        expect(migration).toContain('AND 6 = (');
        expect(migration).toContain('AND 5 = (');
        expect(migration).toContain('AND 4 = (');
    });

    it('patches both adoption gates with immutable production hashes', () => {
        expect(migration).toContain('4388067ac704171dc4941fa14b4f437b');
        expect(migration).toContain('dd8797d275e908273ff316f94e164e8d');
        expect(migration).toContain('earlybird_provider_run_adoption_ready');
        expect(migration).toContain('resolve_analysis_v2_exact_recovery_provider_run');
        expect(migration).toContain('ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT');
        expect(migration).toContain('ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT');
        expect(migration).toContain('RETURN NULL;');
    });

    it('resumes only the requestless adoption-required admission', () => {
        expect(migration).toContain('resume_earlybird_v211_policy_identity_admission');
        expect(migration).toContain(
            "v_fulfillment.last_error_code <> 'PROVIDER_RUN_ADOPTION_REQUIRED'",
        );
        expect(migration).toContain('v_fulfillment.request_id IS NOT NULL');
        expect(migration).toContain('v_preflight.consumed_request_id IS NOT NULL');
        expect(migration).toContain("SET status = 'admission_pending', attempt_count = 0");
        expect(migration).not.toMatch(
            /UPDATE\s+public\.analysis_requests|DELETE\s+FROM\s+public\.analysis_requests/i,
        );
    });

    it('keeps helper gates private and the resume RPC service-role-only', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.earlybird_v211_policy_identity_replay_ready',
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.resume_earlybird_v211_policy_identity_admission',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_resume, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_resume, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE')",
        );
    });
});
