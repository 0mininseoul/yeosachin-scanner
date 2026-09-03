import { describe, it, expect } from 'vitest';
import {
    APIFY_CREDENTIAL_SLOTS,
    isApifyCredentialSlot,
    type ScraperProvider,
} from './types';

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
    it('accepts the canonical ten-slot catalog, including the concierge slots', () => {
        expect(APIFY_CREDENTIAL_SLOTS).toEqual([
            'primary',
            'secondary',
            'tertiary',
            'quaternary',
            'quinary',
            'senary',
            'septenary',
            'octonary',
            'nonary',
            'tenth',
        ]);
        for (const slot of APIFY_CREDENTIAL_SLOTS) {
            expect(isApifyCredentialSlot(slot)).toBe(true);
        }
    });

    it('rejects an unrecognized value', () => {
        expect(isApifyCredentialSlot('eleventh')).toBe(false);
        expect(isApifyCredentialSlot(123)).toBe(false);
        expect(isApifyCredentialSlot(undefined)).toBe(false);
    });
});
