import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260813170000_add_earlybird_order_scoped_apify_slot.sql', import.meta.url),
    'utf8',
);

describe('earlybird order-scoped credential migration', () => {
    it('stores only an allowlisted slot and grants one service-role bind RPC', () => {
        expect(migration).toContain('concierge_apify_credential_slot TEXT');
        expect(migration).toContain('order_scoped_apify_credential_slot TEXT');
        expect(migration).toContain('public.analysis_v2_valid_apify_credential_slot');
        expect(migration).toContain('bind_earlybird_order_scoped_apify_slot');
        expect(migration).toContain(
            'SET order_scoped_apify_credential_slot = p_credential_slot,\n        updated_at = pg_catalog.clock_timestamp()'
        );
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.bind_earlybird_order_scoped_apify_slot[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.bind_earlybird_order_scoped_apify_slot[\s\S]*?TO service_role;/);
        expect(migration).toContain('orderScopedCredentialSlot');
        expect(migration).toContain('load_analysis_v2_collection_context_with_policy_v2');
        expect(migration).toContain('claim_analysis_v2_preflight_admission_v3');
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy_v2');
        expect(migration).toContain('v_preflight.access_mode::TEXT,v_preflight.order_scoped_apify_credential_slot');
        expect(migration).not.toContain('DROP FUNCTION public.claim_analysis_v2_preflight_admission_v2');
        expect(migration).not.toMatch(/APIFY_[A-Z_]*TOKEN\s*=/);
    });
});
