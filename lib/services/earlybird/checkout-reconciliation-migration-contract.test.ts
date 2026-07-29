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
            /REVOKE ALL ON TABLE public\.earlybird_checkout_reconciliations\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT SELECT ON TABLE public\.earlybird_checkout_reconciliations\s+TO service_role/
        );
        expect(migration).not.toMatch(/GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE).*earlybird_checkout_reconciliations.*(?:anon|authenticated)/);
        expect(migration).toContain(
            'CREATE TRIGGER earlybird_checkout_reconciliations_immutable'
        );
        expect(migration).toContain(
            'EARLYBIRD_RECONCILIATION_AUDIT_IMMUTABLE'
        );
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

    it('interposes a private reconciliation-aware finalizer on both payment paths', () => {
        expect(migration).toContain(
            'RENAME TO finalize_earlybird_groble_payment_pre_reconciliation'
        );
        expect(migration).toContain(
            'CREATE FUNCTION public.finalize_earlybird_groble_payment_reconciliation_aware'
        );
        expect(migration).toContain(
            'p_require_legacy_email_only BOOLEAN'
        );
        expect(migration).toContain(
            'v_reconciliation_history_count INTEGER := 0'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment_pre_reconciliation\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment_reconciliation_aware\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment_by_reference'
        );
        expect(migration).toContain("'late_cancelled_payment'");
        expect(migration).toContain("'ambiguous_buyer'");
        expect(migration).not.toContain(
            "MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_CONFLICT',\n            ERRCODE = 'P0001'"
        );
    });

    it('keeps the rolling nine-argument overload behind the durable helper and a narrow ACL', () => {
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(\s*p_event_id TEXT,\s*p_idempotency_key TEXT,\s*p_event_type TEXT,\s*p_occurred_at TIMESTAMP WITH TIME ZONE,\s*p_payment_id TEXT,\s*p_buyer_email TEXT,\s*p_product_id TEXT,\s*p_amount_krw INTEGER,\s*p_paid_at TIMESTAMP WITH TIME ZONE\s*\)[\s\S]*?finalize_earlybird_groble_payment_reconciliation_aware\(\s*NULL::UUID,\s*TRUE,/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) TO service_role/
        );
        expect(migration).toContain(
            'Include owners from both candidate lineage and immutable'
        );
        expect(migration).toContain(
            'SELECT payment_order.user_id'
        );
        expect(migration).toContain(
            'SELECT attributed_order.user_id'
        );
    });
});
