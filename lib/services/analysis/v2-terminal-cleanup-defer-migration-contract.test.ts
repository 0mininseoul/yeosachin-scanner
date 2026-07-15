import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260715175739_defer_analysis_v2_terminal_cleanup.sql';
const migration = readFileSync(new URL(migrationName, migrationsUrl), 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const current = source.indexOf(fragment, previous + 1);
        expect(current, `missing or out-of-order fragment: ${fragment}`)
            .toBeGreaterThan(previous);
        previous = current;
    }
}

describe('analysis V2 terminal cleanup defer migration contract', () => {
    it('runs after the collection-context dependency migration', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf('20260715103605_expose_v2_access_mode_to_collection_context.sql'))
            .toBeLessThan(names.indexOf(migrationName));
    });

    it('locks the canonical scope and requires an active exact live claim', () => {
        const defer = functionDefinition('defer_analysis_v2_terminal_cleanup');
        expectInOrder(defer, [
            'FROM public.analysis_preflights AS preflight',
            'FOR UPDATE',
            'FROM public.analysis_requests AS analysis_request',
            'FOR UPDATE',
            'FROM public.analysis_pipeline_jobs AS job',
            'FOR UPDATE',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            'FOR UPDATE',
        ]);
        for (const guard of [
            "v_request.pipeline_version <> 'v2'",
            "v_request.status NOT IN ('pending', 'processing')",
            "v_job.status <> 'processing'",
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
            'v_intent.completed_at IS NOT NULL',
        ]) {
            expect(defer).toContain(guard);
        }
    });

    it('permits owner and sibling claims while preserving handler attempts', () => {
        const defer = functionDefinition('defer_analysis_v2_terminal_cleanup');
        expect(defer).not.toContain('v_intent.failed_job_key');
        expect(defer).not.toContain('v_intent.failed_claim_token');
        expectInOrder(defer, [
            "SET status = 'pending'",
            'lease_token = NULL',
            'lease_expires_at = NULL',
            "last_error_code = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED'",
            'RETURN QUERY SELECT',
            'TRUE, v_job.status::TEXT, v_job.attempt_count',
        ]);
        expect(defer).not.toMatch(/SET[\s\S]*?attempt_count\s*=/);
        expect(defer).not.toContain('p_max_attempts');
        expect(defer).not.toContain('fail_analysis_v2_request_from_job');
    });

    it('is PII-free and executable only by the service role', () => {
        const defer = functionDefinition('defer_analysis_v2_terminal_cleanup');
        expect(defer).not.toMatch(
            /username|instagram|caption|comment|profile_url|post_url|api_token|secret/i
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.defer_analysis_v2_terminal_cleanup\(\s*UUID, TEXT, UUID\s*\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.defer_analysis_v2_terminal_cleanup\(\s*UUID, TEXT, UUID\s*\)[\s\S]*?TO service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.defer_analysis_v2_terminal_cleanup\(\s*UUID, TEXT, UUID\s*\)[\s\S]*?TO (?:PUBLIC|anon|authenticated)/
        );
    });
});
