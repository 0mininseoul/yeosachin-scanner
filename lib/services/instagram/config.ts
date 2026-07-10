import type {
    Capability,
    ProviderName,
    InteractionProviderName,
    ScraperProviderSelection,
} from './providers/types';

export interface ScraperConfig {
    profile: ProviderName;
    profilesBatch: ProviderName;
    followers: ProviderName;
    following: ProviderName;
    fallback: boolean;
}

/** 기능별 생산 기본 프로바이더. */
export const DEFAULT_PROVIDERS: Record<Capability, ProviderName> = {
    profile: 'selfhosted',
    profilesBatch: 'selfhosted',
    followers: 'apify',
    following: 'apify',
};

/** Explicit single-hop fallback pairs. Manual providers never gain an automatic successor. */
export const AUTOMATIC_FALLBACK: Partial<
    Record<Capability, Partial<Record<ProviderName, ProviderName>>>
> = {
    profile: { selfhosted: 'apify' },
    profilesBatch: { selfhosted: 'apify' },
};

export const VALID_PROVIDERS: Record<Capability, readonly ProviderName[]> = {
    profile: ['apify', 'selfhosted'],
    profilesBatch: ['apify', 'selfhosted'],
    followers: ['flashapi', 'apify', 'coderx'],
    following: ['flashapi', 'apify', 'coderx', 'rapidapi'],
};

function pick(capability: Capability, raw: string | undefined): ProviderName {
    if (raw === undefined) return DEFAULT_PROVIDERS[capability];
    const value = raw.trim() as ProviderName;
    if (VALID_PROVIDERS[capability].includes(value)) return value;
    throw new Error(
        `SCRAPING_CONFIG_ERROR: '${raw}'는 '${capability}'에 사용할 수 없습니다.`
    );
}

function booleanSetting(raw: string | undefined): boolean {
    if (raw === undefined) return true;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error('SCRAPING_CONFIG_ERROR: SCRAPER_FALLBACK은 true 또는 false여야 합니다.');
}

export function isProviderAllowed(capability: Capability, value: unknown): value is ProviderName {
    return typeof value === 'string' && VALID_PROVIDERS[capability].includes(value as ProviderName);
}

export function parseScraperProviderSelection(raw: unknown): ScraperProviderSelection {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('SCRAPING_CONFIG_ERROR: scraperOptions는 객체여야 합니다.');
    }

    const input = raw as Record<string, unknown>;
    const allowedKeys = new Set([
        'profile',
        'profilesBatch',
        'followers',
        'following',
        'likers',
        'comments',
        'fallback',
    ]);
    const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
    if (unknownKey) {
        throw new Error(`SCRAPING_CONFIG_ERROR: 알 수 없는 scraperOptions 키 '${unknownKey}'입니다.`);
    }
    const output: ScraperProviderSelection = {};
    for (const capability of ['profile', 'profilesBatch', 'followers', 'following'] as const) {
        const value = input[capability];
        if (value === undefined) continue;
        if (!isProviderAllowed(capability, value)) {
            throw new Error(
                `SCRAPING_CONFIG_ERROR: '${String(value)}'는 '${capability}'에 사용할 수 없습니다.`
            );
        }
        output[capability] = value;
    }
    for (const capability of ['likers', 'comments'] as const) {
        const value = input[capability];
        if (value === undefined) continue;
        if (value !== 'apify' && value !== 'disabled') {
            throw new Error(
                `SCRAPING_CONFIG_ERROR: '${String(value)}'는 '${capability}'에 사용할 수 없습니다.`
            );
        }
        output[capability] = value as InteractionProviderName;
    }
    if (input.fallback !== undefined) {
        if (typeof input.fallback !== 'boolean') {
            throw new Error('SCRAPING_CONFIG_ERROR: fallback은 boolean이어야 합니다.');
        }
        output.fallback = input.fallback;
    }
    return output;
}

export function getScraperConfig(
    env: Record<string, string | undefined> = process.env
): ScraperConfig {
    return {
        profile: pick('profile', env.SCRAPER_PROFILE),
        profilesBatch: pick('profilesBatch', env.SCRAPER_PROFILES_BATCH),
        followers: pick('followers', env.SCRAPER_FOLLOWERS),
        following: pick('following', env.SCRAPER_FOLLOWING),
        fallback: booleanSetting(env.SCRAPER_FALLBACK),
    };
}
