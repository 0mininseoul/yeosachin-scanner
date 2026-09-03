import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
    'supabase/migrations/20260904130000_add_permanent_order_audit_bundle.sql';

function migration(): string {
    return readFileSync(migrationPath, 'utf8');
}

describe('permanent order audit bundle migration contract', () => {
    it('defines versioned parent and normalized candidate/interaction children', () => {
        const sql = migration();

        expect(sql).toContain('CREATE TABLE public.analysis_order_audit_bundles');
        expect(sql).toContain('CREATE TABLE public.analysis_order_audit_candidates');
        expect(sql).toContain('CREATE TABLE public.analysis_order_audit_interactions');
        expect(sql).toContain('request_id UUID NOT NULL');
        expect(sql).toContain('version INTEGER NOT NULL');
        expect(sql).toContain('previous_version_hash');
        expect(sql).toContain('source_set_hash');
        expect(sql).toContain('completeness_status');
        expect(sql).toContain('gap_codes');
        expect(sql).toContain('usage_unknown');
        expect(sql).toContain('initial_gender_output');
        expect(sql).toContain('final_gender_output');
        expect(sql).toContain('risk_components');
        expect(sql).toContain('source_post_id');
        expect(sql).toContain('comment_text');
    });

    it('installs append-only assembly, reconciliation, and bounded operator RPCs', () => {
        const sql = migration();

        expect(sql).toContain('enqueue_analysis_order_audit_bundle');
        expect(sql).toContain('assemble_analysis_order_audit_bundle');
        expect(sql).toContain('load_analysis_order_audit_bundle');
        expect(sql).toContain('list_analysis_order_audit_bundle_recovery');
        expect(sql).toContain('claim_analysis_order_audit_bundle');
        expect(sql).toContain('release_analysis_order_audit_bundle');
        expect(sql).toContain('ON CONFLICT (request_id, source_set_hash)');
        expect(sql).toContain('pg_advisory_xact_lock');
        expect(sql).toContain('OFFSET p_cursor LIMIT p_page_size');
        expect(sql).toContain("p_page_size NOT BETWEEN 1 AND 50");
        expect(sql).toContain("p_section IN ('summary', 'mutuals', 'gender', 'interactions', 'risk')");
    });

    it('forces RLS, denies direct table access, and rejects mutation of every audit row', () => {
        const sql = migration();

        for (const table of [
            'analysis_order_audit_bundles',
            'analysis_order_audit_candidates',
            'analysis_order_audit_interactions',
            'analysis_order_audit_assembly_queue',
        ]) {
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(sql).toContain(`REVOKE ALL ON TABLE public.${table}`);
        }
        expect(sql).toContain('prevent_analysis_order_audit_mutation');
        expect(sql).toContain('ANALYSIS_ORDER_AUDIT_IMMUTABLE');
        expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.assemble_analysis_order_audit_bundle');
        expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_order_audit_bundle');
    });

    it('assembles from authoritative V2 rows and keeps missing evidence/cost explicit', () => {
        const sql = migration();

        expect(sql).toContain('analysis_v2_relationship_sides');
        expect(sql).toContain('analysis_v2_relationship_manifests');
        expect(sql).toContain('analysis_v2_mutual_rows');
        expect(sql).toContain('analysis_v2_ai_result_checkpoints');
        expect(sql).toContain('analysis_v2_candidate_feature_rows');
        expect(sql).toContain('analysis_target_interactors');
        expect(sql).toContain('analysis_v2_candidate_score_rows');
        expect(sql).toContain('analysis_v2_cost_rollups');
        expect(sql).toContain('COST_USAGE_UNKNOWN');
        expect(sql).toContain('TARGET_PROFILE_MISSING');
        expect(sql).toContain('MUTUAL_ROWS_MISSING');
        expect(sql).not.toMatch(/COALESCE\([^\n]*usage_unknown[^\n]*,\s*FALSE\)/i);
    });

    it('makes both enqueue triggers fail open so durable DML can be retried later', () => {
        const sql = migration();
        const requestTriggerStart = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request()',
        );
        const requestIdTriggerStart = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request_id()',
        );
        expect(requestTriggerStart).toBeGreaterThanOrEqual(0);
        expect(requestIdTriggerStart).toBeGreaterThan(requestTriggerStart);

        const requestTrigger = sql.slice(requestTriggerStart, requestIdTriggerStart);
        const requestIdTrigger = sql.slice(requestIdTriggerStart);
        for (const trigger of [requestTrigger, requestIdTrigger]) {
            expect(trigger).toContain('EXCEPTION WHEN OTHERS');
            expect(trigger).toContain('ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED');
        }
    });
});
