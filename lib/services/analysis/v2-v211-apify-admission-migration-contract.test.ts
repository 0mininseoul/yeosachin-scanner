import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260808260000_authorize_v211_apify_transient_admission.sql',
), 'utf8');

describe('v2.11 Apify transient admission authorization migration', () => {
    it('adds only the exact r9 readiness branch', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808250000');
        expect(migration).toContain('0fee6978e531a3f838fe47dc178fd064');
        expect(migration).toContain(
            'public.earlybird_v211_apify_transient_replay_ready(',
        );
        expect(migration).toContain("|| '.r8'");
        expect(migration).toContain("|| '.r9'");
        expect(migration).toContain("source_run.status = ''aborted''");
    });

    it('records a single immutable requestless resume', () => {
        expect(migration).toContain(
            'earlybird_v211_apify_transient_admission_resumes',
        );
        expect(migration).toContain(
            'prevent_earlybird_v211_apify_transient_admission_resume_mutation',
        );
        expect(migration).toContain(
            "v_fulfillment.last_error_code <> 'PROVIDER_RUN_ADOPTION_REQUIRED'",
        );
        expect(migration).toContain('v_fulfillment.request_id IS NOT NULL');
        expect(migration).toContain('v_preflight.consumed_request_id IS NOT NULL');
        expect(migration).toContain(
            "SET status = 'admission_pending', attempt_count = 0",
        );
    });

    it('does not mutate any failed request or provider evidence', () => {
        expect(migration).not.toMatch(
            /UPDATE\s+public\.(?:analysis_requests|analysis_pipeline_jobs|analysis_v2_provider_runs|analysis_v2_ai_attempts)/i,
        );
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run',
        );
    });

    it('keeps readiness private and resume service-role-only', () => {
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.resume_earlybird_v211_apify_transient_admission',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_resume, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_resume, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_readiness, 'EXECUTE')",
        );
    });
});
