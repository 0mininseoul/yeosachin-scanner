import { describe, it, expect } from 'vitest';
import { getTransportConfig, buildRequest } from './transport';

describe('getTransportConfig', () => {
    it('기본은 direct', () => {
        expect(getTransportConfig({}).mode).toBe('direct');
    });

    it('예전 proxy transport 설정을 묵시하지 않고 거부한다', () => {
        expect(() => getTransportConfig({ IG_TRANSPORT: 'http-proxy' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });
});

describe('buildRequest', () => {
    const target = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=x';

    it('direct는 타겟 URL을 그대로 쓴다', () => {
        const { url } = buildRequest(target, { mode: 'direct' });
        expect(url).toBe(target);
    });
});
