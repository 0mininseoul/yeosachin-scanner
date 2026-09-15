import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbookPath = new URL(
    '../../../docs/analysis-v2-historical-legacy-dispatch-terminalizer-runbook.md',
    import.meta.url
);

describe('historical legacy-dispatch terminalizer runbook', () => {
    it('documents the exact owner-only, provider-free procedure', () => {
        expect(existsSync(runbookPath)).toBe(true);
        const runbook = readFileSync(runbookPath, 'utf8');
        for (const phrase of [
            'exactly the five expected rows',
            'database-owner session',
            'PUBLIC`, `anon`, `authenticated`, or `service_role',
            'seven days old',
            'zero, one, or multiple provider-run ledger rows',
            'every row must be terminal and reconciled',
            'valid `rejected` provider row',
            'both `null`',
            'conservative_max_charge',
            'list_analysis_v2_historical_legacy_dispatch_candidates',
            'resolve_analysis_v2_historical_legacy_dispatch',
            'legacyActiveQueuedV2Tasks',
            'immutable receipt',
            'idempotent replay',
            '/api/analysis/v2/recover',
            'provider/AI call',
            'payment_pending',
        ]) {
            expect(runbook).toContain(phrase);
        }
    });
});
