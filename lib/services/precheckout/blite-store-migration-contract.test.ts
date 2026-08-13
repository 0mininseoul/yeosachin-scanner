import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260812231822_add_precheckout_blite_durable_cache.sql',
), 'utf8');

function singleCollectionMigration(): string {
    const files = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_precheckout_blite_single_collection.sql'));
    expect(files).toHaveLength(1);
    return readFileSync(join(process.cwd(), 'supabase/migrations', files[0]), 'utf8');
}

describe('precheckout B-lite durable cache migration', () => {
    it('uses one preflight row, a bounded lease, and cascade cleanup', () => {
        expect(migration).toContain('preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE');
        expect(migration).toContain("v_now + INTERVAL '2 minutes'");
        expect(migration).toContain("state IN ('pending', 'complete')");
    });

    it('fences completion and release by the exact lease token', () => {
        expect(migration).toMatch(/complete_precheckout_blite_v1[\s\S]*lease_token = p_lease_token[\s\S]*lease_expires_at > pg_catalog\.clock_timestamp\(\)/);
        expect(migration).toMatch(/release_precheckout_blite_v1[\s\S]*lease_token = p_lease_token/);
        expect(migration).toMatch(/FOR UPDATE;[\s\S]*v_now := pg_catalog\.clock_timestamp\(\)/);
    });

    it('deletes derived persona data whenever its parent preflight is PII-scrubbed', () => {
        expect(migration).toContain('AFTER UPDATE OF pii_scrubbed_at ON public.analysis_preflights');
        expect(migration).toMatch(/NEW\.pii_scrubbed_at IS NOT NULL[\s\S]*DELETE FROM public\.precheckout_blite_cache/);
    });

    it('keeps the table and security-definer RPCs service-role only', () => {
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('FORCE ROW LEVEL SECURITY');
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.precheckout_blite_cache FROM PUBLIC, anon, authenticated/);
        expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(4);
        expect(migration.match(/SET search_path = ''/g)).toHaveLength(4);
        expect(migration.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(4);
        expect(migration.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(3);
    });

    it('adds the v2 failure-aware lifecycle while preserving flag-off v1 RPCs', () => {
        const v2 = singleCollectionMigration();
        expect(v2).toContain("state IN ('pending', 'complete', 'failed')");
        expect(v2).toContain('claim_precheckout_blite_v2');
        expect(v2).toContain('complete_precheckout_blite_v2');
        expect(v2).toContain('fail_precheckout_blite_v2');
        expect(v2).toContain('read_precheckout_blite_status_v1');
        expect(v2).not.toContain('DROP FUNCTION public.claim_precheckout_blite_v1(UUID)');
        expect(v2).not.toContain('DROP FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB)');
        expect(v2).not.toContain('DROP FUNCTION public.release_precheckout_blite_v1(UUID, UUID)');
        expect(v2).toContain('GRANT EXECUTE ON FUNCTION public.claim_precheckout_blite_v1(UUID)');
        expect(v2).toContain('GRANT EXECUTE ON FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB)');
        expect(v2).toContain('GRANT EXECUTE ON FUNCTION public.release_precheckout_blite_v1(UUID, UUID)');
    });
});
