import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations');
const migrationName = readdirSync(migrationsDirectory).find(name =>
    /_add_authorized_revenue_settlement_readiness\.sql$/.test(name)
);
const migration = migrationName
    ? readFileSync(resolve(migrationsDirectory, migrationName), 'utf8')
    : '';

function functionBody(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) return '';
    const end = migration.indexOf('$$;', start);
    return end < 0 ? '' : migration.slice(start, end + 3);
}

describe('authorized revenue settlement readiness migration', () => {
    it('holds one exact admission replay for existing reconciliation without creating another provider generation', () => {
        expect(migrationName).toBeDefined();
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission('
        );
        expect(migration).toContain('RETURNS JSONB');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('p_selected_plan_id IS NULL');
        expect(migration).toContain('p_selected_plan_id NOT IN (\'basic\', \'standard\')');
        expect(migration).toContain('FROM public.analysis_preflights AS preflight');
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain('target-profile-fallback');
        expect(migration).toContain('target-profile-fresh-admission:g1');
        expect(migration).toContain("v_fallback.input_hash !~ '^[a-f0-9]{64}$'");
        expect(migration).toContain('v_fallback.input_hash IS DISTINCT FROM v_fresh.input_hash');
        expect(migration).not.toContain('SET target_input_hash = v_fallback.input_hash');
        expect(migration).toContain('v_preflight.target_input_hash IS NULL THEN');
        expect(migration).toContain("MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'");
        expect(migration).toContain('v_preflight.admission_generation IS DISTINCT FROM 1');
        expect(migration).toContain('usage_reconciled_at IS NULL');
        expect(migration).toContain("'not_applicable'");
        expect(migration).toContain("'replayable'");
        expect(migration).toContain("'pending'");
        expect(migration).toContain("'ready'");
        expect(migration).toContain("INTERVAL '2 minutes'");
        expect(migration).toContain("INTERVAL '30 seconds'");
        expect(migration).toContain("'admissionToken'");
        expect(migration).toContain('UPDATE public.analysis_preflights AS preflight');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(');
        expect(migration).toContain('TO service_role');
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.consume_analysis_v2_authorized_test_entitlement('
        );
        expect(migration).toContain(
            'prepare_analysis_v2_authorized_revenue_settlement_admission'
        );
        expect(migration).toContain(
            "MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_PENDING'"
        );
        expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.(?:analysis_requests|analysis_v2_test_entitlement_consumptions)/i);
        expect(migration).not.toMatch(/UPDATE\s+public\.(?:analysis_requests|analysis_preflight_provider_runs|analysis_v2_test_entitlement_consumptions)/i);
    });

    it('fences a NULL target hash before the first migration can return pending', () => {
        const readiness = functionBody(
            'prepare_analysis_v2_authorized_revenue_settlement_admission'
        );
        const nullFence = readiness.indexOf('IF v_preflight.target_input_hash IS NULL THEN');
        const pending = readiness.indexOf('IF v_fallback.usage_reconciled_at IS NULL');

        expect(nullFence).toBeGreaterThan(-1);
        expect(pending).toBeGreaterThan(-1);
        expect(nullFence).toBeLessThan(pending);
    });

    it('fences every registered strict g1 identity mismatch before the legacy reserve can create another generation', () => {
        const reserve = functionBody('reserve_analysis_v2_preflight_admission');
        const runnerLookup = reserve.indexOf('FROM public.load_e2e_test_runner_v1');
        const mismatchFence = reserve.indexOf("MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE'");
        const legacyReserve = reserve.indexOf(
            'analysis_v2_reserve_preflight_admission_after_settlement_internal'
            , mismatchFence
        );

        expect(runnerLookup).toBeGreaterThan(-1);
        expect(mismatchFence).toBeGreaterThan(runnerLookup);
        expect(legacyReserve).toBeGreaterThan(mismatchFence);
        expect(reserve).toContain('v_preflight.admission_generation < 1');
        expect(reserve).toContain('v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id');
        expect(reserve).toContain('v_preflight.admission_entitlement_jti_hash');
        expect(reserve).toContain('p_entitlement_jti_hash !~');
    });

    it('uses the base consume lock order before strict readiness takes the preflight row', () => {
        const wrapper = functionBody('consume_analysis_v2_authorized_test_entitlement');
        const jtiLock = wrapper.indexOf('pg_advisory_xact_lock');
        const userLock = wrapper.indexOf('FROM public.users AS account');
        const preflightLock = wrapper.indexOf(
            'prepare_analysis_v2_authorized_revenue_settlement_admission'
        );

        expect(jtiLock).toBeGreaterThan(-1);
        expect(userLock).toBeGreaterThan(jtiLock);
        expect(preflightLock).toBeGreaterThan(userLock);
        expect(wrapper).toContain('pg_catalog.hashtextextended(p_entitlement_jti_hash, 0)');
        expect(wrapper).toContain('FOR UPDATE');
    });

    it('reloads PostgREST metadata after adding the exact service-only RPC signatures', () => {
        expect(migration.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';$/);
        expect(migration).toContain(
            'public.prepare_analysis_v2_authorized_revenue_settlement_admission(\n    UUID, UUID, TEXT, TEXT\n) TO service_role'
        );
        expect(migration).toContain(
            'public.consume_analysis_v2_authorized_test_entitlement(\n    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB\n) TO service_role'
        );
    });
});
