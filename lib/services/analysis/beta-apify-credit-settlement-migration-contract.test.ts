import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260802040000_settle_betatest_apify_credit_reservations.sql'
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

function definition(name: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = migration.lastIndexOf(marker);
    expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
    const create = start;
    const end = migration.indexOf('$$;', start);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(create, end + 4);
}

function expectServiceOnly(signature: string): void {
    const escaped = signature.replaceAll('(', '\\(\\s*')
        .replaceAll(')', '\\s*\\)').replaceAll(',', '\\s*,\\s*');
    expect(migration).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated, service_role`
    ));
    expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role`
    ));
}

describe('betatest credit settlement/recovery migration contract', () => {
    it('is an append-only forward settlement migration', () => {
        expect(migration).not.toBe('');
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
        expect(migration).toContain('actual_usd');
        expect(migration).toContain('released_usd');
        expect(migration).toContain('reconciliation_watermark');
        expect(migration).toContain('settlement_reason');
    });

    it('settles each exact family conservatively and never resolves an ambiguous start', () => {
        const settle = definition('settle_analysis_beta_apify_credit_allocation');
        for (const fragment of [
            "split_part(provider_run.operation_key, ':', 1)",
            "operation_key = 'target-profile-fallback'",
            "operation_key ~ '^target-profile-fresh-admission:g",
            "status IN ('succeeded', 'failed', 'aborted', 'timed_out', 'resolved_no_run')",
            'actual_usage_usd IS NOT NULL',
            'usage_reconciled_at IS NOT NULL',
            'v_actual > v_reservation.reserved_usd',
            'ANALYSIS_BETA_SETTLEMENT_ACTUAL_EXCEEDS_RESERVATION',
            "lifecycle_state = 'settled', actual_usd = v_actual",
            "SET lifecycle_state = 'settled', settled_at = v_now",
        ]) expect(settle).toContain(fragment);
        expect(settle).not.toContain("status = 'starting' THEN UPDATE");
    });

    it('subtracts only held reservations plus local debit newer than the provider snapshot', () => {
        const load = definition('load_analysis_beta_apify_credit_pool');
        expect(load).toContain("reservation.lifecycle_state <> 'settled'");
        expect(migration).toContain('debit.reconciliation_watermark >= p_observed_at');
        expect(load).toContain('GREATEST(');
        expect(load).toContain('monthly_limit_usd - snapshot.monthly_usage_usd');
    });

    it('has bounded nonblocking service-only recovery and retention cleanup', () => {
        const recover = definition('recover_analysis_beta_apify_credit_allocations');
        expect(recover).toContain('FOR UPDATE OF users SKIP LOCKED');
        expect(recover).toContain('p_limit NOT BETWEEN 1 AND 1000');
        expect(recover).toContain('pg_catalog.clock_timestamp()');
        expectServiceOnly('settle_analysis_beta_apify_credit_allocation(UUID,TEXT)');
        expectServiceOnly('recover_analysis_beta_apify_credit_allocations(INTEGER)');
        expectServiceOnly('archive_settled_analysis_beta_apify_credit_allocations(INTEGER)');
        expect(migration).toContain('ON DELETE SET NULL');
        expect(migration).toContain('analysis_beta_pool_local_debits');
    });
});
