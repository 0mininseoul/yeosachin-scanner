import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731110000_advance_zero_spend_rearm_preflight_generation.sql',
        import.meta.url
    ),
    'utf8'
);

describe('zero-spend rearm preflight generation migration', () => {
    it('accepts only bounded r1 through r8 consumed preflight keys', () => {
        expect(migration).toContain("'[.]r[1-8]$'");
        expect(migration).toContain('v_preflight_generation IS NULL');
        expect(migration).toContain('(v_preflight_generation + 1)::TEXT');
        expect(migration).toContain('family_preflight.idempotency_key');
        expect(migration).toContain('> v_preflight_generation');
    });

    it('preserves the exact failed request r1 witness and audit ACL', () => {
        expect(migration).toContain(
            'v_request.idempotency_key IS DISTINCT FROM'
        );
        expect(migration).toContain("|| ''.r1'')");
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure'
        );
        expect(migration).toContain('TO service_role');
    });

    it('fails closed if the expected 100 function body is not exact', () => {
        expect(migration).toContain(
            'EARLYBIRD_ZERO_SPEND_REARM_GENERATION_PATCH_MISMATCH'
        );
        expect(migration).toContain('v_rewritten = v_definition');
    });
});
