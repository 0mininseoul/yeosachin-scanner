import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260804160000_read_earlybird_fulfillment_status.sql',
        import.meta.url
    ),
    'utf8'
);

describe('earlybird fulfillment status projection', () => {
    it('keeps the fulfillment table private behind a service-only status RPC', () => {
        expect(migration).toMatch(
            /CREATE FUNCTION public\.load_earlybird_fulfillment_status\([\s\S]*?p_order_id UUID[\s\S]*?\)/
        );
        expect(migration).toContain(
            'FROM public.earlybird_fulfillments AS fulfillment'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_earlybird_fulfillment_status\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_earlybird_fulfillment_status\(UUID\)[\s\S]*?TO service_role;/
        );
    });
});
