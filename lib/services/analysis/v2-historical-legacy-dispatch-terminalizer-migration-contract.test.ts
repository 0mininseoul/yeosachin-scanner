import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260904000000_analysis_v2_historical_legacy_dispatch_terminalizer.sql',
    import.meta.url
);

function migrationSource(): string {
    expect(existsSync(migrationPath), 'the historical terminalizer migration must exist').toBe(true);
    return readFileSync(migrationPath, 'utf8');
}

function functionDefinition(source: string, name: string): string {
    const start = source.search(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`));
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('V2 historical legacy-dispatch terminalizer migration contract', () => {
    it('is additive, ordered after the conservative max-charge repair, and provider-free', () => {
        const migration = migrationSource();
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260903020000');
        expect(migration).toContain('BEGIN;');
        expect(migration).toContain('COMMIT;');
        expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b/i);
        expect(migration).not.toMatch(/\bTRUNCATE\b/i);
        expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(migration).not.toMatch(/payment_pending/i);
        expect(migration).not.toMatch(/\b(?:fetch|http|apify-client|scraper)\b/i);
        expect(migration).not.toMatch(/INNER JOIN public\.analysis_v2_provider_runs/i);
        expect(migration).not.toMatch(/v_provider_count/);
        expect(migration).not.toMatch(/provider_count/);
        expect(migration).not.toMatch(/UPDATE\s+public\.(analysis_requests|analysis_v2_provider_runs|analysis_revenue_cost_operations|analysis_provider_admission_leases|analysis_v2_ai_attempts|analysis_v2_gemini_leases|analysis_v2_scheduler_operations|vertex_ai_budget_reservations)/i);
        expect(migration).toContain('UPDATE public.analysis_pipeline_jobs AS job');
        expect(migration).toContain('analysis_v2_historical_legacy_dispatch_terminalization_receipts');
    });

    it('defines a PII-free immutable receipt and owner-only ACLs', () => {
        const migration = migrationSource();
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('FORCE ROW LEVEL SECURITY');
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.analysis_v2_historical_legacy_dispatch_terminalization_receipts[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/);
        expect(migration).toContain('analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability');
        expect(migration).toContain('TG_OP <> \'INSERT\'');
        expect(migration).not.toMatch(/username|caption|comment_text|profile_url|provider_payload/i);
        for (const rpc of [
            'list_analysis_v2_historical_legacy_dispatch_candidates',
            'resolve_analysis_v2_historical_legacy_dispatch',
        ]) {
            const definition = functionDefinition(migration, rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\(`));
            expect(migration).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`));
        }
    });

    it('requires every exact historical safety gate before allowing terminalization', () => {
        const migration = migrationSource();
        const list = functionDefinition(migration, 'list_analysis_v2_historical_legacy_dispatch_candidates');
        const resolve = functionDefinition(migration, 'resolve_analysis_v2_historical_legacy_dispatch');
        const body = `${list}\n${resolve}`;
        for (const fragment of [
            "pipeline_version = 'v2'",
            "request.status = 'failed'",
            "job.dispatch_state = 'delivered'",
            'job.dispatch_workload_role IS NULL',
            'job.dispatch_contract_version IS NULL',
            'job.claim_workload_role IS NULL',
            'job.claim_contract_version IS NULL',
            "job.status IN ('pending', 'processing')",
            'job.lease_expires_at <= v_now',
            'job.lease_token IS NULL',
            "provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')",
            "provider_run.status = 'rejected'",
            'provider_run.actual_usage_usd IS NOT DISTINCT FROM 0',
            'provider_run.run_id IS NULL',
            'provider_run.terminalized_at IS NOT NULL',
            'provider_run.actual_usage_usd IS NOT NULL',
            'provider_run.usage_reconciled_at IS NOT NULL',
            "manual_resolution_kind = 'conservative_max_charge'",
            'manual_resolution_evidence_hash',
            "state IN ('leased', 'recovery_required')",
            "attempt.status = 'reserved'",
            "lease.state = 'leased'",
            "reservation.state = 'reserved'",
            "child.status IN ('reserved', 'started', 'ambiguous')",
            'cleanup.completed_at IS NULL',
            "operation.status = 'claimed'",
            "job.updated_at <= v_now - INTERVAL '7 days'",
            'NOT EXISTS (',
        ]) {
            expect(body, `missing hard gate: ${fragment}`).toContain(fragment);
        }
        expect(resolve).toContain('FOR UPDATE');
        expect(resolve).toContain('p_prior_status');
        expect(resolve).toContain('p_prior_lease_token');
        expect(resolve).toContain('p_prior_lease_expires_at');
        expect(resolve).toContain('p_audit_evidence_hash');
        expect(resolve).toContain('HISTORICAL_LEGACY_DISPATCH_TERMINALIZED');
    });

    it('only clears stale job leases and preserves dispatch/provenance columns', () => {
        const migration = migrationSource();
        const resolve = functionDefinition(migration, 'resolve_analysis_v2_historical_legacy_dispatch');
        expect(resolve).toContain('lease_token = NULL');
        expect(resolve).toContain('lease_expires_at = NULL');
        expect(resolve).toContain('completed_at = v_now');
        expect(resolve).toContain('last_error_code =');
        expect(resolve).toContain('last_error_at = v_now');
        expect(resolve).not.toMatch(/\bdispatch_state\s*=/i);
        expect(resolve).not.toMatch(/\bdispatch_generation\s*=/i);
        expect(resolve).not.toMatch(/\bdispatch_reservation_token\s*=/i);
        expect(resolve).not.toMatch(/\bdispatch_task_name\s*=/i);
        expect(resolve).not.toMatch(/\bdelivered_at\s*=/i);
        expect(resolve).not.toMatch(/UPDATE\s+public\.(analysis_requests|analysis_v2_provider_runs|analysis_revenue_cost_operations)/i);
        expect(resolve).toContain('INSERT INTO public.analysis_v2_historical_legacy_dispatch_terminalization_receipts');
    });
});
