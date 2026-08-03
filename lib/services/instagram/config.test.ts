import { describe, it, expect } from 'vitest';
import {
    AUTOMATIC_FALLBACK,
    getInteractionScraperConfig,
    getScraperConfig,
    DEFAULT_PROVIDERS,
    getAnalysisV2PaidCollectionProvider,
    parseScraperProviderSelection,
} from './config';

describe('getScraperConfig', () => {
    it('env가 비면 현행 기본값을 쓴다', () => {
        const c = getScraperConfig({});
        expect(c).toEqual({
            profile: 'selfhosted',
            profilesBatch: 'selfhosted',
            followers: 'apify',
            following: 'apify',
            fallback: true,
        });
    });

    it('env로 기능별 프로바이더를 덮어쓴다', () => {
        const c = getScraperConfig({
            SCRAPER_PROFILES_BATCH: 'selfhosted',
            SCRAPER_FALLBACK: 'true',
        });
        expect(c.profilesBatch).toBe('selfhosted');
        expect(c.profile).toBe('selfhosted');
        expect(c.fallback).toBe(true);
    });

    it('명시적으로 잘못된 프로바이더와 fallback 값을 거부한다', () => {
        expect(() => getScraperConfig({ SCRAPER_PROFILE: 'garbage' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
        expect(() => getScraperConfig({ SCRAPER_FALLBACK: 'yes' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
        expect(() => getScraperConfig({ SCRAPER_FOLLOWERS: '' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });

    it('생산 기본은 selfhosted 프로필 + Apify relationship이다', () => {
        expect(DEFAULT_PROVIDERS.following).toBe('apify');
        expect(DEFAULT_PROVIDERS.followers).toBe('apify');
        expect(DEFAULT_PROVIDERS.profile).toBe('selfhosted');
    });

    it('relationship에는 자동 폴백을 두지 않고 프로필만 Apify로 폴백한다', () => {
        expect(AUTOMATIC_FALLBACK.followers).toEqual({ selfhosted_auth: 'apify' });
        expect(AUTOMATIC_FALLBACK.following).toEqual({ selfhosted_auth: 'apify' });
        expect(AUTOMATIC_FALLBACK.profile).toEqual({ selfhosted: 'apify' });
        expect(AUTOMATIC_FALLBACK.profilesBatch).toEqual({ selfhosted: 'apify' });
    });

    it('request 선택은 기능별 허용 프로바이더만 받는다', () => {
        expect(parseScraperProviderSelection({ followers: 'coderx', fallback: false })).toEqual({
            followers: 'coderx',
            fallback: false,
        });
        expect(parseScraperProviderSelection({
            followers: 'selfhosted_auth',
            following: 'selfhosted_auth',
        })).toEqual({
            followers: 'selfhosted_auth',
            following: 'selfhosted_auth',
        });
        expect(() => parseScraperProviderSelection({ followers: 'selfhosted' })).toThrow();
        expect(() => parseScraperProviderSelection({ typo: 'flashapi' })).toThrow('typo');
    });

    it('상호작용 provider를 Apify 또는 명시적 disabled로 선택한다', () => {
        expect(parseScraperProviderSelection({
            likers: 'apify',
            comments: 'disabled',
        })).toEqual({ likers: 'apify', comments: 'disabled' });
        expect(parseScraperProviderSelection({
            likers: 'selfhosted_auth',
            comments: 'selfhosted_auth',
        })).toEqual({
            likers: 'selfhosted_auth',
            comments: 'selfhosted_auth',
        });
        expect(() => parseScraperProviderSelection({ likers: 'selfhosted' }))
            .toThrow('likers');
    });

    it('authenticated provider는 기본 OFF이고 명시적 kill switch가 켜져야 선택한다', () => {
        expect(() => getScraperConfig({
            SCRAPER_FOLLOWERS: 'selfhosted_auth',
        })).toThrow('SELFHOSTED_AUTH_ENABLED');
        expect(() => getScraperConfig({
            SCRAPER_FOLLOWERS: 'selfhosted_auth',
            SELFHOSTED_AUTH_ENABLED: 'false',
        })).toThrow('SELFHOSTED_AUTH_ENABLED');
        expect(getScraperConfig({
            SCRAPER_FOLLOWERS: 'selfhosted_auth',
            SCRAPER_FOLLOWING: 'selfhosted_auth',
            SELFHOSTED_AUTH_ENABLED: 'true',
        })).toMatchObject({
            followers: 'selfhosted_auth',
            following: 'selfhosted_auth',
        });
        expect(() => getScraperConfig({
            SELFHOSTED_AUTH_ENABLED: 'yes',
        })).toThrow('SELFHOSTED_AUTH_ENABLED');
    });

    it('permits authenticated profiles only behind the authenticated-worker kill switch', () => {
        expect(() => getScraperConfig({
            SCRAPER_PROFILE: 'selfhosted_auth',
        })).toThrow('SELFHOSTED_AUTH_ENABLED');
        expect(getScraperConfig({
            SELFHOSTED_AUTH_ENABLED: 'true',
            SCRAPER_PROFILE: 'selfhosted_auth',
            SCRAPER_PROFILES_BATCH: 'selfhosted_auth',
        })).toMatchObject({
            profile: 'selfhosted_auth',
            profilesBatch: 'selfhosted_auth',
        });
        expect(AUTOMATIC_FALLBACK.profile?.selfhosted_auth).toBeUndefined();
        expect(AUTOMATIC_FALLBACK.profilesBatch?.selfhosted_auth).toBeUndefined();
    });
});

describe('getInteractionScraperConfig', () => {
    it('defaults interactions to the existing Apify path', () => {
        expect(getInteractionScraperConfig({})).toEqual({
            likers: 'apify',
            comments: 'apify',
            fallback: true,
        });
    });

    it('requires the authenticated-provider kill switch for either interaction source', () => {
        expect(() => getInteractionScraperConfig({
            SCRAPER_LIKERS: 'selfhosted_auth',
        })).toThrow('SELFHOSTED_AUTH_ENABLED');
        expect(getInteractionScraperConfig({
            SELFHOSTED_AUTH_ENABLED: 'true',
            SCRAPER_LIKERS: 'selfhosted_auth',
            SCRAPER_COMMENTS: 'selfhosted_auth',
            SCRAPER_FALLBACK: 'false',
        })).toEqual({
            likers: 'selfhosted_auth',
            comments: 'selfhosted_auth',
            fallback: false,
        });
    });

    it('rejects disabled and malformed interaction providers in the executable env path', () => {
        expect(() => getInteractionScraperConfig({ SCRAPER_LIKERS: 'disabled' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
        expect(() => getInteractionScraperConfig({ SCRAPER_COMMENTS: 'selfhosted' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });
});

describe('getAnalysisV2PaidCollectionProvider', () => {
    it('requires all paid collection selectors to choose the same provider', () => {
        const auth = {
            SELFHOSTED_AUTH_ENABLED: 'true',
            SCRAPER_FOLLOWERS: 'selfhosted_auth',
            SCRAPER_FOLLOWING: 'selfhosted_auth',
            SCRAPER_LIKERS: 'selfhosted_auth',
            SCRAPER_COMMENTS: 'selfhosted_auth',
        } as const;
        expect(getAnalysisV2PaidCollectionProvider(auth)).toBe('selfhosted_auth');
        expect(getAnalysisV2PaidCollectionProvider({})).toBe('apify');
        expect(() => getAnalysisV2PaidCollectionProvider({
            ...auth,
            SCRAPER_COMMENTS: 'apify',
        })).toThrow('paid collection selectors');
    });
});
