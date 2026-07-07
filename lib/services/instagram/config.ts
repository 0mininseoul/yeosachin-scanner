import type { Capability, ProviderName } from './providers/types';

export interface ScraperConfig {
    profile: ProviderName;
    profilesBatch: ProviderName;
    followers: ProviderName;
    following: ProviderName;
    fallback: boolean;
}

/** 기능별 외부(비-selfhosted) 기본 프로바이더 — 폴백 대상이자 초기 기본값 */
export const EXTERNAL_DEFAULT: Record<Capability, ProviderName> = {
    profile: 'apify',
    profilesBatch: 'apify',
    followers: 'apify',
    following: 'rapidapi',
};

const VALID: Record<Capability, ProviderName[]> = {
    profile: ['apify', 'selfhosted'],
    profilesBatch: ['apify', 'selfhosted'],
    followers: ['apify', 'selfhosted'],
    following: ['rapidapi', 'selfhosted'],
};

function pick(capability: Capability, raw: string | undefined): ProviderName {
    const value = (raw || '').trim() as ProviderName;
    if (VALID[capability].includes(value)) return value;
    return EXTERNAL_DEFAULT[capability];
}

export function getScraperConfig(
    env: Record<string, string | undefined> = process.env
): ScraperConfig {
    return {
        profile: pick('profile', env.SCRAPER_PROFILE),
        profilesBatch: pick('profilesBatch', env.SCRAPER_PROFILES_BATCH),
        followers: pick('followers', env.SCRAPER_FOLLOWERS),
        following: pick('following', env.SCRAPER_FOLLOWING),
        fallback: env.SCRAPER_FALLBACK === 'true',
    };
}
