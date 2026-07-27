import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(
    process.cwd(),
    'supabase/migrations/20260727030000_add_analysis_v2_policy_snapshot_reader.sql',
), 'utf8');

describe('analysis V2 scheduler policy snapshot reader migration', () => {
    it('exposes only a validated V2 snapshot to the service-role worker', () => {
        expect(migration).toContain(
            'analysis_v2_scheduler_reader_valid_policy_snapshot_v1'
        );
        expect(migration).toContain("p_snapshot ? 'scheduler'");
        expect(migration).toContain(
            "p_snapshot->>'scheduler' IS DISTINCT FROM 'ai-scheduler-v1'"
        );
        expect(migration).toContain('pg_catalog.char_length(item.value #>>');
        expect(migration).toContain('> 128');
        expect(migration).toContain('analysis_v2_valid_scheduler_policy_snapshot_v1');
        expect(migration).toContain("p_snapshot->>'scheduler' = 'ai-scheduler-v1'");
        expect(migration).toContain('load_analysis_v2_policy_versions_snapshot');
        expect(migration).toContain("analysis_request.pipeline_version = 'v2'");
        expect(migration).not.toContain('analysis_v2_valid_policy_versions_snapshot_v2');
        expect(migration).not.toContain('analysis_v2_policy_validator_contract_version');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
        expect(migration).toMatch(/GRANT EXECUTE[\s\S]*TO service_role/);
    });
});
