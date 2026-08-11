import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260811100000_add_revenue_cost_provider_settlement_queue.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('revenue cost provider settlement queue migration contract', () => {
    it('extends the existing provider reconciliation queue with only exact trusted revenue children', () => {
        const list = functionDefinition('list_analysis_v2_unreconciled_provider_runs');

        expect(list).toContain("cost_operation.owner_kind = 'provider_run'");
        expect(list).toContain("cost_operation.status IN ('reserved', 'started', 'ambiguous')");
        expect(list).toContain("revenue_ledger.access_mode = 'test_entitlement'");
        expect(list).toContain("revenue_ledger.plan_id IN ('basic', 'standard')");
        expect(list).toContain("'revenueCostSettlementRequired'");
        expect(list).toContain('provider_run.actual_usage_usd IS NOT NULL');
        expect(list).toContain('provider_run.usage_reconciled_at IS NOT NULL');
        expect(list).toContain('FOR UPDATE OF provider_run SKIP LOCKED');
        expect(list).toContain('usage_reconciliation_attempt_count');
        expect(list).not.toContain('job_claim_token');
        expect(list).not.toContain('lease_token');
    });

    it('keeps the global provider RPC service-role-only and does not add a global revenue mutation RPC', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_analysis_v2_unreconciled_provider_runs\(INTEGER\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_analysis_v2_unreconciled_provider_runs\(INTEGER\)\s+TO service_role/
        );
        expect(migration).not.toContain('settle_analysis_revenue_cost_operation_v3');
        expect(migration).not.toContain('release_analysis_revenue_cost_operation_v3');
    });
});
