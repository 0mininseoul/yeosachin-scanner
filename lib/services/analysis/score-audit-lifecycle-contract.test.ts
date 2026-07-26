import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const executor = readFileSync(new URL('./v2-ai-scoring-executors.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727032000_add_analysis_v2_score_audit.sql',
    import.meta.url,
), 'utf8');

describe('analysis score audit completion isolation', () => {
    it('has no network audit call in scoring or finalization', () => {
        expect(executor).not.toMatch(
            /captureAuditSource|materializeAudit|scoreAudit|captureAnalysisScoreAuditSource/
        );
    });

    it('atomically stores only O(1) checkpoint metadata with a bounded lock wait', () => {
        const triggerStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.enqueue_analysis_v2_score_audit_from_stage'
        );
        const triggerEnd = migration.indexOf(
            'CREATE TRIGGER enqueue_analysis_v2_score_audit_from_stage',
            triggerStart,
        );
        const trigger = migration.slice(triggerStart, triggerEnd);
        expect(migration).toContain('AFTER INSERT OR UPDATE ON public.analysis_v2_ai_scoring_stage_checkpoints');
        expect(trigger).toContain("NEW.stage_kind = 'final_score'");
        expect(trigger).toContain('NEW.result_hash');
        expect(trigger).toContain('NEW.item_count');
        expect(trigger).toContain('retain_until');
        expect(trigger).toMatch(
            /WHEN analysis_v2_score_audit_intents\.source_result_hash[\s\S]*?IS DISTINCT FROM EXCLUDED\.source_result_hash[\s\S]*?clock_timestamp\(\) \+ INTERVAL '30 minutes'/
        );
        expect(trigger).toContain("SET lock_timeout = '100ms'");
        expect(trigger).toContain(
            'INSERT INTO public.analysis_v2_score_audit_intents'
        );
        expect(trigger).not.toMatch(
            /NEW\.payload|jsonb_|candidate|JOIN|FOR UPDATE|pg_catalog\.max/iu
        );
        expect(migration).toContain('source_payload JSONB');
        expect(migration).toContain('pg_catalog.octet_length(source_payload::TEXT) <= 4194304');
        expect(trigger).toMatch(/EXCEPTION WHEN OTHERS THEN\s+NULL;/);
        expect(migration).toContain(
            "run.status IN ('queued','processing')"
        );
        expect(migration).toContain(
            "stage.stage_kind = 'final_score' AND stage.batch_key = -1"
        );
        expect(migration).toMatch(
            /attempt_count = CASE[\s\S]*?source_result_hash[\s\S]*?IS DISTINCT FROM EXCLUDED\.source_result_hash[\s\S]*?source_generation[\s\S]*?IS DISTINCT FROM EXCLUDED\.source_generation[\s\S]*?THEN 0/
        );
    });

    it('uses intent before run and checkpoint for claim, materialize, and TTL purge', () => {
        const claimStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.claim_analysis_v2_score_audit'
        );
        const materializeStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.materialize_analysis_v2_score_audit'
        );
        const purgeStart = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_score_audit_evidence'
        );
        const claim = migration.slice(claimStart, materializeStart);
        const materialize = migration.slice(materializeStart, purgeStart);
        const purge = migration.slice(purgeStart);
        expect(claim.indexOf('analysis_v2_score_audit_intents AS intent'))
            .toBeLessThan(claim.indexOf('analysis_v2_result_summaries AS summary'));
        expect(claim.indexOf('FOR UPDATE'))
            .toBeLessThan(claim.indexOf('INSERT INTO public.analysis_v2_score_audit_runs'));
        expect(materialize.indexOf('analysis_v2_score_audit_intents'))
            .toBeLessThan(materialize.indexOf('analysis_v2_score_audit_runs'));
        expect(purge.indexOf('FROM public.analysis_v2_score_audit_intents AS intent'))
            .toBeLessThan(purge.indexOf('INSERT INTO public.analysis_v2_score_audit_runs'));
        expect(purge).toContain('FOR UPDATE SKIP LOCKED');
    });
});
