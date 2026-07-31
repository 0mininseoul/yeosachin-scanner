import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260731070000_allow_fully_scrubbed_provider_run_adoption.sql',
    import.meta.url
), 'utf8');

describe('fully scrubbed provider-run adoption migration', () => {
    it('keeps the retained-admission policy and adds a fully scrubbed branch', () => {
        expect(migration).toContain(
            'RENAME TO analysis_v2_valid_retained_admission_adoption_preflights'
        );
        expect(migration).toContain("p_recovery.admission_status <> 'idle'");
        expect(migration).toContain('p_recovery.admission_plan_cards_snapshot IS NOT NULL');
        expect(migration).toContain(
            "'retained.' || pg_catalog.substr("
        );
        expect(migration).toContain("p_recovery.admission_status <> 'ready'");
        expect(migration).toContain(
            'p_recovery.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id'
        );
        expect(migration).toContain(
            "'earlybird-fulfillment-admission-v1'"
        );
    });

    it('recomputes current cards from current counts and checks order capacity independently', () => {
        expect(migration).toContain('p_current.target_followers_count');
        expect(migration).toContain('p_current.plan_cards_snapshot = v_cards');
        expect(migration).toContain('p_order.target_followers_count');
        expect(migration).toContain(
            "<= (v_selected->'relationshipCapacity'->>'followers')::INTEGER"
        );
        expect(migration).not.toContain(
            'p_current.target_followers_count IS DISTINCT FROM p_order.target_followers_count'
        );
    });

    it('requires the immutable failed-request receipt and fail-closed resolver patch', () => {
        expect(migration).toContain('analysis_v2_failure_receipts AS receipt');
        expect(migration).toContain(
            'ANALYSIS_V2_FULLY_SCRUBBED_ADOPTION_PATCH_MISMATCH'
        );
        expect(migration).toContain(
            "'OR NOT public.analysis_v2_valid_recovery_adoption_preflights('"
        );
        expect(migration).toContain('EXECUTE v_rewritten');
        expect(migration).toContain(
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
        );
    });
});
