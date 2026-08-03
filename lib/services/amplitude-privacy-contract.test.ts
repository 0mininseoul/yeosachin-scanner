import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

function source(relativePath: string): string {
    return readFileSync(new URL(relativePath, root), 'utf8');
}

function tsxFiles(directory: string): string[] {
    const absolute = fileURLToPath(new URL(directory, root));
    return readdirSync(absolute).flatMap((entry) => {
        const path = join(absolute, entry);
        if (statSync(path).isDirectory()) {
            return tsxFiles(`${directory}${entry}/`);
        }
        return entry.endsWith('.tsx') ? [path] : [];
    });
}

describe('Amplitude replay privacy contract', () => {
    it('uses conservative masking with no application unmask selector', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain("defaultMaskLevel: 'conservative'");
        expect(analytics).not.toContain('unmaskSelector');
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
        expect(analytics).toContain("'[contenteditable]'");
    });

    it('rejects cached replay config in both installed SDK module formats', () => {
        const patch = source('patches/@amplitude+session-replay-browser+1.47.4.patch');

        expect(patch.match(/source !== 'remote'/g)).toHaveLength(2);
        expect(patch).toContain('lib/cjs/config/joined-config.js');
        expect(patch).toContain('lib/esm/config/joined-config.js');
        expect(patch.indexOf("source !== 'remote'"))
            .toBeLessThan(patch.indexOf('JSON.stringify(remoteConfig'));
    });

    it('masks core route containers while retaining private and media blocks', () => {
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

        expect(landing).toContain('data-amp-mask');
        expect(analyze.match(/data-amp-mask/g)?.length).toBeGreaterThanOrEqual(2);
        expect(analyze).toMatch(/<main[^>]*data-amp-mask/);
        expect(login).toMatch(/<main[^>]*data-amp-mask/);
        expect(mypage).toMatch(/<main[^>]*data-amp-mask/);
        expect(earlybirdPage).toMatch(/<main[^>]*data-amp-mask/);
        expect(earlybird).toContain('data-amp-block');
        expect(history).toContain('data-amp-block');
        expect(progress).toMatch(/<main[^>]*data-amp-mask/);
        expect(result).toMatch(/<main[^>]*data-amp-mask/);
        expect(shared).toMatch(/<main[^>]*data-amp-mask/);
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

    it('never opts app or component DOM back into replay visibility', () => {
        const files = [
            ...tsxFiles('app/'),
            ...tsxFiles('components/'),
        ];

        for (const file of files) {
            const contents = readFileSync(file, 'utf8');
            expect(contents, file).not.toMatch(/amp-unmask|data-amp-unmask/);
        }
    });
});
