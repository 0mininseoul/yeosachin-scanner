import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260802100600_add_betatest_pool_observability.sql',
    import.meta.url,
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

describe('betatest pool observability migration contract', () => {
    it('defines one bounded aggregate-only security definer RPC', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.load_analysis_beta_apify_pool_observability('
        );
        expect(migration).toMatch(/p_max_age_seconds INTEGER DEFAULT 300/);
        expect(migration).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = ''/);
        expect(migration).toContain("SET statement_timeout = '5s'");
        expect(migration).toMatch(/p_max_age_seconds[^;]*BETWEEN 1 AND 900/);
        expect(migration).toContain('public.analysis_beta_pool_effective_capacity_snapshot()');
        for (const key of [
            'schemaVersion', 'observedAt', 'runtimeEnabled',
            'totalEffectiveHeadroomUsd', 'staleSnapshotCount',
            'activeAllocationCount', 'settlementLagMs',
            'overcommittedSlotCount',
        ]) expect(migration).toContain(`'${key}'`);
        for (const forbidden of [
            "'requestId'", "'preflightId'", "'userId'", "'accountId'",
            "'credentialSlot'", "'targetInstagramId'", "'secondary'",
        ]) expect(migration).not.toContain(forbidden);
    });

    it('revokes every default role and grants only service_role execute', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_beta_apify_pool_observability\(INTEGER\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_beta_apify_pool_observability\(INTEGER\)[\s\S]*TO service_role;/
        );
        expect(migration).not.toMatch(/TO (?:PUBLIC|anon|authenticated)/);
    });
});
