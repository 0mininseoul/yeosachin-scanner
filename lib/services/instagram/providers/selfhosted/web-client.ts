import { getTransportConfig, buildRequest, type TransportConfig } from './transport';

const IG_APP_ID = '936619743392459';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function profileUrl(username: string): string {
    return `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

/**
 * web_profile_info를 호출해 data.user를 반환.
 * - 계정 없음(404/유효 JSON에 user 없음) → null
 * - 차단/네트워크/파싱 오류 → throw (라우터 폴백 트리거 가능)
 */
export async function fetchWebProfileUser(
    username: string,
    cfg: TransportConfig = getTransportConfig()
): Promise<Record<string, unknown> | null> {
    const { url, dispatcher } = buildRequest(profileUrl(username), cfg);

    const response = await fetch(url, {
        headers: {
            'x-ig-app-id': IG_APP_ID,
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        },
        // undici 확장 옵션
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: web_profile_info 요청 실패 (HTTP ${response.status}).`);
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new Error('SCRAPING_ERROR: 프로필 응답 파싱 실패 (차단되었을 수 있습니다).');
    }

    const user = (json as { data?: { user?: Record<string, unknown> } })?.data?.user;
    if (!user || typeof user !== 'object') return null;
    return user;
}
