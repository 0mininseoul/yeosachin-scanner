import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260813233100_recover_concierge_snapshot_conflict.sql',
    import.meta.url,
), 'utf8');

describe('concierge snapshot-conflict recovery migration contract', () => {
    it('is fixed to the one paid Basic incident and its exact count transition', () => {
        expect(migration).toContain('recover_earlybird_concierge_snapshot_conflict');
        expect(migration).toContain("TIMESTAMPTZ '2026-08-12 18:07:00+09'");
        expect(migration).toContain("TIMESTAMPTZ '2026-08-12 18:08:00+09'");
        expect(migration).toContain("v_order.plan_id = 'basic'");
        expect(migration).toContain('v_order.target_followers_count = 158');
        expect(migration).toContain('v_order.target_following_count = 361');
        expect(migration).toContain('v_preflight.target_followers_count = 158');
        expect(migration).toContain('v_preflight.target_following_count = 361');
        expect(migration).toContain('v_preflight.admission_target_followers_count = 158');
        expect(migration).toContain('v_preflight.admission_target_following_count = 362');
        expect(migration).not.toMatch(/p_(?:old|new|target)_(?:followers|following)_count/i);
        expect(migration).toContain('earlybird_snapshot_count_drift_within_tolerance');
        expect(migration).toMatch(/pg_catalog\.abs\(p_new_count - p_old_count\) <= 3/);
        expect(migration).toMatch(
            /pg_catalog\.abs\(p_new_count - p_old_count\)::NUMERIC \* 100[\s\S]*?<= p_old_count::NUMERIC/,
        );
    });

    it('requires paid, not-refunded, request-free manual concierge eligibility', () => {
        for (const predicate of [
            "v_order.status = 'paid'",
            'v_order.seller_reference_confirmed_at IS NOT NULL',
            'v_order.payment_id IS NOT NULL',
            'pg_catalog.hashtextextended(v_payment_id_hint, 0)',
            'v_order.result_request_id IS NULL',
            "refund_event.event_type = 'payment.refunded'",
            "v_fulfillment.status = 'manual_review'",
            "v_fulfillment.last_error_code = 'SNAPSHOT_CONFLICT'",
            'v_fulfillment.request_id IS NULL',
            'v_fulfillment.operator_admitted_at IS NOT NULL',
            "v_order.concierge_apify_credential_slot = 'tertiary'",
            "v_preflight.order_scoped_apify_credential_slot = 'tertiary'",
        ]) {
            expect(migration).toContain(predicate);
        }
        expect(migration).toMatch(
            /v_fulfillment\.manual_review_at\s+IS DISTINCT FROM p_expected_manual_review_at/,
        );
        expect(migration).toMatch(
            /v_preflight\.admission_refreshed_at\s+IS DISTINCT FROM p_expected_admission_refreshed_at/,
        );
    });

    it('binds the exact successful tertiary generation witness and rejects unrelated work', () => {
        for (const predicate of [
            'v_preflight.id IS DISTINCT FROM p_expected_preflight_id',
            'v_preflight.admission_generation = 3',
            "v_preflight.admission_status = 'ready'",
            "v_provider_run.operation_key = 'target-profile-fresh-admission:g3'",
            "v_provider_run.logical_provider = 'apify'",
            "v_provider_run.credential_slot = 'tertiary'",
            "v_provider_run.status = 'succeeded'",
            'v_provider_run.run_id IS NOT NULL',
            'v_provider_run.terminalized_at IS NOT NULL',
            'v_provider_run.actual_usage_usd IS NOT NULL',
            'v_provider_run.usage_reconciled_at IS NOT NULL',
            'v_provider_run.reusable_profile_schema_version = 1',
            "active_request.status IN ('pending', 'processing')",
            "active_preflight.status IN ('pending', 'processing', 'ready')",
            "'target-profile-fresh-admission:g1'",
            "'target-profile-fresh-admission:g2'",
            'pg_catalog.count(DISTINCT provider_lineage.input_hash)',
            'v_provider_run.input_hash = p_server_target_input_hash',
            'p_admission_generation = 3',
            'p_admission_refreshed_at = recovery.new_witness_recorded_at',
        ]) {
            expect(migration).toContain(predicate);
        }
    });

    it('records timestamps and reason in an immutable receipt without rewriting snapshots', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_concierge_snapshot_conflict_recoveries',
        );
        expect(migration).toContain(
            'EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation()',
        );
        expect(migration).toContain('GET DIAGNOSTICS v_updated = ROW_COUNT');
        expect(migration).toContain('IF v_updated <> 1 THEN');
        expect(migration).toContain('old_snapshot_recorded_at');
        expect(migration).toContain('new_witness_recorded_at');
        expect(migration).toContain('158, 361, 158, 361, 158, 362, v_order.created_at');
        expect(migration).toContain("recovery_reason = 'bounded_time_snapshot_drift'");
        expect(migration).not.toMatch(/UPDATE public\.earlybird_orders AS earlybird_order[\s\S]*?SET target_/);
        expect(migration).not.toMatch(/UPDATE public\.analysis_preflights AS preflight[\s\S]*?SET target_/);
        expect(migration).toContain("last_error_code = 'CONCIERGE_SNAPSHOT_CONFLICT_RECOVERY'");
    });

    it('receipt-gates only the existing count and stale-admission comparisons', () => {
        expect(migration).toContain(
            'earlybird_concierge_snapshot_conflict_counts_authorized',
        );
        expect(migration).toContain(
            "'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)'",
        );
        expect(migration).toContain('pg_catalog.pg_get_functiondef');
        expect(migration).toContain('v_preflight.admission_target_followers_count');
        expect(migration).toContain('v_preflight.admission_target_following_count');
        expect(migration).toContain('v_preflight.admission_refreshed_at');
        expect(migration).toContain('v_preflight.admission_generation');
        expect(migration).toContain(
            'earlybird_concierge_snapshot_conflict_receipt_authorized',
        );
        expect(migration).toMatch(
            /admission_refreshed_at < v_now - INTERVAL '2 minutes'[\s\S]*?AND NOT public\.earlybird_concierge_snapshot_conflict_receipt_authorized/,
        );
        expect(migration).toMatch(
            /AND 3 = \([\s\S]*?provider_lineage\.status = 'succeeded'[\s\S]*?provider_lineage\.credential_slot = 'tertiary'/,
        );
        expect(migration).toMatch(
            /IF FOUND THEN[\s\S]*?v_provider_lineage_exact_count <> 3[\s\S]*?refund_event\.event_type = 'payment\.refunded'[\s\S]*?CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
        );
        expect(migration).toMatch(
            /claim_earlybird_fulfillment\(uuid,uuid,integer\)[\s\S]*?admission_refreshed_at < v_now - INTERVAL '2 minutes'[\s\S]*?earlybird_concierge_snapshot_conflict_receipt_authorized/,
        );
    });

    it('keeps receipt-bound local jobs out of shared recovery and completes exactly one order', () => {
        const requestWrapperStart = migration.indexOf(
            'CREATE FUNCTION public.create_earlybird_concierge_snapshot_recovery_request(',
        );
        const requestWrapperEnd = migration.indexOf(
            'CREATE FUNCTION public.mark_earlybird_concierge_snapshot_recovery_job_local(',
            requestWrapperStart,
        );
        const requestWrapper = migration.slice(requestWrapperStart, requestWrapperEnd);
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.list_analysis_v2_dispatchable_jobs\([\s\S]*?NOT EXISTS \([\s\S]*?earlybird_concierge_snapshot_conflict_recoveries[\s\S]*?earlybird_concierge_snapshot_conflict_receipt_authorized/,
        );
        expect(migration).toMatch(
            /CREATE FUNCTION public\.complete_earlybird_concierge_snapshot_recovery\([\s\S]*?v_order\.result_request_id IS DISTINCT FROM v_request\.id[\s\S]*?v_request\.status IS DISTINCT FROM 'completed'[\s\S]*?SET status = 'completed'/,
        );
        expect(migration).toMatch(
            /CREATE FUNCTION public\.create_earlybird_concierge_snapshot_recovery_request\([\s\S]*?pg_advisory_xact_lock[\s\S]*?payment\.refunded[\s\S]*?claim_earlybird_fulfillment[\s\S]*?create_or_replay_earlybird_fulfillment_request/,
        );
        expect(requestWrapperStart).toBeGreaterThanOrEqual(0);
        expect(requestWrapperEnd).toBeGreaterThan(requestWrapperStart);
        expect(requestWrapper.indexOf('SELECT fulfillment.* INTO v_fulfillment'))
            .toBeLessThan(requestWrapper.indexOf('SELECT earlybird_order.* INTO v_order'));
        expect(migration).not.toContain('reconcile_earlybird_fulfillments');
    });

    it('is security-definer with an empty search path and service-role-only execution', () => {
        expect(migration).toMatch(
            /CREATE FUNCTION public\.recover_earlybird_concierge_snapshot_conflict\([\s\S]*?SECURITY DEFINER\s+SET search_path = ''/,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_earlybird_concierge_snapshot_conflict\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_earlybird_concierge_snapshot_conflict\([\s\S]*?TO service_role;/,
        );
        expect(migration).toMatch(
            /CREATE FUNCTION public\.mark_earlybird_concierge_snapshot_recovery_job_local\([\s\S]*?SECURITY DEFINER\s+SET search_path = ''/,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.mark_earlybird_concierge_snapshot_recovery_job_local\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.mark_earlybird_concierge_snapshot_recovery_job_local\([\s\S]*?TO service_role;/,
        );
        for (const functionName of [
            'inspect_earlybird_concierge_snapshot_recovery_execution',
            'create_earlybird_concierge_snapshot_recovery_request',
            'complete_earlybird_concierge_snapshot_recovery',
        ]) {
            expect(migration).toMatch(new RegExp(
                `CREATE FUNCTION public\\.${functionName}\\([\\s\\S]*?`
                + "SECURITY DEFINER\\s+SET search_path = ''",
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?`
                + 'TO service_role;',
            ));
        }
    });
});
