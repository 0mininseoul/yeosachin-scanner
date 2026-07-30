import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730140000_rehydrate_earlybird_paid_preflight_snapshot.sql',
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

describe('paid earlybird preflight rehydration migration contract', () => {
    it('uses one complete current snapshot or one complete retained admission snapshot', () => {
        const admit = functionDefinition('admit_earlybird_fulfillment');
        expect(admit).toContain('v_preflight.plan_cards_snapshot IS NULL');
        expect(admit).toContain('v_preflight.admission_capacity_required_plan_id');
        expect(admit).toContain('v_preflight.admission_required_plan_id');
        expect(admit).toContain('v_preflight.admission_plan_cards_snapshot');
        expect(admit).toContain('v_plan_cards_snapshot := v_preflight.plan_cards_snapshot');
        expect(admit).toContain('v_plan_cards_snapshot := \'{}\'::JSONB');
        expect(admit).toContain('v_preflight.plan_catalog_snapshot->v_plan_id');
    });

    it('restores every ready-status payload field only after the snapshot remains eligible', () => {
        const admit = functionDefinition('admit_earlybird_fulfillment');
        expect(admit).toContain("MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT'");
        expect(admit).toContain("v_selected_card->>'selectionState'");
        expect(admit).toContain('v_card_followers::BIGINT < v_order.target_followers_count::BIGINT');
        expect(admit).toContain('capacity_required_plan_id = v_capacity_required_plan_id');
        expect(admit).toContain('required_plan_id = v_required_plan_id');
        expect(admit).toContain('plan_cards_snapshot = v_plan_cards_snapshot');
        expect(admit).toContain("status = 'ready'");
    });

    it('keeps the replacement RPC service-role only', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.admit_earlybird_fulfillment\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.admit_earlybird_fulfillment\(UUID\)[\s\S]*?TO service_role;/
        );
    });

    it('keeps pending and paid commercial checkout preflights out of expiry scrubbing', () => {
        expect(migration).toContain(
            "earlybird_order.status IN (\n                    'payment_pending', 'cancelled', 'paid', 'analysis_in_progress', 'completed'\n                )"
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.purge_expired_analysis_v2_preflights\(\s*p_limit INTEGER DEFAULT 100\s*\)/
        );
    });
});
