import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql',
    import.meta.url,
), 'utf8');
const aclCorrectionMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260902091001_revoke_vertex_ai_budget_rpc_api_execute.sql',
    import.meta.url,
), 'utf8');

describe('Vertex AI budget reservation migration contract', () => {
    it('creates a service-only monetary reservation ledger with all three scope indexes', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.vertex_ai_budget_reservations');
        expect(migration).toContain('vertex_ai_budget_run_totals_idx');
        expect(migration).toContain('vertex_ai_budget_order_totals_idx');
        expect(migration).toContain('vertex_ai_budget_day_totals_idx');
        expect(migration).toContain('vertex_ai_budget_terminal_retention_idx');
        expect(migration).toContain("state IN ('reserved', 'settled', 'cancelled')");
        expect(migration).toContain('ALTER TABLE public.vertex_ai_budget_reservations FORCE ROW LEVEL SECURITY');
    });

    it('locks and enforces run, order, and UTC-day ceilings before inserting a reservation', () => {
        expect(migration).toContain("hashtextextended('vertex-ai-budget:all-scopes', 0)");
        expect(migration).toContain('p_per_run_limit_usd NUMERIC');
        expect(migration).toContain('p_per_order_limit_usd NUMERIC');
        expect(migration).toContain('p_daily_limit_usd NUMERIC');
        expect(migration).toContain('VERTEX_AI_BUDGET_EXCEEDED:run');
        expect(migration).toContain('VERTEX_AI_BUDGET_EXCEEDED:order');
        expect(migration).toContain('VERTEX_AI_BUDGET_EXCEEDED:day');
        expect(migration).toContain('RETURN QUERY INSERT INTO public.vertex_ai_budget_reservations');
        expect(migration).toContain('p_day_key IS NOT NULL');
        expect(migration).toContain('reserved/settled work anchored to its original UTC day');
    });

    it('keeps cancellation, conservative settlement, and RPC access fail-closed', () => {
        expect(migration).toContain('state = \'cancelled\'');
        expect(migration).toContain('usage_unknown = p_actual_cost_usd IS NULL');
        expect(migration).toContain('actual_cost_usd IS NULL');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.reserve_vertex_ai_budget');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.reserve_vertex_ai_budget');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.settle_vertex_ai_budget');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.cancel_vertex_ai_budget');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.snapshot_vertex_ai_budget');
        expect(migration).toContain('preserves reservation-key tombstones');
        expect(migration).not.toContain('20260719190000_reconcile_stuck_groble_earlybird_order.sql');
    });

    it('removes explicit API-role EXECUTE grants without changing defaults or function bodies', () => {
        for (const signature of [
            'public.reserve_vertex_ai_budget(',
            'public.settle_vertex_ai_budget(TEXT, UUID, NUMERIC)',
            'public.cancel_vertex_ai_budget(TEXT, UUID)',
            'public.snapshot_vertex_ai_budget()',
        ]) {
            expect(aclCorrectionMigration).toContain(`REVOKE EXECUTE ON FUNCTION ${signature}`);
            expect(aclCorrectionMigration).toContain('FROM PUBLIC, anon, authenticated;');
            expect(aclCorrectionMigration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
            expect(aclCorrectionMigration).toContain('TO service_role;');
        }
        expect(aclCorrectionMigration.match(/REVOKE EXECUTE ON FUNCTION/g)).toHaveLength(4);
        expect(aclCorrectionMigration.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(4);
        expect(aclCorrectionMigration).not.toContain('ALTER DEFAULT PRIVILEGES');
        expect(aclCorrectionMigration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(aclCorrectionMigration).not.toMatch(/TO\s+(?:PUBLIC|anon|authenticated)/);
    });
});
