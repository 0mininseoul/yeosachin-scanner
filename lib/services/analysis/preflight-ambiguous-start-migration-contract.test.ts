import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714175411_add_preflight_apify_provider_run_ledger.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('preflight ambiguous Apify start manual resolution migration', () => {
    it('models a zero-cost terminal-like no-run state with hashed evidence only', () => {
        expect(migration).toContain("'resolved_no_run'");
        expect(migration).toContain('manual_resolution_evidence_hash VARCHAR(64)');
        expect(migration).toContain('manual_resolved_at TIMESTAMP WITH TIME ZONE');
        expect(migration).toContain("manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'");
        expect(migration).toContain("status = 'resolved_no_run'");
        expect(migration).toContain('AND run_id IS NULL');
        expect(migration).toContain('AND actual_usage_usd = 0');
        expect(migration).toContain('AND usage_reconciled_at IS NOT NULL');
        expect(migration).toContain('AND manual_resolved_at IS NOT NULL');
    });

    it('lists only a bounded PII-free candidate page after a 30-minute quiet period', () => {
        const list = functionDefinition(
            'list_analysis_preflight_ambiguous_start_candidates'
        );

        expect(list).toContain('p_limit NOT BETWEEN 1 AND 100');
        expect(list).toContain("provider_run.status = 'starting'");
        expect(list).toContain('provider_run.run_id IS NULL');
        expect(list).toContain("provider_run.reserved_at <= v_now - INTERVAL '30 minutes'");
        expect(list).toContain("provider_run.updated_at <= v_now - INTERVAL '30 minutes'");
        expect(list).toContain('preflight.expires_at <= v_now');
        expect(list).toContain('preflight.lease_expires_at <= v_now');
        expect(list).toContain('LIMIT p_limit');
        expect(list).not.toMatch(/target_instagram_id|username|api_token|access_token|payload/i);
    });

    it('row-locks and verifies the complete immutable identity before resolution', () => {
        const resolve = functionDefinition(
            'resolve_analysis_preflight_provider_run_no_run'
        );
        const preflightLock = resolve.indexOf('FROM public.analysis_preflights AS preflight');
        const runLock = resolve.indexOf(
            'FROM public.analysis_preflight_provider_runs AS provider_run'
        );

        expect(preflightLock).toBeGreaterThanOrEqual(0);
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
        expect(resolve).toContain("v_run.status IS DISTINCT FROM 'starting'");
        expect(resolve).toContain('ANALYSIS_PREFLIGHT_AMBIGUOUS_START_NOT_READY');
    });

    it('is idempotent only for the exact evidence and writes a long-lived zero-cost event', () => {
        const resolve = functionDefinition(
            'resolve_analysis_preflight_provider_run_no_run'
        );
        const eventHelper = functionDefinition(
            'record_analysis_preflight_manual_no_run_cost_event'
        );

        expect(resolve).toContain("IF v_run.status = 'resolved_no_run' THEN");
        expect(resolve).toContain(
            'v_run.manual_resolution_evidence_hash\n                IS DISTINCT FROM p_evidence_reference_hash'
        );
        expect(resolve).toContain("SET status = 'resolved_no_run'");
        expect(resolve).toContain('actual_usage_usd = 0');
        expect(resolve).toContain('terminalized_at = v_now');
        expect(resolve).toContain('usage_reconciled_at = v_now');
        expect(resolve).toContain('manual_resolved_at = v_now');
        expect(resolve).toContain(
            'PERFORM public.record_analysis_preflight_manual_no_run_cost_event'
        );

        expect(eventHelper).toContain("'manual_no_run:' || p_preflight_id::TEXT || ':'");
        expect(eventHelper).toContain('pg_catalog.sha256');
        expect(eventHelper).toContain("'manual_no_run'");
        expect(eventHelper).toContain("'resolved_no_run'");
        expect(eventHelper).toContain('p_evidence_reference_hash');
        expect(eventHelper).toContain("p_logical_provider IS DISTINCT FROM 'apify'");
        expect(eventHelper).toContain(
            "p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'"
        );
        expect(eventHelper).toContain(
            'public.analysis_v2_valid_apify_credential_slot(p_credential_slot)'
        );
        expect(eventHelper).toContain(
            'v_event.credential_slot IS DISTINCT FROM p_credential_slot'
        );
        expect(eventHelper).not.toContain('INSERT INTO public.analysis_preflights');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.record_analysis_preflight_manual_no_run_cost_event\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_analysis_preflight_manual_no_run_cost_event/
        );
    });

    it('keeps listing service-only and resolution database-owner-only', () => {
        for (const name of [
            'list_analysis_preflight_ambiguous_start_candidates',
            'resolve_analysis_preflight_provider_run_no_run',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_analysis_preflight_ambiguous_start_candidates\([\s\S]*?TO service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.resolve_analysis_preflight_provider_run_no_run\(/
        );

        for (const relativePath of [
            './preflight.ts',
            './preflight-retention.ts',
            './preflight-provider-run.ts',
        ]) {
            const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
            expect(source).not.toContain('resolve_analysis_preflight_provider_run_no_run');
        }

        const operatorCli = readFileSync(
            new URL('../../../scripts/resolve-preflight-ambiguous-apify-start.ts', import.meta.url),
            'utf8'
        );
        expect(operatorCli).not.toMatch(
            /rpc\(\s*['"]resolve_analysis_preflight_provider_run_no_run/
        );
        expect(operatorCli).toContain('Database-owner-only statement');
    });

    it('releases the purge fence only for the fully reconciled manual state', () => {
        const purge = functionDefinition('purge_expired_analysis_v2_preflights');
        expect(purge).toContain("'resolved_no_run'");
        expect(purge).toContain('provider_run.actual_usage_usd IS NULL');
        expect(purge).toContain('provider_run.usage_reconciled_at IS NULL');
    });
});
