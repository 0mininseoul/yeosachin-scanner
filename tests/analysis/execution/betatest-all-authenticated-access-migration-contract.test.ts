import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260802110348_enable_betatest_all_authenticated_access.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';
const ordinaryPreflightRoute = readFileSync(new URL(
    '../../../app/api/analysis/preflight/route.ts',
    import.meta.url
), 'utf8');

function body(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
    const start = migration.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + marker.length);
    return migration.slice(start, next < 0 ? undefined : next);
}

describe('all-authenticated betatest access migration', () => {
    it('is a forward-only standalone extension of the applied beta schema', () => {
        expect(migration).toContain('ALTER TABLE public.analysis_beta_access_grants');
        expect(migration).toContain('CREATE TABLE public.analysis_beta_access_policy');
        expect(migration).toContain('ALTER TABLE public.analysis_beta_access_policy ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('ALTER TABLE public.analysis_beta_access_policy FORCE ROW LEVEL SECURITY');
        expect(migration).toContain('REVOKE ALL ON TABLE public.analysis_beta_access_policy');
        expect(migration).toContain('public.analysis_beta_runtime_gate');
        expect(migration).not.toContain('CREATE TABLE public.analysis_beta_access_grants');
        expect(migration).not.toContain('CREATE TABLE public.analysis_beta_runtime_gate');
    });

    it('keeps enrollment caller-bound and policies/operator grants service-only', () => {
        const enroll = body('enroll_analysis_beta_user(');
        const policy = body('set_analysis_beta_access_policy(');
        const operatorGrant = body('upsert_analysis_beta_access_grant(');
        for (const functionBody of [enroll, policy, operatorGrant]) {
            expect(functionBody).toContain('SECURITY DEFINER');
            expect(functionBody).toContain("SET search_path = ''");
            expect(functionBody).toContain("SET lock_timeout = '5s'");
            expect(functionBody).toContain("SET statement_timeout = '2min'");
        }
        expect(enroll).toContain('p_user_id UUID');
        expect(enroll).toContain('analysis_beta_runtime_gate');
        expect(enroll).toContain('analysis_beta_access_policy');
        expect(enroll).toMatch(/grant_source\s*=\s*'automatic'/);
        expect(enroll).toMatch(/audit_reference_hash\s*=\s*pg_catalog\.encode\(extensions\.digest\(/);
        expect(policy).toMatch(/grant_source\s*=\s*'automatic'/);
        expect(operatorGrant).toMatch(/grant_source\s*=\s*'operator'/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.enroll_analysis_beta_user\(UUID\) TO service_role/);
        expect(enroll).not.toContain('TO authenticated');
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_analysis_beta_access_policy\(TEXT\)\s*TO service_role/);
        expect(policy).not.toContain('TO authenticated');
    });

    it('keeps automatic enrollment out of the ordinary analysis entry route', () => {
        expect(ordinaryPreflightRoute).not.toContain('ensureBetaTestAccess');
        expect(ordinaryPreflightRoute).not.toContain(
            'enroll_analysis_beta_user'
        );
    });
});
