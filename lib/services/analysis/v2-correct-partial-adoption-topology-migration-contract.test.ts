import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260801170000_correct_partial_adoption_incident_topology.sql',
    import.meta.url
), 'utf8');

describe('correct partial-adoption incident topology migration', () => {
    it('patches only the exact 1600 shape and is idempotent on the complete final shape', () => {
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_OLD_SHAPE_MISMATCH');
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_BLOCK_MISMATCH');
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_REWRITE_MISMATCH');
        expect(migration).toContain("<> '2994a37e90c99d26aabd2a75a44c70a1'");
        expect(migration).toContain('= pg_catalog.md5(v_new_block)');
        expect(migration).toContain('v_partial_source_initial_operation');
        expect(migration).toContain('v_partial_source_followers_operation TEXT');
        expect(migration).toContain('v_partial_current_followers_operation TEXT');
        expect(migration).toContain('v_partial_current_following_operation TEXT');
        expect(migration).toContain('v_partial_source_preflight.admission_target_followers_count');
        expect(migration).toContain('v_preflight.target_followers_count, v_order.plan_id, FALSE');
        expect(migration).toContain('v_preflight.target_following_count, v_order.plan_id, FALSE');
        expect(migration).toContain('pg_catalog.count(*) = 8');
        expect(migration).toContain('pg_catalog.count(*) = 3');
        expect(migration).toContain('v_fulfillment.attempt_count = 2');
        expect(migration).toContain("v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')");
        expect(migration).toContain('COALESCE(v_partial_source_topology_valid');
        expect(migration).toContain('COALESCE(v_partial_adoption_topology_valid');
        expect(migration).toContain('adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id');
        expect(migration).toContain('public.analysis_v2_valid_recovery_adoption_preflights(');
        expect(migration).toContain('v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant');
    });

    it('pins exact source and destination identities without replacement runs', () => {
        expect(migration).toContain('source_run.operation_key = v_partial_source_followers_operation');
        expect(migration).toContain('source_run.input_hash = v_partial_source_followers_input');
        expect(migration).toContain('source_run.operation_key = v_partial_source_following_operation');
        expect(migration).toContain('source_run.input_hash = v_partial_source_following_input');
        expect(migration).toContain('adoption.operation_key = v_partial_current_following_operation');
        expect(migration).toContain('adoption.destination_input_hash = v_partial_current_following_input');
        expect(migration).toContain('ELSE adoption.operation_key = source_run.operation_key');
        expect(migration).toContain('AND adoption.destination_input_hash = source_run.input_hash');
        expect(migration).not.toContain("v_order.plan_id, TRUE\n+    ) AS identity;");
    });

    it('preserves zero-spend and legacy fences and keeps the RPC service-only', () => {
        expect(migration).toContain('run.request_id = v_request.id');
        expect(migration).toContain('public.analysis_provider_cost_ledger AS cost');
        expect(migration).toContain('public.analysis_v2_ai_attempts AS attempt');
        expect(migration).toContain('public.analysis_v2_relationship_sides AS evidence');
        expect(migration).toContain('public.analysis_v2_target_evidence_manifests AS evidence');
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure');
        expect(migration).toContain('EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_ACL_MISMATCH');
    });
});
