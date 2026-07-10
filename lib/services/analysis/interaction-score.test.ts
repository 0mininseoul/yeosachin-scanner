import { describe, expect, it } from 'vitest';
import {
    calculateInteractionScore,
    interactionCoverageRatio,
} from './interaction-score';

const source = (postId: string, declaredCount: number, returnedCount: number, requestedLimit = 200) => ({
    postId,
    declaredCount,
    returnedCount,
    requestedLimit,
});

describe('calculateInteractionScore', () => {
    it('weights all three observed interaction directions and caps comments at two per post', () => {
        const result = calculateInteractionScore({
            targetLikePostIds: ['t1', 't2'],
            targetCommentPostIds: ['t1', 't2'],
            candidatePostIds: ['c1', 'c2'],
            femaleLikedTargetPostIds: ['t1', 't1'],
            femaleCommentsOnTarget: [
                { commentId: 'a', postId: 't1' },
                { commentId: 'b', postId: 't1' },
                { commentId: 'c', postId: 't1' },
                { commentId: 'a', postId: 't1' },
            ],
            targetLikedFemalePostIds: ['c1'],
            targetLikeCoverage: [source('t1', 100, 100), source('t2', 50, 50)],
            targetCommentCoverage: [
                source('t1', 10, 10, 15),
                source('t2', 5, 5, 15),
            ],
            candidateLikeCoverage: [
                source('c1', 80, 80, 100),
                source('c2', 40, 40, 100),
            ],
        });

        expect(result.femaleToTargetLikesCount).toBe(1);
        expect(result.femaleToTargetCommentsCount).toBe(3);
        expect(result.targetToFemaleLikesCount).toBe(1);
        expect(result.score).toBe(50);
        expect(result.coverage).toBe(1);
        expect(result.coverageStatus).toBe('high');
    });

    it('does not infer negative evidence from truncated pages', () => {
        const result = calculateInteractionScore({
            targetLikePostIds: ['t1'],
            targetCommentPostIds: ['t1'],
            candidatePostIds: [],
            femaleLikedTargetPostIds: [],
            femaleCommentsOnTarget: [],
            targetLikedFemalePostIds: [],
            targetLikeCoverage: [source('t1', 1_000, 200)],
            targetCommentCoverage: [source('t1', 100, 15, 15)],
            candidateLikeCoverage: [],
        });

        expect(result.score).toBe(0);
        expect(result.coverage).toBeCloseTo(0.1375);
        expect(result.coverageStatus).toBe('low');
    });

    it('ignores duplicate IDs, unknown posts, and out-of-scope evidence', () => {
        const result = calculateInteractionScore({
            targetLikePostIds: ['t1'],
            targetCommentPostIds: ['t1'],
            candidatePostIds: ['c1'],
            femaleLikedTargetPostIds: ['other'],
            femaleCommentsOnTarget: [{ commentId: 'a', postId: 'other' }],
            targetLikedFemalePostIds: ['other'],
            targetLikeCoverage: [],
            targetCommentCoverage: [],
            candidateLikeCoverage: [],
        });

        expect(result.score).toBe(0);
        expect(result.femaleToTargetLikesCount).toBe(0);
        expect(result.femaleToTargetCommentsCount).toBe(0);
        expect(result.targetToFemaleLikesCount).toBe(0);
    });

    it('normalizes target likes over four posts and comments over six posts independently', () => {
        const result = calculateInteractionScore({
            targetLikePostIds: ['l1', 'l2', 'l3', 'l4'],
            targetCommentPostIds: ['l1', 'l2', 'l3', 'l4', 'c5', 'c6'],
            candidatePostIds: ['candidate-1'],
            femaleLikedTargetPostIds: ['l1', 'l2', 'l3', 'l4', 'c5'],
            femaleCommentsOnTarget: [
                { commentId: 'comment-1', postId: 'l1' },
                { commentId: 'comment-2', postId: 'l2' },
                { commentId: 'comment-3', postId: 'l3' },
                { commentId: 'comment-4', postId: 'l4' },
                { commentId: 'comment-5', postId: 'c5' },
                { commentId: 'comment-6', postId: 'c6' },
            ],
            targetLikedFemalePostIds: ['candidate-1'],
            targetLikeCoverage: [],
            targetCommentCoverage: [],
            candidateLikeCoverage: [],
        });

        expect(result.femaleToTargetLikesCount).toBe(4);
        expect(result.femaleToTargetCommentsCount).toBe(6);
        expect(result.breakdown.femaleToTargetLikes).toBe(35);
        expect(result.breakdown.femaleToTargetComments).toBe(22.5);
        expect(result.breakdown.targetToFemaleLikes).toBe(20);
        expect(result.score).toBe(78);
    });
});

describe('interactionCoverageRatio', () => {
    it('uses actual declared counts and treats a known empty post as complete', () => {
        expect(interactionCoverageRatio(source('a', 114, 109))).toBeCloseTo(109 / 114);
        expect(interactionCoverageRatio(source('b', 0, 0))).toBe(1);
    });

    it('rejects impossible coverage metadata', () => {
        expect(() => interactionCoverageRatio(source('a', 10, 201)))
            .toThrow('INTERACTION_COVERAGE_ERROR');
    });
});
