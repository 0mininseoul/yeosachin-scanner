import { describe, it, expect } from 'vitest';
import { isApifyCredentialSlot, type ScraperProvider } from './types';

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

describe('isApifyCredentialSlot', () => {
    it('accepts every general-catalog slot plus the batch-scoped tenth (a fresh-quota operator slot)', () => {
        expect(isApifyCredentialSlot('primary')).toBe(true);
        expect(isApifyCredentialSlot('septenary')).toBe(true);
        expect(isApifyCredentialSlot('tenth')).toBe(true);
    });

    it('still excludes octonary/nonary from this general-catalog check (unchanged, batch-only carve-out)', () => {
        expect(isApifyCredentialSlot('octonary')).toBe(false);
        expect(isApifyCredentialSlot('nonary')).toBe(false);
    });

    it('rejects an unrecognized value', () => {
        expect(isApifyCredentialSlot('eleventh')).toBe(false);
        expect(isApifyCredentialSlot(123)).toBe(false);
        expect(isApifyCredentialSlot(undefined)).toBe(false);
    });
});
