import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('Amplitude product funnel caller contract', () => {
    it('wires every authoritative funnel boundary without raw identity properties', () => {
        const callers = [
            source('components/landing-page.tsx'),
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
            /isSafeGrobleCheckoutUrl\(payload\.checkoutUrl\)[\s\S]*?trackEvent\(EVENTS\.CHECKOUT_REDIRECTED[\s\S]*?await flushAnalytics\(\)[\s\S]*?window\.location\.assign\(payload\.checkoutUrl\)/,
        );
        expect(analyze).toMatch(
            /payload\.nextUrl[\s\S]*?await flushAnalytics\(\)[\s\S]*?window\.location\.assign\(payload\.nextUrl\)/,
        );
    });

    it('tracks preflight and analysis only at accepted lifecycle boundaries', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        expect(preflight).toMatch(
            /fetch\('\/api\/analysis\/preflight'[\s\S]*?x-analytics-eligible[\s\S]*?trackEvent\(EVENTS\.PREFLIGHT_STARTED\)/,
        );
        expect(preflight).toMatch(
            /if \(!scope\.isCurrent\(\)\) return false;[\s\S]*?trackEvent\(EVENTS\.EXCLUSION_DECIDED/,
        );
        expect(preflight).toMatch(
            /parsed\.data\.status !== 'admission_pending'[\s\S]*?consumeTestEntitlementToken[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_STARTED[\s\S]*?return requestId/,
        );

        const progress = source('hooks/useAnalysisProgress.ts');
        expect(progress).toMatch(
            /currentData\?\.status !== 'pending'[\s\S]*?currentData\?\.status !== 'processing'[\s\S]*?claimObservedAnalysisStart[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_STARTED/,
        );
        expect(progress).toMatch(
            /currentData\?\.status !== 'completed'[\s\S]*?analysisCompletedEventKey\(requestId\)[\s\S]*?trackEvent\(EVENTS\.ANALYSIS_COMPLETED/,
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

    it('flushes status and payment analytics before the automatic fulfillment bridge navigates', () => {
        const status = source('app/earlybird/earlybird-status.tsx');
        expect(status).toMatch(
            /trackEvent\(EVENTS\.PAYMENT_CONFIRMED_VIEWED[\s\S]*?\}, \[order\]\);[\s\S]*?flushAnalytics\(\)[\s\S]*?router\.replace\(nextUrl\)/,
        );
    });

    it('does not create a Plus plan-view or waitlist analytics event', () => {
        const analyze = source('app/analyze/page.tsx');
        expect(analyze).toContain("plan.planId === 'plus'");
        expect(analyze).not.toMatch(/EVENTS\.[A-Z_]*WAITLIST/);
    });

    it('uses persisted wall-clock starts and never invents a duration on terminal direct-open', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        expect(preflight).not.toContain('performance.now()');
        expect(preflight).toContain('persistPreflightStartedAt(');
        expect(preflight).toContain('readPreflightStartedAt(');

        const progress = source('hooks/useAnalysisProgress.ts');
        expect(progress).not.toContain('observedStartedAtRef');
        expect(progress).toContain('trustedDurationMs(');
        expect(progress).toMatch(
            /durationMs === undefined[\s\S]*?\{\}[\s\S]*?\{ duration_ms: durationMs \}/,
        );
    });

    it('honors the disabled analytics capability through preflight, progress, result pagination, and commercial controls', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        const progress = source('hooks/useAnalysisProgress.ts');
        const analyze = source('app/analyze/page.tsx');
        const result = source('app/result/[requestId]/page.tsx');

        expect(preflight).toContain("response.headers.get('x-analytics-eligible') !== '0'");
        expect(preflight).toMatch(/if \(!analyticsEligibleRef\.current\) return;[\s\S]*?PREFLIGHT_SUCCEEDED/);
        expect(preflight).toMatch(/if \(analyticsEligibleRef\.current\) trackEvent\(EVENTS\.EXCLUSION_DECIDED/);
        expect(progress).toMatch(/!analyticsEligibleRef\.current[\s\S]*?ANALYSIS_STARTED/);
        expect(progress).toMatch(/!analyticsEligibleRef\.current[\s\S]*?ANALYSIS_COMPLETED/);
        expect(analyze).toMatch(/!readyPreflight[\s\S]*?!analyticsEligible[\s\S]*?PLAN_VIEWED/);
        expect(analyze).toMatch(/if \(analyticsEligible\) trackEvent\(EVENTS\.CHECKOUT_REDIRECTED/);
        expect(result).toContain("response.headers.get('x-analytics-eligible') !== '0'");
        expect(result).toContain("response.headers.get('x-external-profile-links') !== 'disabled'");
        expect(result).toMatch(/goToResultPage[\s\S]*?x-external-profile-links[\s\S]*?mapV2Result/);
        expect(result).toContain("data.pipelineVersion === 'v1'");
    });
});
