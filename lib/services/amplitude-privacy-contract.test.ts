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

    it('requires production-only explicit bounded sampling and a fail-closed remote acknowledgement', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain("NEXT_PUBLIC_VERCEL_ENV === 'production'");
        expect(analytics).toContain("NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED !== 'true'");
        expect(analytics).toContain('SESSION_REPLAY_MAX_SAMPLE_RATE = 0.1');
        expect(analytics).toContain("/^0\\.(?:0[1-9]|1|10)$/.test(rawSampleRate)");
        expect(analytics).toContain('captureEnabled: false, sampleRate: 0');
        expect(analytics).toContain('hasExpectedReplaySampling');
        expect(analytics).toContain('isTrustedReplayConfigUrl');
        expect(analytics).toContain('sampleRate: 0');
        expect(analytics).toContain('interactionConfig: { enabled: false, batch: false }');
        expect(analytics).not.toContain('ugcFilterRules');
        expect(analytics).toContain('handleSendEvents: createSafeSessionReplaySender(apiKey)');
        expect(analytics).toContain("'[contenteditable]'");
    });

    it('masks every form control and blocks media plus every sensitive route container', () => {
        const landing = source('app/page.tsx');
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
        expect(analyze).toContain('data-amp-block');
        expect(login).toContain('data-amp-block');
        expect(mypage).toContain('data-amp-block');
        expect(earlybirdPage).toContain('data-amp-block');
        expect(earlybird).toContain('data-amp-block');
        expect(history).toContain('data-amp-block');
        expect(progress).toMatch(/<main[^>]*data-amp-block/);
        expect(result).toMatch(/<main[^>]*data-amp-block/);
        expect(shared).toMatch(/<main[^>]*data-amp-block/);
    });

    it('does not send route values into replay lifecycle calls', () => {
        const provider = source('components/amplitude-provider.tsx');
        const analytics = source('lib/services/analytics.ts');

        expect(provider).toContain('enforceAmplitudeReplayRoutePrivacy()');
        expect(provider).not.toMatch(/enforceAmplitudeReplayRoutePrivacy\([^)]/);
        expect(analytics).toContain('SESSION_REPLAY_SAFE_PATHS');
        expect(analytics).toContain('location.search.length === 0');
        expect(analytics).toContain('location.hash.length === 0');
        expect(provider).toContain('installAmplitudeReplayNavigationGuards()');
    });

    it('derives demo replay shutdown from the server-only deployment flag', () => {
        const layout = source('app/layout.tsx');
        const provider = source('components/amplitude-provider.tsx');
        const analytics = source('lib/services/analytics.ts');

        expect(layout).toContain('process.env.DEMO_ANALYSIS_ENABLED === "true"');
        expect(layout).toContain('data-amplitude-demo-mode');
        expect(layout).toContain('demoAnalysisEnabled={demoAnalysisEnabled}');
        expect(provider).toContain('updateAmplitudeReplayRuntimeContext({ demoAnalysisEnabled })');
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
