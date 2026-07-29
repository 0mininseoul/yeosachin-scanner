import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260730040000_upgrade_demo_fixture_v2_realism.sql', import.meta.url),
    'utf8',
);

describe('operator editable fixture v2 migration contract', () => {
    it('enforces five minutes only for V2 while preserving canonical generic operator durations', () => {
        expect(migration).toContain("fixture_version = 'operator-editable-fixture-v2' AND duration_seconds = 300");
        expect(migration).toContain("fixture_version = 'synthetic-fixture-v1' AND duration_seconds BETWEEN 60 AND 90");
        expect(migration).toContain("fixture_version ~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$'");
        expect(migration).toContain("fixture_version <> 'operator-editable-fixture-v2'");
        expect(migration).toContain('duration_seconds BETWEEN 30 AND 45');
        expect(migration).toContain("p_fixture_version = 'operator-editable-fixture-v2' AND p_duration_seconds <> 300");
        expect(migration).toContain("p_fixture_version <> 'operator-editable-fixture-v2'");
        expect(migration).toContain("p_fixture_version !~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$'");
        expect(migration).toContain('p_duration_seconds NOT BETWEEN 30 AND 45');
    });

    it('keeps the final six-argument RPC service-role only with an empty search path', () => {
        expect(migration).toContain('p_fixture_payload JSONB');
        expect(migration).toContain('SECURITY DEFINER SET search_path = \'\'');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) TO service_role;');
    });
});
