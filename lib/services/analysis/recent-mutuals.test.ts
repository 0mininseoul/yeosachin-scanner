import { describe, expect, it } from 'vitest';
import {
    getRecentMutualBonus,
    inferRecentMutualFemaleRanks,
    orderedMutualUsernamesFromStepData,
} from './recent-mutuals';

describe('recent mutual inference', () => {
    it('preserves provider order and ranks only public female results', () => {
        const ranks = inferRecentMutualFemaleRanks(
            ['male_one', 'Woman_A', 'private_woman', 'woman_b', 'unknown_one'],
            ['woman_a', 'woman_b']
        );

        expect([...ranks.entries()]).toEqual([
            ['woman_a', 1],
            ['woman_b', 2],
        ]);
    });

    it('only considers the first ten mutuals and assigns at most five badges', () => {
        const mutuals = Array.from({ length: 12 }, (_, index) => `woman_${index + 1}`);
        const ranks = inferRecentMutualFemaleRanks(mutuals, mutuals);

        expect([...ranks.entries()]).toEqual([
            ['woman_1', 1],
            ['woman_2', 2],
            ['woman_3', 3],
            ['woman_4', 4],
            ['woman_5', 5],
        ]);
        expect(ranks.has('woman_11')).toBe(false);
    });

    it('deduplicates usernames case-insensitively without changing rank order', () => {
        const ranks = inferRecentMutualFemaleRanks(
            ['Woman_A', 'woman_a', 'WOMAN_B'],
            ['woman_a', 'woman_b']
        );

        expect([...ranks.entries()]).toEqual([
            ['woman_a', 1],
            ['woman_b', 2],
        ]);
    });

    it('reads ordered mutual usernames defensively from persisted step data', () => {
        expect(orderedMutualUsernamesFromStepData({
            mutualFollows: ['first', 3, '', 'second'],
        })).toEqual(['first', 'second']);
        expect(orderedMutualUsernamesFromStepData(null)).toEqual([]);
        expect(orderedMutualUsernamesFromStepData({ mutualFollows: 'first' })).toEqual([]);
    });
});

describe('recent mutual score bonus', () => {
    it('gives the newest mutual twenty points and decays by unique ordered position', () => {
        const mutuals = ['newest', 'second', 'third', 'fourth'];

        expect(getRecentMutualBonus('newest', mutuals)).toBe(20);
        expect(getRecentMutualBonus('second', mutuals)).toBe(10);
        expect(getRecentMutualBonus('third', mutuals)).toBeCloseTo(20 / 3);
        expect(getRecentMutualBonus('fourth', mutuals)).toBe(5);
    });

    it('normalizes usernames and does not let duplicates reduce a later bonus', () => {
        expect(getRecentMutualBonus('@WOMAN_B', [
            'woman_a',
            'WOMAN_A',
            '@woman_b',
        ])).toBe(10);
    });

    it('is bounded, strictly decreases with rank, and returns zero for non-mutuals', () => {
        const mutuals = Array.from({ length: 100 }, (_, index) => `woman_${index + 1}`);
        const bonuses = mutuals.map(username => getRecentMutualBonus(username, mutuals));

        expect(Math.max(...bonuses)).toBe(20);
        expect(Math.min(...bonuses)).toBeGreaterThan(0);
        expect(bonuses.every((bonus, index) => index === 0 || bonus < bonuses[index - 1]))
            .toBe(true);
        expect(getRecentMutualBonus('not_a_mutual', mutuals)).toBe(0);
        expect(getRecentMutualBonus('', mutuals)).toBe(0);
    });

    it('does not change an existing bonus when older mutuals are appended', () => {
        const before = getRecentMutualBonus('second', ['newest', 'second']);
        const after = getRecentMutualBonus('second', ['newest', 'second', 'older', 'oldest']);

        expect(after).toBe(before);
    });
});
