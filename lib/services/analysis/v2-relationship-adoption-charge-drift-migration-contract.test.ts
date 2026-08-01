import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260801180000_fix_relationship_adoption_charge_drift.sql',
    import.meta.url
), 'utf8');

describe('relationship adoption charge-drift migration', () => {
    it('uses immutable source charge audit data while bounding usage by both caps', () => {
        expect(migration).toContain('source_run.max_charge_usd = p_max_charge_usd');
        expect(migration).toContain(
            "|| '<= source_run.max_charge_usd + 0.000000001'"
        );
        expect(migration).toContain("|| '<= p_max_charge_usd + 0.000000001'");
        expect(migration).toContain('initial_run.actual_usage_usd');
        expect(migration).toContain(
            "v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd"
        );
        expect(migration).toContain("'''maxChargeUsd'', v_source.max_charge_usd");
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_CHARGE_DRIFT_OLD_SHAPE_MISMATCH');
        expect(migration).toContain('ANALYSIS_V2_RELATIONSHIP_CHARGE_DRIFT_REWRITE_MISMATCH');
        expect(migration).toContain('046d6ba9df0c23106151db6d5e2afb8d');
        expect(migration).toContain('1486eec1954681d6da029172d1976d2e');
    });

    it('opens only the exact audited attempt-three r2 incident into r3', () => {
        expect(migration).toContain('earlybird_partial_adoption_second_rearms');
        expect(migration).toContain('expected_fulfillment_attempt_count = 3');
        expect(migration).toContain('v_fulfillment.attempt_count <> 3');
        expect(migration).toContain("('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r2')");
        expect(migration).toContain("v_base_preflight_key || '.r3'");
        expect(migration).toContain('pg_catalog.count(*) = 8');
        expect(migration).toContain('pg_catalog.count(*) = 3');
        expect(migration).toContain('pg_catalog.count(*) = 1');
        expect(migration).toContain('v_first_adoption_topology_valid');
        expect(migration).toContain(
            'adoption.source_request_id = v_lineage.failed_request_id'
        );
        expect(migration).toContain('adoption.job_key = source_run.job_key');
        expect(migration).toContain('source_run.max_charge_usd = 0.198050000000');
        expect(migration).toContain('source_run.actual_usage_usd = 0.163100000000');
        expect(migration).toContain('public.analysis_v2_valid_source_adoption_preflights(');
        expect(migration).toContain('public.analysis_v2_valid_recovery_adoption_preflights(');
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_INELIGIBLE');
        expect(migration).toContain("'retained.' || pg_catalog.substr(");
        expect(migration).toContain('v_preflight.pii_scrubbed_at IS NULL');
        expect(migration).toContain(
            "v_preflight.exclusion_decision IS DISTINCT FROM 'skip'"
        );
        expect(migration).toContain('v_preflight.excluded_instagram_id IS NOT NULL');
        expect(migration).toContain("job.track = 'coordinator'");
        expect(migration).toContain("job.kind = 'bootstrap'");
        expect(migration).toContain("job.track = 'relationships'");
        expect(migration).toContain("job.track = 'target_evidence'");
    });

    it('keeps the new audit immutable and both RPCs locked and service-only', () => {
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("COALESCE('search_path=\"\"' = ANY(proc.proconfig), FALSE)");
        expect(migration).toContain('WHERE earlybird_order.id = p_order_id FOR UPDATE;');
        expect(migration).toContain('WHERE request.id = p_expected_failed_request_id FOR UPDATE;');
        expect(migration).toContain('FOR UPDATE OF source_preflight;');
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_IMMUTABLE');
        expect(migration).toContain('bfa202272672f2b954ad0eaedcb47cc5');
        expect(migration).toContain('$existing_audit_table_guard$');
        expect(migration).toContain('table_row.relforcerowsecurity');
        expect(migration).toContain('pg_catalog.pg_get_constraintdef');
        expect(migration).toContain('pg_catalog.has_table_privilege');
        expect(migration).toContain('trigger_row.tgfoid = function_row.oid');
        expect(migration).toContain('trigger_row.tgtype = (1 | 2 | 8 | 16)');
        expect(migration).toContain("trigger_row.tgenabled = 'O'");
        expect(migration).toContain(
            'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_TABLE_SHAPE_MISMATCH'
        );
        expect(migration).toContain(
            'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_TRIGGER_SHAPE_MISMATCH'
        );
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.rearm_earlybird_partial_adoption_second_failure');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.rearm_earlybird_partial_adoption_second_failure');
        expect(migration).toContain("pg_catalog.has_function_privilege('anon', v_rearm_signature, 'EXECUTE')");
        expect(migration).toContain('EARLYBIRD_RELATIONSHIP_CHARGE_DRIFT_FINAL_GUARD_MISMATCH');
    });
});
