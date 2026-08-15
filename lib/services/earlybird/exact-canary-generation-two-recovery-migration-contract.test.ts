import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260815140000_recover_exact_canary_generation_two_pending_idle.sql',
    import.meta.url,
), 'utf8');

function recoveryDefinition(): string {
    const marker = 'CREATE FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(';
    const start = migration.indexOf(marker);
    expect(start, 'recovery RPC must exist').toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, 'recovery RPC must have a bounded body').toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('exact generation-two pending-idle canary recovery migration contract', () => {
    it('fences recovery behind the already-applied PR403 prerequisite migration', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815130000');
        expect(migration).toContain("WHERE version = '20260815130000'");
    });

    it('resumes only the verified no-spend checkpoint and never rebinds or recollects', () => {
        const recovery = recoveryDefinition();

        expect(recovery).toContain('SECURITY DEFINER');
        expect(recovery).toContain("SET search_path = ''");
        expect(recovery).toContain("v_order.status IS DISTINCT FROM 'paid'");
        expect(recovery).toContain('refund_event.event_type IN (');
        expect(recovery).toContain("'payment.refunded'");
        expect(recovery).toContain("v_fulfillment.status IS DISTINCT FROM 'admission_pending'");
        expect(recovery).toContain('v_current.admission_generation IS DISTINCT FROM 2');
        expect(recovery).toContain("v_current.admission_status IS DISTINCT FROM 'pending'");
        expect(recovery).toContain("v_current.admission_dispatch_state IS DISTINCT FROM 'idle'");
        expect(recovery).toContain('analysis_preflight_provider_runs AS generation_one_run');
        expect(recovery).toContain("generation_one_run.operation_key = 'target-profile-fresh-admission:g1'");
        expect(recovery).toContain("generation_one_run.status = 'succeeded'");
        expect(recovery).toContain('analysis_preflight_provider_runs AS generation_two_run');
        expect(recovery).toContain("generation_two_run.operation_key = 'target-profile-fresh-admission:g2'");
        expect(recovery).toContain('v_current.admission_target_followers_count IS NOT NULL');
        expect(recovery).not.toContain('v_source.admission_generation');
        expect(recovery).toContain('public.claim_earlybird_fulfillment');
        expect(recovery).toContain('public.create_or_replay_earlybird_fulfillment_request');
        expect(recovery).not.toContain('rebind_expired_paid_earlybird_preflight');
        expect(recovery).not.toContain('reserve_analysis_v2_preflight_admission');
        expect(recovery).not.toContain('INSERT INTO public.analysis_preflight_provider_runs');
    });

    it('keeps the recovery callable only by service_role', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_exact_earlybird_generation_two_pending_idle\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_exact_earlybird_generation_two_pending_idle\([\s\S]*?TO service_role;/
        );
    });
});
