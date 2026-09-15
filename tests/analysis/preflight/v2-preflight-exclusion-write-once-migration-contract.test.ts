import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260714151043_make_preflight_exclusion_write_once.sql';
const migration = readFileSync(new URL(migrationName, migrationsUrl), 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const current = source.indexOf(fragment, previous + 1);
        expect(current, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = current;
    }
}

describe('analysis V2 preflight exclusion write-once migration contract', () => {
    it('runs after the owner-history migration without modifying it', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf('20260714140011_fix_analysis_v2_owner_history_deletion.sql'))
            .toBeLessThan(names.indexOf(migrationName));
    });

    it('serializes decisions and permits only the pending-to-final transition', () => {
        const definition = functionDefinition('set_analysis_v2_preflight_exclusion');

        expectInOrder(definition, [
            'FROM public.analysis_preflights AS preflight',
            'FOR UPDATE;',
            'v_preflight.exclusion_decision = p_decision',
            'v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id',
            'RETURN FALSE;',
            "v_preflight.exclusion_decision <> 'pending'",
            "MESSAGE = 'PREFLIGHT_IMMUTABLE'",
            'v_preflight.expires_at <= v_now',
            "v_preflight.status = 'consumed'",
            'UPDATE public.analysis_preflights AS preflight',
            "preflight.exclusion_decision = 'pending'",
        ]);
        expect(definition.match(/MESSAGE = 'PREFLIGHT_IMMUTABLE'/g)).toHaveLength(2);
    });

    it('normalizes equivalent IDs and rejects conflicting decisions or IDs', () => {
        const definition = functionDefinition('set_analysis_v2_preflight_exclusion');

        expect(definition).toContain(
            'pg_catalog.lower(pg_catalog.btrim(p_excluded_instagram_id))'
        );
        expect(definition).toContain('v_excluded_instagram_id IS NULL');
        expect(definition).toContain(
            'v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id'
        );
        expect(definition).toContain("p_decision NOT IN ('exclude', 'skip')");
    });

    it('keeps the write RPC service-role only with an empty search path', () => {
        const definition = functionDefinition('set_analysis_v2_preflight_exclusion');

        expect(definition).toContain('SECURITY DEFINER');
        expect(definition).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_analysis_v2_preflight_exclusion\(UUID, UUID, TEXT, TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_analysis_v2_preflight_exclusion\(UUID, UUID, TEXT, TEXT\)\s+TO service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_analysis_v2_preflight_exclusion\(UUID, UUID, TEXT, TEXT\)\s+TO (?:anon|authenticated)/
        );
    });
});
