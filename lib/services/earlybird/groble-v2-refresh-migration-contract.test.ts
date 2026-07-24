import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260725023000_separate_groble_v2_checkout_lineage.sql',
    import.meta.url
);

function migration(): string {
    return readFileSync(migrationUrl, 'utf8');
}

describe('Groble v2 product separation and legacy refresh migration', () => {
    it('creates service-only product configuration and immutable audit lineage', () => {
        const sql = migration();

        for (const table of [
            'earlybird_groble_product_versions',
            'earlybird_checkout_retirements',
            'earlybird_checkout_refreshes',
        ]) {
            expect(sql).toContain(`CREATE TABLE public.${table}`);
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(sql).toMatch(
                new RegExp(
                    `REVOKE ALL ON TABLE public\\.${table}\\s+`
                    + 'FROM PUBLIC, anon, authenticated'
                )
            );
            expect(sql).toContain(
                `GRANT SELECT ON TABLE public.${table} TO service_role`
            );
        }

        expect(sql).toContain('UNIQUE (product_id)');
        expect(sql).toContain('UNIQUE (payment_address)');
        expect(sql).toContain('UNIQUE (plan_id, pricing_version)');
        expect(sql).toContain(
            'CREATE FUNCTION public.configure_earlybird_groble_product_lineage('
        );
        expect(sql).toContain('GROBLE_IDENTIFIERS_MUST_BE_GLOBALLY_DISTINCT');
        expect(sql).toContain('EARLYBIRD_PRODUCT_LINEAGE_FROZEN');
        expect(sql).not.toContain(
            'CREATE FUNCTION public.configure_earlybird_groble_product_version('
        );
        expect(sql).toContain('EARLYBIRD_AUDIT_IMMUTABLE');
        expect(sql).toContain("SET search_path = ''");
    });

    it('activates v2 only through one atomic four-binding configuration', () => {
        const sql = migration();
        const configuration = sql.slice(
            sql.indexOf(
                'CREATE FUNCTION public.configure_earlybird_groble_product_lineage('
            ),
            sql.indexOf(
                '-- The phone-aware canonical finalizer'
            )
        );

        expect(configuration).toContain("'basic', 'earlybird-2026-07-v1'");
        expect(configuration).toContain("'standard', 'earlybird-2026-07-v1'");
        expect(configuration).toContain("'basic', 'earlybird-2026-07-v2'");
        expect(configuration).toContain("'standard', 'earlybird-2026-07-v2'");
        expect(configuration).toContain('14900, FALSE');
        expect(configuration).toContain('19900, FALSE');
        expect(configuration).toContain('6900, TRUE');
        expect(configuration).toContain('9900, TRUE');
        expect(configuration).toContain('ON CONFLICT (plan_id, pricing_version)');
        expect(configuration).toContain('EARLYBIRD_PRODUCT_LINEAGE_FROZEN');
        expect(configuration).toContain(
            'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_AMBIGUOUS'
        );
        expect(configuration).toContain(
            'EARLYBIRD_LEGACY_PRODUCT_EVIDENCE_MISMATCH'
        );
        expect(configuration).toContain(
            'FROM public.earlybird_webhook_events AS evidence'
        );
        expect(configuration).not.toContain(
            'evidence.pricing_version = v_existing.pricing_version'
        );
        expect(configuration).toContain(
            'GRANT EXECUTE ON FUNCTION public.configure_earlybird_groble_product_lineage('
        );
    });

    it('atomically retires every untouched old-product pending order across v1 and v2 prices', () => {
        const sql = migration();
        const retirement = sql.slice(
            sql.indexOf('DO $retire_legacy$'),
            sql.indexOf('$retire_legacy$;') + '$retire_legacy$;'.length
        );

        expect(retirement).toContain("pricing_version = 'earlybird-2026-07-v1'");
        expect(retirement).toContain("pricing_version = 'earlybird-2026-07-v2'");
        expect(retirement).toContain("status = 'payment_pending'");
        expect(retirement).toContain("plan_id = 'basic'");
        expect(retirement).toContain('expected_amount_krw = 14900');
        expect(retirement).toContain("plan_id = 'standard'");
        expect(retirement).toContain('expected_amount_krw = 19900');
        expect(retirement).toContain('expected_amount_krw = 6900');
        expect(retirement).toContain('expected_amount_krw = 9900');
        expect(retirement).toContain('payment_id IS NULL');
        expect(retirement).toContain('actual_groble_product_id IS NULL');
        expect(retirement).toContain('actual_amount_krw IS NULL');
        expect(retirement).toContain('paid_at IS NULL');
        expect(retirement).toContain('result_request_id IS NULL');
        expect(retirement).toContain("SET status = 'cancelled'");
        expect(retirement).toContain("'pricing_v2_product_separation'");
        expect(retirement).not.toMatch(
            /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
        );
        expect(retirement).not.toMatch(/@[a-z0-9._-]+|target_instagram_id\s*=/i);
        expect(retirement).not.toMatch(
            /status\s+IN\s*\([^)]*'paid'|status\s*=\s*'refund_pending'/i
        );
    });

    it('fences every new checkout on an exact active version binding and revokes the old RPC', () => {
        const sql = migration();

        expect(sql).toContain('CREATE FUNCTION public.create_earlybird_checkout_v2(');
        expect(sql).toContain('p_payment_address TEXT');
        expect(sql).toContain(
            "p_pricing_version IS DISTINCT FROM 'earlybird-2026-07-v2'"
        );
        expect(sql).toContain('binding.product_id <> p_expected_product_id');
        expect(sql).toContain('binding.payment_address <> p_payment_address');
        expect(sql).toContain('binding.expected_amount_krw <> p_expected_amount_krw');
        expect(sql).toContain('binding.checkout_active');
        expect(sql).toContain(
            'public.issue_earlybird_groble_seller_reference(checkout.order_id)'
        );
        expect(sql).toContain(
            'RETURNS TABLE(order_id UUID, created BOOLEAN, seller_reference TEXT)'
        );
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.create_earlybird_checkout('
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout_v2('
        );
        expect(sql).toContain('TO service_role');
    });

    it('uses payment, product, then sorted-user fencing around the canonical finalizer', () => {
        const sql = migration();
        const wrapper = sql.slice(
            sql.indexOf('CREATE FUNCTION public.finalize_earlybird_groble_payment('),
            sql.indexOf(
                'CREATE FUNCTION public.refresh_legacy_earlybird_checkout('
            )
        );
        const paymentLock = wrapper.indexOf(
            'pg_catalog.hashtextextended(p_payment_id, 0)'
        );
        const productLock = wrapper.indexOf(
            "'earlybird:groble:product:' || p_product_id"
        );
        const sortedUsers = wrapper.indexOf(
            'ORDER BY potential_user.user_id::TEXT'
        );

        expect(paymentLock).toBeGreaterThan(-1);
        expect(productLock).toBeGreaterThan(paymentLock);
        expect(sortedUsers).toBeGreaterThan(productLock);
        expect(wrapper).toContain(
            'finalize_earlybird_groble_payment_before_product_fence'
        );
    });

    it('makes seller-reference attribution authoritative and refunds retired late payments', () => {
        const sql = migration();
        const direct = sql.slice(
            sql.lastIndexOf(
                'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment_by_reference('
            ),
            sql.indexOf(
                'CREATE FUNCTION public.refresh_legacy_earlybird_checkout('
            )
        );

        expect(direct).toContain(
            'WHERE referenced_order.groble_seller_reference = p_seller_reference'
        );
        expect(direct).toContain('FOR UPDATE');
        expect(direct).toContain("v_order.status = 'cancelled'");
        expect(direct).toContain("SET status = 'refund_pending'");
        expect(direct).toContain("'late_cancelled_payment'");
        expect(direct).toContain("v_order.status <> 'payment_pending'");
        expect(direct).toContain("SET status = 'paid'");
        expect(direct).toContain('seller_reference_confirmed_at');
        expect(direct).not.toContain(
            'FROM public.finalize_earlybird_groble_payment('
        );
    });

    it('provides an owner-fenced idempotent refresh without storing raw phone input', () => {
        const sql = migration();
        const refresh = sql.slice(
            sql.indexOf('CREATE FUNCTION public.refresh_legacy_earlybird_checkout(')
        );

        expect(refresh).toContain('p_legacy_order_id UUID');
        expect(refresh).toContain('p_user_id UUID');
        expect(refresh).toContain('FOR UPDATE');
        expect(refresh).toContain('earlybird_checkout_retirements');
        expect(refresh).toContain('earlybird_checkout_refreshes');
        expect(refresh).toContain('create_earlybird_checkout_v2');
        expect(refresh).toContain('CHECKOUT_PHONE_REQUIRED');
        expect(refresh).toContain('EARLYBIRD_SOLD_OUT');
        expect(refresh).toContain('EARLYBIRD_LEGACY_REFRESH_NOT_ELIGIBLE');
        expect(refresh).toContain('EARLYBIRD_LEGACY_REFRESH_CONFLICT');
        expect(refresh).not.toMatch(/p_(?:raw_)?phone/i);
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.refresh_legacy_earlybird_checkout('
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.refresh_legacy_earlybird_checkout('
        );
    });
});
