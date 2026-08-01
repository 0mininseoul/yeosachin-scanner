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
        expect(migration).toContain('v_order, v_source_preflight, v_current');
        expect(migration).toContain("ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT");
    });

    it('permits only a nonempty exact-lineage adoption subset in the audited zero-spend policy rearm', () => {
        expect(migration).toContain('v_partial_adoption_variant BOOLEAN');
        expect(migration).toContain('v_fulfillment.attempt_count = 2');
        expect(migration).toContain("v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')");
        expect(migration).toContain('v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant');
        expect(migration).toContain('adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id');
        expect(migration).toContain("job.last_error_code = ''ANALYSIS_V2_PROGRESS_CONFLICT''");
        expect(migration).not.toContain('NOT BETWEEN 1 AND 5');
        expect(migration).toContain('EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_REARM_PATCH_MISMATCH');
    });
});
