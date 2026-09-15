import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260806093026_allow_anonymous_preflight_exclusion_before_ready.sql',
), 'utf8');

describe('anonymous preflight exclusion migration contract', () => {
    it('allows the claim holder to decide exclusion while the snapshot is pending', () => {
        expect(migration).toContain(
            "AND status IN ('pending', 'processing', 'ready')",
        );
        expect(migration).toContain('AND expires_at > v_now');
        expect(migration).not.toContain("AND status = 'ready'");
    });

    it('keeps the browser RPC invoker-scoped', () => {
        expect(migration).toContain('SECURITY INVOKER');
        expect(migration).not.toContain('SECURITY DEFINER');
    });
});
