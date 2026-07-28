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
