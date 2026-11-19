import {
    KAKAO_ATTRIBUTION_COOKIE,
    readKakaoSignupAttribution,
} from '@/lib/services/identity/kakao-signup-attribution';

/** Same shape the DB check enforces on earlybird_orders.client_device_label. */
export const CLIENT_DEVICE_LABEL_PATTERN = /^[A-Za-z0-9가-힣 ·]{1,40}$/;

function platformOf(userAgent: string): string {
    if (/iPhone/.test(userAgent)) return 'iPhone';
    if (/iPad/.test(userAgent)) return 'iPad';
    if (/Android/.test(userAgent)) return 'Android';
    if (/Macintosh|Mac OS X/.test(userAgent)) return 'Mac';
    if (/Windows/.test(userAgent)) return 'Windows';
    if (/Linux/.test(userAgent)) return 'Linux';
    return '기타';
}

function inAppOf(userAgent: string): string | null {
    if (/KAKAOTALK/i.test(userAgent)) return '카카오톡 인앱';
    if (/Instagram/.test(userAgent)) return '인스타 인앱';
    if (/FBAN|FBAV/.test(userAgent)) return '페이스북 인앱';
    if (/NAVER\(inapp/i.test(userAgent)) return '네이버 인앱';
    return null;
}

function browserOf(userAgent: string): string {
    if (/SamsungBrowser/.test(userAgent)) return '삼성 인터넷';
    if (/Whale/.test(userAgent)) return 'Whale';
    if (/Edg(e|A|iOS)?\//.test(userAgent)) return 'Edge';
    if (/OPR\/|Opera/.test(userAgent)) return 'Opera';
    if (/FxiOS|Firefox\//.test(userAgent)) return 'Firefox';
    if (/CriOS|Chrome\//.test(userAgent)) return 'Chrome';
    if (/Safari\//.test(userAgent)) return 'Safari';
    return '기타 브라우저';
}

/**
 * Reduces a User-Agent to a short label such as "iPhone · Safari".
 * The raw User-Agent is never returned or stored.
 */
export function classifyClientDevice(userAgent: string | null | undefined): string | null {
    const value = userAgent?.slice(0, 1024).trim();
    if (!value) return null;
    const label = `${platformOf(value)} · ${inAppOf(value) ?? browserOf(value)}`;
    return CLIENT_DEVICE_LABEL_PATTERN.test(label) ? label : null;
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
        const raw = part.slice(separator + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Reads the bounded first-touch label the proxy stores for every production
 * visitor. Returns one of the nine fixed labels or null.
 */
export function attributionLabelFromCookieHeader(cookieHeader: string | null | undefined): string | null {
    return readKakaoSignupAttribution(cookieValue(cookieHeader, KAKAO_ATTRIBUTION_COOKIE)).label;
}
