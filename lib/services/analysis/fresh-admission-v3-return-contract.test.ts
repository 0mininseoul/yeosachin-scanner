import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const correctionMigrations = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('_correct_claim_analysis_v2_preflight_admission_v3_return_contract.sql'))
    .sort();

describe('fresh-admission v3 return contract correction migration', () => {
    it('replaces only v3 with an explicit, exact six-column service-only contract', () => {
        expect(correctionMigrations).toHaveLength(1);

        const migration = readFileSync(
            new URL(correctionMigrations[0], migrationDirectory),
            'utf8',
        );

        expect(migration).toContain(
            'DROP FUNCTION IF EXISTS public.claim_analysis_v2_preflight_admission_v3(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER);',
        );
        expect(migration).toContain(
            'CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v3(',
        );
        expect(migration).toContain(
            'RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT, access_mode TEXT, order_scoped_credential_slot TEXT)',
        );
        expect(migration).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\' AS $$');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission_v3(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)\n    FROM PUBLIC, anon, authenticated, service_role;',
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission_v3(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)\n    TO service_role;',
        );
        expect(migration).not.toContain('claim_analysis_v2_preflight_admission_v2(');
        expect(migration).not.toContain('pg_get_functiondef');
    });
});
