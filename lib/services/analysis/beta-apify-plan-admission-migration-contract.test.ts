import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(
    process.cwd(), 'supabase/migrations/20260802080000_admit_betatest_apify_plan.sql'
), 'utf8');

describe('beta plan-admission migration contract', () => {
    it('keeps narrow service-only fresh-admission and replay RPCs', () => {
        expect(migration).toContain('CREATE FUNCTION public.admit_analysis_v2_betatest_plan(');
        expect(migration).toContain('CREATE FUNCTION public.load_analysis_v2_betatest_plan_replay(');
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
        expect(migration).toContain("REVOKE ALL ON FUNCTION public.load_analysis_v2_betatest_plan_replay(");
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.admit_analysis_v2_betatest_plan('
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.load_analysis_v2_betatest_plan_replay('
        );
    });

    it('owns one immutable all-plan budget catalog and persists a recoverable bootstrap job', () => {
        expect(migration).toContain('CREATE FUNCTION public.analysis_beta_plan_operation_budget_map');
        expect(migration).toContain(
            '"profile-fallback":0.782600000001,"profile-repair":0.81'
        );
        expect(migration).toContain(
            '"profile-fallback":1.5626,"profile-repair":1.62'
        );
        expect(migration).toContain(
            '"profile-fallback":2.3426,"profile-repair":2.43'
        );
        expect(migration).toContain("reservation.operation_family = 'target-profile'");
        expect(migration).toContain('v_target_reservation.reserved_usd IS DISTINCT FROM 0.005200000000');
        expect(migration).toContain('public.activate_analysis_beta_apify_request_credit(');
        expect(migration).toContain('policy_versions_snapshot,');
        expect(migration).toContain('analysis_entry_channel');
        expect(migration).toContain('v_preflight.policy_versions_snapshot,');
        expect(migration).toContain("'coordinator:bootstrap'");
        expect(migration).toContain('INSERT INTO public.analysis_pipeline_jobs');
        expect(migration).toMatch(
            /p_operation_budget_map IS DISTINCT FROM\s+public\.analysis_beta_plan_operation_budget_map\(p_selected_plan_id\)/
        );
        expect(migration).not.toMatch(/secondary/);
    });

    it('validates full stored replay identity without consulting current grant or proposed maps', () => {
        const replayStart = migration.indexOf(
            'CREATE FUNCTION public.analysis_v2_betatest_plan_replay_internal('
        );
        const replayEnd = migration.indexOf(
            'CREATE FUNCTION public.load_analysis_v2_betatest_plan_replay('
        );
        const replay = migration.slice(replayStart, replayEnd);
        expect(replay).toContain("v_allocation.lifecycle_state NOT IN ('active', 'settled')");
        expect(replay).toContain('v_allocation.operation_slot_map,');
        expect(replay).toContain('v_allocation.operation_budget_map,');
        expect(replay).toContain("v_request.analysis_entry_channel IS DISTINCT FROM 'betatest'");
        expect(replay).toContain("v_job.track IS DISTINCT FROM 'coordinator'");
        expect(replay).toContain("v_job.kind IS DISTINCT FROM 'bootstrap'");
        expect(replay).toContain("v_policy.mode IS DISTINCT FROM 'betatest_free_pool'");
        expect(replay).toContain('v_reservation_count <> 8');
        expect(replay).toContain('v_active_reservation_count < 1');
        expect(replay).toContain(
            "reservation.lifecycle_state NOT IN ('active', 'settled')"
        );
        expect(replay).not.toContain('analysis_beta_access_grants');
        expect(replay).not.toContain('p_operation_slot_map');
        expect(replay).not.toContain('p_operation_budget_map');
    });

    it('samples time after authoritative locks and preserves ordinary entitlement paths', () => {
        const admissionStart = migration.indexOf(
            'CREATE FUNCTION public.admit_analysis_v2_betatest_plan('
        );
        const admission = migration.slice(admissionStart);
        const user = admission.indexOf('WHERE users.id = p_user_id\n    FOR UPDATE');
        const preflight = admission.indexOf(
            'WHERE preflight.id = p_preflight_id\n    FOR UPDATE'
        );
        const allocation = admission.indexOf(
            'WHERE allocation.preflight_id = p_preflight_id\n    FOR UPDATE'
        );
        const targetReservation = admission.indexOf(
            "AND reservation.operation_family = 'target-profile'\n    FOR UPDATE"
        );
        const grant = admission.indexOf(
            'WHERE grant_row.user_id = p_user_id\n    FOR UPDATE'
        );
        const sampledNow = admission.indexOf('v_now := pg_catalog.clock_timestamp();');
        const activation = admission.lastIndexOf(
            'v_activation := public.activate_analysis_beta_apify_request_credit('
        );
        const postActivationNow = admission.indexOf(
            'v_now := pg_catalog.clock_timestamp();',
            sampledNow + 1
        );
        const postActivationFence = admission.slice(postActivationNow);
        expect(user).toBeGreaterThan(-1);
        expect(preflight).toBeGreaterThan(user);
        expect(allocation).toBeGreaterThan(preflight);
        expect(targetReservation).toBeGreaterThan(allocation);
        expect(grant).toBeGreaterThan(targetReservation);
        expect(sampledNow).toBeGreaterThan(grant);
        expect(activation).toBeGreaterThan(sampledNow);
        expect(postActivationNow).toBeGreaterThan(activation);
        expect(postActivationFence).toContain(
            "v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'"
        );
        expect(postActivationFence).toContain(
            "v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds'"
        );
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement');
    });
});
