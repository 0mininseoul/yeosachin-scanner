import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260802090000_settle_betatest_terminal_credit.sql',
    import.meta.url,
), 'utf8');
const latestPurgeSchema = readFileSync(new URL(
    '../../../supabase/migrations/20260731130000_rearm_terminal_unavailable_job_exhaustion.sql',
    import.meta.url,
), 'utf8');
const settlementRuntime = readFileSync(new URL(
    './beta-apify-credit-settlement-runtime.ts',
    import.meta.url,
), 'utf8');

function functionHeader(name: string): string {
    const start = migration.indexOf(`FUNCTION public.${name}`);
    const end = migration.indexOf('AS $$', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('terminal betatest credit settlement migration contract', () => {
    it('keeps rejected runs zero-cost while retaining unresolved starts', () => {
        expect(migration).toContain("provider_run.status = 'rejected' OR");
        expect(migration).toContain("'succeeded','failed','aborted','timed_out'");
        expect(migration).not.toMatch(/starting'[\s\S]*?0::NUMERIC/);
    });

    it('uses narrow service-only post-terminal targeting and safe archival', () => {
        expect(migration).toContain('settle_analysis_beta_apify_request_credit');
        expect(migration).toContain('settle_analysis_beta_apify_preflight_credit');
        expect(migration).toContain("allocation.lifecycle_state='settled'");
        expect(migration).toContain('FOR UPDATE OF users SKIP LOCKED');
        expect(migration).toMatch(/NOT EXISTS \([\s\S]*?analysis_beta_pool_allocations AS allocation[\s\S]*?allocation\.preflight_id = preflight\.id/);
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_request_credit(UUID)');
        expect(migration).toContain('SET search_path = \'\'');
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
    });

    it('bounds invocation-time locks and independently aborts slow application RPCs', () => {
        for (const name of [
            'settle_analysis_beta_apify_credit_allocation',
            'settle_analysis_beta_apify_request_credit',
            'settle_analysis_beta_apify_preflight_credit',
            'archive_fully_settled_analysis_beta_apify_credit_allocations',
            'archive_settled_analysis_beta_apify_credit_allocations',
            'purge_expired_analysis_v2_preflights',
        ]) {
            expect(functionHeader(name)).toContain("SET lock_timeout = '1s'");
            expect(functionHeader(name)).toContain("SET statement_timeout = '5s'");
        }
        expect(migration).toMatch(
            /ALTER FUNCTION public\.recover_analysis_beta_apify_credit_allocations\(INTEGER\)[\s\S]*?SET lock_timeout TO '1s'/,
        );
        expect(migration).toMatch(
            /ALTER FUNCTION public\.recover_analysis_beta_apify_credit_allocations\(INTEGER\)[\s\S]*?SET statement_timeout TO '5s'/,
        );
        expect(settlementRuntime).toContain('new AbortController()');
        expect(settlementRuntime).toContain('BETA_APIFY_MAINTENANCE_RPC_TIMEOUT_MS = 5_000');
        expect(settlementRuntime).toContain('controller.abort()');
    });

    it('retains every latest purge fence apart from the intentional beta/rejected additions', () => {
        for (const fence of [
            'earlybird_orders', 'earlybird_waitlist',
            'earlybird_schema_failure_recoveries',
            'analysis_v2_replay_capture_authorizations',
            'earlybird_adoption_policy_failure_rearms',
            'earlybird_terminal_unavailable_exhaustion_rearms',
        ]) {
            expect(migration).toContain(fence);
        }
        expect(latestPurgeSchema).toContain('earlybird_terminal_unavailable_exhaustion_rearms');
        expect(latestPurgeSchema).toContain('earlybird_adoption_policy_failure_rearms');
        expect(migration).toMatch(/analysis_beta_pool_allocations AS allocation[\s\S]*?allocation\.preflight_id = preflight\.id/);
        expect(migration).toContain("provider_run.status <> 'rejected'");
    });
});
