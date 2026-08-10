import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const originalMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260805092000_add_anonymous_preflight_claim_runtime.sql',
), 'utf8');
const hardeningMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260805150000_harden_authenticated_preflight_exclusion_security_definer.sql',
), 'utf8');

const signature = 'public.set_authenticated_analysis_v2_preflight_exclusion';

describe('authenticated preflight exclusion security definer migration', () => {
    it('retains caller and owner guards before enabling owner-table access', () => {
        expect(originalMigration).toContain('(SELECT auth.uid()) IS DISTINCT FROM p_user_id');
        expect(originalMigration).toContain('preflight.user_id = (SELECT auth.uid())');
        expect(hardeningMigration).toContain(`ALTER FUNCTION ${signature}`);
        expect(hardeningMigration).toContain('SECURITY DEFINER;');
        expect(hardeningMigration).toContain("SET search_path = '';");
        expect(hardeningMigration).toContain("SET lock_timeout = '5s';");
        expect(hardeningMigration).toContain("SET statement_timeout = '2min';");
    });

    it('keeps the browser RPC executable only by authenticated callers', () => {
        expect(originalMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\(UUID, UUID, TEXT, TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(hardeningMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\([\s\S]*?\) FROM PUBLIC;/,
        );
        expect(hardeningMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\([\s\S]*?\) TO authenticated;/,
        );
        expect(hardeningMigration).not.toMatch(/TO (?:anon|service_role);/);
    });
});
