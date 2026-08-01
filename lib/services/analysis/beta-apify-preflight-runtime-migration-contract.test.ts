import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(), 'supabase/migrations/20260802070000_wire_betatest_preflight_credit_runtime.sql'
), 'utf8');

describe('betatest preflight runtime migration contract', () => {
    it('retains the latest claim and fresh-admission lock/fence vocabulary', () => {
        for (const fragment of [
            'FOR UPDATE', "v_preflight.status IN ('pending','processing','ready')",
            'worker_attempt_count >= 7', 'lease_token=p_claim_token',
            'admission_dispatch_generation <> p_dispatch_generation',
            'admission_dispatch_token IS DISTINCT FROM p_dispatch_token',
            "admission_dispatch_state NOT IN ('reserved','enqueued')",
            'analysis_entry_channel::TEXT',
        ]) expect(migration).toContain(fragment);
    });

    it('keeps the hold lookup service-only and identity-sanitized', () => {
        expect(migration).toContain('load_analysis_beta_apify_preflight_hold');
        expect(migration).toContain("'targetProfileBudgetUsd', v_reservation.reserved_usd");
        expect(migration).not.toMatch(/'userId'|'token'|'account'/);
        expect(migration).toContain("REVOKE ALL ON FUNCTION public.load_analysis_beta_apify_preflight_hold(UUID)");
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_beta_apify_preflight_hold(UUID) TO service_role');
    });
});
