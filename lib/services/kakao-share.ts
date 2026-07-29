/**
 * Kakao JavaScript SDK loader and share helper.
 *
 * The JavaScript key is a public, domain-restricted client credential — it ships
 * in the bundle by design and is not a secret. It still comes from an env var so
 * it can be rotated or pointed at a different Kakao app per environment without
 * a code change.
 *
 * Integrity hash was computed from the served file:
 *   curl -s https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js \
 *     | openssl dgst -sha384 -binary | openssl base64 -A
 */

const KAKAO_SDK_SRC = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js';
const KAKAO_SDK_INTEGRITY = 'sha384-DKYJZ8NLiK8MN4/C5P2dtSmLQ4KwPaoqAfyA/DfmEc1VDxu4yyC7wy6K1Hs90nka';
const KAKAO_SDK_ELEMENT_ID = 'kakao-js-sdk';

interface KakaoShareLink {
    mobileWebUrl: string;
    webUrl: string;
}

interface KakaoFeedTemplate {
    objectType: 'feed';
    content: {
        title: string;
        description?: string;
        imageUrl: string;
        link: KakaoShareLink;
    };
    buttons: { title: string; link: KakaoShareLink }[];
}

interface KakaoSdk {
    isInitialized(): boolean;
    init(key: string): void;
    Share?: { sendDefault(template: KakaoFeedTemplate): void };
}

declare global {
    interface Window {
        Kakao?: KakaoSdk;
    }
}

export function kakaoJavascriptKey(): string | null {
    const key = process.env.NEXT_PUBLIC_KAKAO_JS_KEY;
    return key && key.trim().length > 0 ? key.trim() : null;
}

/* Memoized so a second caller joins the in-flight load instead of listening to
   a script element whose load event may already have fired — those listeners
   would never run, leaving the promise pending forever. */
let sdkLoad: Promise<KakaoSdk | null> | null = null;

function loadKakaoSdk(): Promise<KakaoSdk | null> {
    if (typeof window === 'undefined') return Promise.resolve(null);
    if (window.Kakao) return Promise.resolve(window.Kakao);
    if (sdkLoad) return sdkLoad;

    sdkLoad = new Promise<KakaoSdk | null>((resolve) => {
        const failed = () => {
            // Drop the dead element and the memo so a later attempt can retry.
            document.getElementById(KAKAO_SDK_ELEMENT_ID)?.remove();
            sdkLoad = null;
            resolve(null);
        };
        const script = document.createElement('script');
        script.id = KAKAO_SDK_ELEMENT_ID;
        script.src = KAKAO_SDK_SRC;
        script.integrity = KAKAO_SDK_INTEGRITY;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.addEventListener('load', () => {
            if (window.Kakao) resolve(window.Kakao);
            else failed();
        }, { once: true });
        script.addEventListener('error', failed, { once: true });
        document.head.appendChild(script);
    });
    return sdkLoad;
}

/**
 * The initialized SDK if it is already sitting in the page, without awaiting.
 *
 * Kakao opens a popup, and Safari only allows that inside the task that handled
 * the tap. Any `await` that crosses a network boundary loses it, so the click
 * path has to be able to reach the SDK synchronously — call `readyKakao()`
 * earlier (on intent) so this returns something by the time it matters.
 */
export function kakaoSdkIfReady(): KakaoSdk | null {
    if (typeof window === 'undefined') return null;
    const sdk = window.Kakao;
    if (!sdk) return null;
    try {
        // `Share` is attached by init(), so it is only meaningful once the SDK
        // reports itself initialized — see readyKakao().
        return sdk.isInitialized() && sdk.Share ? sdk : null;
    } catch {
        return null;
    }
}

/** Resolves to the initialized SDK, or null when the key is unset or the CDN is unreachable.
 *
 * Loading the script only gives you `Kakao` with `VERSION`, `init` and
 * `isInitialized` on it. Every module — `Share` included — is attached by
 * `init()`. Testing for `Share` before initializing therefore always fails, and
 * fails silently, which is what kept KakaoTalk share from ever running.
 */
export async function readyKakao(): Promise<KakaoSdk | null> {
    const key = kakaoJavascriptKey();
    if (!key) return null;
    const sdk = await loadKakaoSdk();
    if (!sdk) return null;
    try {
        if (!sdk.isInitialized()) sdk.init(key);
    } catch {
        return null;
    }
    return sdk.isInitialized() && sdk.Share ? sdk : null;
}

export interface ResultShareContent {
    /** Publicly reachable destination. Never an auth-gated result URL. */
    url: string;
    title: string;
    /** One factual line under the title. Never a teaser about what was found. */
    description?: string;
    imageUrl: string;
}

/** The feed card. Kakao ignores the page's own OG tags and uses only this. */
function feedTemplate(content: ResultShareContent): KakaoFeedTemplate {
    const link = { mobileWebUrl: content.url, webUrl: content.url };
    return {
        objectType: 'feed',
        content: {
            title: content.title,
            ...(content.description ? { description: content.description } : {}),
            imageUrl: content.imageUrl,
            link,
        },
        buttons: [{ title: '결과 보기', link }],
    };
}

/**
 * Sends through Kakao in the same task as the tap. Returns false when the SDK is
 * not ready, leaving the caller to fall back.
 */
export function shareToKakaoNow(
    content: ResultShareContent,
    /* Surfaced rather than swallowed. A bare catch here once hid a bug for this
       feature's whole life: every send failed, the caller quietly fell back to
       the OS share sheet, and nothing ever said why. */
    onError?: (reason: string) => void,
): boolean {
    const sdk = kakaoSdkIfReady();
    if (!sdk?.Share) {
        onError?.('SDK_NOT_READY');
        return false;
    }
    try {
        sdk.Share.sendDefault(feedTemplate(content));
        return true;
    } catch (error) {
        onError?.(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        return false;
    }
}

export type ShareChannel = 'kakao' | 'web_share' | 'clipboard';

interface ShareFallbacks {
    share?: (data: { title: string; text: string; url: string }) => Promise<void>;
    writeText?: (text: string) => Promise<void>;
}

/**
 * Sends the share through Kakao when it is available, otherwise falls back to the
 * Web Share sheet and finally the clipboard. Returns the channel actually used so
 * the caller can report it to analytics, or null when every channel failed.
 */
export async function shareResultToKakao(
    content: ResultShareContent,
    fallbacks: ShareFallbacks = {},
): Promise<ShareChannel | null> {
    const sdk = await readyKakao();
    if (sdk?.Share) {
        try {
            sdk.Share.sendDefault(feedTemplate(content));
            return 'kakao';
        } catch {
            // fall through to the platform share sheet
        }
    }

    if (fallbacks.share) {
        try {
            await fallbacks.share({
                title: content.title,
                text: content.title,
                url: content.url,
            });
            return 'web_share';
        } catch {
            // fall through to the clipboard
        }
    }

    if (fallbacks.writeText) {
        try {
            await fallbacks.writeText(content.url);
            return 'clipboard';
        } catch {
            return null;
        }
    }

    return null;
}
