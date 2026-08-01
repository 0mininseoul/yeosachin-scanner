import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/'
            + '20260801160000_fix_schema_recovery_source_preflight_partial_adoption.sql',
        import.meta.url
    ),
    'utf8'
);

describe('schema-recovery source-preflight partial-adoption migration', () => {
    it('uses the failed request preflight admission witness instead of checkout counts', () => {
        expect(migration).toContain('v_source_preflight public.analysis_preflights%ROWTYPE');
        expect(migration).toContain('WHERE preflight.id = v_failed_request.preflight_id');
        expect(migration).toContain('FOR UPDATE');
        expect(migration).toContain('v_source_preflight.admission_target_followers_count');
        expect(migration).toContain('v_source_preflight.admission_target_following_count');
        expect(migration).not.toContain('v_order.target_followers_count\n        ELSE v_order.target_following_count');
    });

    it('fails closed unless every source witness is exact, admitted, and inside the paid partition', () => {
        expect(migration).toContain('v_source_preflight.id IS DISTINCT FROM v_failed_request.preflight_id');
        expect(migration).toContain("v_source_preflight.status <> ''consumed''");
        expect(migration).toContain('v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id');
        expect(migration).toContain("v_source_preflight.admission_status <> ''ready''");
        expect(migration).toContain('v_source_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id');
        expect(migration).toContain('v_source_preflight.admission_capacity_required_plan_id');
        expect(migration).toContain('v_source_preflight.admission_required_plan_id');
        expect(migration).toContain('v_order, v_recovery_preflight, v_current');
        expect(migration).toContain(
            'v_order, v_recovery_preflight, v_source_preflight, v_current'
        );
        expect(migration).toContain("ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT");
    });

    it('recomputes source, current, and immutable order partitions independently', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_source_adoption_preflights('
        );
        expect(migration).toContain('v_source_capacity_rank');
        expect(migration).toContain('v_current_capacity_rank');
        expect(migration).toContain('v_order_capacity_rank');
        expect(migration).toContain('p_source.admission_target_followers_count');
        expect(migration).toContain('p_current.target_followers_count');
        expect(migration).toContain('p_order.target_followers_count');
        expect(migration).toContain('p_source.admission_plan_cards_snapshot = v_source_cards');
        expect(migration).toContain('p_current.admission_plan_cards_snapshot = v_current_cards');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_source_adoption_preflights('
        );
        expect(migration).not.toContain(
            'GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_source_adoption_preflights('
        );
        expect(migration).toContain('public.analysis_v2_valid_recovery_adoption_preflights(');
        expect(migration).toContain('public.analysis_v2_valid_source_adoption_preflights(');
    });

    it('permits only the exact eight-source, three-adoption incident topology in the audited rearm', () => {
        expect(migration).toContain('v_partial_adoption_variant BOOLEAN');
        expect(migration).toContain('v_fulfillment.attempt_count = 2');
        expect(migration).toContain("v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')");
        expect(migration).toContain('v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant');
        expect(migration).toContain('adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id');
        expect(migration).toContain('v_partial_source_topology_valid BOOLEAN');
        expect(migration).toContain('v_partial_adoption_topology_valid BOOLEAN');
        expect(migration).toContain('pg_catalog.count(*) = 8');
        expect(migration).toContain('pg_catalog.count(*) = 3');
        expect(migration).toContain('v_partial_source_initial_operation');
        expect(migration).toContain('v_partial_source_operation');
        expect(migration).toContain('v_partial_current_operation');
        expect(migration).toContain('v_partial_source_preflight.admission_target_following_count');
        expect(migration).toContain('v_preflight.target_following_count, v_order.plan_id, TRUE');
        expect(migration).toContain('source_run.input_hash = v_partial_source_initial_input');
        expect(migration).toContain('source_run.input_hash = v_partial_source_input');
        expect(migration).toContain("'^profile-fallback:[0-9a-f]{64}$'");
        expect(migration).toContain("'^target-likers:[0-9a-f]{64}$'");
        expect(migration).toContain("'^target-comments:[0-9a-f]{64}$'");
        expect(migration).toContain('pg_catalog.count(source_run.request_id) = 3');
        expect(migration).toContain('pg_catalog.bool_and(adoption.job_key = source_run.job_key)');
        expect(migration).toContain('adoption.operation_key = v_partial_current_operation');
        expect(migration).toContain('adoption.destination_input_hash = v_partial_current_input');
        expect(migration).toContain('ELSE adoption.operation_key = source_run.operation_key');
        expect(migration).toContain('AND adoption.destination_input_hash = source_run.input_hash');
        expect(migration).toContain('COALESCE(v_partial_source_topology_valid, FALSE)');
        expect(migration).toContain('COALESCE(v_partial_adoption_topology_valid, FALSE)');
        expect(migration).toContain('public.analysis_provider_cost_ledger AS cost');
        expect(migration).toContain('public.analysis_v2_ai_attempts AS attempt');
        expect(migration).toContain("job.last_error_code = ''ANALYSIS_V2_PROGRESS_CONFLICT''");
        expect(migration).toContain('NOT v_partial_adoption_variant AND job.attempt_count = 0');
        expect(migration).not.toContain('NOT BETWEEN 1 AND 5');
        expect(migration).toContain('EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_REARM_PATCH_MISMATCH');
    });
});
