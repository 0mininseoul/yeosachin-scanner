import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260814160000_read_claimed_preflight_target_hash.sql',
), 'utf8');

describe('claimed preflight target hash migration', () => {
    it('reads only the persisted opaque hash while the current claim is live', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(',
        );
        expect(migration).toContain('RETURNS VARCHAR');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain("v_preflight.status <> 'processing'");
        expect(migration).toContain(
            'v_preflight.lease_token IS DISTINCT FROM p_claim_token',
        );
        expect(migration).toContain('v_preflight.lease_expires_at <= v_now');
        expect(migration).toContain('v_preflight.expires_at <= v_now');
        expect(migration).toContain("v_preflight.target_input_hash !~ '^[0-9a-f]{64}$'");
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(UUID, UUID)',
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(UUID, UUID)',
        );
        expect(migration).not.toContain('target_instagram_id');
    });
});
