import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260731080000_allow_pending_dispatch_recovery_adoption.sql',
    import.meta.url
), 'utf8');

describe('pending dispatch recovery adoption migration', () => {
    it('preserves the ABI and delegates every non-hybrid row', () => {
        expect(migration).toContain(
            'RENAME TO analysis_v2_valid_pre_hybrid_recovery_adoption_preflights'
        );
        expect(migration).toContain("p_recovery.admission_status <> 'pending'");
        expect(migration).toContain(
            'RETURN public.analysis_v2_valid_pre_hybrid_recovery_adoption_preflights'
        );
    });

    it('requires the exact order-bound pending/enqueued witness and time order', () => {
        for (const fragment of [
            "p_recovery.admission_status <> 'pending'",
            'p_recovery.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id',
            "'earlybird-fulfillment-admission-v1'",
            'p_recovery.admission_token IS NULL',
            'p_recovery.admission_requested_at IS NULL',
            "p_recovery.admission_dispatch_state <> 'enqueued'",
            'p_recovery.admission_dispatch_token IS NULL',
            'p_recovery.admission_dispatch_reserved_at IS NULL',
            'p_recovery.admission_dispatched_at IS NULL',
            '> p_recovery.admission_dispatch_reserved_at',
            '> p_recovery.admission_dispatched_at',
            'p_recovery.admission_dispatched_at > p_recovery.pii_scrubbed_at',
        ]) {
            expect(migration).toContain(fragment);
        }
    });

    it('normalizes only the hybrid admission fields in a local composite', () => {
        expect(migration).toContain('v_normalized := p_recovery');
        expect(migration).toContain("v_normalized.admission_status := 'idle'");
        expect(migration).toContain("v_normalized.admission_dispatch_state := 'idle'");
        expect(migration).toContain(
            'p_order, v_normalized, p_current'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_valid_recovery_adoption_preflights/
        );
    });
});
