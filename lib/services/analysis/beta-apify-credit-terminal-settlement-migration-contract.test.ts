import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260802090000_settle_betatest_terminal_credit.sql',
    import.meta.url,
), 'utf8');
const latestPurge = readFileSync(new URL(
    '../../../supabase/migrations/20260731010000_guard_preflight_purge_restricted_references.sql',
    import.meta.url,
), 'utf8');

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
        expect(migration).toContain('NOT EXISTS (SELECT 1 FROM public.analysis_beta_pool_allocations allocation WHERE allocation.preflight_id=preflight.id)');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_analysis_beta_apify_request_credit(UUID)');
        expect(migration).toContain('SET search_path = \'\'');
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
    });

    it('retains every latest purge fence apart from the intentional beta/rejected additions', () => {
        for (const fence of [
            'earlybird_orders', 'earlybird_waitlist',
            'earlybird_schema_failure_recoveries',
            'analysis_v2_replay_capture_authorizations',
        ]) {
            expect(latestPurge).toContain(fence);
            expect(migration).toContain(fence);
        }
        expect(migration).toContain('analysis_beta_pool_allocations allocation WHERE allocation.preflight_id=preflight.id');
        expect(migration).toContain("provider_run.status <> 'rejected'");
    });
});
