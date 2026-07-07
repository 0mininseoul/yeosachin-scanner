import { describe, it, expect } from 'vitest';
import { getScraperConfig, EXTERNAL_DEFAULT } from './config';

describe('getScraperConfig', () => {
    it('env가 비면 현행 기본값을 쓴다', () => {
        const c = getScraperConfig({});
        expect(c).toEqual({
            profile: 'apify',
            profilesBatch: 'apify',
            followers: 'apify',
            following: 'rapidapi',
            fallback: false,
        });
    });

    it('env로 기능별 프로바이더를 덮어쓴다', () => {
        const c = getScraperConfig({
            SCRAPER_PROFILES_BATCH: 'selfhosted',
            SCRAPER_FALLBACK: 'true',
        });
        expect(c.profilesBatch).toBe('selfhosted');
        expect(c.profile).toBe('apify');
        expect(c.fallback).toBe(true);
    });

    it('잘못된 값은 기본값으로 안전하게 폴백한다', () => {
        const c = getScraperConfig({ SCRAPER_PROFILE: 'garbage' });
        expect(c.profile).toBe('apify');
    });

    it('EXTERNAL_DEFAULT는 following만 rapidapi', () => {
        expect(EXTERNAL_DEFAULT.following).toBe('rapidapi');
        expect(EXTERNAL_DEFAULT.profile).toBe('apify');
    });
});
