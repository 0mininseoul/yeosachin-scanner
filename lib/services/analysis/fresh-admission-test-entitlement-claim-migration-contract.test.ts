import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationName =
    '20260812011137_expose_test_entitlement_access_mode_to_fresh_admission_claim.sql';
const migration = readFileSync(
    new URL(`../../../supabase/migrations/${migrationName}`, import.meta.url),
    'utf8'
);
const freshAdmission = readFileSync(
    new URL('./fresh-plan-admission.ts', import.meta.url),
    'utf8'
);

function claimDefinition(): string {
    const start = migration.indexOf(
        'CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v2('
    );
    expect(start, 'the forward claim replacement must exist').toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, 'the claim replacement must have a bounded body').toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('fresh admission test-entitlement claim migration contract', () => {
    it('propagates authoritative preflight access mode through the service-only claim RPC', () => {
        const claim = claimDefinition();

        expect(migration).not.toContain(
            'DROP FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER);'
        );
        expect(migration).not.toContain(
            'CREATE FUNCTION public.claim_analysis_v2_preflight_admission('
        );
        expect(claim).toContain(
            'RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT, access_mode TEXT)'
        );
        expect(claim).toContain('v_preflight.access_mode::TEXT');
        expect(claim).toContain('SECURITY DEFINER');
        expect(claim).toContain("SET search_path = ''");
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission_v2(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)\n    FROM PUBLIC, anon, authenticated, service_role;'
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission_v2(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER) TO service_role;'
        );
        expect(freshAdmission).toContain(
            "claimRpc: 'claim_analysis_v2_preflight_admission_v2'"
        );
    });
});
