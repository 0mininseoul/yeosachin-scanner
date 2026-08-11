import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../supabase/migrations/20260810100000_add_revenue_cost_operation_ledger.sql', import.meta.url), 'utf8');
const AI_DISPATCH_MARKER = '-- Durable Gemini-attempt economic authority.';

function aiDispatchWrapper(startSignature: string, endSignature?: string): string {
    const aiDispatch = source.slice(source.indexOf(AI_DISPATCH_MARKER));
    const start = aiDispatch.indexOf(startSignature);
    const end = endSignature === undefined ? -1 : aiDispatch.indexOf(endSignature, start + 1);
    return aiDispatch.slice(start, end === -1 ? undefined : end);
}

function aiReviewRefresh(): string {
    const start = source.indexOf('CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_refresh_review_v1');
    const end = source.indexOf('-- Preserve the provider implementation exactly', start);
    return source.slice(start, end);
}

describe('revenue cost-operation migration contract', () => {
    it('freezes pricing and makes legacy parent actual cost non-null before pricing enforcement', () => {
        expect(source).toContain("'revenue-e2e-cost-2026-08-10-v1'");
        expect(source).toContain('UPDATE public.analysis_revenue_run_ledgers SET actual_cost_krw = 0 WHERE actual_cost_krw IS NULL');
        expect(source).toContain('ALTER COLUMN actual_cost_krw SET NOT NULL');
        expect(source).toContain('analysis_revenue_run_ledgers_actual_cost_nonnegative_check');
        expect(source).toContain("(plan_id = 'basic' AND cost_cap_krw = 1808 AND margin_target_krw = 904)");
        expect(source).toContain("(plan_id = 'standard' AND cost_cap_krw = 3634 AND margin_target_krw = 1817)");
    });

    it('uses non-null source identities, exact source mapping, lifecycle checks, and service-only child access', () => {
        expect(source).toContain("source_job_key TEXT NOT NULL CHECK (");
        expect(source).toContain("'^[a-z0-9][a-z0-9:._-]{0,159}$'");
        expect(source).toContain('analysis_revenue_cost_operations_source_mapping_check');
        expect(source).toContain("owner_kind = 'preflight_provider_run' AND source_job_key = 'preflight' AND source_attempt = 0 AND operation_kind = 'target_profile'");
        expect(source).toContain('analysis_revenue_cost_operations_lifecycle_check');
        expect(source).toContain('UNIQUE (request_id, owner_kind, source_job_key, source_operation_key_hash, source_attempt)');
        expect(source).toContain('analysis_revenue_cost_operations_source_lookup_idx');
        expect(source).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('imports exactly the two succeeded and reconciled source rows with database-derived opaque hashes', () => {
        expect(source).toContain("'target-profile-fallback'");
        expect(source).toContain("'target-profile-fresh-admission:g1'");
        expect(source).toContain('v_count <> 2');
        expect(source).toContain("v_fallback.status IS DISTINCT FROM 'succeeded'");
        expect(source).toContain('v_fallback.terminalized_at IS NULL');
        expect(source).toContain('v_fallback.usage_reconciled_at IS NULL');
        expect(source).toContain('v_preflight.target_input_hash');
        expect(source).toContain("extensions.digest(pg_catalog.convert_to(v_fallback.operation_key, 'UTF8'), 'sha256')");
        expect(source).not.toContain('target_instagram_id, \'UTF8\')');
    });

    it('locks and verifies every immutable begin replay fact rather than conflict-dropping source evidence', () => {
        expect(source).toContain('consumed preflight -> request -> entitlement');
        expect(source).toContain('v_existing.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at');
        expect(source).toContain('v_existing.request_started_at IS DISTINCT FROM v_request.created_at');
        expect(source).toContain("v_existing.reserved_cost_krw IS DISTINCT FROM 0 OR v_existing.status IS DISTINCT FROM 'running'");
        expect(source).toContain('v_child.selected_manifest_scope_hash IS NULL AND v_child.denial_reason IS NULL');
        expect(source).toContain("'created', FALSE, 'replayed', TRUE");
        expect(source).toContain("'created', TRUE, 'replayed', FALSE");
        expect(source).not.toContain('ON CONFLICT');
    });

    it('retains compiled RPC signatures but fences live operations and bounded reconciliation', () => {
        for (const name of [
            'begin_analysis_revenue_cost_ledger_v1', 'reserve_analysis_revenue_cost_operation_v1',
            'mark_analysis_revenue_cost_operation_started_v1', 'settle_analysis_revenue_cost_operation_v1',
            'release_analysis_revenue_cost_operation_v1', 'mark_analysis_revenue_manual_review_v1',
            'read_analysis_revenue_cost_reconciliation_v1',
        ]) expect(source).toContain(`FUNCTION public.${name}`);
        expect(source).toContain("REVENUE_COST_OPERATION_NOT_READY");
        expect(source).toContain('DROP FUNCTION IF EXISTS public.read_analysis_revenue_cost_reconciliation_v1(UUID)');
        expect(source).toContain("'finalizable', FALSE, 'reason', 'not_ready'");
        expect(source).toContain('REVOKE ALL ON FUNCTION');
        expect(source).toContain('GRANT EXECUTE ON FUNCTION');
    });

    it('exposes service-only source-aware reserve/start authority for provider and immutable AI attempts', () => {
        expect(source).toContain('FUNCTION public.reserve_analysis_revenue_cost_operation_v2');
        expect(source).toContain('FUNCTION public.mark_analysis_revenue_cost_operation_started_v2');
        expect(source).toContain('p_source_operation_key TEXT');
        expect(source).toContain('p_job_claim_token UUID');
        expect(source).toContain('DROP FUNCTION IF EXISTS public.reserve_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT,TEXT,INTEGER,NUMERIC,TEXT)');
        expect(source).toContain('v_now := pg_catalog.clock_timestamp()');
        expect(source).toContain('analysis_revenue_ai_cost_max_usd_v1');
        expect(source).toContain('analysis_revenue_ai_cost_owner_hash_v1');
        expect(source).toContain('analysis_revenue_ai_cost_operation_mapping_v1');
        expect(source).toContain("'stage_one_routing'");
        expect(source).toContain("'stage_one_routing_retry'");
        expect(source).toContain("'resolver'");
        expect(source).not.toContain('REVENUE_COST_OPERATION_AI_NOT_READY');
        expect(source).toContain("COALESCE(pg_catalog.sum(CASE WHEN status IN ('reserved','started') THEN reserved_krw ELSE 0 END), 0)");
        expect(source).toContain("REVOKE ALL ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2");
        expect(source).toContain("GRANT EXECUTE ON FUNCTION public.reserve_analysis_revenue_cost_operation_v2");
        expect(source).toContain("REVOKE ALL ON FUNCTION public.mark_analysis_revenue_cost_operation_started_v2");
        expect(source).toContain("GRANT EXECUTE ON FUNCTION public.mark_analysis_revenue_cost_operation_started_v2");
    });

    it('makes the AI path test-entitlement-only and keeps one unified operation ledger authority', () => {
        expect(source).toContain("v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'");
        expect(source).toContain("v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')");
        expect(source).toContain("v_policy.mode IS DISTINCT FROM 'test_operation_split'");
        expect(source).toContain("v_runner_plan IS DISTINCT FROM v_request.selected_plan_id_snapshot");
        expect(source).toContain("owner_kind = 'ai_attempt' AND source_job_key <> 'preflight'");
        expect(source).toContain("p_source_kind IS DISTINCT FROM 'ai_attempt'");
        expect(source).toContain('v_manifest_count <> 1');
        expect(source).not.toContain('CREATE TABLE public.analysis_revenue_ai_cost_operations');
        expect(source).not.toContain('CREATE TABLE public.analysis_ai_cost_operations');
    });

    it('keeps provider-authoritative settlement while adding terminal AI telemetry settlement and release-or-ambiguity', () => {
        expect(source).toContain('FUNCTION public.settle_analysis_revenue_cost_operation_v2');
        expect(source).toContain('FUNCTION public.release_analysis_revenue_cost_operation_v2');
        expect(source).toContain("v_ai.usage_metadata_status='complete'");
        expect(source).toContain("v_ai.status IN ('rate_limited','rejected')");
        expect(source).toContain("'ambiguous_external_call'");
        expect(source).toContain("v_ai.estimated_cost_usd IS DISTINCT FROM v_actual_usd");
        expect(source).toContain("p_source_attempt > 1");
        expect(source).toContain("v_provider.status = 'rejected'");
        expect(source).toContain("v_provider.status NOT IN ('succeeded','failed','aborted','timed_out')");
        expect(source).toContain("REVENUE_COST_OPERATION_NOT_READY");
        expect(source).toContain('DROP FUNCTION IF EXISTS public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT,NUMERIC,NUMERIC)');
        expect(source).toContain('DROP FUNCTION IF EXISTS public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT,TEXT)');
        expect(source).toContain('REVOKE ALL ON FUNCTION public.settle_analysis_revenue_cost_operation_v2(UUID,TEXT,TEXT,TEXT,SMALLINT) FROM PUBLIC, anon, authenticated, service_role');
        expect(source).toContain('GRANT EXECUTE ON FUNCTION public.release_analysis_revenue_cost_operation_v2(UUID,TEXT,UUID,TEXT,TEXT,TEXT,SMALLINT) TO service_role');
    });

    it('targets the exact AI terminal and release wrappers without raw target-field reads', () => {
        const settlement = aiDispatchWrapper(
            'CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v2',
            'CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2',
        );
        expect(settlement).toContain('analysis_revenue_ai_cost_assert_lineage_v1(p_request_id,p_job_key,NULL,NULL,FALSE)');
        expect(settlement).toContain('SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts');
        expect(settlement).not.toContain('lower(v_preflight.target_instagram_id)');
        expect(settlement).not.toContain('lower(v_policy.target_instagram_id)');
        const release = aiDispatchWrapper(
            'CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2',
        );
        expect(release).toContain('analysis_revenue_ai_cost_assert_lineage_v1(p_request_id,p_job_key,p_job_claim_token,p_job_input_hash,TRUE)');
        expect(release).toContain('RETURN public.settle_analysis_revenue_cost_operation_v2(');
        expect(release).not.toContain('lower(v_preflight.target_instagram_id)');
        expect(release).not.toContain('lower(v_policy.target_instagram_id)');
    });

    it('documents definite rejection and keeps terminal replays parent-state independent', () => {
        expect(source).toContain('A provider `rejected` row is authoritative proof that no external run');
        expect(source).toContain("UPDATE public.analysis_revenue_cost_operations SET status='released',started_at=NULL");
        expect(source).toContain("WHEN manual_review_reason IN ('cost_overrun','cost_denied') THEN manual_review_reason");
        expect(source).toContain("v_parent.manual_review_reason='ambiguous_external_call' AND v_unsettled=0 AND v_denied=0");
    });

    it('routes exact AI settlement through the denied-child precedence refresh rather than the earlier provider function', () => {
        const settlement = aiDispatchWrapper(
            'CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v2',
            'CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2',
        );
        const refresh = aiReviewRefresh();
        expect(settlement).toContain('PERFORM public.analysis_revenue_ai_cost_refresh_review_v1(p_request_id)');
        expect(refresh).toContain("pg_catalog.count(*) FILTER (WHERE status = 'denied')::INTEGER");
        expect(refresh).toContain('ELSIF v_denied > 0 THEN');
        expect(refresh).toContain("manual_review_reason = 'cost_denied'");
        expect(refresh).toContain("v_parent.manual_review_reason IN ('cost_overrun','cost_denied')");
    });

    it('targets the exact new AI dispatch wrappers and keeps cost-denied monotonic across settlement', () => {
        const settlement = aiDispatchWrapper(
            'CREATE OR REPLACE FUNCTION public.settle_analysis_revenue_cost_operation_v2',
            'CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2',
        );
        const release = aiDispatchWrapper(
            'CREATE OR REPLACE FUNCTION public.release_analysis_revenue_cost_operation_v2',
        );

        expect(settlement).toContain("IF p_source_kind='provider_run' THEN");
        expect(settlement).toContain('SELECT * INTO v_ai FROM public.analysis_v2_ai_attempts');
        expect(settlement).toContain("v_ai.usage_metadata_status='complete'");
        expect(settlement).not.toContain('v_provider.actual_usage_usd');
        expect(settlement).toContain("manual_review_reason IN ('cost_overrun','cost_denied')");
        expect(release).toContain("manual_review_reason IN ('cost_overrun','cost_denied')");
    });

    it('restricts skipped-start lifecycle evidence to authoritative provider settlement and aggregates it below active ambiguity but above running', () => {
        expect(source).toContain("lifecycle_anomaly TEXT CONSTRAINT analysis_revenue_cost_operations_lifecycle_anomaly_value_check CHECK (lifecycle_anomaly IN ('skipped_start'))");
        expect(source).toContain('analysis_revenue_cost_operations_lifecycle_anomaly_check');
        expect(source).toContain("lifecycle_anomaly = 'skipped_start' AND owner_kind = 'provider_run' AND source_job_key <> 'preflight' AND source_attempt = 0");
        expect(source).toContain('AND v_child.lifecycle_anomaly IS NULL');
        expect(source).toContain("lifecycle_anomaly=CASE WHEN v_child.status='reserved' THEN 'skipped_start' ELSE lifecycle_anomaly END");
        expect(source).toContain("pg_catalog.count(*) FILTER (WHERE lifecycle_anomaly='skipped_start')::INTEGER");
        expect(source).toContain("ELSIF v_ambiguous > 0 THEN");
        expect(source).toContain("ELSIF v_skipped_start > 0 THEN");
    });
});
