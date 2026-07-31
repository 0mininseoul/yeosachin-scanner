import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260728120000_add_earlybird_automatic_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const lockOrderMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731040000_recover_scrubbed_earlybird_freshness_conflict.sql',
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

function replacementFunctionDefinition(name: string): string {
    const start = lockOrderMigration.indexOf(
        `CREATE OR REPLACE FUNCTION public.${name}(`
    );
    expect(start, `${name} replacement must exist`).toBeGreaterThanOrEqual(0);
    const end = lockOrderMigration.indexOf('\n$$;', start);
    expect(end, `${name} replacement must have a bounded body`).toBeGreaterThan(start);
    return lockOrderMigration.slice(start, end);
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
        expect(admission).toContain(
            'preflight.user_id IS NOT DISTINCT FROM earlybird_order.user_id'
        );
        expect(admission).toContain("preflight.access_mode = 'production'");
        expect(admission).toContain('preflight.consumed_request_id IS NULL');
        expect(admission).toContain(
            'public.analysis_v2_valid_launch_snapshot(preflight.launch_status_snapshot)'
        );
        expect(admission).toContain(
            'public.analysis_v2_valid_plan_catalog_snapshot(preflight.plan_catalog_snapshot)'
        );
        expect(admission).toContain(
            'public.analysis_v2_valid_pricing_snapshot(preflight.pricing_snapshot)'
        );
        expect(admission).toContain(
            'public.analysis_v2_valid_policy_versions_snapshot(preflight.policy_versions_snapshot)'
        );
        expect(admission).toContain(
            "preflight.plan_catalog_snapshot ->earlybird_order.plan_id->>'launchStatus' = 'production'"
        );
        expect(admission).toContain(
            'FOR UPDATE OF earlybird_order, fulfillment, preflight SKIP LOCKED'
        );
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

    it('replaces the locking cursor with an unlocked snapshot and inner serialized admit', () => {
        const admission = replacementFunctionDefinition(
            'auto_admit_eligible_earlybird_fulfillments'
        );
        expect(admission).toContain('p_limit NOT BETWEEN 1 AND 100');
        expect(admission).toContain("fulfillment.status = 'awaiting_operator'");
        expect(admission).toContain("earlybird_order.status = 'paid'");
        expect(admission).toContain('LIMIT p_limit');
        expect(admission).toContain(
            'public.admit_earlybird_fulfillment(v_candidate.order_id)'
        );
        expect(admission).toContain(
            "v_admitted.fulfillment_status = 'admission_pending'"
        );
        expect(admission).not.toContain('FOR UPDATE');
        expect(admission).not.toContain('SKIP LOCKED');
        expect(lockOrderMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.auto_admit_eligible_earlybird_fulfillments\(INTEGER\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(lockOrderMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.auto_admit_eligible_earlybird_fulfillments\(INTEGER\)[\s\S]*?TO service_role;/
        );
    });
});
