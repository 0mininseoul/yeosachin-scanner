import { describe, it, expect } from 'vitest';
import type { ScraperProvider } from './types';

describe('ScraperProvider', () => {
    it('부분 구현(getProfile만) 객체가 인터페이스를 만족한다', () => {
        const p: ScraperProvider = {
            name: 'selfhosted',
            async getProfile() {
                return null;
            },
        };
        expect(p.name).toBe('selfhosted');
        expect(p.getFollowers).toBeUndefined();
    });
});
