import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../../supabase/migrations/20260727013000_expand_analysis_v2_replay_source_lineage.sql',
    import.meta.url,
);

describe('analysis V2 replay source lineage forward migration', () => {
    it('allows only the current Standard tuple and observed production Plus canary tuple', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('observed historical production Plus canary tuple');
        expect(sql).not.toContain('historical signed Plus');
        expect(sql).not.toContain('signed Plus E2E');
        expect(sql).toContain('not a Standard-to-Plus mapping');
        expect(sql).toContain('Standard-equivalent workload source');
        expect(sql).toContain('not Standard full-E2E evidence');
        expect(sql).toMatch(
            /selected_plan_id_snapshot = 'standard'[\s\S]*ai-stage-policy-v2\.7[\s\S]*risk-policy-v2\.3', 'risk-policy-v2\.4'/,
        );
        expect(sql).toMatch(
            /selected_plan_id_snapshot = 'plus'[\s\S]*ai-stage-policy-v2\.4[\s\S]*risk-policy-v2\.2/,
        );
        expect(sql).toContain("'selectedPlanId', v_request.selected_plan_id_snapshot");
        expect(sql).toContain("request.plan_access_mode_snapshot = 'production'");
        expect(sql).toContain("preflight.access_mode = 'production'");
        expect(sql).toContain('preflight.policy_versions_snapshot = v_request.policy_versions_snapshot');
        expect(sql).toContain("v_preflight.plan_cards_snapshot->'standard'");
        expect(sql).toContain("v_standard_card->>'launchStatus' <> 'production'");
        expect(sql).toContain('FROM public.analysis_v2_result_summaries AS summary');
        expect(sql).toContain('summary.public_mutuals <= v_standard_detailed_limit');
        expect(sql).toContain('summary.screened_mutuals <= v_standard_detailed_limit');
        expect(sql).toContain('ORDER BY run.operation_key');
        expect(sql).toContain('LIMIT 128');
        expect(sql).toContain('LIMIT 4');
        expect(sql).toContain('SECURITY DEFINER');
        expect(sql).toContain("SET search_path = ''");
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.read_analysis_v2_replay_capture_source');
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
        expect(sql).not.toContain('GRANT SELECT');
    });
});
