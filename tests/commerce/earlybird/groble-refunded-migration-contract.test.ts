import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260803193000_finalize_groble_refunded_webhooks.sql',
        import.meta.url
    ),
    'utf8'
);

describe('Groble payment.refunded migration contract', () => {
    it('extends only webhook event vocabulary and installs a service-only finalizer', () => {
        expect(migration).toContain('ADD COLUMN refund_amount_krw INTEGER');
        expect(migration).toContain('ADD COLUMN partial_refund BOOLEAN');
        expect(migration).toContain(
            'ADD COLUMN refunded_at TIMESTAMP WITH TIME ZONE'
        );
        expect(migration).toContain("'payment.refunded'");
        expect(migration).toContain("'refunded'");
        expect(migration).toContain("'partial_refund_recorded'");
        expect(migration).toContain(
            'CREATE FUNCTION public.finalize_earlybird_groble_refund('
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_refund\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_refund\([\s\S]*?TO service_role;/
        );
    });

    it('matches only the attributed merchant UID and preserves product and amount fences', () => {
        expect(migration).toContain('WHERE earlybird_order.payment_id = p_payment_id');
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain('pg_advisory_xact_lock');
        expect(migration).toContain(
            'v_order.expected_groble_product_id IS DISTINCT FROM p_product_id'
        );
        expect(migration).toContain(
            'v_order.actual_groble_product_id IS DISTINCT FROM p_product_id'
        );
        expect(migration).toContain(
            'v_order.actual_amount_krw IS DISTINCT FROM p_amount_krw'
        );
        expect(migration).not.toMatch(/seller_reference|buyer_email|buyer_phone/i);
    });

    it('does not revoke access for partial refunds and only finalizes full-refund states', () => {
        expect(migration).toContain('IF p_partial_refund THEN');
        expect(migration).toContain("'partial_refund_recorded'");
        expect(migration).toContain(
            "v_order.status IN ('paid', 'refund_pending', 'analysis_in_progress', 'completed')"
        );
        expect(migration).toContain("SET status = 'refunded'");
        expect(migration).toContain(
            'p_refund_amount_krw, p_partial_refund, p_refunded_at'
        );
    });
});
