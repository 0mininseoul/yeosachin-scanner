import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260716162523_harden_analysis_v2_ai_unavailable_replay_policy.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 unavailable, replay, and policy migration contract', () => {
    it('separates fetch and AI-response unavailability through finalization', () => {
        expect(migration).toContain('unavailable_reason VARCHAR(16)');
        expect(migration).toContain("unavailable_reason IN ('profile_fetch', 'ai_response')");
        expect(migration).toContain('analysis_unavailable_count SMALLINT');

        const finalizer = functionDefinition('complete_analysis_v2_result_and_purge');
        expect(finalizer).toContain("feature.unavailable_reason = 'profile_fetch'");
        expect(finalizer).toContain("outcome.status <> 'success'");
        expect(finalizer).toContain("feature.unavailable_reason = 'ai_response'");
        expect(finalizer).toContain("outcome.status = 'success'");
        expect(finalizer).toContain("rich_outcome.value->>'status' = 'analysis_unavailable'");
        expect(finalizer).toContain("feature.terminal_classification = 'unavailable'");
        expect(finalizer).toContain("feature.unavailable_reason = 'profile_fetch'");
        expect(finalizer).toContain("feature.unavailable_reason = 'ai_response'");

        const summary = functionDefinition('analysis_v2_result_summary_json');
        expect(summary).toContain("'analysisUnavailableMutuals'");
        expect(summary).toContain('p_summary.analysis_unavailable_count');
        expect(summary).toContain(
            '- p_summary.fetch_unavailable_count - p_summary.media_unavailable_count\n'
            + '            - p_summary.analysis_unavailable_count'
        );
    });

    it('adds a distinct durable response-rejected attempt state', () => {
        expect(migration).toContain("'response_rejected'");
        expect(migration).toContain(
            "'p_status NOT IN (''success'', ''rate_limited'', ''ambiguous'', ''rejected'', ''response_rejected'')'"
        );
        expect(migration).toContain(
            "public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)"
        );
        for (const routine of [
            'checkpoint_analysis_v2_private_names',
            'checkpoint_analysis_v2_narratives',
            'analysis_v2_result_partner_safety_row_matches',
        ]) {
            expect(migration).toContain(`public.${routine}(`);
        }
        expect(migration).toContain("ai_attempt.status = ''response_rejected''");
    });

    it('loads only the bounded request AI-stage policy version for service workers', () => {
        const loader = functionDefinition('load_analysis_v2_ai_stage_policy_version');
        expect(loader).toContain("policy_versions_snapshot->>'aiStage'");
        expect(loader).toContain("pipeline_version = 'v2'");
        expect(loader).toContain('SECURITY DEFINER');
        expect(loader).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_ai_stage_policy_version\(UUID\)\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_ai_stage_policy_version\(UUID\)\s+TO service_role;/
        );
    });
});
