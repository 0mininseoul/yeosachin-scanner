import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727032000_add_analysis_v2_score_audit.sql',
    import.meta.url,
), 'utf8');

describe('analysis score audit migration contract', () => {
    it('uses a private, service-role-only projection and a bounded outbox lease', () => {
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('FORCE ROW LEVEL SECURITY');
        expect(migration).toMatch(/REVOKE ALL ON TABLE[\s\S]*anon, authenticated, service_role;/);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/);
        expect(migration).toContain("INTERVAL '2 minutes'");
        expect(migration).toContain('RETRY_LIMIT_REACHED');
        expect(migration).toContain(
            'CREATE TRIGGER enqueue_analysis_v2_score_audit_from_stage'
        );
        expect(migration).toContain(
            'AFTER INSERT OR UPDATE ON public.analysis_v2_ai_scoring_stage_checkpoints'
        );
        expect(migration).toContain('source_payload JSONB');
        expect(migration).toContain('analysis_v2_score_audit_scan_locators');
        expect(migration).toContain(
            'analysis_v2_score_audit_scan_locators_ready_unretained_idx'
        );
        expect(migration).toContain(
            'analysis_v2_score_audit_scan_locators_ready_retained_idx'
        );
        expect(migration).toContain('analysis_v2_score_audit_scan_locators_expiry_idx');
        expect(migration).toContain(
            'refresh_analysis_v2_score_audit_scan_locator'
        );
        expect(migration).toMatch(
            /refresh_analysis_v2_score_audit_scan_locator\([\s\S]*?pg_advisory_xact_lock\([\s\S]*?hashtextextended\(p_request_id::TEXT, 0\)[\s\S]*?SELECT summary\.\*/
        );
        expect(migration).toMatch(
            /INSERT INTO public\.analysis_v2_score_audit_scan_locators[\s\S]*?FROM public\.analysis_v2_result_summaries AS summary[\s\S]*?ON CONFLICT \(request_id\) DO NOTHING/
        );
        expect(migration).toContain(
            'LIMIT LEAST(GREATEST(p_limit, 1), 20)'
        );
        const scannerStart = migration.lastIndexOf(
            'CREATE OR REPLACE FUNCTION public.list_analysis_v2_score_audit_candidates'
        );
        const scannerEnd = migration.indexOf('\n$$;', scannerStart);
        const scanner = migration.slice(scannerStart, scannerEnd);
        expect(scanner).toContain('reserved_expiry AS MATERIALIZED');
        expect(scanner).toContain('regular_retained AS MATERIALIZED');
        expect(scanner).toContain('regular_unretained AS MATERIALIZED');
        expect(scanner).toContain('retention_deadline_epoch >= params.scanned_epoch');
        expect(scanner.match(/LIMIT/g)).toHaveLength(4);
        expect(scanner).not.toMatch(
            /analysis_v2_result_summaries|analysis_v2_score_audit_runs|analysis_v2_score_audit_intents/
        );
        expect(scanner).toContain(
            'ORDER BY candidate.reserved DESC, candidate.sort_at, candidate.request_id'
        );
        expect(migration).toContain(
            'purge_expired_analysis_v2_score_audit_evidence'
        );
        expect(migration).toContain(
            'supported 500-request'
        );
        expect(migration).toMatch(
            /purge_expired_analysis_v2_score_audit_evidence\([\s\S]*?analysis_v2_score_audit_intents_expiry_idx|analysis_v2_score_audit_intents_expiry_idx[\s\S]*?purge_expired_analysis_v2_score_audit_evidence\(/
        );
        expect(migration).toContain(
            'LIMIT LEAST(GREATEST(p_limit, 1), 100)'
        );
        expect(migration).toContain('FOR UPDATE SKIP LOCKED');
        expect(migration).toContain('MIGRATION_PREDECESSOR=20260727031000');
    });

    it('expands only final public score inputs after completion, without media or provider payloads', () => {
        expect(migration).toContain("stage_kind = 'final_score'");
        expect(migration).toContain("'genderProvenance', 'unavailable'");
        expect(migration).toContain('account_context = \'official_group_or_brand\'');
        expect(migration).toContain("policy_versions_snapshot->>'aiStage'");
        expect(migration).toContain('analysis_v2_score_audit_expected_v24_components');
        expect(migration).toContain("LEAST((p_signals->>'candidateLikes')::NUMERIC * 6, 24)");
        expect(migration).toContain("LEAST((p_signals->>'candidateComments')::NUMERIC * 2.5, 30)");
        expect(migration).toContain("p_value->>'username' ~ '^[a-z0-9._]{1,30}$'");
        expect(migration).toContain('source_generation');
        expect(migration).toContain('SOURCE_EVIDENCE_EXPIRED');
        expect(migration).toContain("INTERVAL '5 minutes'");
        expect(migration).toContain('SAFE_SOURCE_PAYLOAD_TOO_LARGE');
        expect(migration).toContain('SOURCE_CAPTURE_FAILED');
        expect(migration).toContain(
            'intent.retain_until <= pg_catalog.clock_timestamp()'
        );
        expect(migration).toContain(
            'intent.retain_until > pg_catalog.clock_timestamp()'
        );
        expect(migration).not.toMatch(/full_name|\bbio\b|profile_image_url|normalized_jpeg|api[_ -]?token/i);
    });

    it('marks score drift inconsistent instead of changing a result', () => {
        expect(migration).toContain('EXACT_SCORE_POLICY_MISMATCH');
        expect(migration).toContain("CASE WHEN v_mismatch THEN 'inconsistent' ELSE 'ready' END");
        expect(migration).toMatch(
            /analysis_v2_expected_relative_risk_rows\([\s\S]*?'risk-policy-v2\.4'/
        );
        expect(migration).toContain('PUBLIC_CANDIDATE_COMPLETENESS_MISMATCH');
        expect(migration).toContain('UNSUPPORTED_SCORE_POLICY_VERSION');
        expect(migration).toContain(
            'result.sort_ordinal = expected.expected_sort_ordinal'
        );
        expect(migration).toContain(
            'expected.expected_band_rank <= 3'
        );
        expect(migration).toContain(
            'expected.expected_band_rank <= 10'
        );
    });
});
