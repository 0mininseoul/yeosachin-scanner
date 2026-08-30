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
    it('keeps reservation admission fenced to the exact failed job', () => {
        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        expect(reserve).toMatch(
            /intent\.request_id = p_request_id\s+AND intent\.failed_job_key = p_job_key\s+AND intent\.failed_job_input_hash = p_input_hash\s+AND intent\.completed_at IS NULL/
        );
        expect(reserve).toContain('analysis_v2_reserve_provider_run_internal');
        expect(migration).toContain(
            'RENAME TO reserve_analysis_v2_provider_run_unscoped_cleanup'
        );
    });

    it('lists and settles only provider rows owned by the exact cleanup job', () => {
        const list = functionDefinition('list_analysis_v2_active_provider_runs_for_cleanup');
        const settle = functionDefinition('settle_analysis_v2_provider_run_for_cleanup');
        expect(list).toContain('intent.failed_job_key = provider_run.job_key');
        expect(list).toContain('intent.failed_job_input_hash = provider_run.input_hash');
        expect(settle).toContain('intent.failed_job_key = v_run.job_key');
        expect(settle).toContain('intent.failed_job_input_hash = v_run.input_hash');
        expect(settle).toContain('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY');
        expect(migration).toContain(
            'RENAME TO list_analysis_v2_active_provider_runs_for_cleanup_unscoped'
        );
        expect(migration).toContain(
            'RENAME TO settle_analysis_v2_provider_run_for_cleanup_unscoped'
        );
    });

    it('provides a privacy-safe exact job/input reader without adding tables', () => {
        const reader = functionDefinition('load_analysis_v2_provider_run_cleanup_intent_for_job');
        expect(reader).toContain('intent.failed_job_key = p_job_key');
        expect(reader).toContain('intent.failed_job_input_hash = p_job_input_hash');
        expect(reader).toContain("'errorCode', intent.error_code");
        expect(reader).not.toMatch(/target|username|bio|caption|token/i);
        expect(migration).not.toMatch(/CREATE\s+TABLE/i);
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job');
    });
});
