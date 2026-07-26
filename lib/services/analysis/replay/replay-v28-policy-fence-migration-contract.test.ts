import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../../supabase/migrations/20260727033000_fence_replay_capture_to_ai_stage_v28.sql',
    import.meta.url,
);

describe('analysis V2 replay v2.8 policy fence migration', () => {
    it('arms only the exact four-key v2.8 capture policy and keeps source reads service-only', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain("p_snapshot->>'aiStage' = 'ai-stage-policy-v2.8'");
        expect(sql).toContain("p_snapshot->>'risk' = 'risk-policy-v2.4'");
        expect(sql).toContain("p_snapshot->>'scheduler' = 'ai-scheduler-v1'");
        expect(sql).toContain("p_snapshot - ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']");
        expect(sql).not.toContain("p_snapshot->>'aiStage' = 'ai-stage-policy-v2.7'");
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.analysis_v2_replay_capture_policy_is_exact[\s\S]*anon, authenticated, service_role/);
        expect(sql).toContain('"ai-stage-policy-v2.7"');
        expect(sql).toContain('"ai-stage-policy-v2.8"');
        expect(sql).toContain("request.selected_plan_id_snapshot = 'standard'");
        expect(sql).toContain("request.plan_access_mode_snapshot = 'production'");
        expect(sql).toContain("preflight.access_mode = 'production'");
        expect(sql).toContain('preflight.policy_versions_snapshot = v_request.policy_versions_snapshot');
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.read_analysis_v2_replay_capture_source');
        expect(sql).toContain('TO service_role');
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
    });
});
