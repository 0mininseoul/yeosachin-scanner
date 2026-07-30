import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260730220000_adopt_schema_recovery_predecessor_provider_run.sql',
    import.meta.url
);

describe('analysis V2 predecessor provider run adoption migration contract', () => {
    const migration = readFileSync(migrationUrl, 'utf8');

    it('replaces the global run uniqueness with a partial index that still owns real runs', () => {
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_v2_provider_runs_run_id_key'
        );
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX analysis_v2_provider_runs_unadopted_run_id_key\s+ON public\.analysis_v2_provider_runs\(run_id\)\s+WHERE adopted_from_request_id IS NULL/u
        );
        // Nothing may reintroduce an unconditional unique index on run_id.
        expect(migration).not.toMatch(
            /CREATE UNIQUE INDEX[^;]*\(run_id\)\s*;/u
        );
    });

    it('forces every adopted row to be terminal, succeeded, and free', () => {
        expect(migration).toMatch(
            /ADD CONSTRAINT analysis_v2_provider_run_adoption_check CHECK \(\s*adopted_from_request_id IS NULL\s*OR \(\s*status = 'succeeded'\s*AND run_id IS NOT NULL\s*AND actual_usage_usd = 0\s*AND usage_reconciled_at IS NOT NULL\s*\)\s*\)/u
        );
    });

    it('requires a recorded lineage edge rather than a target-only reuse cache', () => {
        expect(migration).toContain('CREATE TABLE public.analysis_request_retry_lineage');
        expect(migration).toContain('successor_preflight_id UUID PRIMARY KEY');
        expect(migration).toMatch(
            /A global "same target -> reuse any prior run" [\s\S]{0,8}cache is deliberately NOT built/u
        );
        expect(migration).toMatch(
            /FROM public\.analysis_request_retry_lineage AS lineage[\s\S]*WHERE lineage\.successor_preflight_id = v_preflight\.id/u
        );
        // Adoption must never resolve its predecessor from the earlybird table directly.
        expect(migration).not.toMatch(
            /adopt_analysis_v2_predecessor_provider_run[\s\S]*earlybird_schema_failure_recoveries/u
        );
    });

    it('keeps owner, target, and byte-exact provider identity guards on the adoption RPC', () => {
        expect(migration).toContain(
            'v_predecessor.user_id IS DISTINCT FROM v_request.user_id'
        );
        expect(migration).toContain(
            "v_predecessor_target = 'retained.' || pg_catalog.substr("
        );
        for (const guard of [
            'provider_run.operation_key = p_operation_key',
            'provider_run.input_hash = p_input_hash',
            'provider_run.logical_provider = p_logical_provider',
            'provider_run.actor_id = p_actor_id',
            'provider_run.credential_slot = p_credential_slot',
            "provider_run.status = 'succeeded'",
            'provider_run.run_id IS NOT NULL',
        ]) {
            expect(migration).toContain(guard);
        }
        // The live job claim is what proves adoption happens during job execution.
        expect(migration).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
    });

    it('excludes adopted rows from Apify usage reconciliation', () => {
        expect(migration).toContain(
            'AND provider_run.adopted_from_request_id IS NULL'
        );
        expect(migration).toContain(
            'IF v_run.adopted_from_request_id IS NOT NULL'
        );
    });

    it('adds the earlybird lineage row without redefining the recovery RPC', () => {
        expect(migration).toContain(
            'CREATE TRIGGER record_earlybird_schema_recovery_retry_lineage'
        );
        expect(migration).toContain(
            'FROM public.earlybird_schema_failure_recoveries AS recovery'
        );
        expect(migration).not.toContain(
            'FUNCTION public.recover_earlybird_schema_failed_fulfillment'
        );
    });

    it('keeps every new routine service-role only', () => {
        for (const signature of [
            'public.adopt_analysis_v2_predecessor_provider_run(\n    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID\n)',
            'public.record_earlybird_schema_recovery_retry_lineage()',
        ]) {
            expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
        }
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.adopt_analysis_v2_predecessor_provider_run\([\s\S]*?\) TO service_role;/u
        );
        expect(migration).not.toMatch(/GRANT[^;]*TO (?:anon|authenticated)\b/u);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_request_retry_lineage\s+FROM PUBLIC, anon, authenticated, service_role/u
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_request_retry_lineage ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(/SET search_path = ''/u);
    });
});
