import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260724230000_update_earlybird_pricing_v2.sql',
    import.meta.url
);
const migration = readFileSync(migrationUrl, 'utf8');

describe('earlybird pricing v2 forward migration contract', () => {
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

    it('accepts only the exact v1 drain and v2 prices before snapshot validation', () => {
        expect(migration).toContain("'earlybird-2026-07-v1'");
        expect(migration).toContain("'earlybird-2026-07-v2'");
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-07-v1'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 14900[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 19900/
        );
        expect(migration).toMatch(
            /p_pricing_version = 'earlybird-2026-07-v2'[\s\S]*?p_plan_id = 'basic' AND p_expected_amount_krw <> 6900[\s\S]*?p_plan_id = 'standard' AND p_expected_amount_krw <> 9900/
        );
        expect(migration).toMatch(
            /v_preflight\.pricing_version <> p_pricing_version[\s\S]*?EARLYBIRD_PRICING_REFRESH_REQUIRED[\s\S]*?EARLYBIRD_PRICE_SNAPSHOT_INVALID/
        );
        expect(migration).toMatch(
            /v_preflight\.pricing_snapshot->p_plan_id->>'amountKrw'[\s\S]*?v_snapshot_amount::INTEGER <> p_expected_amount_krw/
        );
    });

    it('replays only an exact pending order without rewriting its v1 snapshot', () => {
        const replay = migration.indexOf('SELECT existing_order.*');
        const latestPreflightCheck = migration.indexOf(
            'FROM public.analysis_preflights AS newer'
        );
        const refresh = migration.indexOf(
            "RAISE EXCEPTION 'EARLYBIRD_PRICING_REFRESH_REQUIRED'"
        );
        expect(replay).toBeGreaterThan(-1);
        expect(latestPreflightCheck).toBeGreaterThan(replay);
        expect(refresh).toBeGreaterThan(replay);
        expect(migration.slice(replay, refresh)).toMatch(
            /v_existing\.user_id <> p_user_id[\s\S]*?v_existing\.plan_id <> p_plan_id[\s\S]*?v_existing\.expected_groble_product_id <> p_expected_product_id[\s\S]*?v_existing\.status <> 'payment_pending'/
        );
        expect(migration.slice(replay, refresh)).not.toMatch(
            /UPDATE\s+public\.earlybird_orders/
        );
        expect(migration).not.toMatch(
            /SET\s+(?:pricing_version|expected_amount_krw)\s*=/
        );
    });

    it('keeps the security-definer RPC private to service_role', () => {
        expect(migration).toMatch(
            /SECURITY DEFINER[\s\S]*?SET search_path = ''/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?TO service_role/
        );
    });
});
