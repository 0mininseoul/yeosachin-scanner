import { describe, expect, it } from 'vitest';
import { classifyKakaoSignupAttribution, normalizeKakaoReferrerOrigin, readKakaoSignupAttribution, validKakaoSignupAttribution } from './kakao-signup-attribution';

describe('Kakao signup attribution', () => {
    it('uses only bounded labels for direct, UTM, and referrer sources', () => {
        expect(classifyKakaoSignupAttribution('', '')).toBe('직접 방문');
        expect(classifyKakaoSignupAttribution('?utm_source=instagram&utm_campaign=private', '')).toBe('UTM: 인스타그램');
        expect(classifyKakaoSignupAttribution('', 'https://www.google.com/search?q=person@example.test')).toBe('외부 참조: 구글');
    });
    it('keeps only a public normalized Everytime origin with no path or query', () => {
        expect(normalizeKakaoReferrerOrigin('https://Everytime.kr/board/free?email=person@example.test#private')).toBe('https://everytime.kr/');
        expect(normalizeKakaoReferrerOrigin('http://127.0.0.1/private')).toBeNull();
        expect(normalizeKakaoReferrerOrigin('https://intranet/')).toBeNull();
        expect(normalizeKakaoReferrerOrigin('https://corp.internal/')).toBeNull();
        expect(normalizeKakaoReferrerOrigin('https://user:pass@evil.test/path')).toBeNull();
        expect(readKakaoSignupAttribution('UTM: 카카오|https://everytime.kr/')).toEqual({ label: 'UTM: 카카오', origin: 'https://everytime.kr/' });
    });
    it('rejects arbitrary cookie values and does not preserve query/referrer data', () => {
        expect(validKakaoSignupAttribution('UTM: 카카오')).toBe('UTM: 카카오');
        expect(validKakaoSignupAttribution('https://evil.test/?token=secret')).toBeNull();
        expect(classifyKakaoSignupAttribution('?utm_source=person@example.test', 'not a url')).toBe('직접 방문');
    });
});
