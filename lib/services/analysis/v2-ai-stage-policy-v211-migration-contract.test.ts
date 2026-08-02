import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260803123000_add_ai_stage_policy_v211_quality.sql',
    import.meta.url,
), 'utf8');

describe('v2.11 AI stage policy migration contract', () => {
    it('adds v2.11 only at the exact live scheduler and checkpoint fences', () => {
        expect(migration).toContain("'ai-stage-policy-v2.10'', ''ai-stage-policy-v2.11'");
        expect(migration).toContain('ANALYSIS_V2_V211_PREFEATURE_CHECKPOINT_DRIFT');
        expect(migration).toContain('ANALYSIS_V2_V211_SCHEDULER_OPERATION_DRIFT');
        expect(migration).toContain('ANALYSIS_V2_V211_GEMINI_LEASE_DRIFT');
        expect(migration).toContain("'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.11'");
        expect(migration).toContain("'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11'");
    });

    it('keeps historical requests immutable and scopes the new overview repair to v2.11', () => {
        expect(migration).not.toMatch(/UPDATE\s+public\.analysis_requests/i);
        expect(migration).toContain("request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'");
        expect(migration).toContain('analysis_v2_apply_v211_summary_tone');
        expect(migration).toContain('analysis_v2_v211_safe_overview_fallback');
        expect(migration).toContain('ANALYSIS_V2_V211_FINALIZER_WRAPPER_DRIFT');
    });
});
