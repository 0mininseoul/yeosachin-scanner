import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260714031500_harden_analysis_v2_terminal_invariants.sql';
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

describe('analysis V2 terminal-invariant hardening migration', () => {
    it('runs after every V2 lifecycle, heartbeat, and fresh-admission migration', () => {
        const names = readdirSync(migrationsUrl).sort();
        for (const dependency of [
            '20260714011500_add_analysis_v2_provider_terminal_safety.sql',
            '20260714024500_add_analysis_v2_active_profile_heartbeats.sql',
            '20260714030000_add_analysis_v2_fresh_admission_gate.sql',
        ]) {
            expect(names.indexOf(dependency)).toBeLessThan(names.indexOf(migrationName));
        }
    });

    it('turns an exhausted crash into a live cleanup claim before handler execution', () => {
        const claim = functionDefinition('claim_analysis_v2_job');
        const exhausted = claim.slice(claim.indexOf(
            'IF v_job.attempt_count >= p_max_attempts THEN'
        ));

        expectInOrder(exhausted, [
            "SET status = 'processing'",
            'lease_token = p_claim_token',
            "last_error_code = 'JOB_ATTEMPTS_EXHAUSTED'",
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            'SET failed_claim_token = p_claim_token',
            'INSERT INTO public.analysis_v2_provider_cleanup_intents',
            'RETURN QUERY SELECT',
            'TRUE, v_job.status::TEXT',
        ]);
        expect(exhausted).not.toContain('fail_analysis_v2_request_from_job');
        expect(exhausted).not.toContain('analysis_v2_purge_result_working_set');
        expect(exhausted).not.toContain(
            "v_intent.error_code IS DISTINCT FROM 'JOB_ATTEMPTS_EXHAUSTED'"
        );
    });

    it('keeps release retry-only and fails closed for every terminal branch', () => {
        const release = functionDefinition('release_analysis_v2_job_claim');
        expectInOrder(release, [
            'IF NOT p_retryable OR v_job.attempt_count >= p_max_attempts THEN',
            "MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_CLEANUP_REQUIRED'",
            "SET status = 'pending'",
        ]);
        expect(release).not.toContain('fail_analysis_v2_request_from_job');
        expect(release).not.toContain("SET status = 'failed'");
    });

    it('revokes the obsolete finalizer and gates the central failure helper', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_analysis_v2_request\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_analysis_v2_request/
        );

        const fail = functionDefinition('fail_analysis_v2_request_from_job');
        expectInOrder(fail, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            'v_intent.failed_job_input_hash IS DISTINCT FROM v_job.input_hash',
            'v_intent.failed_claim_token IS DISTINCT FROM v_job.lease_token',
            "provider_run.status = 'running'",
            "provider_run.status = 'starting'",
            'public.analysis_v2_unconfirmed_start_resolutions AS resolution',
            "SET status = 'failed'",
        ]);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.fail_analysis_v2_request_from_job\(UUID, TEXT, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
    });

    it('keeps every request-wide V1 mutation away from V2 rows', () => {
        for (const name of [
            'acquire_analysis_request_lease',
            'release_analysis_request_lease',
            'complete_analysis_request_and_purge_staging',
            'fail_analysis_request_and_purge_staging',
        ]) {
            expect(functionDefinition(name)).toContain(
                "analysis_request.pipeline_version IS DISTINCT FROM 'v2'"
            );
        }

        const staleTrigger = functionDefinition('reject_concurrent_analysis_request');
        expect(staleTrigger).not.toContain('fail_analysis_request_and_purge_staging');
        expect(staleTrigger).not.toMatch(/UPDATE public\.analysis_requests|DELETE FROM/);
    });

    it('purges terminal heartbeats atomically and lets the live claim replace future skew', () => {
        const trigger = functionDefinition(
            'analysis_v2_purge_terminal_active_profile_heartbeat'
        );
        expect(trigger).toContain("NEW.status IN ('completed', 'failed', 'cancelled')");
        expect(trigger).toContain(
            'DELETE FROM public.analysis_v2_active_profile_heartbeats'
        );
        expect(migration).toContain(
            'CREATE TRIGGER analysis_v2_active_profile_terminal_purge'
        );
        expect(migration).toMatch(
            /DELETE FROM public\.analysis_v2_active_profile_heartbeats AS heartbeat[\s\S]*?job\.status IN \('completed', 'failed', 'cancelled'\)[\s\S]*?analysis_request\.status IN \('completed', 'failed'\)/
        );

        const checkpoint = functionDefinition(
            'checkpoint_analysis_v2_active_profile_heartbeat'
        );
        expectInOrder(checkpoint, [
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_expected_total IS DISTINCT FROM p_total_count',
            'ON CONFLICT (request_id, job_key) DO UPDATE',
            'completed_count = CASE',
            'WHERE EXCLUDED.claim_token',
            'IS DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token',
            'AND EXCLUDED.started_at',
        ]);
    });

    it('requires a locked active request and a 30-minute quiescent manual audit', () => {
        const resolution = functionDefinition(
            'analysis_v2_validate_unconfirmed_start_resolution'
        );
        expectInOrder(resolution, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            'FROM public.analysis_v2_provider_runs AS provider_run',
        ]);
        for (const guard of [
            "v_request.status NOT IN ('pending', 'processing')",
            "v_intent.completed_at IS NOT NULL",
            "v_failed_job.status <> 'processing'",
            'v_failed_job.lease_token IS DISTINCT FROM v_intent.failed_claim_token',
            "v_quiet_before := v_now - INTERVAL '30 minutes'",
            'v_failed_job.lease_expires_at > v_quiet_before',
            'v_intent.requested_at > v_quiet_before',
            'v_run.updated_at > v_quiet_before',
            "live_job.status = 'processing'",
        ]) {
            expect(resolution).toContain(guard);
        }
    });

    it('rotates PII-free usage reconciliation with bounded backoff', () => {
        const columns = migration.slice(
            migration.indexOf('ADD COLUMN usage_reconciliation_attempt_count'),
            migration.indexOf(
                'CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs'
            )
        );
        expect(columns).not.toMatch(
            /username|caption|profile_url|post_url|api_token|secret/i
        );

        const list = functionDefinition(
            'list_analysis_v2_unreconciled_provider_runs'
        );
        for (const guard of [
            'usage_reconciliation_attempted_at IS NULL',
            'usage_reconciliation_attempt_count',
            '3600',
            'NULLS FIRST',
            'FOR UPDATE SKIP LOCKED',
            'usage_reconciliation_attempted_at = v_now',
        ]) {
            expect(list).toContain(guard);
        }
        expect(list).toContain('public.analysis_v2_provider_run_json(candidate)');
        expect(list).not.toMatch(/username|caption|api_token|secret/i);
    });
});
