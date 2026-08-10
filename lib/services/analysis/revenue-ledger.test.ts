import { describe, expect, it } from 'vitest';
import { assertCoverageInvariant, RevenueCostLedger, RevenueLedgerError } from './revenue-ledger';

describe('revenue cost and coverage ledgers', () => {
    it('reserves before operation and fail-closes the hard cap', () => {
        const ledger = new RevenueCostLedger('basic');
        ledger.reserve({ reservationId: 'routing', operation: 'routing', units: 400, estimatedCostKrw: 1_000 });
        ledger.reserve({ reservationId: 'profile', operation: 'profile', units: 100, estimatedCostKrw: 808 });
        ledger.settle('routing', 900);
        ledger.settle('profile', 800);
        expect(ledger.assertWithinCap()).toMatchObject({ actualKrw: 1_700, marginTargetPassed: false, negativeMarginPilot: true });
        expect(() => ledger.reserve({ reservationId: 'too-much', operation: 'resolver', units: 20, estimatedCostKrw: 109 })).toThrowError(new RevenueLedgerError('BUDGET_EXCEEDED'));
    });

    it('applies integer unknown coverage gate and rejects overlap', () => {
        expect(assertCoverageInvariant({ publicMutualCount: 100, screenedCount: 80, notScreenedCount: 20, unknownBurdenCount: 24 }).passesUnknownGate).toBe(true);
        expect(assertCoverageInvariant({ publicMutualCount: 100, screenedCount: 80, notScreenedCount: 20, unknownBurdenCount: 25 }).passesUnknownGate).toBe(false);
        expect(() => assertCoverageInvariant({ publicMutualCount: 10, screenedCount: 8, notScreenedCount: 1, unknownBurdenCount: 0 })).toThrowError(new RevenueLedgerError('COVERAGE_INVARIANT_FAILED'));
    });
});
