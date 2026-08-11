import { describe, expect, it } from 'vitest';
import { isReplayAllowedPath, replayFieldDisposition } from './analytics-replay-allowlist';

describe('Replay allowlist', () => {
    it('allows result/share content but rejects arbitrary and credential paths', () => {
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
