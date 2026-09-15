import { describe, expect, it } from "vitest";
import { type InstagramPost } from "@/lib/types/instagram";
import { instagramPostUrl, selectRecentInteractionPosts } from "../../../lib/services/analysis/interaction-posts";
import { calculateInteractionScore, interactionCoverageRatio } from "../../../lib/services/analysis/interaction-score";
import { parseRelationshipCheckpoint } from "../../../lib/services/analysis/relationship-checkpoint";
import { INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID, INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256, hasUsableInstagramProfileImage, isDefaultInstagramProfileImage, preferredInstagramProfileImageUrl } from "../../../lib/services/analysis/profile-image-evidence";
import { getRecentMutualBonus, hydratedMutualCountFromStepData, inferRecentMutualFemaleRanks, normalizeLegacyGenderStats, orderedMutualUsernamesFromStepData } from "../../../lib/services/analysis/recent-mutuals";

describe("interaction-posts", () => {
    function post(id: string, shortCode: string, timestamp: string, type: InstagramPost['type'] = 'image'):
    InstagramPost {
        return {
            id,
            shortCode,
            timestamp,
            type,
            likesCount: 0,
            commentsCount: 0,
            taggedUsers: [],
            mentionedUsers: [],
        };
    }

    describe('selectRecentInteractionPosts', () => {
        it('sorts by publication time and prevents old pinned posts from taking a recent slot', () => {
            const selected = selectRecentInteractionPosts([
                post('old-pinned', 'OLD_code', '2024-01-01T00:00:00Z'),
                post('new', 'NEW_code', '1760000000'),
                post('middle', 'MID_code', '2025-01-01T00:00:00Z'),
            ], 2);

            expect(selected.map(item => item.id)).toEqual(['new', 'middle']);
        });

        it('deduplicates shortcodes and drops malformed post identifiers', () => {
            const selected = selectRecentInteractionPosts([
                post('a', 'Valid_1', '2'),
                post('b', 'valid_1', '3'),
                post('', 'Valid_2', '4'),
                post('c', 'bad!', '5'),
            ], 6);

            expect(selected.map(item => item.id)).toEqual(['a']);
        });
    });

    describe('instagramPostUrl', () => {
        it('builds canonical post and reel URLs', () => {
            expect(instagramPostUrl(post('a', 'Post_123', '1')))
                .toBe('https://www.instagram.com/p/Post_123/');
            expect(instagramPostUrl(post('b', 'Reel_123', '1', 'reel')))
                .toBe('https://www.instagram.com/reel/Reel_123/');
        });
    });
});

describe("interaction-score", () => {
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
});

describe("relationship-checkpoint", () => {
    const follower = {
        username: 'candidate.user',
        fullName: 'Candidate',
        profilePicUrl: 'https://example.com/profile.jpg',
        isPrivate: false,
        isVerified: false,
    };

    describe('paid relationship checkpoint', () => {
        it('restores both lists so a later collect retry does not rerun paid actors', () => {
            expect(parseRelationshipCheckpoint({
                followers: [follower],
                following: [follower],
            }, 500)).toEqual({
                followers: [follower],
                following: [follower],
            });
        });

        it('restores one completed parallel list while the other Actor still needs to run', () => {
            expect(parseRelationshipCheckpoint({
                followers: [follower],
            }, 500)).toEqual({
                followers: [follower],
            });
        });

        it('fails closed on oversized or malformed persisted data', () => {
            expect(() => parseRelationshipCheckpoint({
                followers: Array.from({ length: 2 }, () => follower),
                following: [],
            }, 1)).toThrow('CHECKPOINT');
            expect(() => parseRelationshipCheckpoint({
                followers: [{ ...follower, username: 'invalid user' }],
                following: [],
            }, 500)).toThrow('CHECKPOINT');
        });
    });
});

describe("profile-image-evidence", () => {
    describe('Instagram profile image evidence', () => {
        it.each([
            ['jpeg-150', 'dst-jpg_e0_s150x150_tt6'],
            ['webp-150', 'dst-webp'],
            ['jpeg-hd', 'dst-jpg_tt6'],
        ])('recognizes the default avatar media id for the %s encoding', (_label, encoding) => {
            const url = `https://scontent.cdninstagram.com/v/t51.2885-19/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}?stp=${encoding}`;
            expect(isDefaultInstagramProfileImage({ url })).toBe(true);
        });

        it('keeps normalized fingerprints for all observed default-avatar encodings', () => {
            expect(INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256).toEqual(expect.arrayContaining([
                '7edcde60c739d5723a0ea6285e44e0d1bed4942b53aeaaeca9c60dc8a5bd10ef',
                'ddd024f05c503446782f8267e861c40cf4d878c6326a655c43df205cc0562a0f',
                '376147675d9b7307dfa755412a30297f6dcf94b08f306e536fd06e4c83c8c437',
            ]));
        });

        it.each([
            ['jpeg-150', '7edcde60c739d5723a0ea6285e44e0d1bed4942b53aeaaeca9c60dc8a5bd10ef'],
            ['webp-150', 'ddd024f05c503446782f8267e861c40cf4d878c6326a655c43df205cc0562a0f'],
            ['jpeg-320', '376147675d9b7307dfa755412a30297f6dcf94b08f306e536fd06e4c83c8c437'],
        ])('recognizes the normalized %s fingerprint independently of its URL', (_label, normalizedSha256) => {
            expect(isDefaultInstagramProfileImage({ normalizedSha256 })).toBe(true);
        });

        it('prefers HD while dropping anonymous avatar URLs', () => {
            expect(preferredInstagramProfileImageUrl({
                profilePicUrl: 'https://cdn.example/profile-150.jpg',
                profilePicUrlHD: 'https://cdn.example/profile-320.jpg',
            })).toBe('https://cdn.example/profile-320.jpg');
            expect(preferredInstagramProfileImageUrl({
                profilePicUrl: `https://cdn.example/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}`,
            })).toBeUndefined();
        });

        it('uses the original URL to reject an anonymous avatar even when HD is transformed', () => {
            expect(hasUsableInstagramProfileImage({
                profilePicUrl: `https://cdn.example/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}`,
                profilePicUrlHD: 'https://cdn.example/default-hd.jpg',
            })).toBe(false);
            expect(hasUsableInstagramProfileImage({
                profilePicUrl: 'https://cdn.example/profile-150.jpg',
                profilePicUrlHD: 'https://cdn.example/profile-320.jpg',
            })).toBe(true);
        });
    });
});

describe("recent-mutuals", () => {
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

        it('reads a bounded hydrated mutual count from concierge evidence', () => {
            expect(hydratedMutualCountFromStepData({
                mutualFollows: Array.from({ length: 150 }, (_, index) => `candidate_${index}`),
                conciergeEvidence: {
                    hydration: { hydrated: 149, unresolved: 1 },
                },
            })).toBe(149);
            expect(hydratedMutualCountFromStepData({ conciergeEvidence: { hydration: { hydrated: -1 } } }))
                .toBeUndefined();
            expect(hydratedMutualCountFromStepData({ conciergeEvidence: { hydration: { hydrated: '149' } } }))
                .toBeUndefined();
        });

        it('normalizes malformed legacy gender stats to finite non-negative counts', () => {
            expect(normalizeLegacyGenderStats({})).toEqual({ male: 0, female: 0, unknown: 0 });
            expect(normalizeLegacyGenderStats({ male: 2, female: Number.NaN, unknown: -1 }))
                .toEqual({ male: 2, female: 0, unknown: 0 });
            expect(normalizeLegacyGenderStats(null)).toEqual({ male: 0, female: 0, unknown: 0 });
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
});
