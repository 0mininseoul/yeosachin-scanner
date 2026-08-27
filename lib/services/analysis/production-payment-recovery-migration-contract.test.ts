import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(
    process.cwd(),
    'supabase',
    'migrations',
);

function readMigration(fragment: string): string {
    const filename = readdirSync(migrationsDirectory)
        .filter(candidate => candidate.endsWith('.sql'))
        .find(candidate => candidate.includes(fragment));
    return filename ? readFileSync(join(migrationsDirectory, filename), 'utf8') : '';
}

describe('production payment recovery migration contracts', () => {
    it('moves anonymous claim authority behind a private locked helper and preserves the public wrapper', () => {
        const source = readMigration('production_preflight_checkout_recovery');
        const helper = source.slice(
            source.indexOf('CREATE OR REPLACE FUNCTION private.claim_anonymous_analysis_v2_preflight'),
            source.indexOf('REVOKE ALL ON FUNCTION private.claim_anonymous_analysis_v2_preflight'),
        );

        expect(source).toContain('CREATE SCHEMA IF NOT EXISTS private');
        expect(helper).toMatch(
            /FROM public\.users[\s\S]*?FOR UPDATE[\s\S]*?FROM public\.analysis_preflights[\s\S]*?FOR UPDATE/i,
        );
        expect(source).toMatch(/private\.claim_anonymous_analysis_v2_preflight[\s\S]*SECURITY DEFINER/i);
        expect(source).toMatch(/private\.claim_anonymous_analysis_v2_preflight[\s\S]*SET search_path = ''/i);
        expect(source).toMatch(/pg_advisory_xact_lock[\s\S]*p_user_id/i);
        expect(source).toMatch(/analysis_preflights[\s\S]*FOR UPDATE/i);
        expect(source).toMatch(/v_owner\.expires_at\s*<=\s*v_now[\s\S]*SET status = 'expired'/i);
        expect(source).toMatch(/v_owner\.target_instagram_id IS NOT DISTINCT FROM v_anonymous\.target_instagram_id/i);
        expect(source).toContain("'owner_active_other_target'::TEXT");
        expect(source).toMatch(/auth\.uid\(\)[\s\S]*p_user_id/i);
        expect(source).toContain('claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)');
        expect(source).toMatch(/public\.claim_anonymous_analysis_v2_preflight[\s\S]*SECURITY INVOKER/i);
        expect(source).toMatch(/public\.claim_anonymous_analysis_v2_preflight[\s\S]*private\.claim_anonymous_analysis_v2_preflight/i);
        expect(source).toContain('ANONYMOUS_PREFLIGHT_OWNER_STALE');
        expect(source).toContain('ANONYMOUS_PREFLIGHT_OWNER_TARGET_CONFLICT');
        expect(source).toMatch(/REVOKE ALL ON FUNCTION public\.claim_anonymous_analysis_v2_preflight/i);
        expect(source).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_anonymous_analysis_v2_preflight[\s\S]*authenticated/i);
        expect(source).toMatch(/REVOKE ALL ON SCHEMA private[\s\S]*PUBLIC/i);
        expect(source).not.toMatch(/CREATE POLICY[^;]*analysis_preflights/i);
        expect(source).not.toMatch(/GRANT\s+(?:ALL|UPDATE)[^;]*analysis_preflights/i);
    });

    it('adds service-only hash-complete creation with atomic bind-or-compare semantics', () => {
        const source = readMigration('production_preflight_checkout_recovery');

        expect(source).toContain('create_or_replay_analysis_v2_preflight_with_target_hash');
        expect(source).toMatch(/p_target_input_hash[\s\S]*\^\[0-9a-f\]\{64\}/i);
        expect(source).toMatch(/target_input_hash[\s\S]*IS NULL[\s\S]*UPDATE/i);
        expect(source).toContain('ANALYSIS_V2_PREFLIGHT_TARGET_HASH_CONFLICT');
        expect(source).toMatch(/create_or_replay_analysis_v2_preflight_with_target_hash[\s\S]*SECURITY DEFINER/i);
        expect(source).toMatch(/create_or_replay_analysis_v2_preflight_with_target_hash[\s\S]*SET search_path = ''/i);
        expect(source).toMatch(/REVOKE ALL ON FUNCTION public\.create_or_replay_analysis_v2_preflight_with_target_hash/i);
        expect(source).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_or_replay_analysis_v2_preflight_with_target_hash[\s\S]*service_role/i);
        expect(source).toContain(
            'FROM public.create_or_replay_analysis_v2_preflight(',
        );
        expect(source).not.toContain(
            'FROM public.analysis_v2_create_or_replay_preflight_unfenced_20260802(',
        );
    });

    it('adds a durable supersession marker and an atomic checkout wrapper without removing the legacy RPC', () => {
        const source = readMigration('production_preflight_checkout_recovery');

        expect(source).toMatch(
            /ALTER TABLE public\.earlybird_orders[\s\S]*?ADD COLUMN IF NOT EXISTS checkout_blocked_at TIMESTAMP WITH TIME ZONE/i,
        );
        expect(source).toMatch(
            /ALTER TABLE public\.earlybird_orders[\s\S]*?ADD COLUMN IF NOT EXISTS checkout_blocked_reason TEXT/i,
        );
        expect(source).toMatch(/SUPERSEDED_LINEAGE/);
        expect(source).toMatch(
            /CONSTRAINT earlybird_orders_checkout_block_check CHECK[\s\S]*?checkout_blocked_at/i,
        );
        expect(source).toContain('create_earlybird_checkout_with_lineage_marker');
        expect(source).toMatch(
            /create_earlybird_checkout_with_lineage_marker[\s\S]*?FROM public\.create_earlybird_checkout\(/i,
        );
        expect(source).toMatch(
            /EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE:SUPERSEDED_LINEAGE[\s\S]*?UPDATE public\.earlybird_orders/i,
        );
        expect(source).toMatch(
            /SET checkout_blocked_at[\s\S]*?checkout_blocked_reason = 'SUPERSEDED_LINEAGE'/i,
        );
        expect(source).toMatch(
            /Reacquire its exact[\s\S]*?earlybird:groble:product:[\s\S]*?hashtextextended\(p_user_id::TEXT, 0\)[\s\S]*?FROM public\.users[\s\S]*?FOR UPDATE/i,
        );
        expect(source).not.toContain('earlybird_orders_checkout_blocked_idx');
        expect(source).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout_with_lineage_marker/i,
        );
        expect(source).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout_with_lineage_marker[\s\S]*?service_role/i,
        );
        expect(source).toContain('FROM public.create_earlybird_checkout(');
    });

    it('fails closed before touching anything except the confirmed administrator test order', () => {
        const source = readMigration('cleanup_confirmed_administrator_test_order');

        expect(source).toContain('0_min._.00');
        expect(source).toMatch(/plan_id\s*=\s*'standard'/i);
        expect(source).toMatch(/status\s*=\s*'payment_pending'/i);
        expect(source).toMatch(/payment_id\s+IS\s+NULL/i);
        expect(source).toMatch(/paid_at\s+IS\s+NULL/i);
        expect(source).toMatch(/actual_groble_product_id\s+IS\s+NULL/i);
        expect(source).toMatch(/actual_amount_krw\s+IS\s+NULL/i);
        expect(source).toMatch(/seller_reference_confirmed_at\s+IS\s+NULL/i);
        expect(source).not.toMatch(/groble_seller_reference\s+IS\s+NULL/i);
        expect(source).toMatch(/earlybird_fulfillments/i);
        expect(source).toMatch(/analysis_requests/i);
        expect(source).not.toMatch(
            /result_request_id\s+IS\s+NULL[\s\S]{0,300}analysis_requests/i,
        );
        expect(source).toMatch(
            /NOT EXISTS\s*\([\s\S]*?analysis_requests[\s\S]*?analysis_request\.id\s*=\s*(?:earlybird_order\.)?result_request_id/i,
        );
        expect(source).toMatch(/COUNT\(\*\)/i);
        expect(source).toMatch(/RAISE EXCEPTION/i);
        expect(source).toMatch(/DELETE\s+FROM\s+public\.earlybird_orders/i);
        expect(source).not.toMatch(/UPDATE\s+public\.earlybird_orders[\s\S]*?status\s*=\s*'cancelled'/i);
        expect(source).not.toMatch(/DELETE\s+FROM\s+public\.users/i);
        expect(source).not.toMatch(/UPDATE\s+public\.users/i);
        expect(source).toMatch(/ROLLBACK|transaction/i);
    });
});
