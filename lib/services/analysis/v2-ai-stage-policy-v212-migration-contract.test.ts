import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260902091000_add_vertex_ai_cost_policy_fences.sql',
    import.meta.url,
), 'utf8');

describe('v2.12 AI stage policy migration contract', () => {
    it('admits only v2.12 at the existing candidate, scheduler, and lease fences', () => {
        expect(migration).toContain('analysis_v2_candidate_feature_pre_feature_admission_check');
        expect(migration).toContain('analysis_v2_candidate_feature_classification_check');
        expect(migration).toContain('analysis_v2_checkpoint_candidate_features_complete');
        expect(migration).toContain('claim_analysis_v2_scheduler_operation');
        expect(migration).toContain('acquire_analysis_v2_scheduler_gemini_lease_v1');
        expect(migration).toContain("'ai-stage-policy-v2.12'");
        expect(migration).toContain('ANALYSIS_V2_V212_PREFEATURE_ADMISSION_CONTRACT_DRIFT');
        expect(migration).toContain('ANALYSIS_V2_V212_SCHEDULER_OPERATION_DRIFT');
        expect(migration).toContain('ANALYSIS_V2_V212_GEMINI_LEASE_DRIFT');
    });

    it('extends the inherited v2.11 summary repair only to v2.12', () => {
        expect(migration).toContain('analysis_v2_apply_v211_summary_tone');
        expect(migration).toContain(
            "'ai-stage-policy-v2.11', 'ai-stage-policy-v2.12'",
        );
        expect(migration).not.toContain('20260719190000_reconcile_stuck_groble_earlybird_order.sql');
    });
});
