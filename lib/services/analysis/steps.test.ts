import { describe, expect, it } from 'vitest';
import {
    compactCompletedStepData,
    getPendingAnalysisSubBatches,
    resolveProfileProviderBatchUsernames,
    type StepData,
} from './steps';

describe('completed analysis state compaction', () => {
    it('keeps only result-display fields and drops raw profiles, posts, captions, and AI state', () => {
        const stepData: StepData = {
            scraperOptions: {
                profile: 'selfhosted',
                profilesBatch: 'selfhosted',
                followers: 'apify',
                following: 'apify',
                comments: 'apify',
                likers: 'apify',
                fallback: false,
            },
            mutualFollows: [
                'newest',
                'second',
                'third',
                'fourth',
                'fifth',
                'sixth',
                'seventh',
                'eighth',
                'ninth',
                'tenth',
                'discarded',
            ],
            targetProfileImage: 'https://instagram.fexample.net/profile.jpg',
            accountsWithPosts: [{
                profile: {
                    username: 'candidate',
                    bio: 'private pipeline material',
                    isPrivate: false,
                },
                recentPosts: [{
                    id: 'post',
                    shortCode: 'abcde',
                    caption: 'discard me',
                    type: 'image',
                    likesCount: 1,
                    commentsCount: 1,
                    timestamp: '2026-01-01T00:00:00.000Z',
                }],
            }],
            combinedResults: {
                candidate: { gender: 'female', genderConfidence: 0.9 },
            },
            interactionCandidateUsernames: ['candidate'],
        };

        expect(compactCompletedStepData(stepData)).toEqual({
            mutualFollows: [
                'newest',
                'second',
                'third',
                'fourth',
                'fifth',
                'sixth',
                'seventh',
                'eighth',
                'ninth',
                'tenth',
            ],
            targetProfileImage: 'https://instagram.fexample.net/profile.jpg',
        });
    });

    it('normalizes, validates, and deduplicates retained mutual usernames', () => {
        expect(compactCompletedStepData({
            mutualFollows: [' Newest ', 'newest', '../invalid', 'Second'],
        })).toEqual({
            mutualFollows: ['newest', 'second'],
        });
    });
});

describe('durable profile provider batch input', () => {
    it('keeps the original usernames when cache misses change during a retry', () => {
        expect(resolveProfileProviderBatchUsernames(
            { batchIndex: 2, usernames: ['Alice', 'bob'] },
            2,
            ['alice', 'bob', 'carol'],
            ['carol']
        )).toEqual(['Alice', 'bob']);
    });

    it('rejects a frozen input for another batch or an unexpected username', () => {
        expect(() => resolveProfileProviderBatchUsernames(
            { batchIndex: 1, usernames: ['alice'] },
            2,
            ['alice'],
            []
        )).toThrow('frozen profile batch input');
        expect(() => resolveProfileProviderBatchUsernames(
            { batchIndex: 2, usernames: ['mallory'] },
            2,
            ['alice'],
            []
        )).toThrow('frozen profile batch input');
    });
});

describe('durable Gemini sub-batch operation indexes', () => {
    it('keeps indexes anchored to the original batch after a partial checkpoint', () => {
        const completed = new Set(['a', 'b', 'c']);
        expect(getPendingAnalysisSubBatches(
            ['a', 'b', 'c', 'd', 'e', 'f'],
            2,
            item => completed.has(item)
        )).toEqual([
            { operationIndex: 1, items: ['d'] },
            { operationIndex: 2, items: ['e', 'f'] },
        ]);
    });

    it('does not re-emit a fully completed fixed slice', () => {
        expect(getPendingAnalysisSubBatches(
            ['a', 'b', 'c', 'd'],
            2,
            item => item === 'a' || item === 'b'
        )).toEqual([{ operationIndex: 1, items: ['c', 'd'] }]);
    });
});
