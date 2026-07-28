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
        description: string;
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

function loadKakaoSdk(): Promise<KakaoSdk | null> {
    if (typeof window === 'undefined') return Promise.resolve(null);
    if (window.Kakao) return Promise.resolve(window.Kakao);

    return new Promise((resolve) => {
        const existing = document.getElementById(KAKAO_SDK_ELEMENT_ID);
        if (existing) {
            existing.addEventListener('load', () => resolve(window.Kakao ?? null), { once: true });
            existing.addEventListener('error', () => resolve(null), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.id = KAKAO_SDK_ELEMENT_ID;
        script.src = KAKAO_SDK_SRC;
        script.integrity = KAKAO_SDK_INTEGRITY;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.addEventListener('load', () => resolve(window.Kakao ?? null), { once: true });
        script.addEventListener('error', () => resolve(null), { once: true });
        document.head.appendChild(script);
    });
}

/** Resolves to the initialized SDK, or null when the key is unset or the CDN is unreachable. */
export async function readyKakao(): Promise<KakaoSdk | null> {
    const key = kakaoJavascriptKey();
    if (!key) return null;
    const sdk = await loadKakaoSdk();
    if (!sdk?.Share) return null;
    try {
        if (!sdk.isInitialized()) sdk.init(key);
    } catch {
        return null;
    }
    return sdk.isInitialized() ? sdk : null;
}

export interface ResultShareContent {
    /** Publicly reachable destination. Never an auth-gated result URL. */
    url: string;
    title: string;
    description: string;
    imageUrl: string;
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
        const link = { mobileWebUrl: content.url, webUrl: content.url };
        try {
            sdk.Share.sendDefault({
                objectType: 'feed',
                content: {
                    title: content.title,
                    description: content.description,
                    imageUrl: content.imageUrl,
                    link,
                },
                buttons: [{ title: '나도 판독해보기', link }],
            });
            return 'kakao';
        } catch {
            // fall through to the platform share sheet
        }
    }

    if (fallbacks.share) {
        try {
            await fallbacks.share({
                title: content.title,
                text: content.description,
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
