import { describe, it, expect } from 'vitest';
import { getTransportConfig, buildRequest } from './transport';

describe('getTransportConfig', () => {
    it('기본은 direct', () => {
        expect(getTransportConfig({}).mode).toBe('direct');
    });
    it('env로 모드를 고른다', () => {
        const c = getTransportConfig({ IG_TRANSPORT: 'http-proxy', IG_PROXY_URL: 'http://u:p@host:1' });
        expect(c.mode).toBe('http-proxy');
        expect(c.proxyUrl).toBe('http://u:p@host:1');
    });
});

describe('buildRequest', () => {
    const target = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=x';

    it('direct는 타겟 URL을 그대로 쓴다', () => {
        const { url, dispatcher } = buildRequest(target, { mode: 'direct' });
        expect(url).toBe(target);
        expect(dispatcher).toBeUndefined();
    });

    it('scrape-api는 타겟을 래핑한다', () => {
        const { url } = buildRequest(target, {
            mode: 'scrape-api',
            scrapeApiUrl: 'http://api.scraperapi.com',
            scrapeApiKey: 'KEY',
        });
        expect(url).toContain('api.scraperapi.com');
        expect(url).toContain('api_key=KEY');
        expect(url).toContain(encodeURIComponent(target));
    });

    it('http-proxy는 dispatcher를 반환한다', () => {
        const { url, dispatcher } = buildRequest(target, {
            mode: 'http-proxy',
            proxyUrl: 'http://u:p@host:1',
        });
        expect(url).toBe(target);
        expect(dispatcher).toBeDefined();
    });
});
