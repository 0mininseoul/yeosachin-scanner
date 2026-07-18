import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('Amplitude product funnel caller contract', () => {
    it('wires every authoritative funnel boundary without raw identity properties', () => {
        const callers = [
            source('app/page.tsx'),
            source('app/analyze/page.tsx'),
            source('app/earlybird/earlybird-status.tsx'),
            source('app/progress/[requestId]/page.tsx'),
            source('hooks/useAnalysisProgress.ts'),
            source('hooks/useAnalysisV2Preflight.ts'),
        ].join('\n');

        for (const event of [
            'LANDING_VIEWED',
            'PREFLIGHT_STARTED',
            'PREFLIGHT_SUCCEEDED',
            'PREFLIGHT_FAILED',
            'EXCLUSION_DECIDED',
            'PLAN_VIEWED',
            'PLAN_SELECTED',
            'CHECKOUT_STARTED',
            'CHECKOUT_REDIRECTED',
            'EARLYBIRD_STATUS_VIEWED',
            'PAYMENT_CONFIRMED_VIEWED',
            'ANALYSIS_STARTED',
            'ANALYSIS_COMPLETED',
        ]) {
            expect(callers).toContain(`EVENTS.${event}`);
        }

        const trackingCalls = callers.match(/trackEvent\([\s\S]*?\);/g)?.join('\n') ?? '';
        expect(trackingCalls).not.toMatch(
            /instagram(Id|Username)?\s*:|targetInstagramId\s*:|email\s*:|phone\s*:|checkoutUrl\s*:|paymentId\s*:/,
        );
    });

    it('tracks checkout redirect only after URL validation and before navigation', () => {
        const analyze = source('app/analyze/page.tsx');
        expect(analyze).toMatch(
            /trackEvent\(EVENTS\.CHECKOUT_STARTED[\s\S]*?fetch\([\s\S]*?'\/api\/earlybird\/checkout'/,
        );
        expect(analyze).toMatch(
            /isSafeGrobleCheckoutUrl\(payload\.checkoutUrl\)[\s\S]*?trackEvent\(EVENTS\.CHECKOUT_REDIRECTED[\s\S]*?window\.location\.assign\(payload\.checkoutUrl\)/,
        );
    });

    it('tracks preflight and analysis only at accepted lifecycle boundaries', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        expect(preflight).toMatch(
            /trackEvent\(EVENTS\.PREFLIGHT_STARTED\);[\s\S]*?fetch\('\/api\/analysis\/preflight'/,
        );
        expect(preflight).toMatch(
            /if \(!scope\.isCurrent\(\)\) return false;[\s\S]*?trackEvent\(EVENTS\.EXCLUSION_DECIDED/,
        );
        expect(preflight).toMatch(
            /parsed\.data\.status !== 'admission_pending'[\s\S]*?consumeTestEntitlementToken[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_STARTED[\s\S]*?return requestId/,
        );

        const progress = source('hooks/useAnalysisProgress.ts');
        expect(progress).toMatch(
            /data\?\.status !== 'pending'[\s\S]*?data\?\.status !== 'processing'[\s\S]*?claimObservedAnalysisStart[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_STARTED/,
        );
        expect(progress).toMatch(
            /data\?\.status !== 'completed'[\s\S]*?analysisCompletedEventKey\(requestId\)[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_COMPLETED/,
        );
        expect(preflight).toContain('claimAnalysisStart(');
    });

    it('keeps order analytics free of target and buyer evidence', () => {
        const status = source('app/earlybird/earlybird-status.tsx');
        const effect = status.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[order\]\);/)?.[0] ?? '';
        expect(effect).toContain('order_id: order.orderId');
        expect(effect).toContain('status: order.systemStatus');
        expect(effect).not.toMatch(/targetInstagramId|email|phone|buyer|groble/i);
    });

    it('does not create a Plus plan-view or waitlist analytics event', () => {
        const analyze = source('app/analyze/page.tsx');
        expect(analyze).toContain("plan.planId === 'plus'");
        expect(analyze).not.toMatch(/EVENTS\.[A-Z_]*WAITLIST/);
    });
});
