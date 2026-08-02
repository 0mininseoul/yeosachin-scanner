import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260802030000_bind_betatest_provider_policy.sql'
);
const validationPath = join(
    process.cwd(),
    'supabase/migrations/20260802030100_validate_betatest_provider_policy.sql'
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';
const validationMigration = existsSync(validationPath)
    ? readFileSync(validationPath, 'utf8')
    : '';

function functionDefinition(name: string): string {
    const signature = `FUNCTION public.${name}(`;
    const start = migration.indexOf(signature);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const createStart = migration.lastIndexOf('CREATE', start);
    const end = migration.indexOf('\n$$;', start);
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(createStart, end + '\n$$;'.length);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const current = source.indexOf(fragment, previous + 1);
        expect(current, `missing/out of order: ${fragment}`).toBeGreaterThan(previous);
        previous = current;
    }
}

function expectServiceOnly(signature: string): void {
    const escaped = signature
        .replaceAll('(', '\\(\\s*')
        .replaceAll(')', '\\s*\\)')
        .replaceAll(',', '\\s*,\\s*')
        .replaceAll(' ', '\\s+');
    expect(migration).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+`
        + 'FROM PUBLIC, anon, authenticated, service_role'
    ));
    expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role`
    ));
}

describe('betatest provider policy/guard migration contract', () => {
    it('uses a forward policy migration and a pure validation transaction', () => {
        expect(migration).not.toBe('');
        expect(validationMigration).not.toBe('');
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
        expect(migration).toContain('ADD CONSTRAINT');
        expect(migration).toContain('NOT VALID');
        expect(migration).not.toContain('VALIDATE CONSTRAINT');
        expect(validationMigration.trim()).toMatch(
            /^SET LOCAL lock_timeout[\s\S]*ALTER TABLE public\.analysis_v2_provider_execution_policies[\s\S]*VALIDATE CONSTRAINT[\s\S]*;$/
        );
        expect(validationMigration).not.toMatch(
            /CREATE|DROP|ADD CONSTRAINT|CREATE OR REPLACE|UPDATE|INSERT|DELETE/
        );
    });

    it('makes exactly the legacy and beta policy branches legal', () => {
        expect(migration).toContain(
            'ALTER COLUMN entitlement_jti_hash DROP NOT NULL'
        );
        for (const legacy of [
            "mode = 'test_operation_split'",
            "policy_version = 'authorized-free-e2e-v1'",
            'entitlement_jti_hash IS NOT NULL',
            'public.analysis_v2_valid_test_operation_slot_map(operation_slot_map)',
        ]) {
            expect(migration).toContain(legacy);
        }
        for (const beta of [
            "mode = 'betatest_free_pool'",
            "policy_version = 'betatest-free-pool-v1'",
            'entitlement_jti_hash IS NULL',
            'public.analysis_beta_valid_operation_slot_map(operation_slot_map)',
        ]) {
            expect(migration).toContain(beta);
        }
        expect(migration).not.toMatch(/ALTER TABLE[\s\S]*DISABLE ROW LEVEL SECURITY/);
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_provider_execution_policies\s+FROM PUBLIC, anon, authenticated, service_role/
        );
    });

    it('binds a request-target-derived beta policy before dispatch/state transition', () => {
        const activate = functionDefinition(
            'activate_analysis_beta_apify_request_credit'
        );
        expect(activate).toContain("'betatest_free_pool'");
        expect(activate).toContain("'betatest-free-pool-v1'");
        expect(activate).toContain('pg_catalog.lower(v_request.target_instagram_id)');
        expect(activate).toContain('v_existing.operation_slot_map');
        expect(activate).toContain('analysis_beta_provider_policy_hash');
        expectInOrder(activate, [
            'activate_analysis_beta_apify_request_credit_unbound',
            'FROM public.analysis_beta_pool_allocations AS allocation',
            'FROM public.analysis_requests AS analysis_request',
            'INSERT INTO public.analysis_v2_provider_execution_policies',
        ]);
        expect(activate).not.toContain('dispatch_state =');
        expect(activate).toContain('ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT');
        expectServiceOnly(
            'activate_analysis_beta_apify_request_credit(UUID,UUID,UUID,TEXT,JSONB,JSONB,INTEGER)'
        );
    });

    it('keeps active replay usable after dispatch but validates the stored policy', () => {
        const activate = functionDefinition(
            'activate_analysis_beta_apify_request_credit'
        );
        const activeBranch = activate.slice(
            activate.indexOf("v_before.lifecycle_state = 'active'")
        );
        expect(activate).toContain(
            'FROM public.analysis_v2_provider_execution_policies AS policy'
        );
        expect(activate).toContain('FOR UPDATE');
        expect(activeBranch).toContain('v_existing.policy_hash');
        expect(activeBranch).toContain('v_existing.operation_slot_map');
        expect(activeBranch).toContain('RETURN v_result');
    });

    it('enforces beta reservation slot and cumulative family budget before internal reserve', () => {
        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        expectInOrder(reserve, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_beta_pool_allocations AS allocation',
            'FROM public.analysis_beta_pool_reservations AS reservation',
            'FROM public.analysis_v2_provider_runs AS provider_run',
            'public.analysis_v2_reserve_provider_run_internal',
        ]);
        expect(reserve).toContain("v_request.analysis_entry_channel = 'betatest'");
        expect(reserve).toContain("'profile-repair'");
        expect(reserve).toContain('public.analysis_beta_valid_apify_credential_slot');
        expect(reserve).toContain('v_reservation.credential_slot');
        expect(reserve).toContain('v_reservation.reserved_usd');
        expect(reserve).toContain('provider_run.request_id = p_request_id');
        expect(reserve).toContain('provider_run.job_key IS DISTINCT FROM p_job_key');
        expect(reserve).toContain('provider_run.operation_key IS DISTINCT FROM p_operation_key');
        expect(reserve).toContain('ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED');
        expect(reserve).toContain('ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH');
        expect(reserve).toContain('ANALYSIS_BETA_PROVIDER_RUN_OPERATION_INVALID');
        expectServiceOnly(
            'reserve_analysis_v2_provider_run(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID)'
        );
    });

    it('preserves shared internal validation and live-claim replay takeover', () => {
        const internal = functionDefinition(
            'analysis_v2_reserve_provider_run_internal'
        );
        for (const validation of [
            'v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp()',
            'pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160',
            'NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)',
            "p_input_hash !~ '^[0-9a-f]{64}$'",
            "p_logical_provider NOT IN ('apify', 'coderx')",
            'pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200',
            'NOT public.analysis_v2_valid_apify_credential_slot',
            'p_reservation_token IS NULL',
        ]) {
            expect(internal).toContain(validation);
        }
        expectInOrder(internal, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_runs AS provider_run',
            'IF v_existing.job_claim_token IS DISTINCT FROM p_claim_token',
            'UPDATE public.analysis_v2_provider_runs AS provider_run',
            'SET job_claim_token = p_claim_token',
            'updated_at = v_now',
        ]);
    });

    it('retains the legacy profile-repair alias only in the legacy branch', () => {
        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        const legacy = reserve.slice(
            reserve.indexOf("ELSIF FOUND THEN")
        );
        expect(legacy).toContain("v_operation_kind = 'profile-repair'");
        expect(legacy).toContain("v_operation_kind := 'profile-fallback'");
        const beta = reserve.slice(
            reserve.indexOf("v_request.analysis_entry_channel = 'betatest'")
        );
        expect(beta).toContain("'profile-repair'");
        expect(beta).not.toContain("v_operation_family := 'profile-fallback'");
    });

    it('guards both beta preflight reservation entry points behind one locked hold', () => {
        const initial = functionDefinition(
            'reserve_analysis_preflight_provider_run'
        );
        const fresh = functionDefinition(
            'reserve_analysis_v2_fresh_admission_provider_run'
        );
        for (const definition of [initial, fresh]) {
            expect(definition).toContain("analysis_entry_channel = 'betatest'");
            expectInOrder(definition, [
                'FROM public.analysis_preflights AS preflight',
                'FROM public.analysis_beta_pool_allocations AS allocation',
                'FROM public.analysis_beta_pool_reservations AS reservation',
                'FROM public.analysis_preflight_provider_runs AS provider_run',
                'INSERT INTO public.analysis_preflight_provider_runs',
            ]);
            expect(definition).toContain("operation_family = 'target-profile'");
            expect(definition).toContain('v_target_reservation.reserved_usd');
            expect(definition).toContain('PERFORM 1 FROM public.analysis_preflight_provider_runs AS provider_run');
            expect(definition).toContain(
                'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_BUDGET_EXCEEDED'
            );
        }
        expect(initial).toContain("operation_key = 'target-profile-fallback'");
        expect(fresh).toContain('p_admission_generation > 1');
        expect(fresh).toContain(
            'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_GENERATION_INVALID'
        );
        expect(fresh).toContain('public.adopt_legacy_fresh_admission_provider_run');
    });

    it('allows a policy-bearing production collection context only for exact beta state', () => {
        const context = functionDefinition(
            'load_analysis_v2_collection_context_with_policy'
        );
        expect(context).toContain("v_request.analysis_entry_channel = 'betatest'");
        expect(context).toContain("v_preflight.analysis_entry_channel = 'betatest'");
        expect(context).toContain("v_policy.mode = 'betatest_free_pool'");
        expect(context).toContain("v_allocation.lifecycle_state = 'active'");
        expect(context).toContain(
            'v_policy.operation_slot_map IS NOT DISTINCT FROM v_allocation.operation_slot_map'
        );
        expect(context).toContain('analysis_beta_provider_policy_hash');
        expect(context).toContain(
            "v_request.plan_access_mode_snapshot = 'production' AND v_policy.request_id IS NOT NULL"
        );
        expectServiceOnly(
            'load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT)'
        );
    });

    it('keeps helper internals revoked and adds no settlement surface', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_beta_provider_policy_hash\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_beta_provider_policy_hash/
        );
        expect(migration).not.toMatch(
            /settle_analysis_beta|recover_expired_analysis_beta|actual_usage_usd|reconciled_actual_usd/
        );
    });
});
