import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260812231822_add_precheckout_blite_durable_cache.sql',
), 'utf8');

describe('precheckout B-lite durable cache migration', () => {
    it('uses one preflight row, a bounded lease, and cascade cleanup', () => {
        expect(migration).toContain('preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE');
        expect(migration).toContain("v_now + INTERVAL '2 minutes'");
        expect(migration).toContain("state IN ('pending', 'complete')");
    });

    it('fences completion and release by the exact lease token', () => {
        expect(migration).toMatch(/complete_precheckout_blite_v1[\s\S]*lease_token = p_lease_token[\s\S]*lease_expires_at > v_now/);
        expect(migration).toMatch(/release_precheckout_blite_v1[\s\S]*lease_token = p_lease_token/);
    });

    it('keeps the table and security-definer RPCs service-role only', () => {
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('FORCE ROW LEVEL SECURITY');
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.precheckout_blite_cache FROM PUBLIC, anon, authenticated/);
        expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(3);
        expect(migration.match(/SET search_path = ''/g)).toHaveLength(3);
        expect(migration.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(3);
        expect(migration.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(3);
    });
});
