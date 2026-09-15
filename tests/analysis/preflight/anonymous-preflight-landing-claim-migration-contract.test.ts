import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'supabase/migrations');
const migrationName = readdirSync(migrationDirectory)
    .filter(name => name.endsWith('_atomic_anonymous_preflight_landing_claim.sql'))[0];
const sql = migrationName
    ? readFileSync(join(migrationDirectory, migrationName), 'utf8')
    : '';

describe('anonymous preflight landing claim migration', () => {
    it('exposes one authenticated transaction that rolls back on landing claim failure', () => {
        expect(migrationName).toBeTruthy();
        expect(sql).toContain('CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight_with_landing');
        expect(sql).toContain('private.claim_anonymous_analysis_v2_preflight');
        expect(sql).toContain('public.claim_landing_lead_journey');
        expect(sql).toContain('LANDING_LEAD_JOURNEY_CLAIM_FAILED');
        expect(sql).toMatch(/SECURITY DEFINER[\s\S]*?SET search_path = ''/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.claim_anonymous_analysis_v2_preflight_with_landing\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_anonymous_analysis_v2_preflight_with_landing\([\s\S]*?\)\s*TO authenticated/);
    });
});
