import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727020000_add_analysis_v2_ai_scheduler_policy_snapshot.sql',
    import.meta.url
), 'utf8');

describe('analysis V2 AI scheduler policy snapshot migration contract', () => {
    it('keeps the policy validator fail-closed for the exact optional scheduler id', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)'
        );
        expect(migration).toContain("p_snapshot ? 'scheduler'");
        expect(migration).toContain("p_snapshot->>'scheduler' IS DISTINCT FROM 'ai-scheduler-v1'");
        expect(migration).toContain("p_snapshot - ARRAY['pipeline', 'risk', 'aiStage', 'scheduler'] <> '{}'::JSONB");
    });

    it('preserves the existing validator security boundary and grants', () => {
        expect(migration).toContain('SECURITY INVOKER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_valid_policy_versions_snapshot\(JSONB\)\s+FROM PUBLIC, anon, authenticated;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_policy_versions_snapshot\(JSONB\)\s+TO service_role;/
        );
    });
});
