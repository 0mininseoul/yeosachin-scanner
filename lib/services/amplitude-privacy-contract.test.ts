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
    it('uses conservative default masking with no unmask selector', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain("defaultMaskLevel: 'conservative'");
        expect(analytics).not.toContain('unmaskSelector');
    });

    it('keeps replay and interaction capture fail-closed until URL privacy is proven', () => {
        const analytics = source('lib/services/analytics.ts');

        expect(analytics).toContain('sampleRate: 0');
        expect(analytics).toContain('capture_enabled: false');
        expect(analytics).toContain('interactionConfig: { enabled: false, batch: false }');
        expect(analytics).not.toContain('ugcFilterRules');
        expect(analytics).not.toContain('handleSendEvents');
    });

    it('masks target inputs and blocks every sensitive route container', () => {
        const landing = source('app/page.tsx');
        const analyze = source('app/analyze/page.tsx');
        const earlybird = source('app/earlybird/earlybird-status.tsx');
        const history = source('app/mypage/analysis-list.tsx');
        const progress = source('app/progress/[requestId]/page.tsx');
        const result = source('app/result/[requestId]/page.tsx');
        const shared = source('app/share/[token]/page.tsx');

        expect(landing).toContain('data-amp-mask');
        expect(analyze.match(/data-amp-mask/g)?.length).toBeGreaterThanOrEqual(2);
        expect(analyze).toContain('data-amp-block');
        expect(earlybird).toContain('data-amp-block');
        expect(history).toContain('data-amp-block');
        expect(progress).toMatch(/<main[^>]*data-amp-block/);
        expect(result).toMatch(/<main[^>]*data-amp-block/);
        expect(shared).toMatch(/<main[^>]*data-amp-block/);
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
