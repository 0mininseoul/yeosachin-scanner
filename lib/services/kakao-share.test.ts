import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* The Kakao SDK attaches its modules during init(), not on script load.
 *
 * Straight from a real browser probe of kakao.min.js 2.7.4:
 *   after load      -> Object.keys(Kakao) = ['VERSION', 'cleanup', 'init', 'isInitialized']
 *   after init(key) -> ... plus ['Auth', 'API', 'Share', 'Channel', 'Navi', 'Picker', 'Cert']
 *
 * Checking for `Share` before calling init() therefore always fails. It did,
 * silently, and every share fell through to the OS share sheet instead.
 */
function fakeKakaoSdk() {
    let initialized = false;
    const sendDefault = vi.fn();
    const sdk: Record<string, unknown> = {
        VERSION: '2.7.4',
        isInitialized: () => initialized,
        init(key: string) {
            if (!key) throw new Error('key required');
            initialized = true;
            // Modules only exist from here on, exactly like the real SDK.
            sdk.Share = { sendDefault };
            sdk.Auth = {};
            sdk.API = {};
        },
    };
    return { sdk, sendDefault };
}

const KEY = 'a'.repeat(32);

describe('kakao SDK readiness', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.NEXT_PUBLIC_KAKAO_JS_KEY = KEY;
        vi.stubGlobal('window', {} as unknown as Window);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.NEXT_PUBLIC_KAKAO_JS_KEY;
    });

    it('initializes before looking for the Share module', async () => {
        const { sdk } = fakeKakaoSdk();
        (globalThis as { window: { Kakao?: unknown } }).window.Kakao = sdk;
        expect(sdk.Share, 'Share must be absent before init, like the real SDK').toBeUndefined();

        const { readyKakao } = await import('./kakao-share');
        const ready = await readyKakao();

        expect(ready, 'readyKakao must not bail on the pre-init absence of Share').not.toBeNull();
        expect(sdk.Share).toBeDefined();
    });

    it('reports the SDK as ready only once init has attached Share', async () => {
        const { sdk } = fakeKakaoSdk();
        (globalThis as { window: { Kakao?: unknown } }).window.Kakao = sdk;

        const { kakaoSdkIfReady, readyKakao } = await import('./kakao-share');
        expect(kakaoSdkIfReady(), 'not ready before init').toBeNull();

        await readyKakao();
        expect(kakaoSdkIfReady(), 'ready after init').not.toBeNull();
    });

    it('sends through Share once ready', async () => {
        const { sdk, sendDefault } = fakeKakaoSdk();
        (globalThis as { window: { Kakao?: unknown } }).window.Kakao = sdk;

        const { readyKakao, shareToKakaoNow } = await import('./kakao-share');
        await readyKakao();

        const onError = vi.fn();
        const sent = shareToKakaoNow(
            { url: 'https://yeosachin.com/share/abc', title: '판독 결과', imageUrl: 'https://yeosachin.com/i.png' },
            onError,
        );

        expect(sent).toBe(true);
        expect(onError).not.toHaveBeenCalled();
        expect(sendDefault).toHaveBeenCalledOnce();
        const template = sendDefault.mock.calls[0][0];
        expect(template.objectType).toBe('feed');
        expect(template.content.imageUrl).toBe('https://yeosachin.com/i.png');
        // The link the reader taps must be the result, never the bare origin.
        expect(template.content.link.mobileWebUrl).toBe('https://yeosachin.com/share/abc');
        // No summary line rides along with the card.
        expect(template.content).not.toHaveProperty('description');
    });

    it('reports SDK_NOT_READY rather than sending when init never ran', async () => {
        const { sdk, sendDefault } = fakeKakaoSdk();
        (globalThis as { window: { Kakao?: unknown } }).window.Kakao = sdk;

        const { shareToKakaoNow } = await import('./kakao-share');
        const onError = vi.fn();
        const sent = shareToKakaoNow(
            { url: 'https://yeosachin.com/share/abc', title: '판독 결과', imageUrl: 'https://yeosachin.com/i.png' },
            onError,
        );

        expect(sent).toBe(false);
        expect(onError).toHaveBeenCalledWith('SDK_NOT_READY');
        expect(sendDefault).not.toHaveBeenCalled();
    });

    it('stays null when no key is configured', async () => {
        delete process.env.NEXT_PUBLIC_KAKAO_JS_KEY;
        const { sdk } = fakeKakaoSdk();
        (globalThis as { window: { Kakao?: unknown } }).window.Kakao = sdk;

        const { readyKakao } = await import('./kakao-share');
        expect(await readyKakao()).toBeNull();
        expect(sdk.Share, 'must not initialize without a key').toBeUndefined();
    });
});
