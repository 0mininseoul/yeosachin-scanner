import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
    new URL(
        '../../../docs/analysis-v2-provider-missing-max-charge-resolution-runbook.md',
        import.meta.url
    ),
    'utf8'
);

describe('V2 provider missing max-charge runbook contract', () => {
    it('keeps the gate owner-only, exact-five, seven-day, and PII-free', () => {
        expect(runbook).toContain('20260902100000_ambiguous_max_charge_identity_drift_repair.sql');
        expect(runbook).toContain('20260903020000_add_analysis_v2_conservative_max_charge_resolution.sql');
        expect(runbook).toContain('candidate_count = 5');
        expect(runbook).toContain('INTERVAL');
        expect(runbook).toContain('seven-day');
        expect(runbook).toContain('list_analysis_v2_conservative_max_charge_candidates(6)');
        expect(runbook).toContain('database-owner');
        expect(runbook).toContain('exactly five');
        expect(runbook).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
        expect(runbook).not.toMatch(/["'`]username["'`]\s*:/i);
        expect(runbook).not.toMatch(/["'`]provider_payload["'`]\s*:/i);
        expect(runbook).toContain('Do not source or print `.env.local`');
        expect(runbook).toContain('`payment_pending`');
    });
});
