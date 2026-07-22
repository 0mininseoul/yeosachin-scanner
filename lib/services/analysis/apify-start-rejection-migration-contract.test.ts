import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql',
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

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('definite Apify start rejection migration contract', () => {
    it('adds a zero-cost rejected state to both ledgers', () => {
        expect(migration).toContain('DROP CONSTRAINT analysis_v2_provider_run_status_check');
        expect(migration).toContain('DROP CONSTRAINT analysis_v2_provider_run_state_check');
        expect(migration).toContain('DROP CONSTRAINT analysis_preflight_provider_run_status_check');
        expect(migration).toContain('DROP CONSTRAINT analysis_preflight_provider_run_state_check');
        expect(migration).toContain("status IN ('starting', 'running', 'rejected'");
        expect(migration).toContain("status = 'rejected'");
        expect(migration).toContain('AND run_id IS NULL');
        expect(migration).toContain('AND run_started_at IS NULL');
        expect(migration).toContain('AND terminalized_at IS NOT NULL');
        expect(migration).toContain('AND actual_usage_usd = 0');
        expect(migration).toContain('AND usage_reconciled_at IS NOT NULL');
    });

    it('persists request rejection behind canonical locks and every immutable fence', () => {
        const reject = functionDefinition('reject_analysis_v2_provider_run_start');
        expectInOrder(reject, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_runs AS provider_run',
        ]);
        for (const check of [
            'v_run.job_claim_token IS DISTINCT FROM p_claim_token',
            'v_run.reservation_token IS DISTINCT FROM p_reservation_token',
            'v_run.input_hash IS DISTINCT FROM p_input_hash',
            'v_run.logical_provider IS DISTINCT FROM p_logical_provider',
            'v_run.actor_id IS DISTINCT FROM p_actor_id',
            'v_run.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
        ]) {
            expect(reject).toContain(check);
        }
        expect(reject).toContain("IF v_run.status = 'rejected' THEN");
        expect(reject).toContain("v_run.status IS DISTINCT FROM 'starting'");
        expect(reject).toContain("SET status = 'rejected'");
        expect(reject).toContain('actual_usage_usd = 0');
        expect(reject).toContain('usage_reconciled_at = v_now');
    });

    it('supports initial and generation-fenced fresh preflight rejection', () => {
        const initial = functionDefinition('reject_analysis_preflight_provider_run_start');
        const fresh = functionDefinition(
            'reject_analysis_v2_fresh_admission_provider_run_start'
        );
        expect(initial).toContain("v_operation_key TEXT := 'target-profile-fallback'");
        expect(initial).toContain("v_preflight.status IS DISTINCT FROM 'processing'");
        expect(initial).toContain('v_preflight.lease_token IS DISTINCT FROM p_claim_token');
        expect(fresh).toContain(
            "v_operation_key := 'target-profile-fresh-admission:g'"
        );
        expect(fresh).toContain('v_preflight.admission_generation IS DISTINCT FROM');
        expect(fresh).toContain(
            'v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token'
        );
        for (const body of [initial, fresh]) {
            expect(body).toContain('FOR UPDATE');
            expect(body).toContain('v_run.input_hash IS DISTINCT FROM p_input_hash');
            expect(body).toContain('v_run.credential_slot IS DISTINCT FROM p_credential_slot');
            expect(body).toContain('v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd');
            expect(body).toContain("IF v_run.status = 'rejected' THEN");
            expect(body).toContain("SET status = 'rejected'");
            expect(body).toContain(
                'PERFORM public.record_analysis_preflight_provider_start_rejected_cost_event'
            );
        }
    });

    it('records one hashed long-lived zero-cost rejection event', () => {
        const helper = functionDefinition(
            'record_analysis_preflight_provider_start_rejected_cost_event'
        );
        expect(migration).toContain("'provider_start_rejected'");
        expect(migration).toContain("terminal_status = 'rejected'");
        expect(migration).toContain('max_charge_usd = 0');
        expect(migration).toContain('actual_usage_usd = 0');
        expect(migration).toContain('evidence_reference_hash IS NULL');
        expect(helper).toContain("'provider_start_rejected:v1:'");
        expect(helper).toContain('pg_catalog.sha256');
        expect(helper).toContain('p_preflight_id::TEXT');
        expect(helper).toContain('p_operation_key');
        expect(helper).toContain('ON CONFLICT (billing_identity_hash) DO NOTHING');
        expect(helper).toContain("v_event.event_kind IS DISTINCT FROM 'provider_start_rejected'");
        expect(helper).not.toMatch(
            /p_(?:status_code|error_type|error_message|provider_message)|payload|username|caption|comment|api_token/i
        );
    });

    it('keeps internal helpers private and exposes rejection RPCs only to service_role', () => {
        const publicRpcs = [
            'reject_analysis_v2_provider_run_start',
            'reject_analysis_preflight_provider_run_start',
            'reject_analysis_v2_fresh_admission_provider_run_start',
        ];
        for (const name of publicRpcs) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role`
            ));
        }
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.record_analysis_preflight_provider_start_rejected_cost_event\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_analysis_preflight_provider_start_rejected_cost_event/
        );
    });

    it('lets reconciled rejection pass retention without storing provider error text', () => {
        const purge = functionDefinition('purge_expired_analysis_v2_preflights');
        expect(purge).toContain("'rejected'");
        expect(purge).toContain('provider_run.actual_usage_usd IS NULL');
        expect(purge).toContain('provider_run.usage_reconciled_at IS NULL');
        expect(migration).not.toMatch(
            /ADD COLUMN\s+(?:status_code|error_type|error_message|provider_message)/i
        );
        expect(migration).not.toMatch(/suppressed in production|usage-limit-exceeded/i);
    });
});
