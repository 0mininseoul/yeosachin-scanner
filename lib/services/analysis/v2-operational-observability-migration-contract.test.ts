import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260714033000_add_analysis_v2_operational_observability.sql';
const migration = readFileSync(new URL(migrationName, migrationsUrl), 'utf8');

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function tableDefinition(name: string): string {
    const start = migration.indexOf(`CREATE TABLE public.${name} (`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end, `${name} must have a bounded definition`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('analysis V2 operational observability migration', () => {
    it('runs after terminal invariant hardening', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf('20260714031500_harden_analysis_v2_terminal_invariants.sql'))
            .toBeLessThan(names.indexOf(migrationName));
    });

    it('persists profile counters independently from the purged profile working set', () => {
        const table = tableDefinition('analysis_v2_profile_fetch_telemetry');
        expect(table).toContain('REFERENCES public.analysis_requests(id) ON DELETE CASCADE');
        expect(table).not.toMatch(
            /REFERENCES public\.analysis_v2_profile_fetch_(?:batches|outcomes)/
        );
        for (const column of [
            'source VARCHAR(16)',
            'status VARCHAR(16)',
            'failure_category VARCHAR(32)',
            'http_status SMALLINT',
            'outcome_count SMALLINT',
            'request_count_total INTEGER',
            'latency_ms_total BIGINT',
            'latency_ms_max INTEGER',
        ]) {
            expect(table).toContain(column);
        }
        expect(migration).toContain(
            'AFTER INSERT ON public.analysis_v2_profile_fetch_outcomes'
        );
        expect(migration).toContain(
            "WHEN NEW.attempt = 'fallback' THEN 'fallback'"
        );
        const capture = functionDefinition(
            'capture_analysis_v2_profile_fetch_telemetry'
        );
        expect(capture).toContain('NEW.failure_category');
        expect(capture).toContain('NEW.http_status');
        expect(capture).not.toMatch(/username|profile_snapshot/i);
        expect(table).toContain("job_key = 'track:target-evidence:collect'");
        expect(table).toContain("job_key ~ '^track:profiles:batch:[0-9]+$'");
        expect(table).toContain("status = 'success'");
        expect(table).toContain('AND failure_category IS NULL');
        expect(table).toContain('AND http_status IS NULL');
        expect(table).toContain("failure_category IN ('not_found', 'empty_user')");
        expect(table).toContain('http_status BETWEEN 400 AND 599');
        expect(migration).toContain(
            'request_id, job_key, source, status, failure_category_key, http_status_key'
        );
    });

    it('captures only plan and numeric coverage independently from result rows', () => {
        const table = tableDefinition('analysis_v2_result_coverage_telemetry');
        expect(table).toContain('REFERENCES public.analysis_requests(id) ON DELETE CASCADE');
        expect(table).not.toContain('REFERENCES public.analysis_v2_result_summaries');
        expect(table).not.toMatch(
            /instagram|username|image|bio|narrative|hash|captured_at|created_at|updated_at/i
        );

        const capture = functionDefinition(
            'capture_analysis_v2_result_coverage_telemetry'
        );
        expect(capture).toContain('NEW.plan_id');
        expect(capture).toContain('NEW.followers_declared');
        expect(capture).not.toMatch(
            /target_instagram|profile_image|finalizer_input|instagram_id|bio|narrative/i
        );
        expect(migration).toContain(
            'AFTER INSERT ON public.analysis_v2_result_summaries'
        );
    });

    it('keeps telemetry tables and trigger functions inaccessible directly', () => {
        for (const table of [
            'analysis_v2_profile_fetch_telemetry',
            'analysis_v2_result_coverage_telemetry',
        ]) {
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT [^;]+ ON TABLE public\\.${table}`
            ));
        }
        for (const fn of [
            'capture_analysis_v2_profile_fetch_telemetry',
            'capture_analysis_v2_result_coverage_telemetry',
        ]) {
            const body = functionDefinition(fn);
            expect(body).toContain('SECURITY DEFINER');
            expect(body).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
    });

    it('returns actual, conservative, and Gemini costs while excluding GCP infrastructure', () => {
        const rpc = functionDefinition('load_analysis_v2_operational_observability');
        expect(rpc).toContain('FROM public.analysis_v2_provider_runs');
        expect(rpc).toContain('provider_run.actual_usage_usd');
        expect(rpc).toContain('provider_run.max_charge_usd');
        expect(rpc).toContain('FROM public.analysis_v2_ai_attempts');
        expect(rpc).toContain('ai_attempt.estimated_cost_usd');
        expect(rpc).toContain("'providerActualUsd'");
        expect(rpc).toContain("'providerConservativeUsd'");
        expect(rpc).toContain("'geminiEstimatedUsd'");
        expect(rpc).toContain("'gcpInfrastructureIncluded', FALSE");
    });

    it('reports unsettled ledgers, preserved coverage, source outcomes, and bounded job timing', () => {
        const rpc = functionDefinition('load_analysis_v2_operational_observability');
        for (const fragment of [
            "provider_run.status IN ('starting', 'running')",
            'provider_run.actual_usage_usd IS NULL',
            "ai_attempt.status = 'reserved'",
            'ai_attempt.usage_complete IS DISTINCT FROM TRUE',
            'FROM public.analysis_v2_profile_fetch_telemetry',
            'FROM public.analysis_v2_result_coverage_telemetry',
            'FROM public.analysis_pipeline_jobs',
            "'attemptCount', job.attempt_count",
            "'durationMs'",
            "'lastErrorCode', job.last_error_code",
            "'failureCategory', telemetry.failure_category",
            "'httpStatus', telemetry.http_status",
            "'wallTimeMs', GREATEST(0",
            "'queueDelayMs', CASE",
            "'processingTimeMs', CASE",
            ') - v_request.created_at',
            'job_rollup.first_started_at - v_request.created_at',
        ]) {
            expect(rpc).toContain(fragment);
        }
    });

    it('exposes no raw identity, prompt, evidence, provider-run, or fence fields', () => {
        const rpc = functionDefinition('load_analysis_v2_operational_observability');
        expect(rpc).not.toMatch(
            /target_instagram_id|excluded_instagram_id|username|profile_snapshot|profile_image|bio|caption|prompt_version|result_json|evidence_(?:json|payload)|interaction_evidence|operation_key|input_hash|actor_id|credential_slot|run_id|claim_token|reservation_token|dispatch_task_name|required_job_keys/i
        );
        expect(rpc).toContain('ANALYSIS_V2_OBSERVABILITY_UNSAFE_JOB');
        expect(rpc).toContain("job.job_key !~ '^(coordinator:");
    });

    it('grants only the strict SECURITY DEFINER RPC to service_role', () => {
        const rpc = functionDefinition('load_analysis_v2_operational_observability');
        expect(rpc).toContain('SECURITY DEFINER');
        expect(rpc).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_operational_observability\(UUID\)\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_operational_observability\(UUID\)\s+TO service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_operational_observability\(UUID\)[\s\S]*?TO (?:anon|authenticated|PUBLIC)/
        );
    });
});
