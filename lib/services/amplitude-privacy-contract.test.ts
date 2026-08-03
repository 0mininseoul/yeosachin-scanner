import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

function source(relativePath: string): string {
    return readFileSync(new URL(relativePath, root), 'utf8');
}

describe('Amplitude replay privacy contract', () => {
    it('keeps the replay readable while masking only marked sensitive regions', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain("defaultMaskLevel: 'light'");
        expect(analytics).toContain("maskSelector: ['[data-amp-mask]']");
        expect(analytics).toContain("blockSelector: ['[data-amp-block]']");
        expect(analytics).not.toContain('maskAttributes:');
    });

    it('uses bounded Vercel sampling with a fail-closed upstream capture veto', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain("process.env.NODE_ENV === 'production'");
        expect(analytics).toContain("NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED !== 'true'");
        expect(analytics).toContain('SESSION_REPLAY_MAX_SAMPLE_RATE = 1');
        expect(analytics).toContain("/^(?:0\\.(?:0[1-9]|1|10)|1)$/.test(rawSampleRate)");
        expect(analytics).toContain('captureEnabled: false, sampleRate: 0');
        expect(analytics).toContain('hasRemoteReplayCaptureApproval');
        expect(analytics).not.toContain('hasExpectedReplaySampling');
        expect(analytics).toContain('isTrustedReplayConfigUrl');
        expect(analytics).toContain(
            'Revalidate route, DNT, GPC, environment, and sticky shutdown after the config fetch.'
        );
        expect(analytics).not.toContain('Route, demo mode, DNT');
        expect(analytics).toContain('sampleRate: 0');
        expect(analytics).toMatch(/interactionConfig:\s*\{\s*enabled: true,\s*batch: true,/);
        expect(analytics).toContain('ugcFilterRules');
        expect(analytics).toContain('handleSendEvents: createSafeSessionReplaySender(apiKey)');
        expect(analytics).toContain('ugcFilterRules');
    });

    it('rejects cached replay config in both installed SDK module formats', () => {
        const patch = source('patches/@amplitude+session-replay-browser+1.47.4.patch');

        expect(patch.match(/source !== 'remote'/g)).toHaveLength(2);
        expect(patch).toContain('lib/cjs/config/joined-config.js');
        expect(patch).toContain('lib/esm/config/joined-config.js');
        expect(patch.indexOf("source !== 'remote'"))
            .toBeLessThan(patch.indexOf('JSON.stringify(remoteConfig'));
    });

    it('does not mask full replay pages and keeps only sensitive regions marked', () => {
        const landing = source('components/landing-page.tsx');
        const analyze = source('app/analyze/page.tsx');
        const login = source('app/login/page.tsx');
        const mypage = source('app/mypage/page.tsx');
        const earlybirdPage = source('app/earlybird/page.tsx');
        const earlybird = source('app/earlybird/earlybird-status.tsx');
        const history = source('app/mypage/analysis-list.tsx');
        const progress = source('app/progress/[requestId]/page.tsx');
        const result = source('app/result/[requestId]/page.tsx');
        const shared = source('app/share/[token]/page.tsx');
        const betaTest = source('app/betatest/betatest-client.tsx');
        const feedback = source('components/result-feedback.tsx');
        const profilePreview = source('components/profile-preview-dialog.tsx');

        expect(landing).toContain('data-amp-mask');
        expect(analyze.match(/data-amp-mask/g)?.length).toBeGreaterThanOrEqual(2);
        expect(analyze).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(login).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(mypage).not.toMatch(/<(?:div|main)[^>]*data-amp-mask/);
        expect(earlybirdPage).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(earlybird).toContain('data-amp-block');
        expect(history).toContain('data-amp-block');
        expect(progress).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(result).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(shared).not.toMatch(/<main[^>]*data-amp-mask/);
        expect(betaTest).toMatch(/id="beta-target-instagram"[\s\S]*?data-amp-mask/);
        expect(betaTest).toMatch(/id="beta-excluded-instagram"[\s\S]*?data-amp-mask/);
        expect(feedback).toMatch(/<textarea[\s\S]*?data-amp-mask/);
        expect(earlybird).toMatch(/href=\{order\.resultUrl\}[\s\S]*?data-amp-block/);
        expect(profilePreview).toMatch(/data-amp-block[\s\S]*?profile\.instagramId/);
        expect(profilePreview).toMatch(/data-amp-block[\s\S]*?profile\.(?:overview|bio)/);
        expect((analyze.match(/data-amp-mask[\s\S]{0,400}\{error\}/g)?.length ?? 0)).toBeGreaterThanOrEqual(2);
        expect(analyze).toMatch(/data-amp-mask[\s\S]{0,400}\{error \?\?/);
        expect(analyze).toMatch(/data-amp-mask[\s\S]{0,400}\{visibleError\}/);
        expect((betaTest.match(/data-amp-mask[\s\S]{0,400}\{error\}/g)?.length ?? 0)).toBeGreaterThanOrEqual(3);
        expect(betaTest).toMatch(/data-amp-mask[\s\S]{0,400}\{error \?\?/);
        expect(progress).toMatch(/data-amp-mask[\s\S]{0,400}\{error \|\|/);
        expect(progress).toMatch(/data-amp-mask[\s\S]{0,400}\{data\.errorMessage/);
        expect(result).toMatch(/data-amp-mask[\s\S]{0,400}\{error \|\|/);
        expect(earlybird).toMatch(/data-amp-mask[\s\S]{0,400}\{checkoutRecoveryError\}/);
        expect(shared).toMatch(/data-amp-mask[\s\S]{0,400}\{error\}/);
        expect(feedback).toMatch(/data-amp-mask[\s\S]{0,400}\{error \?\?/);
    });

    it('does not send route values into replay lifecycle calls', () => {
        const provider = source('components/amplitude-provider.tsx');
        const analytics = source('lib/services/analytics.ts');

        expect(provider).toContain('enforceAmplitudeReplayRoutePrivacy()');
        expect(provider).not.toMatch(/enforceAmplitudeReplayRoutePrivacy\([^)]/);
        expect(analytics).toContain('SESSION_REPLAY_SAFE_PATHS');
        expect(analytics).not.toContain('location.search.length === 0');
        expect(analytics).not.toContain('location.hash.length === 0');
        expect(provider).toContain('installAmplitudeReplayNavigationGuards()');
    });

    it('uses local UGC rules to canonicalize every eligible route before replay persistence', () => {
        const analytics = source('lib/services/analytics.ts');

        for (const route of [
            '/', '/privacy', '/terms', '/login', '/analyze', '/earlybird', '/mypage',
            '/progress/:requestId', '/result/:requestId', '/share/:token',
        ]) {
            expect(analytics).toContain(`replacement: '${route}'`);
        }
        expect(analytics).not.toContain('yeosachin.vercel.app');
    });

    it('keeps server-only demo eligibility independent from the replay client', () => {
        const layout = source('app/layout.tsx');
        const provider = source('components/amplitude-provider.tsx');
        const analytics = source('lib/services/analytics.ts');
        const demoPolicy = source('lib/services/demo-analysis/demo-analysis.ts');

        expect(demoPolicy).toContain("import 'server-only'");
        expect(demoPolicy).toContain("env.DEMO_ANALYSIS_ENABLED !== 'true'");
        expect(layout).not.toContain('DEMO_ANALYSIS_ENABLED');
        expect(layout).not.toContain('data-amplitude-demo-mode');
        expect(provider).not.toContain('demoAnalysisEnabled');
        expect(provider).not.toContain('updateAmplitudeReplayRuntimeContext');
        expect(analytics).not.toContain('DEMO_ANALYSIS_ENABLED');
        expect(analytics).not.toContain('NEXT_PUBLIC_DEMO_ANALYSIS_ENABLED');
    });

});
