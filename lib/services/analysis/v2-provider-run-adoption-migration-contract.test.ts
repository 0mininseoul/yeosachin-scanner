import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.resolve(
    process.cwd(),
    'supabase/migrations/20260731060000_adopt_recovery_provider_runs.sql'
), 'utf8');

describe('recovery provider-run adoption migration', () => {
    it('is immutable, RPC-only, and does not copy provider or cost rows', () => {
        expect(sql).toContain('CREATE TABLE public.analysis_v2_recovery_provider_run_adoptions');
        expect(sql).toContain('BEFORE UPDATE OR DELETE');
        expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(sql).not.toMatch(/INSERT INTO public\.analysis_v2_provider_runs/);
        expect(sql).not.toMatch(/INSERT INTO public\.provider_cost/);
    });

    it('requires a live job claim, paid order proof, exact recovery lineage and reconciled success', () => {
        expect(sql).toContain("v_job.status <> 'processing'");
        expect(sql).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(sql).toContain('v_order.seller_reference_confirmed_at IS NULL');
        expect(sql).toContain('v_recovery.failed_request_id');
        expect(sql).toContain('v_current_preflight.idempotency_key !~');
        expect(sql).toContain("v_source.status <> 'succeeded'");
        expect(sql).toContain('v_source.actual_usage_usd IS NULL');
        expect(sql).toContain('v_source.usage_reconciled_at IS NULL');
    });

    it('matches every immutable provider identity and exposes an adoption-aware evidence resolver', () => {
        for (const field of [
            'input_hash', 'logical_provider', 'actor_id', 'credential_slot',
            'max_charge_usd',
        ]) {
            expect(sql).toContain(`v_source.${field}`);
        }
        expect(sql).toContain('analysis_v2_valid_provider_evidence_source');
        expect(sql).toContain('analysis_v2_recovery_provider_run_adoptions AS adoption');
    });
});
