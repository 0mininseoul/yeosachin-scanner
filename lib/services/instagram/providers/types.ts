import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

export type Capability = 'profile' | 'profilesBatch' | 'followers' | 'following';

export type ProviderName = 'apify' | 'rapidapi' | 'selfhosted';

/**
 * 스크래핑 프로바이더. 각 프로바이더는 지원하는 기능만 구현한다.
 * (예: rapidapi는 getFollowing만, selfhosted는 getProfile/getProfilesBatch만)
 */
export interface ScraperProvider {
    readonly name: ProviderName;
    getProfile?(username: string): Promise<InstagramProfile | null>;
    getFollowers?(username: string, limit: number): Promise<InstagramFollower[]>;
    getFollowing?(username: string, limit: number): Promise<InstagramFollower[]>;
    getProfilesBatch?(usernames: string[], batchSize?: number): Promise<InstagramProfile[]>;
}
