import type { InstagramFollower } from '@/lib/types/instagram';

const NOT_IMPLEMENTED =
    'SCRAPING_ERROR: 자체 팔로워/팔로잉 수집은 2단계에서 지원됩니다. 현재는 SCRAPER_FOLLOWERS/FOLLOWING을 apify/rapidapi로 두거나 SCRAPER_FALLBACK=true를 사용하세요.';

/** [2단계 스캐폴드] friendships/{id}/followers — 세션 필요. 현재 미구현. */
export async function fetchFollowers(_username: string, _limit: number): Promise<InstagramFollower[]> {
    throw new Error(NOT_IMPLEMENTED);
}

/** [2단계 스캐폴드] friendships/{id}/following — 세션 필요. 현재 미구현. */
export async function fetchFollowing(_username: string, _limit: number): Promise<InstagramFollower[]> {
    throw new Error(NOT_IMPLEMENTED);
}
