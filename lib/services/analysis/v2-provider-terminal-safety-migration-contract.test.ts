import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = '20260714011500_add_analysis_v2_provider_terminal_safety.sql';
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
        expect(current, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = current;
    }
}

describe('analysis V2 provider terminal-safety migration contract', () => {
    it('runs after the expanded credential and result-boundary migrations', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf('20260713204500_expand_analysis_v2_apify_credential_slots.sql'))
            .toBeLessThan(names.indexOf(migrationName));
        expect(names.indexOf('20260713213000_harden_analysis_v2_result_runtime_boundary.sql'))
            .toBeLessThan(names.indexOf(migrationName));
    });

    it('stores a PII-free, RPC-only cleanup intent behind the exact live job fence', () => {
        const table = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_provider_cleanup_intents ('),
            migration.indexOf('\n);', migration.indexOf(
                'CREATE TABLE public.analysis_v2_provider_cleanup_intents ('
            ))
        );
        expect(table).not.toMatch(/username|caption|comment|post_url|profile_url|api_token/i);
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_provider_cleanup_intents FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_provider_cleanup_intents[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_provider_cleanup_intents/
        );

        const request = functionDefinition('request_analysis_v2_provider_run_cleanup');
        expectInOrder(request, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
        ]);
        expect(request).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(request).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
        expect(request).toContain('SET failed_claim_token = p_claim_token');
        expect(request).not.toContain('DELETE FROM public.analysis_v2_provider_runs');

        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        expectInOrder(reserve, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            'public.analysis_v2_reserve_provider_run_internal(',
        ]);
        expect(reserve).toContain('intent.completed_at IS NULL');
        expect(migration).toContain(
            ') RENAME TO analysis_v2_reserve_provider_run_internal;'
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_reserve_provider_run_internal/
        );
    });

    it('reports unconfirmed starts without inventing run IDs and lists only confirmed running IDs', () => {
        const list = functionDefinition(
            'list_analysis_v2_active_provider_runs_for_cleanup'
        );
        expect(list).toContain("provider_run.status = 'starting'");
        expect(list).toContain(
            'LEFT JOIN public.analysis_v2_unconfirmed_start_resolutions AS resolution'
        );
        expect(list).toContain('resolution.reservation_token IS NULL');
        expect(list).toContain("provider_run.status = 'running'");
        expect(list).toContain("'startingCount', v_starting_count");
        expect(list).toContain('public.analysis_v2_provider_run_json(candidate)');
        expect(list).toContain('intent.completed_at IS NULL');
        expect(list).toContain('LIMIT p_limit');
        expect(list).not.toMatch(/api_token|secret|job_claim_token/i);
    });

    it('keeps manual ambiguous-start resolution owner-only, identity-fenced, and usage-unknown', () => {
        const tableStart = migration.indexOf(
            'CREATE TABLE public.analysis_v2_unconfirmed_start_resolutions ('
        );
        const tableEnd = migration.indexOf('\n);', tableStart);
        const table = migration.slice(tableStart, tableEnd);
        for (const field of [
            'reservation_token', 'request_id', 'job_key', 'operation_key',
            'input_hash', 'logical_provider', 'actor_id', 'credential_slot',
            'max_charge_usd', 'audit_reason', 'audit_reference', 'audited_by',
            'database_actor',
            'confirmed_at',
        ]) {
            expect(table).toContain(field);
        }
        expect(table).not.toContain('actual_usage_usd');
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_unconfirmed_start_resolutions[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_unconfirmed_start_resolutions/
        );
        const trigger = functionDefinition(
            'analysis_v2_validate_unconfirmed_start_resolution'
        );
        expect(trigger).toContain("v_run.status <> 'starting'");
        expect(trigger).toContain('v_run.run_id IS NOT NULL');
        expect(trigger).toContain('NEW.database_actor := SESSION_USER');
        expect(trigger).toContain('NEW.confirmed_at := pg_catalog.clock_timestamp()');
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_validate_unconfirmed_start_resolution/
        );
    });

    it('seals only an exact confirmed run and preserves eventual usage reconciliation', () => {
        const settle = functionDefinition(
            'settle_analysis_v2_provider_run_for_cleanup'
        );
        for (const comparison of [
            'v_run.run_id IS DISTINCT FROM p_run_id',
            'v_run.logical_provider IS DISTINCT FROM p_logical_provider',
            'v_run.actor_id IS DISTINCT FROM p_actor_id',
            'v_run.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
        ]) {
            expect(settle).toContain(comparison);
        }
        expect(settle).toContain(
            "'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'"
        );
        expect(settle).toContain("v_run.status <> 'running'");
        expect(settle).toContain('p_actual_usage_usd > v_run.max_charge_usd');
        expect(settle).toContain('usage_reconciled_at = CASE');
        expect(settle).not.toContain('job_claim_token');
        expect(settle).not.toContain('lease_token');
    });

    it('blocks both terminal purges while any provider row is active', () => {
        const success = functionDefinition('complete_analysis_v2_result_and_purge');
        expectInOrder(success, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            "provider_run.status IN ('starting', 'running')",
            'public.analysis_v2_complete_result_and_purge_internal(',
        ]);

        const failure = functionDefinition('fail_analysis_v2_result_and_purge');
        expectInOrder(failure, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_cleanup_intents AS intent',
            "provider_run.status = 'running'",
            'public.analysis_v2_unconfirmed_start_resolutions AS resolution',
            'public.analysis_v2_fail_result_and_purge_internal(',
        ]);
        expect(migration).toContain(
            ') RENAME TO analysis_v2_fail_result_and_purge_internal;'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_fail_result_and_purge_internal\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_fail_result_and_purge_internal/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.fail_analysis_v2_result_and_purge\([\s\S]*?TO service_role/
        );
    });
});
