import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816155500_reconcile_exact_three_concierge_target_lineage.sql', import.meta.url),
    'utf8',
);

describe('exact concierge target-lineage repair migration contract', () => {
    it('uses an audited, service-only exact-three RPC instead of widening freeze eligibility', () => {
        expect(migration).toContain('CREATE TABLE public.earlybird_concierge_batch_target_lineage_repairs');
        expect(migration).toContain('CREATE FUNCTION public.reconcile_exact_three_concierge_target_lineage(');
        expect(migration).toContain('p_expected_allowlist_hash TEXT');
        expect(migration).toContain('CONCIERGE_BATCH_TARGET_LINEAGE_ALLOWLIST_CONFLICT');
        expect(migration).toContain('CONCIERGE_BATCH_TARGET_LINEAGE_COUNT_CONFLICT');
        expect(migration).toContain('earlybird_first15_canary_provider_rearms');
        expect(migration).toContain("rearm.rearm_generation = 3");
        expect(migration).toContain("rearm.source_credential_slot = 'quinary'");
        expect(migration).toContain("rearm.fallback_credential_slot = 'primary'");
        expect(migration).toContain("request_row.target_instagram_id = 'retained.'");
        expect(migration).toContain("preflight.target_instagram_id = 'retained.'");
        expect(migration).toContain("request_row.error_message IN (");
        expect(migration).toContain("earlybird_order.status = 'analysis_in_progress'");
        expect(migration).toContain("fulfillment.status = 'analysis_in_progress'");
        expect(migration).toMatch(
            /NOT EXISTS \(\s+SELECT 1\s+FROM public\.earlybird_webhook_events/
        );
        expect(migration).toContain('payment.refunded');
        expect(migration).toContain('payment.refund_pending');
        expect(migration).toContain('payment.cancelled');
        expect(migration).toContain('payment.failed');
        expect(migration).toContain('usage_reconciled_at IS NULL');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.reconcile_exact_three_concierge_target_lineage');
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.reconcile_exact_three_concierge_target_lineage\([^)]*\)\s+TO service_role/);
    });

    it('updates only target fields and keeps the existing cohort freeze guard untouched', () => {
        expect(migration).toContain('UPDATE public.analysis_requests');
        expect(migration).toContain('UPDATE public.analysis_preflights');
        expect(migration).not.toContain('UPDATE public.earlybird_orders');
        expect(migration).not.toContain('UPDATE public.earlybird_fulfillments');
        expect(migration).not.toContain('UPDATE public.analysis_pipeline_jobs');
        expect(migration).not.toContain('UPDATE public.analysis_v2_provider_runs');
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.freeze_concierge_batch_cohort');
    });
});
