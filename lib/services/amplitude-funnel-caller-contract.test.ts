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
            source('hooks/useAnalysisV2Preflight.ts'),
            source('lib/services/analysis/v2-worker.ts'),
            source('lib/services/analysis/v2-ai-scoring-executors.ts'),
            source('lib/services/analytics-server.ts'),
            source('lib/services/analytics.ts'),
        ].join('\n');

        for (const event of [
            'LANDING_VIEWED',
            'PREFLIGHT_STARTED',
            'PREFLIGHT_SUCCEEDED',
            'PREFLIGHT_BLOCKED',
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
            'ANALYSIS_FAILED',
            'LOGIN_PROMPTED',
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
            /isSafeEarlybirdCheckoutContinuationUrl\(payload\.nextUrl\)[\s\S]*?trackEvent\(EVENTS\.CHECKOUT_REDIRECTED[\s\S]*?window\.location\.assign\(payload\.nextUrl\)/,
        );
        expect(analyze).not.toContain('flushAnalytics');
    });

    it('tracks preflight and analysis only at accepted lifecycle boundaries', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        expect(preflight).toMatch(
            /fetch\('\/api\/analysis\/preflight'[\s\S]*?x-analytics-eligible[\s\S]*?trackEvent\(EVENTS\.PREFLIGHT_STARTED\)/,
        );
        expect(preflight).toMatch(
            /if \(!scope\.isCurrent\(\)\) return false;[\s\S]*?trackEvent\(EVENTS\.EXCLUSION_DECIDED/,
        );
        expect(preflight).not.toContain('EVENTS.ANALYSIS_STARTED');
        expect(preflight).not.toContain('EVENTS.ANALYSIS_COMPLETED');
        const worker = source('lib/services/analysis/v2-worker.ts');
        const scoring = source('lib/services/analysis/v2-ai-scoring-executors.ts');
        expect(worker).toContain("eventName: 'analysis_started'");
        expect(worker).toContain("eventName: 'analysis_failed'");
        expect(scoring).toContain("eventName: 'analysis_completed'");
    });

    it('keeps order analytics free of target and buyer evidence', () => {
        const status = source('app/earlybird/earlybird-status.tsx');
        expect(status).toContain('const { user, loading: authLoading } = useAuth();');
        expect(status).toMatch(/if \(authLoading \|\| !user\?\.id\) return;/);
        const effect = status.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[authLoading, order, user\?\.id\]\);/)?.[0] ?? '';
        expect(effect).toContain('order_id: order.orderId');
        expect(effect).toContain('status: order.systemStatus');
        expect(effect).not.toMatch(/targetInstagramId|email|phone|buyer|groble/i);
    });

    it('flushes status and payment analytics before the automatic fulfillment bridge navigates', () => {
        const status = source('app/earlybird/earlybird-status.tsx');
        expect(status).toMatch(
            /trackEvent\(EVENTS\.PAYMENT_CONFIRMED_VIEWED[\s\S]*?\}, \[authLoading, order, user\?\.id\]\);[\s\S]*?flushAnalytics\(\)[\s\S]*?router\.replace\(nextUrl\)/,
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

        expect(preflight).toContain('trustedDurationMs(');
        expect(preflight).toContain('classifyPreflightAnalyticsOutcome(');
        expect(preflight).toContain('EVENTS.PREFLIGHT_BLOCKED');
        expect(preflight).toMatch(/preflightStartedAt:\s*preflightStartedAtRef\.current/);
    });

    it('honors the disabled analytics capability through preflight, progress, result pagination, and commercial controls', () => {
        const preflight = source('hooks/useAnalysisV2Preflight.ts');
        const analyze = source('app/analyze/page.tsx');
        const result = source('app/result/[requestId]/page.tsx');

        expect(preflight).toContain("response.headers.get('x-analytics-eligible') !== '0'");
        expect(preflight).toMatch(/if \(!analyticsEligibleRef\.current\) return;[\s\S]*?PREFLIGHT_SUCCEEDED/);
        expect(preflight).toMatch(/if \(analyticsEligibleRef\.current\) trackEvent\(EVENTS\.EXCLUSION_DECIDED/);
        expect(analyze).toMatch(/!readyPreflight[\s\S]*?!analyticsEligible[\s\S]*?PLAN_VIEWED/);
        expect(analyze).toMatch(/if \(analyticsEligible\) trackEvent\(EVENTS\.CHECKOUT_REDIRECTED/);
        expect(result).toContain("response.headers.get('x-analytics-eligible') !== '0'");
        expect(result).toContain("response.headers.get('x-external-profile-links') !== 'disabled'");
        expect(result).toMatch(/goToResultPage[\s\S]*?x-external-profile-links[\s\S]*?mapV2Result/);
        expect(result).toContain("data.pipelineVersion === 'v1'");
    });
});
