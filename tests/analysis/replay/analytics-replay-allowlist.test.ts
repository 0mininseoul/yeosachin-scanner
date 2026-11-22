import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { maskFn } from '../../../node_modules/@amplitude/session-replay-browser/lib/cjs/helpers';
import { isReplayAllowedPath, replayFieldDisposition } from '../../../lib/services/analytics-replay-allowlist';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string) => { window: { document: Document } };
};

describe('Replay allowlist', () => {
    it('masks contact details mirrored into the cherry invitation', () => {
        const html = readFileSync('public/namchin/index.html', 'utf8');
        const document = new JSDOM(html).window.document;
        const mask = maskFn('text', { defaultMaskLevel: 'light', maskSelector: ['[data-amp-mask]'] });
        for (const selector of ['[data-pass-email]', '[data-pass-phone]']) {
            const element = document.querySelector<HTMLElement>(selector);
            expect(element).not.toBeNull();
            expect(mask('private@example.com', element)).not.toContain('private');
        }
    });
    it('allows result/share content but rejects arbitrary and credential paths', () => {
        expect(isReplayAllowedPath('/cherry')).toBe(true);
        expect(isReplayAllowedPath('/cherry/private')).toBe(false);
        expect(isReplayAllowedPath('/result/123')).toBe(true);
        expect(isReplayAllowedPath('/share/token_123')).toBe(true);
        expect(isReplayAllowedPath('/result/123?token=secret')).toBe(false);
        expect(isReplayAllowedPath('/admin/debug')).toBe(false);
    });
    it('defaults new result descendants to blocked until explicitly marked', () => {
        expect(replayFieldDisposition({ isResultContent: true, hasAllowMarker: false, containsSensitiveInput: false })).toBe('block');
        expect(replayFieldDisposition({ isResultContent: true, hasAllowMarker: true, containsSensitiveInput: false })).toBe('allow');
        expect(replayFieldDisposition({ isResultContent: true, hasAllowMarker: true, containsSensitiveInput: true })).toBe('mask');
    });
});
