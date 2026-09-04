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
        expect(sql).toContain('target_likes_declared');
        expect(sql).toContain('target_comments_collected');
        expect(sql).toContain('candidate_likes_declared');
        expect(sql).toContain('purge_fenced_at');
        expect(sql).toContain('purge_fence_reason');
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
        expect(sql).toContain('analysis_order_audit_candidate_key_coverage');
        expect(sql).toContain('CANDIDATE_KEY_SET_GAP');
        expect(sql).toContain('TAGS_SOURCE_MISSING');
        expect(sql).toContain('MENTIONS_SOURCE_MISSING');
        expect(sql).toContain('analysis_order_audit_purge_fence');
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
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.analysis_order_audit_purge_fence');
        expect(sql).toContain('public.analysis_v2_purge_result_working_set_exact(UUID, BOOLEAN)');
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

    it('does not reopen a completed queue for an unchanged cost source', () => {
        const sql = migration();
        const triggerStart = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request_id()',
        );
        const triggerEnd = sql.indexOf(
            'CREATE TRIGGER enqueue_analysis_order_audit_after_request_finalization',
            triggerStart,
        );
        const trigger = sql.slice(triggerStart, triggerEnd);

        expect(trigger).toContain('IS DISTINCT FROM');
        expect(trigger).toContain("TG_OP = 'INSERT'");
        expect(trigger).toContain("status = 'completed'");
        expect(trigger).toContain('costSourceHash');
    });

    it('fences terminal purge until a durable audit bundle exists', () => {
        const sql = migration();
        expect(sql).toContain('ANALYSIS_ORDER_AUDIT_PURGE_FENCED');
        expect(sql).toContain('ANALYSIS_ORDER_AUDIT_PURGE_COMPLETED');
        expect(sql).toContain('analysis_v2_purge_result_working_set');
        expect(sql).toContain('analysis_order_audit_assembly_queue');
        expect(sql).toContain('to_regclass');

        const wrapperStart = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(',
        );
        const wrapperEnd = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.assemble_analysis_order_audit_bundle(',
            wrapperStart,
        );
        const wrapper = sql.slice(wrapperStart, wrapperEnd);
        expect(wrapper).toContain("v_request_status NOT IN ('completed', 'failed')");
        expect(wrapper).toContain('INSERT INTO public.analysis_order_audit_assembly_queue');
        expect(wrapper).toContain("v_queue_status IS DISTINCT FROM 'completed'");
        expect(wrapper).toContain('v_bundle_assembled_at <= v_purge_fenced_at');
        expect(wrapper).toContain('v_bundle_finalized');
        expect(wrapper).toContain('ANALYSIS_ORDER_AUDIT_ASSEMBLY_NOT_FINALIZED');
        expect(sql).toContain("'finalized', v_finalized");
    });

    it('has one authoritative definition and creates hardening columns once', () => {
        const sql = migration();
        const definitions = (name: string) => (
            sql.match(new RegExp(
                `^CREATE OR REPLACE FUNCTION public\\.${name}\\(`,
                'gm',
            )) ?? []
        ).length;

        expect(definitions('assemble_analysis_order_audit_bundle')).toBe(1);
        expect(definitions('enqueue_analysis_order_audit_bundle')).toBe(1);
        expect(definitions('analysis_order_audit_enqueue_from_request')).toBe(1);
        expect(definitions('analysis_order_audit_enqueue_from_request_id')).toBe(1);
        expect(definitions('analysis_order_audit_bundle_payload')).toBe(1);
        expect(sql).not.toContain('ADD COLUMN IF NOT EXISTS');
    });

    it('keeps production purge lock order and final-score retention in the internal helper', () => {
        const sql = migration();
        const helperStart = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set_exact(',
        );
        const helperEnd = sql.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(',
            helperStart,
        );
        expect(helperStart).toBeGreaterThanOrEqual(0);
        expect(helperEnd).toBeGreaterThan(helperStart);
        const helper = sql.slice(helperStart, helperEnd);
        const intentLock = helper.indexOf('analysis_v2_score_audit_intents');
        const summaryLock = helper.indexOf('analysis_v2_result_summaries');
        const runLock = helper.indexOf('analysis_v2_score_audit_runs');
        const checkpointLock = helper.indexOf('analysis_v2_ai_scoring_stage_checkpoints');
        expect(intentLock).toBeGreaterThanOrEqual(0);
        expect(summaryLock).toBeGreaterThan(intentLock);
        expect(runLock).toBeGreaterThan(summaryLock);
        expect(checkpointLock).toBeGreaterThan(runLock);
        expect(helper).toContain("stage.stage_kind = 'final_score'");
        expect(helper).toContain('stage.batch_key = -1');
        expect(helper).toContain("intent.intent_status = 'queued'");
        expect(helper).toContain('intent.retain_until > pg_catalog.clock_timestamp()');
        expect(helper).toContain("run.status IN ('queued','processing')");
        expect(sql).toContain('PERFORM public.analysis_v2_purge_result_working_set_exact');
    });

    it('reads target interactor details through a production-compatible projection', () => {
        const sql = migration();
        expect(sql).toContain("NULLIF(to_jsonb(interaction)->'details', 'null'::JSONB)");
        expect(sql).not.toMatch(
            /FROM public\.analysis_target_interactors AS interaction[\s\S]{0,180}interaction\.details/,
        );
    });
});
