import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260903020000_add_analysis_v2_conservative_max_charge_resolution.sql',
    import.meta.url
);

function migrationSource(): string {
    expect(existsSync(migrationPath), 'the V2 migration must exist').toBe(true);
    return readFileSync(migrationPath, 'utf8');
}

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('V2 provider missing max-charge repair migration contract', () => {
    it('documents the post-preflight predecessor and keeps the migration additive', () => {
        const migration = migrationSource();
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260902100000');
        expect(migration).toContain('20260902100000_ambiguous_max_charge_identity_drift_repair.sql');
        expect(migration).toContain('BEGIN;');
        expect(migration).toContain('COMMIT;');
        expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b/i);
        expect(migration).not.toMatch(/\bTRUNCATE\b/i);
        expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(migration).not.toMatch(/payment_pending/i);
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.analysis_v2_provider_run_json');
        expect(migration).not.toContain('ADD COLUMN IF NOT EXISTS');
    });

    it('stores explicit immutable conservative-resolution metadata without changing provider truth', () => {
        const migration = migrationSource();
        for (const column of [
            'manual_resolution_kind',
            'manual_resolution_evidence_hash',
            'manual_resolved_at',
        ]) {
            expect(migration).toContain(`ADD COLUMN ${column}`);
        }
        expect(migration).toContain("manual_resolution_kind = 'conservative_max_charge'");
        expect(migration).toContain("manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'");
        expect(migration).toContain('actual_usage_usd = max_charge_usd');
        expect(migration).toContain("status = 'succeeded'");
        expect(migration).toContain("logical_provider = 'apify'");
        expect(migration).toContain("credential_slot = 'tertiary'");
        expect(migration).toContain('run_id IS NOT NULL');
        expect(migration).toContain('run_started_at IS NOT NULL');
        expect(migration).toContain('terminalized_at IS NOT NULL');
        expect(migration).toContain('usage_reconciled_at IS NOT NULL');
        expect(migration).toContain('manual_resolved_at = usage_reconciled_at');
        expect(migration).toContain('analysis_v2_provider_run_manual_resolution_immutability');
        expect(migration).toContain('manual_resolution_evidence_hash IS DISTINCT FROM');
        for (const immutableField of [
            'input_hash',
            'job_claim_token',
            'reservation_token',
            'actor_id',
            'reserved_at',
            'request_id',
            'job_key',
            'operation_key',
        ]) {
            expect(migration).toContain(`NEW.${immutableField} IS DISTINCT FROM OLD.${immutableField}`);
        }
        expect(migration).toContain('usage_reconciled_at = v_now');
        expect(migration).not.toMatch(/SET\s+status\s*=/i);
        expect(migration).not.toMatch(/SET\s+run_id\s*=/i);
    });

    it('uses a seven-day hard fence and exact immutable identity arguments', () => {
        const migration = migrationSource();
        const list = functionDefinition(
            migration,
            'list_analysis_v2_conservative_max_charge_candidates'
        );
        const resolve = functionDefinition(
            migration,
            'resolve_analysis_v2_provider_run_conservative_max_charge'
        );
        expect(list).toContain("terminalized_at <= v_now - INTERVAL '7 days'");
        expect(list).toContain("logical_provider = 'apify'");
        expect(list).toContain("credential_slot = 'tertiary'");
        expect(list).toContain("status = 'succeeded'");
        expect(list).toContain('actual_usage_usd IS NULL');
        expect(list).toContain('usage_reconciled_at IS NULL');
        expect(list).toContain("state IN ('leased', 'recovery_required')");
        expect(list).toContain('processing_lease_expires_at');
        expect(list).toContain('lease_expires_at');
        expectInOrder(resolve, [
            'p_request_id UUID',
            'p_job_key TEXT',
            'p_operation_key TEXT',
            'p_input_hash TEXT',
            'p_job_claim_token UUID',
            'p_reservation_token UUID',
            'p_run_id TEXT',
            'p_logical_provider TEXT',
            'p_actor_id TEXT',
            'p_credential_slot TEXT',
            'p_max_charge_usd NUMERIC',
            'p_reserved_at TIMESTAMPTZ',
            'p_run_started_at TIMESTAMPTZ',
            'p_terminalized_at TIMESTAMPTZ',
            'p_status TEXT',
            'p_evidence_hash TEXT',
        ]);
        expect(resolve).toContain('FOR UPDATE');
        expect(resolve).toContain('IS DISTINCT FROM p_input_hash');
        expect(resolve).toContain('IS DISTINCT FROM p_job_claim_token');
        expect(resolve).toContain('IS DISTINCT FROM p_reservation_token');
        expect(resolve).toContain('IS DISTINCT FROM p_run_id');
        expect(resolve).toContain('IS DISTINCT FROM p_max_charge_usd');
        expect(resolve).toContain("MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT'");
        expect(resolve).toContain("MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY'");
        expect(resolve).toContain('RETURNING * INTO v_run');
    });

    it('settles only an exact active revenue child through the latest authoritative RPC', () => {
        const migration = migrationSource();
        const resolve = functionDefinition(
            migration,
            'resolve_analysis_v2_provider_run_conservative_max_charge'
        );
        expect(resolve).toContain("v_child_state IN ('reserved', 'started', 'ambiguous', 'settled')");
        expect(resolve).toContain("v_child_state NOT IN ('reserved', 'started', 'ambiguous', 'settled')");
        expect(resolve).toContain('source_operation_key_hash');
        expect(resolve).toContain('settle_analysis_revenue_cost_operation_v2');
        expect(resolve).toContain("'provider_run'");
        expect(resolve).not.toContain('INSERT INTO public.analysis_revenue_cost_operations');
        expect(resolve).not.toContain('reserve_analysis_revenue_cost_operation_v2');
        expect(resolve).toContain("THEN 'absent'");
    });

    it('keeps candidate, resolver, and metadata helpers database-owner-only', () => {
        const migration = migrationSource();
        for (const rpc of [
            'list_analysis_v2_conservative_max_charge_candidates',
            'resolve_analysis_v2_provider_run_conservative_max_charge',
        ]) {
            const definition = functionDefinition(migration, rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(
                new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\(`)
            );
            expect(migration).not.toMatch(
                new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`)
            );
        }
        expect(migration).not.toMatch(/username|caption|comment_text|profile_url|provider_payload/i);
    });
});
