import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql',
    import.meta.url,
), 'utf8');

describe('Vertex AI budget reservation migration contract', () => {
    it('creates a service-only monetary reservation ledger with all three scope indexes', () => {
        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.vertex_ai_budget_reservations');
        expect(migration).toContain('vertex_ai_budget_run_totals_idx');
        expect(migration).toContain('vertex_ai_budget_order_totals_idx');
        expect(migration).toContain('vertex_ai_budget_day_totals_idx');
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
        expect(migration).not.toContain('20260719190000_reconcile_stuck_groble_earlybird_order.sql');
    });
});
