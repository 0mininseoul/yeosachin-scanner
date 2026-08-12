import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    'supabase/migrations/20260812133925_raise_preflight_global_hourly_limit.sql',
    'utf8',
);

describe('preflight global hourly limit migration', () => {
    it('raises only the shared ceiling and preserves the private helper permissions', () => {
        expect(migration).toContain("'v_global_preflight_count >= 3000'");
        expect(migration).not.toContain('v_recent_preflight_count >= 30');
        expect(migration).not.toContain("INTERVAL '1 seconds'");
        expect(migration).toContain(
            'FROM PUBLIC, anon, authenticated, service_role',
        );
    });
});
