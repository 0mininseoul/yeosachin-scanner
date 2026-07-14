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

function tableDefinition(): string {
    const start = migration.indexOf('CREATE TABLE public.analysis_preflight_provider_runs (');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function acquisitionCostTableDefinition(): string {
    const start = migration.indexOf(
        'CREATE TABLE public.analysis_preflight_acquisition_cost_events ('
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('preflight Apify provider-run migration contract', () => {
    it('keeps a cascade-owned, PII-free ledger behind forced RLS', () => {
        const table = tableDefinition();

        expect(table).toContain(
            'REFERENCES public.analysis_preflights(id) ON DELETE CASCADE'
        );
        expect(table).not.toMatch(
            /\b(username|instagram_id|message|api_token|access_token|payload|JSONB)\b/i
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_preflight_provider_runs ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_preflight_provider_runs FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_preflight_provider_runs\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_preflight_provider_runs/
        );
        expect(migration).not.toContain('CREATE POLICY');
    });

    it('stores only the fixed paid operation identity and a SHA-256 target identity', () => {
        const table = tableDefinition();

        expect(table).toContain("operation_key TEXT NOT NULL DEFAULT 'target-profile-fallback'");
        expect(table).toContain("operation_key = 'target-profile-fallback'");
        expect(table).toContain("logical_provider TEXT NOT NULL DEFAULT 'apify'");
        expect(table).toContain("logical_provider = 'apify'");
        expect(table).toContain(
            "actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper'"
        );
        expect(table).toContain("actor_id = 'apify/instagram-profile-scraper'");
        expect(table).toContain("input_hash ~ '^[0-9a-f]{64}$'");
        expect(table).toContain('max_charge_usd = 0.002600000000');
        expect(table).toContain(
            'public.analysis_v2_valid_apify_credential_slot(credential_slot)'
        );
    });

    it('fences load, reserve, started, and terminal RPCs with a live preflight claim', () => {
        for (const rpc of [
            'load_analysis_preflight_provider_run',
            'reserve_analysis_preflight_provider_run',
            'checkpoint_analysis_preflight_provider_run_started',
            'checkpoint_analysis_preflight_provider_run_terminal',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain("v_preflight.status <> 'processing'");
            expect(definition).toContain(
                'v_preflight.lease_token IS DISTINCT FROM p_claim_token'
            );
            expect(definition).toContain('v_preflight.lease_expires_at <= v_now');
            expect(definition).toContain('v_preflight.expires_at <= v_now');
            expect(definition).toContain(
                "MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH'"
            );
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
    });

    it('commits one immutable intent before a caller may start an Actor', () => {
        const reserve = functionDefinition('reserve_analysis_preflight_provider_run');

        for (const identityCheck of [
            "v_existing.operation_key IS DISTINCT FROM 'target-profile-fallback'",
            'v_existing.input_hash IS DISTINCT FROM p_input_hash',
            "v_existing.logical_provider IS DISTINCT FROM 'apify'",
            "v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'",
            'v_existing.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
        ]) {
            expect(reserve).toContain(identityCheck);
        }
        expect(reserve).toContain(
            "MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT'"
        );
        expect(reserve.indexOf("'created', FALSE")).toBeLessThan(
            reserve.indexOf('INSERT INTO public.analysis_preflight_provider_runs')
        );
        expect(reserve.indexOf('INSERT INTO public.analysis_preflight_provider_runs')).toBeLessThan(
            reserve.indexOf("'created', TRUE")
        );
    });

    it('fails closed on an ambiguous starting replay instead of replacing the intent', () => {
        const table = tableDefinition();
        const reserve = functionDefinition('reserve_analysis_preflight_provider_run');

        expect(table).toContain('preflight_id UUID PRIMARY KEY');
        expect(table).toContain("status TEXT NOT NULL DEFAULT 'starting'");
        expect(table).toContain("status = 'starting'");
        expect(table).toContain('AND run_id IS NULL');
        expect(reserve).toContain("'created', FALSE");
        expect(reserve).not.toContain('ON CONFLICT');
        expect(reserve).not.toContain('DELETE FROM');
        expect(migration).not.toContain('DELETE FROM public.analysis_preflight_provider_runs');
    });

    it('retains one run ID through terminal replay and supports optional actual cost', () => {
        const started = functionDefinition(
            'checkpoint_analysis_preflight_provider_run_started'
        );
        const terminal = functionDefinition(
            'checkpoint_analysis_preflight_provider_run_terminal'
        );

        expect(started).toContain("SET status = 'running'");
        expect(started).toContain('run_id = p_run_id');
        expect(terminal).toContain('v_run.run_id IS DISTINCT FROM p_run_id');
        expect(terminal).toContain("SET status = p_status");
        expect(terminal).not.toContain('run_id = NULL');
        expect(terminal).toContain(
            'p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL'
        );
        expect(terminal).toContain(
            'v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd'
        );
    });

    it('reconciles bounded PII-free stale running and terminal identities', () => {
        const table = tableDefinition();
        const list = functionDefinition(
            'list_analysis_preflight_unreconciled_provider_runs'
        );
        const reconcile = functionDefinition(
            'reconcile_analysis_preflight_provider_run_usage'
        );

        expect(table).toContain('usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0');
        expect(table).toContain('usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE');
        expect(list).toContain("provider_run.status = 'running'");
        expect(list).toContain(
            "provider_run.run_started_at <= v_now - INTERVAL '30 seconds'"
        );
        expect(list).toContain("provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'");
        expect(list).toContain('FOR UPDATE SKIP LOCKED');
        expect(list).toContain('LIMIT p_limit');
        expect(list).toContain('usage_reconciliation_attempt_count + 1');
        expect(list).not.toMatch(/username|api_token|access_token|payload/i);

        for (const identityCheck of [
            'v_run.input_hash IS DISTINCT FROM p_input_hash',
            'v_run.run_id IS DISTINCT FROM p_run_id',
            'v_run.logical_provider IS DISTINCT FROM p_logical_provider',
            'v_run.actor_id IS DISTINCT FROM p_actor_id',
            'v_run.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
            'v_run.status IS DISTINCT FROM p_status',
        ]) {
            expect(reconcile).toContain(identityCheck);
        }
        expect(reconcile).toContain("p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'");
        expect(reconcile).toContain('public.analysis_v2_valid_apify_credential_slot');
        expect(reconcile).toContain('p_max_charge_usd IS DISTINCT FROM 0.002600000000');
        expect(reconcile).toContain("v_run.terminalized_at > v_now - INTERVAL '30 seconds'");
        expect(reconcile).toContain("IF v_run.status = 'running' THEN");
        expect(reconcile).toContain('SET status = p_status');
        expect(reconcile).toContain('p_provider_finished_at TIMESTAMP WITH TIME ZONE');
        expect(reconcile).toContain('pg_catalog.statement_timestamp()');
        expect(reconcile).toContain(
            "p_provider_finished_at > v_now - INTERVAL '30 seconds'"
        );
        expect(reconcile).toContain('p_provider_finished_at < v_run.run_started_at');
        expect(reconcile).toContain('terminalized_at = p_provider_finished_at');
        expect(reconcile).toContain(
            "(p_provider_finished_at AT TIME ZONE 'UTC')::DATE"
        );
        expect(reconcile).toContain('usage_reconciled_at = v_now');
        expect(reconcile).toContain('p_actual_usage_usd > v_run.max_charge_usd');
        expect(reconcile).toContain('SECURITY DEFINER');
        expect(reconcile).toContain("SET search_path = ''");

        for (const rpc of [
            'list_analysis_preflight_unreconciled_provider_runs',
            'reconcile_analysis_preflight_provider_run_usage',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
    });

    it('prevents retention from cascade-deleting an unreconciled paid run', () => {
        const purge = functionDefinition('purge_expired_analysis_v2_preflights');

        expect(purge).toContain('NOT EXISTS (');
        expect(purge).toContain(
            'FROM public.analysis_preflight_provider_runs AS provider_run'
        );
        expect(purge).toContain('provider_run.actual_usage_usd IS NULL');
        expect(purge).toContain('provider_run.usage_reconciled_at IS NULL');
        expect(purge.indexOf('NOT EXISTS (')).toBeLessThan(
            purge.indexOf('DELETE FROM public.analysis_preflights')
        );
    });

    it('keeps long-lived acquisition cost events PII-free and outside parent cascade', () => {
        const table = acquisitionCostTableDefinition();

        expect(table).toContain('billing_identity_hash VARCHAR(64) PRIMARY KEY');
        expect(table).toContain("event_kind IN ('provider_run', 'manual_no_run')");
        expect(table).toContain("event_kind = 'provider_run'");
        expect(table).toContain("event_kind = 'manual_no_run'");
        expect(table).not.toMatch(
            /\b(preflight_id|user_id|username|instagram_id|input_hash|run_id|message|token|payload)\b/i
        );
        expect(table).not.toContain('REFERENCES public.analysis_preflights');
        expect(migration).toContain(
            'ALTER TABLE public.analysis_preflight_acquisition_cost_events FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_preflight_acquisition_cost_events\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_preflight_acquisition_cost_events/
        );
    });

    it('records provider cost exactly once by domain-separated run hash in the ledger transaction', () => {
        const helper = functionDefinition(
            'record_analysis_preflight_provider_cost_event'
        );
        const checkpoint = functionDefinition(
            'checkpoint_analysis_preflight_provider_run_terminal'
        );
        const reconcile = functionDefinition(
            'reconcile_analysis_preflight_provider_run_usage'
        );

        expect(helper).toContain("'provider_run:' || p_run_id");
        expect(helper).toContain('pg_catalog.sha256');
        expect(helper).toContain('ON CONFLICT (billing_identity_hash) DO NOTHING');
        for (const comparison of [
            'v_event.event_kind IS DISTINCT FROM',
            'v_event.logical_provider IS DISTINCT FROM',
            'v_event.actor_id IS DISTINCT FROM',
            'v_event.credential_slot IS DISTINCT FROM',
            'v_event.terminal_status IS DISTINCT FROM',
            'v_event.max_charge_usd IS DISTINCT FROM',
            'v_event.actual_usage_usd IS DISTINCT FROM',
            'v_event.event_date IS DISTINCT FROM',
        ]) {
            expect(helper).toContain(comparison);
        }
        expect(helper).toContain('ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT');
        expect(checkpoint).toContain(
            'PERFORM public.record_analysis_preflight_provider_cost_event'
        );
        expect(reconcile).toContain(
            'PERFORM public.record_analysis_preflight_provider_cost_event'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.record_analysis_preflight_provider_cost_event\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_analysis_preflight_provider_cost_event/
        );
    });

    it('exposes only a bounded service-role period acquisition aggregate', () => {
        const aggregate = functionDefinition(
            'aggregate_analysis_preflight_acquisition_costs'
        );

        expect(aggregate).toContain('p_end_date_exclusive > p_start_date + 3660');
        expect(aggregate).toContain('pg_catalog.sum(event.actual_usage_usd)');
        expect(aggregate).toContain('pg_catalog.count(*)::INTEGER');
        expect(aggregate).toContain('provider_run.actual_usage_usd IS NULL');
        expect(aggregate).toContain("'unsettledRows'");
        expect(aggregate).toContain("'unsettledMaximumChargeUsd'");
        expect(aggregate).toContain("'hasUnsettled'");
        expect(aggregate).toContain("'isComplete'");
        expect(aggregate).toContain('LIMIT 30');
        expect(aggregate).toContain('LANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER');
        expect(aggregate).not.toContain('VOLATILE');
        expect(aggregate).not.toMatch(/preflight_id|user_id|input_hash|run_id/i);
        expect(aggregate).toContain('SECURITY DEFINER');
        expect(aggregate).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.aggregate_analysis_preflight_acquisition_costs\(DATE, DATE\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.aggregate_analysis_preflight_acquisition_costs\(DATE, DATE\)\s+TO service_role/
        );
    });

    it('does not expose the row serializer directly', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_preflight_provider_run_json\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_preflight_provider_run_json/
        );
    });
});
