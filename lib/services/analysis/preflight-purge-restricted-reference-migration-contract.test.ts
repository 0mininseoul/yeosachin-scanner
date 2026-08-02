import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The terminal beta settlement rollout intentionally replaced retention so it
// can settle/recover beta allocations before deleting eligible tombstones.
// Append-only migration history therefore makes 0900 the canonical latest
// definition while retaining every restricted-reference fence added in 0731.
const MIGRATION_NAME = '20260802090000_settle_betatest_terminal_credit.sql';
const migrationsDirectory = fileURLToPath(
    new URL('../../../supabase/migrations/', import.meta.url)
);
const migration = readFileSync(`${migrationsDirectory}${MIGRATION_NAME}`, 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('preflight purge restricted reference migration contract', () => {
    it('fences every ON DELETE RESTRICT reference before deleting a tombstone', () => {
        const purge = functionDefinition('purge_expired_analysis_v2_preflights');
        const deletable = purge.slice(purge.indexOf('WITH deletable AS ('));

        expect(deletable).toContain(
            'FROM public.earlybird_schema_failure_recoveries AS recovery'
        );
        expect(deletable).toContain('recovery.recovery_preflight_id = preflight.id');
        expect(deletable).toContain(
            'FROM public.analysis_v2_replay_capture_authorizations'
        );
        expect(deletable).toContain('capture_authorization.preflight_id = preflight.id');
        // The references that were already fenced must stay fenced.
        expect(deletable).toContain('FROM public.earlybird_orders AS earlybird_order');
        expect(deletable).toContain('FROM public.earlybird_waitlist AS waitlist_entry');
        expect(deletable).toContain(
            'FROM public.analysis_preflight_provider_runs AS provider_run'
        );
        expect(deletable).toContain('provider_run.actual_usage_usd IS NULL');
        expect(deletable).toContain('provider_run.usage_reconciled_at IS NULL');
    });

    it('keeps the commercial checkout exemption on the scrub path', () => {
        expect(functionDefinition('purge_expired_analysis_v2_preflights')).toMatch(
            /earlybird_order\.status IN\s*\(\s*'payment_pending',\s*'cancelled',\s*'paid',\s*'analysis_in_progress',\s*'completed'\s*\)/
        );
    });

    it('keeps the batching, locking and privilege posture of the replaced function', () => {
        const purge = functionDefinition('purge_expired_analysis_v2_preflights');

        expect(purge).toContain('SECURITY DEFINER');
        expect(purge).toContain("SET search_path = ''");
        expect(purge.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(2);
        expect(purge.match(/LIMIT p_limit/g)).toHaveLength(2);
        expect(purge).toContain("MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT'");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.purge_expired_analysis_v2_preflights\(INTEGER\)\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.purge_expired_analysis_v2_preflights\(INTEGER\)\s+TO service_role;/
        );
    });

    it('is the last migration that defines the retention function', () => {
        const definitions = readdirSync(migrationsDirectory)
            .filter((name) => name.endsWith('.sql'))
            .filter((name) => readFileSync(`${migrationsDirectory}${name}`, 'utf8').includes(
                'CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights('
            ))
            .sort();

        expect(definitions.at(-1)).toBe(MIGRATION_NAME);
    });
});
