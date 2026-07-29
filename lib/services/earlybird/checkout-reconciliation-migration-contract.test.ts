import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730110000_add_earlybird_checkout_reconciliation.sql',
        import.meta.url
    ),
    'utf8'
);

describe('earlybird checkout reconciliation migration contract', () => {
    it('creates an immutable, private provider-dashboard evidence audit', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_checkout_reconciliations'
        );
        expect(migration).toContain("provider_dashboard_no_sale");
        expect(migration).toContain('ALTER TABLE public.earlybird_checkout_reconciliations ENABLE ROW LEVEL SECURITY');
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.earlybird_checkout_reconciliations\s+FROM anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT SELECT, INSERT ON TABLE public\.earlybird_checkout_reconciliations\s+TO service_role/
        );
        expect(migration).not.toMatch(/GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE).*earlybird_checkout_reconciliations.*(?:anon|authenticated)/);
    });

    it('exposes only a service-role reconciliation RPC with bounded evidence', () => {
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.reconcile_earlybird_checkout_no_sale\(/);
        expect(migration).toMatch(/SECURITY DEFINER[\s\S]*?SET search_path = ''/);
        expect(migration).toContain("pg_advisory_xact_lock");
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain("v_order.status NOT IN ('payment_pending', 'cancelled')");
        expect(migration).toContain("v_order.payment_id IS NOT NULL");
        expect(migration).toContain("v_order.actual_amount_krw IS NOT NULL");
        expect(migration).toContain("v_order.paid_at IS NOT NULL");
        expect(migration).toContain("v_order.seller_reference_confirmed_at IS NOT NULL");
        expect(migration).toContain("v_order.result_request_id IS NOT NULL");
        expect(migration).toContain("EARLYBIRD_RECONCILIATION_EVIDENCE_INVALID");
        expect(migration).toContain("EARLYBIRD_RECONCILIATION_NOT_ELIGIBLE");
        expect(migration).toContain("EARLYBIRD_RECONCILIATION_CONFLICT");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.reconcile_earlybird_checkout_no_sale\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.reconcile_earlybird_checkout_no_sale\([\s\S]*?TO service_role/
        );
    });
});
