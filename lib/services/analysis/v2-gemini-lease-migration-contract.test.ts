import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('deployment-wide Gemini lease migration contract', () => {
    it('creates exactly eight private fenced slots', () => {
        expect(migration).toContain(
            'CREATE TABLE public.analysis_v2_gemini_leases'
        );
        expect(migration).toContain('CHECK (slot BETWEEN 1 AND 8)');
        expect(migration).toContain('pg_catalog.generate_series(1, 8)');
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_gemini_leases ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_gemini_leases\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_gemini_leases/
        );
    });

    it('serializes acquisition and quarantines expired or ambiguous ownership', () => {
        const acquire = functionDefinition('acquire_analysis_v2_gemini_lease');
        expect(acquire).toContain('pg_advisory_xact_lock');
        expect(acquire).toContain("ORDER BY lease.slot");
        expect(acquire).toContain("SET state = 'quarantined'");
        expect(acquire).toContain("lease.expires_at <= v_now");
        expect(acquire).toContain("lease.fence + 1");
        expect(acquire).toContain("'capacity_pending'::TEXT");
        expect(acquire).toContain("'quarantine_active'::TEXT");
        expect(acquire).toContain('p_lease_seconds NOT BETWEEN 225 AND 300');
    });

    it('requires exact token and fence for renewal and release', () => {
        for (const name of [
            'renew_analysis_v2_gemini_lease',
            'release_analysis_v2_gemini_lease',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain(
                'v_lease.lease_claim_token = p_claim_token'
            );
            expect(definition).toContain('v_lease.fence = p_fence');
            expect(definition).toContain("SET search_path = ''");
        }
    });

    it('keeps quarantine resolution DB-owner-only with audited evidence', () => {
        const resolution = functionDefinition(
            'resolve_analysis_v2_gemini_lease_quarantine'
        );
        expect(resolution).toContain("p_evidence_hash !~ '^[a-f0-9]{64}$'");
        expect(resolution).toContain('resolution_evidence_hash = p_evidence_hash');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.resolve_analysis_v2_gemini_lease_quarantine\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.resolve_analysis_v2_gemini_lease_quarantine/
        );
    });

    it('defers admission signals without consuming the job failure budget', () => {
        const defer = functionDefinition('defer_analysis_v2_job_for_ai_capacity');
        for (const code of [
            'ANALYSIS_V2_AI_CAPACITY_PENDING',
            'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
            'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
        ]) {
            expect(defer).toContain(`'${code}'`);
        }
        expect(defer).toContain('attempt_count = job.attempt_count - 1');
        expect(defer).toContain(
            'ai_capacity_deferral_count = job.ai_capacity_deferral_count + 1'
        );
        expect(defer).toContain('lease_token = NULL');
        expect(defer).toContain('lease_expires_at = NULL');
    });

    it('grants only service role execution for runtime functions', () => {
        for (const name of [
            'acquire_analysis_v2_gemini_lease',
            'renew_analysis_v2_gemini_lease',
            'release_analysis_v2_gemini_lease',
            'defer_analysis_v2_job_for_ai_capacity',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role;'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'TO service_role;'
            ));
        }
    });
});
