import { describe, it, expect } from 'vitest';
import { apifyProvider } from './apify';

describe('apifyProvider', () => {
    it('name과 지원 기능이 노출된다', () => {
        expect(apifyProvider.name).toBe('apify');
        expect(typeof apifyProvider.getProfile).toBe('function');
        expect(typeof apifyProvider.getFollowers).toBe('function');
        expect(typeof apifyProvider.getProfilesBatch).toBe('function');
        expect(apifyProvider.getFollowing).toBeUndefined();
    });
});
