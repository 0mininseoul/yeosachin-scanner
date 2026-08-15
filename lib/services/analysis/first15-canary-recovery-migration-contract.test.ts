import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260815170000_rearm_first15_canary_provider_failures.sql',
    import.meta.url,
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('first15 terminal provider-canary recovery migration contract', () => {
    it('creates one service-role-only audited replay lineage after the copy-quality migration', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815160000');
        expect(migration).toContain('CREATE TABLE public.earlybird_first15_canary_provider_rearms');
        expect(migration).toContain('CREATE FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()');
        expect(migration).toContain('CREATE FUNCTION public.rearm_earlybird_first15_canary_provider_failure(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('TO service_role');
        expect(migration).toContain("'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain("'SCRAPING_PROVIDER_QUOTA_ERROR'");
        expect(migration).toContain("'SCRAPING_PROVIDER_START_REJECTED_ERROR'");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_earlybird_first15_canary_provider_recovery_candidates\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
    });

    it('preserves the fresh-profile checkpoint and only authorizes the documented ordered fallback slots', () => {
        expect(migration).toContain('load_analysis_v2_reusable_target_profile_run_first15');
        expect(migration).toContain('resolve_analysis_v2_recovery_provider_run_first15');
        expect(migration).toContain("('senary', 'tertiary')");
        expect(migration).toContain("('tertiary', 'quinary')");
        expect(migration).toContain("('quinary', 'primary')");
        expect(migration).toContain("('primary', 'secondary')");
        expect(migration).toContain('allowRelationshipIncompleteReplacement');
        expect(migration).not.toContain('UPDATE public.analysis_results');
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_provider_runs');
    });
});
