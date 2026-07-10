import { describe, expect, it } from 'vitest';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type { InstagramPost } from '@/lib/types/instagram';
import {
    CANDIDATE_INTERACTION_POST_LIMIT,
    CANDIDATE_LIKER_LIMIT_PER_POST,
    extractCandidateInteractions,
    extractTargetInteractions,
    MAX_INTERACTION_CANDIDATES,
    parseStoredInteractionCoverage,
    rankObservedInteractionCandidates,
    scoreCandidateInteractions,
    TARGET_COMMENT_LIMIT_PER_POST,
    TARGET_COMMENT_POST_LIMIT,
    TARGET_LIKER_LIMIT_PER_POST,
    TARGET_LIKER_POST_LIMIT,
} from './interaction-stage';
import { instagramPostUrl } from './interaction-posts';

function post(
    id: string,
    shortCode: string,
    likesCount = 10,
    commentsCount = 2,
    timestamp = '2026-07-10T00:00:00.000Z'
): InstagramPost {
    return {
        id,
        shortCode,
        type: 'image',
        likesCount,
        commentsCount,
        timestamp,
        taggedUsers: [],
        mentionedUsers: [],
    };
}

function liker(username: string, source: InstagramPost, id = username): ApifyPostLiker {
    return {
        postUrl: instagramPostUrl(source),
        id,
        username,
        profilePicUrl: 'https://example.com/profile.jpg',
        isPrivate: false,
        isVerified: false,
        totalLikes: source.likesCount,
    };
}

function comment(username: string, source: InstagramPost, id = username): ApifyPostComment {
    return {
        postUrl: instagramPostUrl(source),
        id,
        text: 'hello',
        ownerUsername: username,
        timestamp: '2026-07-10T00:00:00.000Z',
    };
}

describe('interaction stage extraction', () => {
    it('keeps only female candidates who positively interacted with target posts', () => {
        const targetPost = post('target-1', 'Target_1', 100, 10);
        const result = extractTargetInteractions(
            [targetPost],
            [liker('Alice', targetPost), liker('unrelated', targetPost)],
            [comment('ALICE', targetPost, 'comment-1')],
            ['alice', 'other.woman']
        );

        expect(result.candidateUsernames).toEqual(['alice']);
        expect(result.evidence.map(row => row.signal)).toEqual([
            'female_target_like',
            'female_target_comment',
        ]);
        expect(result.likerCoverage[0]).toMatchObject({
            declaredCount: 100,
            returnedCount: 2,
            requestedLimit: 150,
        });
        expect(result.evidence.find(row => row.signal === 'female_target_comment')?.content)
            .toBe('hello');
    });

    it('stores only bounded sanitized text for a positively matched comment', () => {
        const targetPost = post('target-1', 'Target_1', 10, 1);
        const matchedComment = comment('alice', targetPost, 'comment-1');
        matchedComment.text = `  <b>hello</b>\u0000 ${'x'.repeat(1_100)}  `;

        const result = extractTargetInteractions(
            [targetPost],
            [],
            [matchedComment],
            ['alice']
        );

        const content = result.evidence[0]?.content;
        expect(content?.startsWith('hello x')).toBe(true);
        expect(content).toHaveLength(1_000);
        expect(content).not.toContain('<b>');
        expect(content).not.toContain('\u0000');
    });

    it('uses four newest target posts for likers and six newest posts for comments', () => {
        const posts = Array.from({ length: 7 }, (_, index) => post(
            `target-${index + 1}`,
            `Target_${index + 1}`,
            10,
            2,
            `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
        ));
        const femaleUsernames = posts.flatMap((_, index) => [
            `liker_${index + 1}`,
            `commenter_${index + 1}`,
        ]);
        const result = extractTargetInteractions(
            posts,
            posts.map((source, index) => liker(`liker_${index + 1}`, source)),
            posts.map((source, index) => comment(`commenter_${index + 1}`, source)),
            femaleUsernames
        );

        expect(result.likerCoverage.map(source => source.postId)).toEqual([
            'target-7', 'target-6', 'target-5', 'target-4',
        ]);
        expect(result.commentCoverage.map(source => source.postId)).toEqual([
            'target-7', 'target-6', 'target-5', 'target-4', 'target-3', 'target-2',
        ]);
        expect(result.evidence.filter(row => row.signal === 'female_target_like'))
            .toHaveLength(4);
        expect(result.evidence.filter(row => row.signal === 'female_target_comment'))
            .toHaveLength(6);
        expect(result.likerCoverage.every(source => source.requestedLimit === 150)).toBe(true);
        expect(result.commentCoverage.every(source => source.requestedLimit === 15)).toBe(true);
    });

    it('detects only the target username in candidate-post liker rows', () => {
        const femalePost = post('female-1', 'Female_1', 20);
        const result = extractCandidateInteractions(
            [{ username: 'Alice', posts: [femalePost] }],
            [liker('target.user', femalePost), liker('someone.else', femalePost)],
            'TARGET.USER'
        );

        expect(result.evidence).toEqual([
            expect.objectContaining({
                candidateUsername: 'alice',
                postId: 'female-1',
                signal: 'target_female_like',
            }),
        ]);
        expect(result.coverage[0].returnedCount).toBe(2);
    });

    it('checks only the newest candidate post at one hundred likers', () => {
        const oldPost = post(
            'female-old',
            'Female_old',
            20,
            0,
            '2026-07-01T00:00:00.000Z'
        );
        const newPost = post(
            'female-new',
            'Female_new',
            20,
            0,
            '2026-07-10T00:00:00.000Z'
        );
        const result = extractCandidateInteractions(
            [{ username: 'Alice', posts: [oldPost, newPost] }],
            [liker('target.user', oldPost), liker('target.user', newPost)],
            'target.user'
        );

        expect(result.evidence).toEqual([
            expect.objectContaining({ postId: 'female-new', signal: 'target_female_like' }),
        ]);
        expect(result.coverage).toEqual([
            expect.objectContaining({
                postId: 'female-new',
                requestedLimit: 100,
                returnedCount: 1,
            }),
        ]);
    });

    it('scores matched positive evidence while preserving low truncated coverage', () => {
        const targetPost = post('target-1', 'Target_1', 1_000, 100);
        const femalePost = post('female-1', 'Female_1', 500, 0);
        const result = scoreCandidateInteractions({
            targetPosts: [targetPost],
            candidatePosts: [femalePost],
            candidateUsername: 'alice',
            evidence: [
                {
                    candidateUsername: 'alice',
                    postId: 'target-1',
                    signal: 'female_target_like',
                    sourceInteractionId: 'alice-id',
                },
                {
                    candidateUsername: 'alice',
                    postId: 'female-1',
                    signal: 'target_female_like',
                    sourceInteractionId: 'target-id',
                },
            ],
            targetLikeCoverage: [{
                postId: 'target-1',
                declaredCount: 1_000,
                returnedCount: 200,
                requestedLimit: 200,
            }],
            targetCommentCoverage: [{
                postId: 'target-1',
                declaredCount: 100,
                returnedCount: 15,
                requestedLimit: 15,
            }],
            candidateLikeCoverage: [{
                candidateUsername: 'alice',
                postId: 'female-1',
                declaredCount: 500,
                returnedCount: 100,
                requestedLimit: 100,
            }],
        });

        expect(result.score).toBe(55);
        expect(result.coverageStatus).toBe('low');
    });

    it('fails closed on malformed persisted coverage', () => {
        expect(() => parseStoredInteractionCoverage([{ postId: 'a' }]))
            .toThrow('INTERACTION_COVERAGE_ERROR');
    });
});

describe('interaction collection limits', () => {
    it('matches the bounded paid collection policy', () => {
        expect(TARGET_LIKER_POST_LIMIT).toBe(4);
        expect(TARGET_LIKER_LIMIT_PER_POST).toBe(150);
        expect(TARGET_COMMENT_POST_LIMIT).toBe(6);
        expect(TARGET_COMMENT_LIMIT_PER_POST).toBe(15);
        expect(CANDIDATE_INTERACTION_POST_LIMIT).toBe(1);
        expect(CANDIDATE_LIKER_LIMIT_PER_POST).toBe(100);
        expect(MAX_INTERACTION_CANDIDATES).toBe(10);
    });
});

describe('rankObservedInteractionCandidates', () => {
    it('ranks observed candidates by score and breaks ties by normalized username', () => {
        const result = rankObservedInteractionCandidates([
            { username: 'Zoe', intermediateScore: 90 },
            { username: 'alice', intermediateScore: 110 },
            { username: 'Bob', intermediateScore: 90 },
            { username: 'not_observed', intermediateScore: 999 },
        ], ['@zoe', 'ALICE', 'bob']);

        expect(result).toEqual(['alice', 'bob', 'zoe']);
    });

    it('caps follow-up at ten and keeps the best score for duplicate usernames', () => {
        const candidates = Array.from({ length: 12 }, (_, index) => ({
            username: `woman_${index + 1}`,
            intermediateScore: index + 1,
        }));
        candidates.push({ username: 'WOMAN_12', intermediateScore: 100 });

        const result = rankObservedInteractionCandidates(
            candidates,
            candidates.map(candidate => candidate.username)
        );

        expect(result).toHaveLength(10);
        expect(result[0]).toBe('woman_12');
        expect(result).not.toContain('woman_1');
        expect(result).not.toContain('woman_2');
    });

    it('rejects non-finite or negative intermediate scores for observed candidates', () => {
        expect(() => rankObservedInteractionCandidates(
            [{ username: 'alice', intermediateScore: Number.NaN }],
            ['alice']
        )).toThrow('INTERACTION_CANDIDATE_ERROR');
        expect(() => rankObservedInteractionCandidates(
            [{ username: 'alice', intermediateScore: -1 }],
            ['alice']
        )).toThrow('INTERACTION_CANDIDATE_ERROR');
    });
});
