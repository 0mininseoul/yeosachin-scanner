import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
}

/* Two share bugs shipped in a row from the same root cause: work that has to
 * happen inside the tap was put behind an await, so by the time it ran the
 * browser no longer counted it as user-initiated. iOS then blocked Kakao's
 * sheet and the Instagram scheme, and the silent fallbacks hid it.
 *
 * These are source-shape assertions rather than behaviour tests because the
 * failure only reproduces in a real mobile browser, where nothing in CI runs.
 */
describe('share actions keep their user gesture', () => {
    const actions = source('components/result-actions.tsx');

    it('hands off to the Instagram app without awaiting anything first', () => {
        const handler = actions.match(/const shareToInstagramDm = [\s\S]*?\n  };/)?.[0];
        expect(handler, 'shareToInstagramDm should be findable').toBeTruthy();

        // An async handler is the exact shape that lost the gesture before.
        expect(handler).not.toMatch(/^const shareToInstagramDm = async/);
        expect(handler).not.toMatch(/\bawait\b/);
        expect(handler).toContain('INSTAGRAM_DM_APP_URL');
    });

    it('copies through the clipboard API, not execCommand', () => {
        const handler = actions.match(/const shareToInstagramDm = [\s\S]*?\n  };/)?.[0];
        // execCommand reports success on iOS while copying nothing, which left a
        // "복사했어요" notice sitting over an empty clipboard.
        const api = handler!.indexOf('navigator.clipboard?.writeText');
        const legacy = handler!.indexOf('copyTextSync');
        expect(api).toBeGreaterThan(-1);
        expect(legacy, 'copyTextSync must remain the fallback').toBeGreaterThan(api);
        expect(handler).toMatch(/else if \(!copyTextSync/);
    });

    it('opens the app from its own tap, never from a timer', () => {
        const handler = actions.match(/const shareToInstagramDm = [\s\S]*?\n  };/)?.[0];
        // A scheme navigation on a timer has drifted out of the tap that caused
        // it, and the browser interrupts with "open another app?" — worse to
        // meet than one more button.
        expect(handler).not.toMatch(/setTimeout/);
        expect(handler).toMatch(/action: \{[\s\S]*?label: '인스타그램 열기'/);
    });

    it('holds the Kakao item back until the share link exists', () => {
        // Without this gate the tap falls through to the async path, loses the
        // gesture, and surfaces as the OS share sheet instead of KakaoTalk.
        expect(actions).toMatch(/disabled=\{kakaoBusy \|\| \(kakaoAvailable && !shareUrl\)\}/);
    });

    it('starts the slow preparation on press, not on click', () => {
        expect(actions).toContain('onPointerDown');
        expect(actions).toMatch(/onPointerDown=\{\(\) => \{ if \(!open\) onPrepare\?\.\(\); \}\}/);
    });

    it('renders the notice through a portal so a transform cannot capture it', () => {
        expect(actions).toContain('createPortal');
        expect(actions).toMatch(/createPortal\([\s\S]*?document\.body/);
    });
});

describe('the Kakao path never degrades to the OS share sheet', () => {
    const page = source('app/result/[requestId]/page.tsx');

    it('only reaches navigator.share when Kakao was never configured', () => {
        const handler = page.match(/const handleKakaoShare = [\s\S]*?\n {4}\};/)?.[0];
        expect(handler, 'handleKakaoShare should be findable').toBeTruthy();

        // The synchronous send comes first...
        const syncSend = handler!.indexOf('shareToKakaoNow');
        // ...and the async fallback is fenced off behind the missing-key check.
        const keyGuard = handler!.indexOf("kakaoJavascriptKey() !== null");
        const asyncFallback = handler!.indexOf('shareResultToKakao');

        expect(syncSend).toBeGreaterThan(-1);
        expect(keyGuard).toBeGreaterThan(syncSend);
        expect(asyncFallback).toBeGreaterThan(keyGuard);
    });

    it('mints the token and warms the SDK concurrently', () => {
        // These were sequential once; the round trip alone outran the tap.
        expect(page).toMatch(/await Promise\.all\(\[\s*\n\s*readyKakao\(\),/);
    });
});
