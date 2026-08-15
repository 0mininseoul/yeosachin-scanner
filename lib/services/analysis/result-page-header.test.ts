import { describe, expect, it } from 'vitest';
import { resultPageHeader } from './result-page-header';

describe('resultPageHeader', () => {
    it('uses the stored target full name and a normalized target profile URL', () => {
        expect(resultPageHeader({
            targetFullName: '  김준호  ',
            targetInstagramId: '@Target.User',
        })).toEqual({
            displayName: '김준호',
            username: 'target.user',
            instagramUrl: 'https://www.instagram.com/target.user/',
        });
    });

    it('falls back to the stored target username when a full name is absent', () => {
        expect(resultPageHeader({
            targetFullName: '   ',
            targetInstagramId: 'Target_User',
        })).toMatchObject({
            displayName: 'target_user',
            username: 'target_user',
            instagramUrl: 'https://www.instagram.com/target_user/',
        });
    });

    it('fails closed on a malformed target username instead of making an external link', () => {
        expect(resultPageHeader({
            targetFullName: null,
            targetInstagramId: 'target/account',
        })).toEqual({
            displayName: '분석 대상',
            username: null,
            instagramUrl: null,
        });
    });

    it('does not link profile names that Instagram itself cannot resolve', () => {
        expect(resultPageHeader({
            targetFullName: null,
            targetInstagramId: '..target',
        })).toMatchObject({
            displayName: '분석 대상',
            username: null,
            instagramUrl: null,
        });
    });
});
