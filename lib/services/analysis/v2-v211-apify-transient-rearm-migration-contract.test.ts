import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260808250000_rearm_v211_apify_transient_replay.sql',
), 'utf8');

describe('v2.11 Apify transient replay migration contract', () => {
    it('fences the exact corrected r8 terminal topology', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260808240000');
        expect(migration).toContain("|| '.r5'");
        expect(migration).toContain("|| '.r8'");
        expect(migration).toContain("|| '.r9'");
        expect(migration).toContain("track:profiles:batch:3");
        expect(migration).toContain('AND job.attempt_count = 2');
        expect(migration).toContain('AND 11 = (');
        expect(migration).toContain('AND 30 = (');
        expect(migration).toContain('AND 24 = (');
    });

    it('keeps failed evidence immutable and creates one fresh preflight', () => {
        expect(migration).toContain('earlybird_v211_apify_transient_replays');
        expect(migration).toContain(
            'prevent_earlybird_v211_apify_transient_replay_mutation',
        );
        expect(migration).toContain("v_base_preflight_key || '.r9'");
        expect(migration).not.toMatch(
            /UPDATE\s+public\.(?:analysis_requests|analysis_pipeline_jobs|analysis_v2_ai_attempts)/i,
        );
    });

    it('extends the existing adoption bridge without weakening its resolver', () => {
        expect(migration).toContain(
            'earlybird_v211_apify_transient_replay_ready',
        );
        expect(migration).toContain('d18925ec6a5df5621048330f6e9ab1cd');
        expect(migration).toContain(
            'source_preflight.admission_target_followers_count <= CASE',
        );
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_exact_recovery_provider_run',
        );
    });

    it('keeps helpers private and the rearm RPC service-role-only', () => {
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.rearm_earlybird_v211_apify_transient_replay',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_rearm, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_rearm, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_failure, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_replay, 'EXECUTE')",
        );
    });
});
