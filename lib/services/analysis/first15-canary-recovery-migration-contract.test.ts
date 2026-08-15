import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260815170000_rearm_first15_canary_provider_failures.sql',
    import.meta.url,
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const generationTwoMigrationPath = new URL(
    '../../../supabase/migrations/20260815220000_first15_canary_existing_route_generation_two.sql',
    import.meta.url,
);
const generationTwoMigration = existsSync(generationTwoMigrationPath)
    ? readFileSync(generationTwoMigrationPath, 'utf8')
    : '';
const generationTwoCreatorMigrationPath = new URL(
    '../../../supabase/migrations/20260815225000_first15_canary_gen2_creator_successor_source_request.sql',
    import.meta.url,
);
const generationTwoCreatorMigration = existsSync(generationTwoCreatorMigrationPath)
    ? readFileSync(generationTwoCreatorMigrationPath, 'utf8')
    : '';

describe('first15 terminal provider-canary recovery migration contract', () => {
    it('creates one service-role-only audited replay lineage after the copy-quality migration', () => {
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260815160000');
        expect(migration).toContain('CREATE TABLE public.earlybird_first15_canary_provider_rearms');
        expect(migration).toContain('CREATE FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()');
        expect(migration).toContain('CREATE FUNCTION public.rearm_earlybird_first15_canary_provider_failure(');
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toContain('TO service_role');
        expect(migration).toContain("'SCRAPING_INCOMPLETE_ERROR'");
        expect(migration).toContain("'SCRAPING_PROVIDER_QUOTA_ERROR'");
        expect(migration).toContain("'SCRAPING_PROVIDER_START_REJECTED_ERROR'");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_earlybird_first15_canary_provider_recovery_candidates\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
    });

    it('preserves the fresh-profile checkpoint and only authorizes the documented ordered fallback slots', () => {
        expect(migration).toContain('load_analysis_v2_reusable_target_profile_run_first15');
        expect(migration).toContain('resolve_analysis_v2_recovery_provider_run_first15');
        expect(migration).toContain("('senary', 'tertiary')");
        expect(migration).toContain("('tertiary', 'quinary')");
        expect(migration).toContain("('quinary', 'primary')");
        expect(migration).toContain("('primary', 'secondary')");
        expect(migration).toContain('allowRelationshipIncompleteReplacement');
        expect(migration).not.toContain('UPDATE public.analysis_results');
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_provider_runs');
    });

    it('continues only the recorded terminal successors through the existing route contract', () => {
        expect(generationTwoMigration).toContain('-- MIGRATION_PREDECESSOR=20260815210000');
        expect(generationTwoMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()',
        );
        expect(generationTwoMigration).toContain('parent.source_failure_code AS error_code');
        expect(generationTwoMigration).toContain("request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'");
        expect(generationTwoMigration).toContain("request.error_message = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'");
        expect(generationTwoMigration).toContain("receipt.failed_job_key = 'track:relationships:collect'");
        expect(generationTwoMigration).toContain("receipt.failed_job_key = 'track:target-evidence:collect'");
        expect(generationTwoMigration).toContain("receipt.failed_job_key = 'track:profile-ai:batch:2'");
        expect(generationTwoMigration).toContain("p_fallback_credential_slot = 'quinary'");
        expect(generationTwoMigration).toContain('FIRST15_CANARY_GEN2_REARM_OLD_SHAPE_MISMATCH');
        expect(generationTwoMigration).toContain('usage_reconciled_at IS NULL');
        expect(generationTwoMigration).not.toContain('CREATE TABLE public.');
        expect(generationTwoMigration).not.toContain('list_analysis_v2_unreconciled_provider_runs');
        expect(generationTwoMigration).not.toContain('GRANT SELECT ON TABLE public.analysis_v2_provider_runs');
    });

    it('passes only the exact generation-two successor request into the existing readiness fence', () => {
        expect(generationTwoCreatorMigration).toContain('-- MIGRATION_PREDECESSOR=20260815220000');
        expect(generationTwoCreatorMigration).toContain('cc8435f6fc8ee4184e99434005c529d8');
        expect(generationTwoCreatorMigration).toContain(
            'v_first15_rearm_failed_request_id UUID;',
        );
        expect(generationTwoCreatorMigration).toContain(
            'rearm.order_id = v_order.id',
        );
        expect(generationTwoCreatorMigration).toContain(
            'rearm.rearmed_preflight_id = v_preflight.id',
        );
        expect(generationTwoCreatorMigration).toContain('rearm.rearm_generation = 2');
        expect(generationTwoCreatorMigration).toContain('FOR KEY SHARE;');
        expect(generationTwoCreatorMigration).toContain(
            'COALESCE(\n                    v_first15_rearm_failed_request_id,\n                    v_conflicting_request.id\n                )',
        );
        expect(generationTwoCreatorMigration).toContain(
            'public.earlybird_first15_canary_provider_rearm_request_ready(',
        );
        expect(generationTwoCreatorMigration).not.toContain('CREATE TABLE public.');
        expect(generationTwoCreatorMigration).not.toContain('CREATE FUNCTION public.');
        expect(generationTwoCreatorMigration).not.toContain('GRANT EXECUTE');
    });
});
