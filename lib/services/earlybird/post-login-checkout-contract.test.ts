import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');

describe('analyze OAuth checkout continuation contract', () => {
    it('preserves the paid action through login and submits it after preflight resume', () => {
        expect(source).toContain("loginRedirectParams.set(AUTO_CHECKOUT_QUERY_PARAM, '1');");
        expect(source).toContain('shouldAutoSubmitEarlybirdAction({');
        expect(source).toContain('void handleEarlybirdAction();');
    });

    it('binds continuation to the originally selected plan and never carries it to a new preflight', () => {
        expect(source).toContain('const [autoCheckoutPlan, setAutoCheckoutPlan]');
        expect(source).toContain('const [autoCheckoutPreflightId, setAutoCheckoutPreflightId]');
        expect(source).toContain('requestedPreflightId: autoCheckoutPreflightId');
        expect(source).toContain('requestedPlanId: autoCheckoutPlan');
        expect(source).toContain('clearAutoCheckoutContinuation();');
        expect(source).not.toContain(
            "if (autoCheckoutRequested) next.set(AUTO_CHECKOUT_QUERY_PARAM, '1');",
        );
    });
});
