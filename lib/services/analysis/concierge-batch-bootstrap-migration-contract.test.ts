import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260816154000_prepare_concierge_batch_order.sql',
    import.meta.url,
);

describe('concierge batch bootstrap migration contract', () => {
    it('bounds preparation row-lock waits at the RPC boundary', () => {
        const migration = readFileSync(new URL(
            '../../../supabase/migrations/20260816160000_bound_concierge_batch_prepare_lock_wait.sql',
            import.meta.url,
        ), 'utf8');
        expect(migration).toMatch(
            /ALTER FUNCTION public\.prepare_concierge_batch_order\(UUID\)\s+SET lock_timeout = '5s';/,
        );
    });

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

    it('orders candidate hash computation before expected-hash comparison and insert', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        const freezeStart = migration.indexOf('CREATE FUNCTION public.freeze_concierge_batch_cohort(');
        const prepareStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order(', freezeStart);
        expect(freezeStart).toBeGreaterThanOrEqual(0);
        expect(prepareStart).toBeGreaterThan(freezeStart);
        const freezeBody = migration.slice(freezeStart, prepareStart);
        const candidateHashAssignment = freezeBody.indexOf('INTO v_manifest_hash\n    FROM public.earlybird_orders');
        const expectedHashGuard = freezeBody.indexOf('IF v_manifest_hash IS DISTINCT FROM p_expected_manifest_hash THEN');
        const cohortInsert = freezeBody.indexOf('INSERT INTO public.earlybird_concierge_batch_cohort_members (');
        expect(candidateHashAssignment).toBeGreaterThanOrEqual(0);
        expect(expectedHashGuard).toBeGreaterThan(candidateHashAssignment);
        expect(cohortInsert).toBeGreaterThan(expectedHashGuard);
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
