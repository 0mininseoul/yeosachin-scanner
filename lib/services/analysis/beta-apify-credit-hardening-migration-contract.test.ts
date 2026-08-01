import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260802050000_harden_betatest_apify_credit_capacity.sql'
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

function definition(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = migration.lastIndexOf(marker);
    expect(start, `${name} must be recreated by the forward correction`)
        .toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('$$;', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end + 3);
}

describe('betatest credit hardening migration contract', () => {
    it('recreates admission capacity fences from one effective snapshot', () => {
        expect(migration).not.toBe('');
        const capacity = definition('analysis_beta_pool_effective_capacity_snapshot');
        const hold = definition('hold_analysis_beta_apify_preflight_credit');
        const activation = definition('activate_analysis_beta_apify_request_credit_unbound');
        const guard = definition('guard_analysis_beta_pool_reservation_headroom');

        expect(capacity).toContain('analysis_beta_pool_reservation_archive');
        expect(capacity).toContain('analysis_beta_pool_local_debits');
        expect(capacity).toContain("archive.archive_state = 'ambiguous_held'");
        for (const fn of [hold, activation, guard]) {
            expect(fn).toContain('analysis_beta_pool_effective_capacity_snapshot');
            expect(fn).not.toMatch(/monthly_limit_usd\s*-\s*[^;]*monthly_usage_usd\s*-\s*v_reserved_usd/);
        }
        // BEFORE INSERT does not include NEW in the aggregate, so this is the
        // final concurrent admission charge and must reject any shortfall.
        expect(guard).toMatch(/v_capacity\s*<\s*NEW\.reserved_usd/);
    });

    it('keeps immutable reservation archive rows insert-only and conflicts before live deletion', () => {
        const archive = definition('archive_settled_analysis_beta_apify_credit_allocations');
        expect(archive).not.toContain('ON CONFLICT (allocation_id,operation_family) DO UPDATE');
        expect(archive).toContain('ANALYSIS_BETA_POOL_ARCHIVE_CONFLICT');
        expect(archive.indexOf('ANALYSIS_BETA_POOL_ARCHIVE_CONFLICT'))
            .toBeLessThan(archive.indexOf('DELETE FROM public.analysis_beta_pool_allocations'));
    });
});
