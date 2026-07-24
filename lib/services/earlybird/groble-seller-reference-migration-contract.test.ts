import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123000_add_groble_seller_reference.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('Groble seller-reference migration contract', () => {
    it('adds one opaque unique reference without expanding browser reads', () => {
        expect(migration).toContain(
            'ADD COLUMN groble_seller_reference TEXT'
        );
        expect(migration).toContain(
            'ADD COLUMN seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE'
        );
        expect(migration).toContain(
            "groble_seller_reference ~ '^ord[.][a-f0-9]{32}$'"
        );
        expect(migration).toContain(
            'CREATE UNIQUE INDEX earlybird_orders_seller_reference_unique'
        );
        expect(migration).not.toMatch(
            /GRANT SELECT \([^)]*(?:groble_seller_reference|seller_reference_confirmed_at)/i
        );
        expect(migration).not.toMatch(
            /GRANT (?:SELECT|ALL).*earlybird_orders.*authenticated/i
        );
    });

    it('issues one stable server-owned reference under a row lock', () => {
        const issuer = functionDefinition(
            'issue_earlybird_groble_seller_reference'
        );
        expect(issuer).toContain('FOR UPDATE');
        expect(issuer).toContain("status IS DISTINCT FROM 'payment_pending'");
        expect(issuer).toContain('extensions.gen_random_uuid()');
        expect(issuer).toContain('v_order.groble_seller_reference');
        expect(issuer).not.toMatch(/email|phone|target_instagram_id/i);
    });

    it('delegates to the canonical finalizer and confirms only the referenced paid order', () => {
        const finalizer = functionDefinition(
            'finalize_earlybird_groble_payment_by_reference'
        );
        expect(finalizer).toContain(
            'public.finalize_earlybird_groble_payment('
        );
        expect(finalizer).toContain(
            'v_result.order_id IS DISTINCT FROM v_referenced_order_id'
        );
        expect(finalizer).toContain(
            "v_result.status IN ('paid', 'analysis_in_progress', 'completed')"
        );
        expect(finalizer).toContain(
            'seller_reference_confirmed_at = COALESCE('
        );
        expect(finalizer).not.toContain('plan_sequence =');
    });

    it('reports only reference-confirmed aggregate demand over a bounded range', () => {
        const reporter = functionDefinition('load_earlybird_demand_summary');
        expect(reporter).toContain('RETURNS JSONB');
        expect(reporter).toContain('STABLE');
        expect(reporter).toContain('SECURITY DEFINER');
        expect(reporter).toContain("SET search_path = ''");
        expect(reporter).toContain(
            'p_end_date_exclusive - p_start_date > 90'
        );
        expect(reporter).toContain(
            'scoped.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(reporter).toContain(
            "'referenceConfirmedPaymentCount', metrics.confirmed_count"
        );
        expect(reporter).toContain(
            "'unconfirmedPaidOrderCount', metrics.unconfirmed_paid_count"
        );
        expect(reporter).toContain(
            "'overdueFulfillmentCount', metrics.overdue_fulfillment_count"
        );
        expect(reporter).not.toMatch(
            /target_instagram_id|excluded_instagram_id|buyer_email|phone_number|groble_seller_reference|event_id/i
        );
    });

    it('exposes both mutation functions only to service_role', () => {
        for (const name of [
            'issue_earlybird_groble_seller_reference',
            'finalize_earlybird_groble_payment_by_reference',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role;'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'TO service_role;'
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.(?:issue|finalize)_earlybird_groble[\s\S]*?TO (?:anon|authenticated);/
        );
    });

    it('exposes the aggregate report only to service_role', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_earlybird_demand_summary\(DATE, DATE\)\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_earlybird_demand_summary\(DATE, DATE\)\s+TO service_role;/
        );
    });
});
