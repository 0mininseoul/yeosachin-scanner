import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = readdirSync(migrationsUrl).find(name =>
    /^20260902.*ambiguous.*max.*charge.*repair.*\.sql$/.test(name)
);
const migration = migrationName
    ? readFileSync(new URL(migrationName, migrationsUrl), 'utf8')
    : '';

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

describe('retained anonymous preflight identity-drift max-charge repair migration', () => {
    it('is a forward-only additive migration after the latest applied migration', () => {
        expect(migrationName).toBeDefined();
        expect(migration).toContain('MIGRATION_PREDECESSOR=20260902091001');
        expect(migration).toContain('BEGIN;');
        expect(migration).toContain('COMMIT;');
        expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM public\.analysis_preflight_failures/i);
        expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?public\.analysis_preflight_failures/i);
    });

    it('adds a truthful terminal state that retains the maximum charge and no run id', () => {
        expect(migration).toContain("'resolved_identity_drift'");
        expect(migration).toContain("status IN (\n            'starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted',\n            'timed_out', 'resolved_no_run', 'resolved_identity_drift'\n        )");
        const state = migration.slice(
            migration.indexOf('ADD CONSTRAINT analysis_preflight_provider_run_state_check'),
            migration.indexOf('\n);', migration.indexOf('ADD CONSTRAINT analysis_preflight_provider_run_state_check'))
        );
        expect(state).toContain("status = 'resolved_identity_drift'");
        expect(state).toContain('run_id IS NULL');
        expect(state).toContain('actual_usage_usd = max_charge_usd');
        expect(state).toContain('usage_reconciled_at IS NOT NULL');
        expect(state).toContain('manual_resolution_evidence_hash ~');
    });

    it('lists only retained anonymous, expired, drifted candidates with no live lease', () => {
        const list = functionDefinition(
            'list_analysis_preflight_ambiguous_identity_drift_candidates'
        );
        expectInOrder(list, [
            "provider_run.status = 'starting'",
            'provider_run.run_id IS NULL',
            'preflight.user_id IS NULL',
            "preflight.provider_selector = 'anonymous_apify'",
            "preflight.status = 'expired'",
            'preflight.pii_scrubbed_at IS NOT NULL',
            'preflight.expires_at <= v_now - INTERVAL \'7 days\'',
            'preflight.target_input_hash IS NOT NULL',
            'provider_run.input_hash IS DISTINCT FROM preflight.target_input_hash',
            'provider_run.reserved_at <= v_now - INTERVAL \'7 days\'',
            'provider_run.updated_at <= v_now - INTERVAL \'7 days\'',
            'preflight.lease_expires_at <= v_now',
            'analysis_provider_admission_leases',
            'LIMIT p_limit',
        ]);
        expect(list).toContain("failure.error_code = 'INTERNAL_ERROR'");
        expect(list).not.toMatch(/target_instagram_id|target_full_name|target_bio|username|caption|comment|api_token|access_token|payload/i);
    });

    it('locks preflight then provider row and verifies every immutable candidate field', () => {
        const resolve = functionDefinition(
            'resolve_analysis_preflight_provider_run_identity_drift'
        );
        const preflightLock = resolve.indexOf('FROM public.analysis_preflights AS preflight');
        const runLock = resolve.indexOf(
            'FROM public.analysis_preflight_provider_runs AS provider_run'
        );
        expect(runLock).toBeGreaterThan(preflightLock);
        expect(resolve.slice(preflightLock, runLock)).toContain('FOR UPDATE');
        expect(resolve.slice(runLock)).toContain('FOR UPDATE');
        for (const identityCheck of [
            'v_run.operation_key IS DISTINCT FROM p_operation_key',
            'v_run.input_hash IS DISTINCT FROM p_input_hash',
            'v_run.logical_provider IS DISTINCT FROM p_logical_provider',
            'v_run.actor_id IS DISTINCT FROM p_actor_id',
            'v_run.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
            'v_run.reserved_at IS DISTINCT FROM p_reserved_at',
        ]) {
            expect(resolve).toContain(identityCheck);
        }
        expect(resolve).toContain('p_evidence_reference_hash');
        expect(resolve).toContain('preflight.target_input_hash');
        expect(resolve).toContain('preflight.expires_at <= v_now - INTERVAL \'7 days\'');
        expect(resolve).toContain('analysis_provider_admission_leases');
        expect(resolve).toContain("status IS DISTINCT FROM 'starting'");
    });

    it('writes max charge into the provider usage fields and one idempotent cost event', () => {
        const resolve = functionDefinition(
            'resolve_analysis_preflight_provider_run_identity_drift'
        );
        const event = functionDefinition(
            'record_analysis_preflight_identity_drift_cost_event'
        );
        expect(resolve).toContain("SET status = 'resolved_identity_drift'");
        expect(resolve).toContain('actual_usage_usd = v_run.max_charge_usd');
        expect(resolve).toContain('usage_reconciled_at = v_now');
        expect(resolve).toContain(
            'PERFORM public.record_analysis_preflight_identity_drift_cost_event'
        );
        expect(event).toContain("'provider_start_identity_drift'");
        expect(event).toContain("'resolved_identity_drift'");
        expect(event).toContain('actual_usage_usd = max_charge_usd');
        expect(event).toContain('ON CONFLICT (billing_identity_hash) DO NOTHING');
        expect(event).toContain('ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT');
        expect(event).toContain('extensions.digest');
        expect(event).toContain('pg_catalog.encode');
        expect(event).not.toContain('pg_catalog.sha256');
        expect(event).toContain('p_operation_key');
        expect(event).toContain('p_input_hash');
        expect(event).toContain('p_reserved_at');
    });

    it('is owner-only and keeps existing runtime no-run and purge paths fail-closed', () => {
        for (const name of [
            'list_analysis_preflight_ambiguous_identity_drift_candidates',
            'resolve_analysis_preflight_provider_run_identity_drift',
            'record_analysis_preflight_identity_drift_cost_event',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_analysis_preflight_ambiguous_identity_drift_candidates\(/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.resolve_analysis_preflight_provider_run_identity_drift\(/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_analysis_preflight_identity_drift_cost_event\(/
        );
        const oldResolve = functionDefinition('resolve_analysis_preflight_provider_run_no_run');
        expect(oldResolve).toContain('ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_DRIFT');
        expect(migration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights('
        );
        expect(migration).not.toMatch(
            /purge_expired_analysis_v2_preflights[\s\S]*resolved_identity_drift/
        );
    });
});
