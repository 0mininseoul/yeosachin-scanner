import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(
    process.cwd(), 'supabase/migrations/20260802080000_admit_betatest_apify_plan.sql'
), 'utf8');

describe('beta plan-admission migration contract', () => {
    it('keeps one service-only, transactionally fenced beta admission RPC', () => {
        expect(migration).toContain('CREATE FUNCTION public.admit_analysis_v2_betatest_plan(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain("v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest'");
        expect(migration).toContain("v_preflight.access_mode IS DISTINCT FROM 'production'");
        expect(migration).toContain('v_preflight.admission_token IS DISTINCT FROM p_admission_token');
        expect(migration).toContain('v_preflight.admission_generation IS DISTINCT FROM p_admission_generation');
        expect(migration).toContain("v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'");
        expect(migration).toContain('v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id');
        expect(migration).toContain('v_grant.expires_at <= v_now');
        expect(migration).toContain("REVOKE ALL ON FUNCTION public.admit_analysis_v2_betatest_plan(");
        expect(migration).toContain('TO service_role;');
    });

    it('freezes the exact hold, then activates all eight-family policy before a recoverable bootstrap job', () => {
        expect(migration).toContain("reservation.operation_family = 'target-profile'");
        expect(migration).toContain('v_target_reservation.reserved_usd IS DISTINCT FROM 0.005200000000');
        expect(migration).toContain('public.activate_analysis_beta_apify_request_credit(');
        expect(migration).toContain('policy_versions_snapshot, analysis_entry_channel');
        expect(migration).toContain("v_preflight.policy_versions_snapshot, 'standard'");
        expect(migration).toContain("'coordinator:bootstrap'");
        expect(migration).toContain('INSERT INTO public.analysis_pipeline_jobs');
        expect(migration).toContain("v_allocation.operation_slot_map IS DISTINCT FROM p_operation_slot_map");
        expect(migration).toContain("v_allocation.operation_budget_map IS DISTINCT FROM p_operation_budget_map");
        expect(migration).toContain('CREATE FUNCTION public.analysis_beta_plan_operation_budget_map');
        expect(migration).toContain('p_operation_budget_map IS DISTINCT FROM public.analysis_beta_plan_operation_budget_map(p_selected_plan_id)');
        expect(migration).not.toMatch(/secondary/);
    });

    it('has a stable lock order and preserves ordinary entitlement paths by adding no broad replacement', () => {
        const user = migration.indexOf('WHERE users.id = p_user_id FOR UPDATE');
        const preflight = migration.indexOf('WHERE preflight.id = p_preflight_id\n    FOR UPDATE');
        const allocation = migration.indexOf('WHERE allocation.preflight_id = p_preflight_id\n    FOR UPDATE');
        expect(user).toBeGreaterThan(-1);
        expect(preflight).toBeGreaterThan(user);
        expect(allocation).toBeGreaterThan(preflight);
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement');
    });
});
