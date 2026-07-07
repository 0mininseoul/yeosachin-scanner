import type { InstagramFollower } from '@/lib/types/instagram';
import { getTransportConfig, buildRequest, type TransportConfig } from './transport';
import { IG_APP_ID, USER_AGENT, fetchWebProfileUser } from './web-client';
import { parseSessions, pickSession, type IgSession } from './session';

export type FriendshipKind = 'followers' | 'following';

interface FriendshipResponse {
    users?: unknown[];
    next_max_id?: string | number | null;
    status?: string;
}

const NO_SESSION =
    'SCRAPING_ERROR: 자체 팔로워/팔로잉 수집에 세션이 없습니다. IG_SESSIONS(또는 IG_SESSION_ID/IG_CSRF_TOKEN/IG_DS_USER_ID)를 설정하거나 SCRAPER_FOLLOWERS/FOLLOWING을 apify/rapidapi로 두세요.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mapFriendshipUser(item: unknown): InstagramFollower | null {
    if (!item || typeof item !== 'object') return null;
    const u = item as Record<string, unknown>;
    if (typeof u.username !== 'string' || u.username.length === 0) return null;
    return {
        username: u.username,
        fullName: (u.full_name as string) || undefined,
        profilePicUrl: (u.profile_pic_url as string) || undefined,
        isPrivate: (u.is_private as boolean) ?? false,
        isVerified: (u.is_verified as boolean) ?? false,
    };
}

function friendshipUrl(userId: string, kind: FriendshipKind, pageSize: number, maxId?: string): string {
    const base = `https://www.instagram.com/api/v1/friendships/${encodeURIComponent(userId)}/${kind}/?count=${pageSize}`;
    return maxId ? `${base}&max_id=${encodeURIComponent(maxId)}` : base;
}

/** 기본 요청 구현: transport(프록시)를 통해 세션 쿠키로 friendships 엔드포인트 호출 */
async function defaultRequest(
    url: string,
    session: IgSession,
    transport: TransportConfig
): Promise<FriendshipResponse> {
    const { url: reqUrl, dispatcher } = buildRequest(url, transport);
    const response = await fetch(reqUrl, {
        headers: {
            'x-ig-app-id': IG_APP_ID,
            'x-csrftoken': session.csrfToken,
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: 'https://www.instagram.com/',
            Cookie: `sessionid=${session.sessionId}; csrftoken=${session.csrfToken}; ds_user_id=${session.userId}`,
        },
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    if (response.status === 401 || response.status === 403) {
        throw new Error(`SCRAPING_AUTH_ERROR: 세션이 만료/차단되었습니다 (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: friendships 요청 실패 (HTTP ${response.status}).`);
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new Error('SCRAPING_ERROR: friendships 응답 파싱 실패 (차단되었을 수 있습니다).');
    }
    return json as FriendshipResponse;
}

async function defaultResolveUserId(username: string): Promise<string | null> {
    const user = await fetchWebProfileUser(username);
    const id = user?.id;
    return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null;
}

export interface FriendshipDeps {
    sessions?: IgSession[];
    resolveUserId?: (username: string) => Promise<string | null>;
    request?: (userId: string, kind: FriendshipKind, maxId: string | undefined, session: IgSession) => Promise<FriendshipResponse>;
    transport?: TransportConfig;
    pageSize?: number;
    delayMs?: number;
    maxPages?: number;
}

async function fetchFriendship(
    username: string,
    limit: number,
    kind: FriendshipKind,
    deps: FriendshipDeps = {}
): Promise<InstagramFollower[]> {
    const sessions = deps.sessions ?? parseSessions();
    const session = pickSession(sessions);
    if (!session) throw new Error(NO_SESSION);

    const resolveUserId = deps.resolveUserId ?? defaultResolveUserId;
    const transport = deps.transport ?? getTransportConfig();
    const pageSize = deps.pageSize ?? 50;
    const delayMs = deps.delayMs ?? 800;
    const maxPages = deps.maxPages ?? 200;
    const request =
        deps.request ??
        ((userId: string, k: FriendshipKind, maxId: string | undefined) =>
            defaultRequest(friendshipUrl(userId, k, pageSize, maxId), session, transport));

    const userId = await resolveUserId(username);
    if (!userId) {
        throw new Error('SCRAPING_ERROR: 대상 계정의 user_id를 확인할 수 없습니다.');
    }

    const collected: InstagramFollower[] = [];
    let maxId: string | undefined;

    for (let page = 0; page < maxPages; page++) {
        const res = await request(userId, kind, maxId, session);
        for (const raw of res.users ?? []) {
            const mapped = mapFriendshipUser(raw);
            if (mapped) collected.push(mapped);
        }
        if (collected.length >= limit) break;

        const next = res.next_max_id;
        if (next === undefined || next === null || next === '') break;
        maxId = String(next);
        if (delayMs > 0) await sleep(delayMs);
    }

    return collected.slice(0, limit);
}

export async function fetchFollowers(
    username: string,
    limit: number,
    deps?: FriendshipDeps
): Promise<InstagramFollower[]> {
    return fetchFriendship(username, limit, 'followers', deps);
}

export async function fetchFollowing(
    username: string,
    limit: number,
    deps?: FriendshipDeps
): Promise<InstagramFollower[]> {
    return fetchFriendship(username, limit, 'following', deps);
}
