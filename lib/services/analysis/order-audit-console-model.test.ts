import { describe, expect, it } from 'vitest';

describe('operator console presentation model', () => {
    it('identifies the first count divergence while leaving unknown counts explicit', async () => {
        const model = await import('./operator-console-model');

        expect(model.deriveFirstDivergence([
            { key: 'mutuals', declared: 10, collected: 10 },
            { key: 'gender-initial', declared: 10, collected: 8 },
            { key: 'gender-final', declared: 8, collected: 8 },
        ])).toEqual({ key: 'gender-initial', kind: 'divergence', missing: 2 });

        expect(model.deriveFirstDivergence([
            { key: 'mutuals', declared: 10, collected: 10 },
            { key: 'gender-initial', declared: null, collected: 8 },
            { key: 'gender-final', declared: 8, collected: 8 },
        ])).toEqual({ key: 'gender-initial', kind: 'unknown' });
    });

    it('never renders stale or missing credit as a numeric current balance', async () => {
        const model = await import('./operator-console-model');

        expect(model.displayCreditUsd({ freshnessState: 'fresh', effectiveRemainingUsd: 1.25 })).toBe('$1.25');
        expect(model.displayCreditUsd({ freshnessState: 'stale', effectiveRemainingUsd: null })).toBe('미상');
        expect(model.displayCreditUsd({ freshnessState: 'missing', effectiveRemainingUsd: null })).toBe('미상');
        expect(model.displayCreditUsd({ freshnessState: 'fresh', effectiveRemainingUsd: null })).toBe('미상');
    });
});
