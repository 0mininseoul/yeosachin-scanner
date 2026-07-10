import { describe, expect, it } from 'vitest';
import {
    expectedRelationshipCount,
    minimumCompleteRelationshipCount,
    validateRelationshipCompleteness,
} from './completeness';
import type { InstagramFollower } from '@/lib/types/instagram';

const rows = (count: number): InstagramFollower[] => Array.from(
    { length: count },
    (_, index) => ({
        username: `user_${index}`,
        isPrivate: false,
        isVerified: false,
    })
);

describe('relationship completeness', () => {
    it('caps declared counts at the requested plan limit', () => {
        expect(expectedRelationshipCount(474, 500)).toBe(474);
        expect(expectedRelationshipCount(642, 500)).toBe(500);
        expect(expectedRelationshipCount(642, 1_000)).toBe(642);
    });

    it('rejects malformed profile counts before a paid relationship call', () => {
        expect(() => expectedRelationshipCount(undefined, 500)).toThrow('SCHEMA');
        expect(() => expectedRelationshipCount(-1, 500)).toThrow('SCHEMA');
        expect(() => expectedRelationshipCount(1.5, 500)).toThrow('SCHEMA');
    });

    it('uses a 99% floor while allowing small live graph changes', () => {
        expect(minimumCompleteRelationshipCount(474)).toBe(470);
        expect(minimumCompleteRelationshipCount(642)).toBe(636);
        expect(() => validateRelationshipCompleteness(rows(469), 474)).toThrow('INCOMPLETE');
        expect(validateRelationshipCompleteness(rows(470), 474)).toHaveLength(470);
    });

    it('rejects the observed truncated FlashAPI result for both relationships', () => {
        expect(() => validateRelationshipCompleteness(rows(320), 474)).toThrow('INCOMPLETE');
        expect(() => validateRelationshipCompleteness(rows(425), 642)).toThrow('INCOMPLETE');
    });

    it('counts normalized unique usernames instead of duplicate rows', () => {
        const duplicateHeavy = [
            ...rows(98),
            { username: 'USER_0', isPrivate: false, isVerified: false },
            { username: 'user_1', isPrivate: true, isVerified: false },
        ];

        expect(() => validateRelationshipCompleteness(duplicateHeavy, 100)).toThrow('INCOMPLETE');
        expect(validateRelationshipCompleteness([
            ...rows(99),
            { username: 'USER_0', isPrivate: false, isVerified: false },
        ], 100)).toHaveLength(99);
    });

    it('rejects malformed relationship usernames', () => {
        expect(() => validateRelationshipCompleteness([{
            username: 'invalid user',
            isPrivate: false,
            isVerified: false,
        }], 1)).toThrow('SCHEMA');
    });

    it('accepts an explicitly empty relationship list only when zero is expected', () => {
        expect(validateRelationshipCompleteness([], 0)).toEqual([]);
        expect(() => validateRelationshipCompleteness([], 1)).toThrow('INCOMPLETE');
    });
});
