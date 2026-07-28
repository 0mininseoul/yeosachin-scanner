export const KAKAO_ATTRIBUTION_COOKIE = 'kakao_signup_attribution';
const LABELS = new Set(['직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타', '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타']);

function sourceLabel(value: string): string {
    if (value.toLowerCase() === 'kakao') return '카카오';
    if (value.toLowerCase() === 'google') return '구글';
    if (value.toLowerCase() === 'instagram') return '인스타그램';
    return '기타';
}

/** Produces only a bounded label; raw query/referrer values are never retained. */
export function classifyKakaoSignupAttribution(search: string, referrer: string): string {
    const source = new URLSearchParams(search).get('utm_source');
    if (source && /^[a-z]{2,20}$/i.test(source)) return `UTM: ${sourceLabel(source)}`;
    try {
        const host = new URL(referrer).hostname.toLowerCase();
        if (/(^|\.)kakao\.com$/.test(host)) return '외부 참조: 카카오';
        if (/(^|\.)google\.[a-z.]+$/.test(host)) return '외부 참조: 구글';
        if (/(^|\.)instagram\.com$/.test(host)) return '외부 참조: 인스타그램';
        return host ? '외부 참조: 기타' : '직접 방문';
    } catch { return '직접 방문'; }
}

export function validKakaoSignupAttribution(value: string | undefined): string | null {
    return value && LABELS.has(value) ? value : null;
}

/** Only a public HTTP(S) origin survives; paths, query, fragments and credentials never do. */
export function normalizeKakaoReferrerOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.port
            || !/^[a-z0-9][a-z0-9.-]{0,251}$/.test(host) || host === 'localhost' || host.endsWith('.local')
            || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /^10\.|^127\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null;
        return `${url.protocol}//${host}/`;
    } catch { return null; }
}

export function encodeKakaoSignupAttribution(label: string, origin: string | null): string {
    return origin ? `${label}|${origin}` : label;
}

export function readKakaoSignupAttribution(value: string | undefined): { label: string | null; origin: string | null } {
    const [label, origin, extra] = value?.split('|') ?? [];
    return { label: extra ? null : validKakaoSignupAttribution(label), origin: extra ? null : normalizeKakaoReferrerOrigin(origin ?? '') };
}
