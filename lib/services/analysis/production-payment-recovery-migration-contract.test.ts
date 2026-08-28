import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(
    process.cwd(),
    'supabase',
    'migrations',
);
const operationsDirectory = join(
    process.cwd(),
    'supabase',
    'operations',
);

function readMigration(fragment: string): string {
    const filename = readdirSync(migrationsDirectory)
        .filter(candidate => candidate.endsWith('.sql'))
        .find(candidate => candidate.includes(fragment));
    return filename ? readFileSync(join(migrationsDirectory, filename), 'utf8') : '';
}

function readOperation(fragment: string): string {
    const filename = readdirSync(operationsDirectory)
        .filter(candidate => candidate.endsWith('.sql'))
        .find(candidate => candidate.includes(fragment));
    return filename ? readFileSync(join(operationsDirectory, filename), 'utf8') : '';
}

describe('production payment recovery migration contracts', () => {
    it('moves anonymous claim authority behind a private locked helper and preserves the public wrapper', () => {
        const source = readMigration('production_preflight_checkout_recovery');
        const helper = source.slice(
            source.indexOf('CREATE OR REPLACE FUNCTION private.claim_anonymous_analysis_v2_preflight'),
            source.indexOf('REVOKE ALL ON FUNCTION private.claim_anonymous_analysis_v2_preflight'),
        );

        expect(source).toContain('CREATE SCHEMA IF NOT EXISTS private');
        expect(source).toMatch(/SET LOCAL lock_timeout\s*=\s*'5s';\s*SET LOCAL statement_timeout\s*=\s*'2min';[\s\S]*?CREATE SCHEMA/i);
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
        expect(helper).toMatch(/v_now\s*:=\s*pg_catalog\.clock_timestamp\(\)[\s\S]*?FROM public\.analysis_preflights[\s\S]*?FOR UPDATE/i);
        expect(helper).toMatch(/status = 'expired'[\s\S]*?error_code = NULL[\s\S]*?blocked_at = NULL/i);
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
        expect(source).toMatch(/ADD CONSTRAINT earlybird_orders_checkout_block_check CHECK[\s\S]*?NOT VALID/i);
        expect(source).toMatch(/VALIDATE CONSTRAINT earlybird_orders_checkout_block_check/i);
        expect(source).toContain('CREATE OR REPLACE FUNCTION public.guard_earlybird_checkout_block_marker');
        expect(source).toMatch(/OLD\.checkout_blocked_at IS NULL[\s\S]*?NEW\.checkout_blocked_at IS NULL[\s\S]*?SUPERSEDED_LINEAGE/i);
        expect(source).toMatch(/checkout_blocked_at IS DISTINCT FROM OLD\.checkout_blocked_at[\s\S]*?RAISE EXCEPTION/i);
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
        expect(source).toContain('EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED');
        expect(source).toMatch(/v_pending_preflight\.created_at[\s\S]*?EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED/i);
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

    it('keeps the administrator cleanup as an explicit locked production operation', () => {
        const source = readOperation('cleanup_confirmed_administrator_test_order');

        expect(source).toContain("operation:production:earlybird-admin-test-order-cleanup:v1");
        expect(source).toContain(
            'ca805b0332bcbf8a263c4ffcfa7bd792226f555d8f2d37f928b30544912b6a52',
        );
        expect(source).toMatch(
            /'earlybird-admin-cleanup:v1\|'[\s\S]*?earlybird_order\.id::TEXT[\s\S]*?earlybird_order\.groble_seller_reference[\s\S]*?created_at AT TIME ZONE 'UTC'[\s\S]*?'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'[\s\S]*?'UTF8'[\s\S]*?'sha256'[\s\S]*?'hex'/i,
        );
        expect(source.match(/extensions\.digest\(/g)).toHaveLength(4);
        expect(source.match(/earlybird_order\.id IS NOT NULL/g)).toHaveLength(4);
        expect(source.match(/earlybird_order\.groble_seller_reference IS NOT NULL/g)).toHaveLength(4);
        expect(source.match(/earlybird_order\.created_at IS NOT NULL/g)).toHaveLength(4);
        expect(source).toMatch(/pg_advisory_xact_lock[\s\S]*hashtextextended[\s\S]*operation:production:earlybird-admin-test-order-cleanup:v1/i);
        expect(source).toContain("v_operation_key CONSTANT TEXT :=\n        'operation:production:earlybird-admin-test-order-cleanup:v1';");
        expect(source).toMatch(/BEGIN;[\s\S]*SET LOCAL lock_timeout[\s\S]*SET LOCAL statement_timeout[\s\S]*SET LOCAL search_path/i);
        expect(source).toMatch(/ON COMMIT PRESERVE ROWS/i);
        expect(source).toMatch(/expected_groble_product_id\s+IS NOT NULL/i);
        expect(source).toMatch(/v_product_id\s+!~\s*'\^\[A-Za-z0-9\]/i);
        expect(source).not.toContain('standard-product-01');
        expect(source).toMatch(/earlybird:groble:product:[\s\S]*hashtextextended[\s\S]*v_admin_id::TEXT[\s\S]*FROM public\.users[\s\S]*FOR UPDATE/i);
        expect(source).toContain('0_min._.00');
        expect(source).toMatch(/plan_id\s*=\s*'standard'/i);
        expect(source).toMatch(/status\s*=\s*'payment_pending'/i);
        expect(source).toMatch(/payment_id\s+IS\s+NULL/i);
        expect(source).toMatch(/paid_at\s+IS\s+NULL/i);
        expect(source).toMatch(/actual_groble_product_id\s+IS\s+NULL/i);
        expect(source).toMatch(/actual_amount_krw\s+IS\s+NULL/i);
        expect(source).toMatch(/seller_reference_confirmed_at\s+IS\s+NULL/i);
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
        expect(source).toMatch(/RETURNING\s+id/i);
        expect(source).toMatch(/deleted_count/i);
        expect(source).toMatch(/completed_at/i);
        expect(source).toMatch(/CREATE TEMP TABLE|pg_temp/i);
        expect(source).not.toMatch(/UPDATE\s+public\.earlybird_orders[\s\S]*?status\s*=\s*'cancelled'/i);
        expect(source).not.toMatch(/DELETE\s+FROM\s+public\.users/i);
        expect(source).not.toMatch(/UPDATE\s+public\.users/i);
        expect(source).toMatch(/COMMIT;[\s\S]*SELECT operation[\s\S]*completed_at/i);
        expect(readMigration('cleanup_confirmed_administrator_test_order')).toBe('');
    });
});
