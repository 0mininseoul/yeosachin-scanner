import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../../supabase/migrations/20260727021000_add_analysis_v2_replay_capture_foundation.sql',
    import.meta.url,
);

describe('analysis V2 replay capture foundation migration', () => {
    it('uses forced RLS, closed table access, and narrowly granted definer RPCs', async () => {
        const sql = await readFile(migration, 'utf8');
        for (const table of [
            'analysis_v2_replay_capture_authorizations',
            'analysis_v2_replay_capture_fragments',
            'analysis_v2_replay_capture_audit_events',
        ]) {
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(sql).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated, service_role`));
        }
        for (const fn of ['arm_analysis_v2_replay_capture', 'bind_analysis_v2_replay_capture', 'register_analysis_v2_replay_capture_fragment']) {
            expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
            expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`));
            expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*TO service_role`));
        }
        expect(sql).toContain("SECURITY DEFINER");
        expect(sql).toContain("SET search_path = ''");
        expect(sql).toContain("preflight.status = 'ready'");
        expect(sql).toContain("analysis_request.status IN ('pending', 'processing')");
        expect(sql).toContain("analysis_request.selected_plan_id_snapshot = 'standard'");
        expect(sql).toContain("analysis_request.plan_access_mode_snapshot = 'production'");
        expect(sql).toContain('p_expected_policy_hash TEXT');
        expect(sql).toContain('p_expected_context_hash TEXT');
        expect(sql).toContain('ANALYSIS_V2_REPLAY_CAPTURE_POLICY_MISMATCH');
        expect(sql).toContain('ANALYSIS_V2_REPLAY_CAPTURE_CONTEXT_MISMATCH');
        expect(sql).toContain('owner_user_id UUID NOT NULL');
        expect(sql).toContain('target_handle_commitment VARCHAR(64) NOT NULL');
        expect(sql).toContain("scheduler_policy_version = 'ai-scheduler-v1'");
        expect(sql).toContain(
            "p_snapshot->>'risk' = 'risk-policy-v2.4'"
        );
        expect(sql).toContain(
            "p_snapshot->>'aiStage' = 'ai-stage-policy-v2.7'"
        );
        expect(sql).not.toContain("risk-policy-v2.3");
        expect(sql).toContain("ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']");
        expect(sql).toContain(
            "p_snapshot->>'scheduler' = 'ai-scheduler-v1'"
        );
        expect(sql).toContain(
            'public.analysis_v2_replay_capture_policy_is_exact('
        );
        expect(sql).toContain('preflight.target_followers_count BETWEEN 0');
        expect(sql).toContain('preflight.target_following_count BETWEEN 0');
        expect(sql).toContain('p_object_key IS DISTINCT FROM (');
        expect(sql).toContain("|| p_fragment_kind || pg_catalog.chr(10)");
        expect(sql).toContain("|| p_stage || pg_catalog.chr(10)");
        expect(sql).toContain("|| p_batch_ordinal::TEXT || pg_catalog.chr(10)");
        expect(sql).toContain("|| p_ordinal::TEXT");
        expect(sql).toContain('ciphertext_byte_size BETWEEN 1 AND 8388608');
        expect(sql).toContain('content_commitment VARCHAR(64) NOT NULL');
        expect(sql).toContain(
            'v_existing.content_commitment IS DISTINCT FROM p_content_commitment'
        );
        expect(sql).toContain("v_existing.ciphertext_sha256 IS DISTINCT FROM p_ciphertext_sha256");
        expect(sql).toContain("replay/v1/");
        expect(sql).toContain("(state <> 'capturing') OR (request_id IS NOT NULL AND bound_at IS NOT NULL");
        expect(sql).toContain("(state <> 'sealed') OR (request_id IS NOT NULL AND bound_at IS NOT NULL");
        expect(sql).toContain('actual_fragment_count <= expected_fragment_count');
        expect(sql).toContain("cleanup_status = 'leased' AND cleanup_lease_token IS NOT NULL");
        expect(sql).toContain(
            "write_lease_expires_at <= write_lease_acquired_at + INTERVAL '15 minutes'"
        );
        expect(sql).toContain(
            "cleanup_lease_expires_at <= cleanup_lease_acquired_at + INTERVAL '15 minutes'"
        );
        expect(sql).toContain(
            'cleanup_lease_acquired_at >= expires_at'
        );
        expect(sql).not.toContain(
            'cleanup_lease_expires_at <= expires_at'
        );
        expect(sql).toMatch(
            /bind_analysis_v2_replay_capture[\s\S]*?RETURNS TABLE \([\s\S]*?write_lease_token UUID,[\s\S]*?write_lease_expires_at TIMESTAMPTZ/
        );
        expect(sql).toContain(
            'v_capture.write_lease_token IS DISTINCT FROM p_write_lease_token'
        );
        expect(sql).toContain("expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours'");
        expect(sql).not.toMatch(/\b(username|bio|prompt|raw_evidence)\b/i);
    });
});
