import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260808150000_recover_fresh_admission_provider_failure.sql',
        import.meta.url
    ),
    'utf8'
);

describe('fresh-admission provider failure recovery migration', () => {
    it('rearms only the exact paid, request-free provider failure', () => {
        expect(migration).toContain(
            'CREATE FUNCTION public.recover_earlybird_fresh_admission_provider_failure('
        );
        expect(migration).toContain("v_order.status = 'paid'");
        expect(migration).toContain(
            'v_order.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(migration).toContain('v_order.payment_id IS NOT NULL');
        expect(migration).toContain(
            'v_order.actual_groble_product_id IS NOT DISTINCT FROM '
            + 'v_order.expected_groble_product_id'
        );
        expect(migration).toContain("v_fulfillment.status = 'manual_review'");
        expect(migration).toContain(
            "v_fulfillment.last_error_code = 'TARGET_UNAVAILABLE'"
        );
        expect(migration).toContain('v_fulfillment.request_id IS NULL');
        expect(migration).toContain("v_preflight.admission_status = 'blocked'");
        expect(migration).toContain(
            "v_preflight.admission_error_code = "
            + "'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'"
        );
        expect(migration).toContain('v_preflight.admission_failure_count = 3');
        expect(migration).toContain('v_preflight.expires_at <= v_now');
    });

    it('preserves lock order and delegates replacement creation to the shared rebind primitive', () => {
        const userLock = migration.indexOf('FROM public.users AS recovery_user');
        const orderLock = migration.indexOf('FOR UPDATE;', userLock);
        expect(userLock).toBeGreaterThanOrEqual(0);
        expect(orderLock).toBeGreaterThan(userLock);
        expect(migration).toContain(
            "SET status = 'retryable_failure'"
        );
        expect(migration).toContain('manual_review_at = NULL');
        expect(migration).toContain(
            'v_rebound_preflight_id := '
            + 'public.rebind_expired_paid_earlybird_preflight(p_order_id);'
        );
        expect(migration).toContain(
            'v_rebound_preflight_id IS NOT DISTINCT FROM v_preflight.id'
        );
        expect(migration).toContain(
            "MESSAGE = 'EARLYBIRD_FRESH_ADMISSION_PROVIDER_RECOVERY_REBIND_FAILED'"
        );
    });

    it('is service-role only and cannot alter payment or refund state', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_earlybird_fresh_admission_provider_failure\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_earlybird_fresh_admission_provider_failure\(UUID\)[\s\S]*?TO service_role;/
        );
        expect(migration).not.toMatch(
            /UPDATE public\.earlybird_orders[\s\S]*?SET[\s\S]*?(?:status|payment|refund)/i
        );
        expect(migration).not.toMatch(/\bEXECUTE\s+(?:pg_catalog\.format|v_)/);
    });
});
