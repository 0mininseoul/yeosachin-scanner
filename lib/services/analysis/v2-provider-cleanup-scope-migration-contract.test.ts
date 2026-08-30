import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260830103000_scope_analysis_v2_provider_cleanup.sql',
    import.meta.url,
), 'utf8');

function functionDefinition(name: string): string {
    const start = Math.max(
        migration.indexOf(`CREATE FUNCTION public.${name}(`),
        migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`),
    );
    expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('provider cleanup scope migration contract', () => {
    it('leaves request-wide provider terminal safety owned by the prior migration', () => {
        expect(migration).not.toMatch(
            /ALTER FUNCTION public\.(reserve_analysis_v2_provider_run|list_analysis_v2_active_provider_runs_for_cleanup|settle_analysis_v2_provider_run_for_cleanup)/,
        );
        expect(migration).not.toContain('analysis_v2_reserve_provider_run_internal');
        expect(migration).not.toContain('provider_run.input_hash');
        expect(migration).not.toContain('v_run.input_hash');
    });

    it('fences the exact job reader to analysis_pipeline_jobs.input_hash', () => {
        const reader = functionDefinition('load_analysis_v2_provider_run_cleanup_intent_for_job');
        expect(reader).toContain('JOIN public.analysis_pipeline_jobs AS failed_job');
        expect(reader).toContain('failed_job.job_key = intent.failed_job_key');
        expect(reader).toContain('failed_job.input_hash = intent.failed_job_input_hash');
        expect(reader).toContain('failed_job.input_hash = p_job_input_hash');
        expect(reader).toContain('intent.failed_job_key = p_job_key');
        expect(reader).toContain('intent.completed_at IS NULL');
    });

    it('provides a privacy-safe exact job/input reader without adding tables', () => {
        const reader = functionDefinition('load_analysis_v2_provider_run_cleanup_intent_for_job');
        expect(reader).toContain("'errorCode', intent.error_code");
        expect(reader).not.toMatch(/target|username|bio|caption|token/i);
        expect(migration).not.toMatch(/CREATE\s+TABLE/i);
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job');
    });
});
