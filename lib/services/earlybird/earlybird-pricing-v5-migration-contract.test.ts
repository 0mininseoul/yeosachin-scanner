import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260812122517_update_earlybird_pricing_v5.sql',
    import.meta.url
);
const migration = readFileSync(migrationUrl, 'utf8');

describe('earlybird pricing v5 forward migration contract', () => {
    it('is append-only, bounded, and changes only the canonical checkout RPC', () => {
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );
        expect(migration).not.toMatch(/^ALTER TABLE/m);
        expect(migration).not.toMatch(/^DELETE FROM/m);
        expect(migration).not.toMatch(/^UPDATE public\./m);
        expect(migration).not.toContain('TRUNCATE');
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment'
        );
    });

    it('pins the v5 version string and the exact 9,900/19,900 KRW amounts', () => {
        expect(migration).toContain("'earlybird-2026-08-v5'");
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-08-v5'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 9900[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 19900/
        );
    });

    it('still contains the v1/v2/v3/v4 historical amount guards unchanged', () => {
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-07-v1'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 14900[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 19900/
        );
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-07-v2'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 6900[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 9900/
        );
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-08-v3'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 990[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 1990/
        );
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-08-v4'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 1990[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 2990/
        );
        expect(migration).toMatch(
            /EARLYBIRD_PRICING_REFRESH_REQUIRED[\s\S]*?v_preflight\.pricing_version <> p_pricing_version[\s\S]*?EARLYBIRD_PRICE_SNAPSHOT_INVALID/
        );
    });

    it('treats v1 through v4 as stale and requires exactly v5 for a new checkout', () => {
        expect(migration).toMatch(
            /IF p_pricing_version <> 'earlybird-2026-08-v5'\s*\n\s*OR v_preflight\.pricing_version IN \('earlybird-2026-07-v1', 'earlybird-2026-07-v2', 'earlybird-2026-08-v3', 'earlybird-2026-08-v4'\) THEN\s*\n\s*RAISE EXCEPTION 'EARLYBIRD_PRICING_REFRESH_REQUIRED';/
        );
    });

    it('replays an exact pending order without rewriting its historical snapshot', () => {
        const replay = migration.indexOf('SELECT existing_order.*');
        const refresh = migration.indexOf(
            "RAISE EXCEPTION 'EARLYBIRD_PRICING_REFRESH_REQUIRED'"
        );
        expect(replay).toBeGreaterThan(-1);
        expect(refresh).toBeGreaterThan(replay);
        expect(migration.slice(replay, refresh)).toMatch(
            /v_existing\.user_id <> p_user_id[\s\S]*?v_existing\.plan_id <> p_plan_id[\s\S]*?v_existing\.expected_groble_product_id <> p_expected_product_id[\s\S]*?v_existing\.status = 'payment_pending'/
        );
        expect(migration.slice(replay, refresh)).not.toMatch(
            /UPDATE\s+public\.earlybird_orders/
        );
        expect(migration).not.toMatch(
            /SET\s+(?:pricing_version|expected_amount_krw)\s*=/
        );
    });

    it('classifies unresolved lineage against v5 as the current version', () => {
        expect(migration.match(
            /v_existing\.pricing_version <> 'earlybird-2026-08-v5' THEN/g
        )).toHaveLength(3);
    });

    it('keeps the security-definer RPC private to service_role', () => {
        expect(migration).toMatch(/SECURITY DEFINER[\s\S]*?SET search_path = ''/);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?TO service_role/
        );
    });
});
