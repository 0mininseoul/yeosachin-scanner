import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260816154000_prepare_concierge_batch_order.sql',
    import.meta.url,
);

describe('concierge batch bootstrap migration contract', () => {
    it('rejects cohort substitutions or newly-paid rows without the preapproved hash', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('CREATE FUNCTION public.freeze_concierge_batch_cohort(\n    p_expected_manifest_hash TEXT');
        expect(migration).toContain("p_expected_manifest_hash IS NULL");
        expect(migration).toContain("p_expected_manifest_hash !~ '^[a-f0-9]{64}$'");
        expect(migration).toContain('v_manifest_hash IS DISTINCT FROM p_expected_manifest_hash');
        expect(migration).toContain('v_existing_hash IS DISTINCT FROM p_expected_manifest_hash');
        expect(migration).toContain('earlybird_order.result_request_id IS NULL');
        expect(migration).toContain('CONCIERGE_BATCH_COHORT_EXPECTED_HASH_CONFLICT');
    });

    it('creates only a service-role request-pair bootstrap and never advances fulfillment', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('CREATE TABLE public.earlybird_concierge_batch_cohort_members');
        expect(migration).toContain('CREATE FUNCTION public.freeze_concierge_batch_cohort(\n    p_expected_manifest_hash TEXT');
        expect(migration).toContain('CONCIERGE_BATCH_COHORT_COUNT_CONFLICT');
        expect(migration).toContain('FOR UPDATE OF earlybird_order, fulfillment');
        expect(migration).toContain('payment_id_fingerprint');
        expect(migration).toContain('LOCK TABLE public.earlybird_concierge_batch_cohort_members');
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain("v_order.status NOT IN ('paid', 'analysis_in_progress')");
        expect(migration).toContain('INSERT INTO public.analysis_requests');
        expect(migration).toContain('UPDATE public.earlybird_orders');
        expect(migration).toContain('v_order.actual_groble_product_id IS DISTINCT FROM v_manifest.actual_product_id');
        expect(migration).not.toContain('UPDATE public.earlybird_fulfillments');
        expect(migration).not.toContain('auto_admit');
        expect(migration).not.toContain('advance_earlybird');
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.prepare_concierge_batch_order\(/);
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.freeze_concierge_batch_cohort\(TEXT\)/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.prepare_concierge_batch_order\([^)]*\)\s+TO service_role/);
    });
});
