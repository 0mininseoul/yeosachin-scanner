import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260816100000_first15_canary_gen3_quota_readiness.sql',
    import.meta.url,
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('first15 gen3 quota readiness migration contract', () => {
    it('extends only the exact gen3 quota no-provider-run fence', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260816090000');
        expect(migration).toContain('c49331a579150cfa30dc5d11822a5928');
        expect(migration).toContain('rearm.rearm_generation = 3');
        expect(migration).toContain('parent_rearm.rearm_generation = 2');
        expect(migration).toContain(
            "parent_rearm.source_failure_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'",
        );
        expect(migration).toContain(
            "rearm.source_failure_code = 'JOB_ATTEMPTS_EXHAUSTED'",
        );
        expect(migration).toContain(
            "receipt.failed_job_key = 'track:profile-ai:batch:2'",
        );
        expect(migration).toContain("rearm.source_credential_slot = 'quinary'");
        expect(migration).toContain("rearm.fallback_credential_slot = 'primary'");
        expect(migration).toContain('FIRST15_CANARY_GEN3_QUOTA_READINESS_OLD_SHAPE_MISMATCH');
        expect(migration).not.toContain('CREATE TABLE public.');
        expect(migration).not.toContain('CREATE FUNCTION public.');
        expect(migration).not.toContain('GRANT ');
        expect(migration).not.toContain('REVOKE ');
    });
});
