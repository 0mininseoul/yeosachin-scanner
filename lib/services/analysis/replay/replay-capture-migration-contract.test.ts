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
        expect(sql).toContain('ANALYSIS_V2_REPLAY_CAPTURE_POLICY_MISMATCH');
        expect(sql).toContain('preflight.target_followers_count BETWEEN 0');
        expect(sql).toContain('preflight.target_following_count BETWEEN 0');
        expect(sql).toContain("p_object_key IS DISTINCT FROM ('replay/v1/' || p_capture_id::TEXT || '/' || p_opaque_locator_hash || '.enc')");
        expect(sql).toContain("v_existing.ciphertext_sha256 IS DISTINCT FROM p_ciphertext_sha256");
        expect(sql).toContain("replay/v1/");
        expect(sql).toContain("(state <> 'capturing') OR (request_id IS NOT NULL AND bound_at IS NOT NULL");
        expect(sql).toContain("(state <> 'sealed') OR (request_id IS NOT NULL AND bound_at IS NOT NULL");
        expect(sql).toContain('actual_fragment_count <= expected_fragment_count');
        expect(sql).toContain("cleanup_status = 'leased' AND cleanup_lease_token IS NOT NULL");
        expect(sql).toContain("expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours'");
        expect(sql).not.toMatch(/\b(username|bio|prompt|raw_evidence)\b/i);
    });
});
