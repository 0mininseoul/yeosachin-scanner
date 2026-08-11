import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const oldMigration = readFileSync(
    new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url),
    'utf8',
);
const aiLifecyclePath = new URL(
    '../../../supabase/migrations/20260811105000_add_revenue_ai_cost_lifecycle_contract.sql',
    import.meta.url,
);
const aiLifecycle = existsSync(aiLifecyclePath) ? readFileSync(aiLifecyclePath, 'utf8') : '';
const routingMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811110000_add_revenue_gender_routing_attempt_contract.sql', import.meta.url),
    'utf8',
);

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

describe('revenue migration forward-only compatibility', () => {
    it('keeps the already-applied cost foundation byte-for-byte immutable', () => {
        expect(sha256(oldMigration)).toBe('d730b9127b890ea9475e81f4eaefcd6fcf30fceb27efcc6b7b13f510390f4254');
    });

    it('moves the AI lifecycle into a later migration before routing consumes it', () => {
        expect(existsSync(aiLifecyclePath)).toBe(true);
        expect(aiLifecycle).toContain('CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_assert_lineage_v1');
        expect(aiLifecycle).toContain('CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_cost_operation_v2');
        expect(aiLifecycle).toContain('ALTER FUNCTION public.reserve_analysis_revenue_cost_operation_v2');
        expect(aiLifecycle).toContain('RENAME TO reserve_analysis_revenue_cost_operation_provider_v2');
        expect(routingMigration).toContain('public.analysis_revenue_ai_cost_assert_lineage_v1(');
    });

    it('orders the immutable baseline, AI lifecycle, and gender routing contracts', () => {
        const names = [
            '20260810100000_add_revenue_cost_operation_ledger.sql',
            '20260811100000_add_revenue_cost_provider_settlement_queue.sql',
            '20260811105000_add_revenue_ai_cost_lifecycle_contract.sql',
            '20260811110000_add_revenue_gender_routing_attempt_contract.sql',
        ];
        expect(names).toEqual([...names].sort());
    });
});
