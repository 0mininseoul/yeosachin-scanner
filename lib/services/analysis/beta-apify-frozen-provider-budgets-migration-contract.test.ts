import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const path = join(
    process.cwd(),
    'supabase/migrations/20260802060000_expose_betatest_frozen_provider_budgets.sql'
);
const migration = existsSync(path) ? readFileSync(path, 'utf8') : '';

function contextFunction(): string {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy('
    );
    const end = migration.indexOf('\n$$;', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end + 4);
}

describe('betatest frozen provider budget context migration', () => {
    it('takes the canonical allocation apply fence before any trigger or child repair lock', () => {
        const lock = 'LOCK TABLE public.analysis_beta_pool_allocations IN EXCLUSIVE MODE;';
        const lockIndex = migration.indexOf(lock);
        const functionIndex = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.activate_analysis_beta_pool_reservations()'
        );
        const triggerIndex = migration.indexOf(
            'CREATE TRIGGER activate_analysis_beta_pool_reservations'
        );
        const childRepairIndex = migration.indexOf(
            '\nUPDATE public.analysis_beta_pool_reservations AS reservation\n'
        );

        expect(lockIndex).toBeGreaterThan(
            migration.indexOf("SET LOCAL statement_timeout = '2min';")
        );
        expect(lockIndex).toBeLessThan(functionIndex);
        expect(lockIndex).toBeLessThan(triggerIndex);
        expect(lockIndex).toBeLessThan(childRepairIndex);
    });

    it('recreates the latest context fence without weakening predecessor claim semantics', () => {
        const context = contextFunction();
        for (const fragment of [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_execution_policies AS policy',
            'FROM public.analysis_beta_pool_allocations AS allocation',
            'FOR UPDATE',
            'v_now := pg_catalog.clock_timestamp()',
            "v_request.pipeline_version IS DISTINCT FROM 'v2'",
            "v_request.status NOT IN ('pending','processing')",
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
            'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH',
        ]) expect(context).toContain(fragment);
    });

    it('returns budgets only for an exact active beta allocation and eight matching reservations', () => {
        const context = contextFunction();
        for (const fragment of [
            'public.analysis_beta_valid_operation_slot_map(v_allocation.operation_slot_map)',
            'public.analysis_beta_valid_operation_budget_map(v_allocation.operation_budget_map)',
            "reservation.lifecycle_state IS DISTINCT FROM 'active'",
            'reservation.credential_slot IS DISTINCT FROM',
            'reservation.reserved_usd IS DISTINCT FROM',
            'v_beta_reservation_count <> 8',
            "'operationBudgets',v_allocation.operation_budget_map",
        ]) expect(context).toContain(fragment);
        expect(context).toContain("v_policy.mode = 'betatest_free_pool'");
        expect(context).toContain("v_allocation.lifecycle_state = 'active'");
        expect(context).toMatch(
            /CASE WHEN v_policy\.request_id IS NULL THEN NULL WHEN v_policy\.mode = 'betatest_free_pool' THEN[\s\S]*?'operationBudgets'/
        );
        expect(context).toMatch(
            /ELSE pg_catalog\.jsonb_build_object\([\s\S]*?'operationSlots',v_policy\.operation_slot_map[\s\S]*?\) END/
        );
    });

    it('keeps the RPC service-only and stores no credential or account identity', () => {
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;'
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) TO service_role;'
        );
        expect(migration).not.toMatch(/api[_-]?token|account[_-]?id|provider[_-]?payload/i);
    });
});
