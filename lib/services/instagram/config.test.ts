import { describe, it, expect } from 'vitest';
import {
    AUTOMATIC_FALLBACK,
    getScraperConfig,
    DEFAULT_PROVIDERS,
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
        expect(AUTOMATIC_FALLBACK.followers).toBeUndefined();
        expect(AUTOMATIC_FALLBACK.following).toBeUndefined();
        expect(AUTOMATIC_FALLBACK.profile).toEqual({ selfhosted: 'apify' });
        expect(AUTOMATIC_FALLBACK.profilesBatch).toEqual({ selfhosted: 'apify' });
    });

    it('request 선택은 기능별 허용 프로바이더만 받는다', () => {
        expect(parseScraperProviderSelection({ followers: 'coderx', fallback: false })).toEqual({
            followers: 'coderx',
            fallback: false,
        });
        expect(() => parseScraperProviderSelection({ followers: 'selfhosted' })).toThrow();
        expect(() => parseScraperProviderSelection({ typo: 'flashapi' })).toThrow('typo');
    });

    it('상호작용 provider를 Apify 또는 명시적 disabled로 선택한다', () => {
        expect(parseScraperProviderSelection({
            likers: 'apify',
            comments: 'disabled',
        })).toEqual({ likers: 'apify', comments: 'disabled' });
        expect(() => parseScraperProviderSelection({ likers: 'selfhosted' }))
            .toThrow('likers');
    });
});
