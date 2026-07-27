import { describe, expect, it } from 'vitest';
import {
    assignRecentFemaleMutuals,
    type RecentFemaleMutualPolicyInput,
} from './recent-female-mutual-policy';

describe('recent verified female mutual policy', () => {
    it('lets only verified, non-excluded women consume the newest-first rank', () => {
        const result = assignRecentFemaleMutuals({
            orderedMutualUsernames: [
                'male_newest',
                'private_woman',
                'unknown_account',
                '@Girlfriend',
                'Woman_A',
                'woman_b',
            ],
            verifiedFemaleUsernames: ['girlfriend', 'woman_a', 'WOMAN_B'],
            excludedUsername: 'GIRLFRIEND',
        });

        expect(result).toEqual([
            { username: 'woman_a', rank: 1, score: 5, badgeRank: 1 },
            { username: 'woman_b', rank: 2, score: 4.5, badgeRank: 2 },
        ]);
    });

    it('scans the full mutual order until it finds the tenth verified woman', () => {
        const orderedMutualUsernames = Array.from(
            { length: 10 },
            (_, index) => [`not_verified_${index}`, `woman_${index + 1}`]
        ).flat();
        const verifiedFemaleUsernames = Array.from(
            { length: 10 },
            (_, index) => `woman_${index + 1}`
        );

        const result = assignRecentFemaleMutuals({
            orderedMutualUsernames,
            verifiedFemaleUsernames,
            excludedUsername: null,
        });

        expect(result).toHaveLength(10);
        expect(result[0]).toMatchObject({ username: 'woman_1', rank: 1 });
        expect(result[9]).toMatchObject({ username: 'woman_10', rank: 10 });
    });

    it('uses the risk-policy score table and gives badges only to female ranks one to five', () => {
        const women = Array.from({ length: 11 }, (_, index) => `woman_${index + 1}`);
        const result = assignRecentFemaleMutuals({
            orderedMutualUsernames: women,
            verifiedFemaleUsernames: women,
            excludedUsername: null,
        });

        expect(result.map(item => item.score)).toEqual([
            5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5,
        ]);
        expect(result.map(item => item.username)).not.toContain('woman_11');
        expect(result.map(item => item.badgeRank)).toEqual([
            1,
            2,
            3,
            4,
            5,
            null,
            null,
            null,
            null,
            null,
        ]);
    });

    it('normalizes and deduplicates both inputs without changing provider order', () => {
        const result = assignRecentFemaleMutuals({
            orderedMutualUsernames: [
                ' @Woman_B ',
                'woman_b',
                'WOMAN_A',
                '@woman_c',
            ],
            verifiedFemaleUsernames: [' woman_a ', 'WOMAN_B', '@woman_b', 'woman_c'],
            excludedUsername: null,
        });

        expect(result.map(item => item.username)).toEqual([
            'woman_b',
            'woman_a',
            'woman_c',
        ]);
        expect(result.map(item => item.rank)).toEqual([1, 2, 3]);
    });

    it('returns a plain JSON-serializable array', () => {
        const result = assignRecentFemaleMutuals({
            orderedMutualUsernames: ['woman_a'],
            verifiedFemaleUsernames: ['woman_a'],
            excludedUsername: null,
        });

        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(Array.isArray(result)).toBe(true);
    });

    it('fails closed on malformed usernames and a missing exclusion decision', () => {
        expect(() => assignRecentFemaleMutuals({
            orderedMutualUsernames: ['valid', 'invalid username'],
            verifiedFemaleUsernames: ['valid'],
            excludedUsername: null,
        })).toThrow('orderedMutualUsernames[1]');
        expect(() => assignRecentFemaleMutuals({
            orderedMutualUsernames: ['valid'],
            verifiedFemaleUsernames: ['invalid username'],
            excludedUsername: null,
        })).toThrow('verifiedFemaleUsernames[0]');
        expect(() => assignRecentFemaleMutuals({
            orderedMutualUsernames: ['valid'],
            verifiedFemaleUsernames: ['valid'],
            excludedUsername: 'invalid username',
        })).toThrow('excludedUsername');
        expect(() => assignRecentFemaleMutuals({
            orderedMutualUsernames: [
                ...Array.from({ length: 10 }, (_, index) => `woman_${index}`),
                'invalid username',
            ],
            verifiedFemaleUsernames: Array.from(
                { length: 10 },
                (_, index) => `woman_${index}`
            ),
            excludedUsername: null,
        })).toThrow('orderedMutualUsernames[10]');
        expect(() => assignRecentFemaleMutuals({
            orderedMutualUsernames: [],
            verifiedFemaleUsernames: [],
        } as unknown as RecentFemaleMutualPolicyInput)).toThrow('decision is required');
    });
});
