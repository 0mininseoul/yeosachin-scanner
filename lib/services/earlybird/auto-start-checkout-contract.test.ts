import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);

function source(path: string): string {
    return readFileSync(new URL(path, root), 'utf8');
}

const migration = source(
    'supabase/migrations/20260730160000_open_earlybird_auto_fulfillment_checkout.sql'
);

describe('automatic earlybird checkout rollout contract', () => {
    it('removes the landing countdown/status navigation and records a time-free disclosure', () => {
        const landing = source('app/page.tsx');
        const catalog = source('lib/domain/earlybird/catalog.ts');
        const legacyReturn = source('app/earlybird/earlybird-status.tsx');

        expect(landing).not.toContain('EarlybirdStatusBanner');
        expect(landing).not.toContain("href=\"/earlybird\"");
        expect(catalog).toContain("'earlybird-auto-start-v2'");
        expect(catalog).toContain("'결제 확인 후 판독이 자동으로 시작됩니다.'");
        expect(catalog).not.toContain('24시간 이내');
        expect(legacyReturn).toContain('router.replace(nextUrl)');
        expect(legacyReturn).toContain('isAutomaticFulfillmentBridge');
    });

    it('accepts the legacy disclosure only for its exact immutable order replay', () => {
        expect(migration).toContain("p_disclosure_version = 'earlybird-auto-start-v2'");
        expect(migration).toContain("p_disclosure_text = '결제 확인 후 판독이 자동으로 시작됩니다.'");
        expect(migration).toContain("p_disclosure_version = 'earlybird-24h-v1'");
        expect(migration).toContain('EARLYBIRD_CONSENT_INVALID');
        expect(migration).toMatch(
            /p_disclosure_version = 'earlybird-24h-v1'[\s\S]*?p_disclosure_text = '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.'/
        );
        expect(migration).toContain('v_legacy_disclosure BOOLEAN := FALSE');
        expect(migration).toMatch(
            /IF v_legacy_disclosure AND \([\s\S]*?NOT FOUND[\s\S]*?v_existing\.disclosure_version IS DISTINCT FROM 'earlybird-24h-v1'[\s\S]*?EARLYBIRD_CONSENT_INVALID/
        );
    });

    it('does not mutate historical orders and blocks only unresolved payment lineages', () => {
        expect(migration).not.toMatch(/^UPDATE public\.earlybird_orders/m);
        expect(migration).not.toMatch(/^DELETE FROM public\.earlybird_orders/m);
        expect(migration).not.toMatch(/^ALTER TABLE public\.earlybird_orders/m);
        const pendingFence = migration.slice(
            migration.indexOf('SELECT pending_order.*'),
            migration.indexOf('INSERT INTO public.earlybird_orders')
        );
        expect(pendingFence).toContain("pending_order.status = 'payment_pending'");
        expect(pendingFence).not.toContain('manual_review');
        expect(pendingFence).not.toContain("status IN ('paid'");
    });

    it('keeps the checkout RPC service-role only', () => {
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
