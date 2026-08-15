import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260816154000_prepare_concierge_batch_order.sql',
    import.meta.url,
);

describe('concierge batch bootstrap migration contract', () => {
    it('creates only a service-role request-pair bootstrap and never advances fulfillment', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain("v_order.status NOT IN ('paid', 'analysis_in_progress')");
        expect(migration).toContain('INSERT INTO public.analysis_requests');
        expect(migration).toContain('UPDATE public.earlybird_orders');
        expect(migration).not.toContain('UPDATE public.earlybird_fulfillments');
        expect(migration).not.toContain('auto_admit');
        expect(migration).not.toContain('advance_earlybird');
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.prepare_concierge_batch_order\(/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.prepare_concierge_batch_order\([^)]*\)\s+TO service_role/);
    });
});
