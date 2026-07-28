import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728120000_add_earlybird_automatic_fulfillment.sql',
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

describe('automatic earlybird fulfillment migration contract', () => {
    it('atomically selects only bounded confirmed paid waiting rows', () => {
        const admission = functionDefinition(
            'auto_admit_eligible_earlybird_fulfillments'
        );
        expect(admission).toContain('p_limit NOT BETWEEN 1 AND 100');
        expect(admission).toContain("fulfillment.status = 'awaiting_operator'");
        expect(admission).toContain("earlybird_order.status = 'paid'");
        expect(admission).toContain(
            'earlybird_order.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(admission).toContain('earlybird_order.payment_id IS NOT NULL');
        expect(admission).toContain(
            'earlybird_order.actual_amount_krw BETWEEN 0 AND earlybird_order.expected_amount_krw'
        );
        expect(admission).toContain(
            'earlybird_order.actual_groble_product_id IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id'
        );
        expect(admission).toContain("earlybird_order.plan_id IN ('basic', 'standard')");
        expect(admission).toContain('FOR UPDATE OF fulfillment, earlybird_order SKIP LOCKED');
        expect(admission).toContain('LIMIT p_limit');
        expect(admission).toContain('public.admit_earlybird_fulfillment');
    });

    it('returns no buyer or target fields and remains service-role only', () => {
        const admission = functionDefinition(
            'auto_admit_eligible_earlybird_fulfillments'
        );
        expect(admission).toContain('order_id UUID');
        expect(admission).toContain('fulfillment_status TEXT');
        expect(admission).not.toMatch(/buyer|phone|email|target_instagram/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.auto_admit_eligible_earlybird_fulfillments\(INTEGER\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.auto_admit_eligible_earlybird_fulfillments\(INTEGER\)[\s\S]*?TO service_role;/
        );
    });
});
