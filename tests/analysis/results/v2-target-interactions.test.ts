import { describe, expect, it } from 'vitest';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type { InstagramPost } from '@/lib/types/instagram';
import {
    extractRawTargetInteractions,
    joinVerifiedFemaleTargetInteractions,
    summarizeCandidateTargetInteractions,
} from '../../../lib/services/analysis/v2-target-interactions';

function post(index: number): InstagramPost {
    return {
        id: `post-${index}`,
        shortCode: `Short${index}`,
        type: index === 1 ? 'reel' : 'image',
        likesCount: 300,
        commentsCount: 40,
        timestamp: new Date(Date.UTC(2026, 0, 20 - index)).toISOString(),
        taggedUsers: [],
        mentionedUsers: [],
    };
}

function liker(username: string, postUrl: string, id: string): ApifyPostLiker {
    return {
        id,
        username,
        fullName: username,
        profilePicUrl: 'https://example.com/profile.jpg',
        isPrivate: false,
        isVerified: false,
        postUrl,
        totalLikes: 300,
    };
}

function comment(username: string, postUrl: string, id: string): ApifyPostComment {
    return {
        id,
        ownerUsername: username,
        postUrl,
        text: '<b> 진짜\u0000 예쁘다 </b>',
        timestamp: '2026-01-20T00:00:00.000Z',
    };
}

describe('V2 raw target interactions', () => {
    it('collects before gender routing and filters the target/exclusion immediately', () => {
        const posts = Array.from({ length: 7 }, (_, index) => post(index + 1));
        const newestUrl = 'https://www.instagram.com/reel/Short1/';
        const snapshot = extractRawTargetInteractions({
            targetPosts: posts,
            likers: [
                liker('Candidate.One', newestUrl, 'like-1'),
                liker('girlfriend', newestUrl, 'like-2'),
                liker('target', newestUrl, 'like-3'),
            ],
            comments: [comment('Candidate.Two', newestUrl, 'comment-1')],
            excludedUsernames: ['target', 'girlfriend'],
        });

        expect(snapshot.observedUsernames).toEqual(['candidate.one', 'candidate.two']);
        expect(snapshot.evidence).toEqual([
            expect.objectContaining({
                actorUsername: 'candidate.one',
                signal: 'target_post_like',
            }),
            expect.objectContaining({
                actorUsername: 'candidate.two',
                signal: 'target_post_comment',
                content: '진짜 예쁘다',
            }),
        ]);
        expect(snapshot.likerCoverage).toHaveLength(4);
        expect(snapshot.commentCoverage).toHaveLength(6);
    });

    it('keeps hidden provider counts conservative instead of claiming complete coverage', () => {
        const hiddenPost = {
            ...post(1),
            likesCount: 0,
            commentsCount: 0,
            likesCountHidden: true as const,
            commentsCountHidden: true as const,
        };

        const snapshot = extractRawTargetInteractions({
            targetPosts: [hiddenPost],
            likers: [],
            comments: [],
            excludedUsernames: [],
        });

        expect(snapshot.likerCoverage[0]).toMatchObject({
            returnedCount: 0,
            declaredCount: 151,
            requestedLimit: 150,
        });
        expect(snapshot.commentCoverage[0]).toMatchObject({
            returnedCount: 0,
            declaredCount: 16,
            requestedLimit: 15,
        });
    });

    it('joins only verified women and reapplies exclusion at the downstream boundary', () => {
        const joined = joinVerifiedFemaleTargetInteractions({
            evidence: [
                {
                    actorUsername: 'verified.woman',
                    postId: 'post-1',
                    signal: 'target_post_like',
                    sourceInteractionId: 'like-1',
                },
                {
                    actorUsername: 'unknown.person',
                    postId: 'post-1',
                    signal: 'target_post_comment',
                    sourceInteractionId: 'comment-1',
                },
                {
                    actorUsername: 'girlfriend',
                    postId: 'post-1',
                    signal: 'target_post_comment',
                    sourceInteractionId: 'comment-2',
                },
            ],
            verifiedFemaleUsernames: ['verified.woman', 'girlfriend'],
            excludedUsername: 'girlfriend',
        });

        expect(joined).toEqual([{
            candidateUsername: 'verified.woman',
            postId: 'post-1',
            signal: 'female_target_like',
            sourceInteractionId: 'like-1',
        }]);
    });

    it('scores unique liked posts and at most two unique comments per target post', () => {
        const rows = [
            ...['like-1', 'like-2'].map(sourceInteractionId => ({
                candidateUsername: 'Verified.Woman',
                postId: 'post-1',
                signal: 'female_target_like' as const,
                sourceInteractionId,
            })),
            ...['comment-3', 'comment-1', 'comment-2'].map(sourceInteractionId => ({
                candidateUsername: 'Verified.Woman',
                postId: 'post-1',
                signal: 'female_target_comment' as const,
                sourceInteractionId,
            })),
            {
                candidateUsername: 'verified.woman',
                postId: 'post-2',
                signal: 'female_target_comment' as const,
                sourceInteractionId: 'comment-4',
            },
        ];

        expect(summarizeCandidateTargetInteractions(rows)).toEqual([{
            candidateUsername: 'verified.woman',
            uniqueTargetPostsLikedByCandidate: 1,
            boundedCandidateCommentsOnTarget: 3,
            likedPostIds: ['post-1'],
            countedCommentInteractionIds: ['comment-1', 'comment-3', 'comment-4'],
        }]);
    });
});
