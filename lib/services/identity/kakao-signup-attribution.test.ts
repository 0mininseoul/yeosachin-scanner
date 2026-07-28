import { describe, expect, it } from 'vitest';
import { classifyKakaoSignupAttribution, validKakaoSignupAttribution } from './kakao-signup-attribution';

describe('Kakao signup attribution', () => {
    it('uses only bounded labels for direct, UTM, and referrer sources', () => {
        expect(classifyKakaoSignupAttribution('', '')).toBe('직접 방문');
        expect(classifyKakaoSignupAttribution('?utm_source=instagram&utm_campaign=private', '')).toBe('UTM: 인스타그램');
        expect(classifyKakaoSignupAttribution('', 'https://www.google.com/search?q=person@example.test')).toBe('외부 참조: 구글');
    });
    it('rejects arbitrary cookie values and does not preserve query/referrer data', () => {
        expect(validKakaoSignupAttribution('UTM: 카카오')).toBe('UTM: 카카오');
        expect(validKakaoSignupAttribution('https://evil.test/?token=secret')).toBeNull();
        expect(classifyKakaoSignupAttribution('?utm_source=person@example.test', 'not a url')).toBe('직접 방문');
    });
});
