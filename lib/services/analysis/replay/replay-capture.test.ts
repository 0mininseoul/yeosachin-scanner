import { describe, expect, it, vi } from 'vitest';
import { captureAnalysisV2ReplayBundle } from './replay-capture';
import { runAnalysisV2AiReplay } from './replay-runner';
import { AnalysisImagePreparationError } from '@/lib/services/ai/image-preprocessing';
import { INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID } from '../profile-image-evidence';
import {
    FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    type ReplaySourceLineage,
} from './replay-source-lineage';

const STANDARD_SOURCE_LINEAGE = {
    selectedPlanId: 'standard' as const,
    policyVersions: {
        pipeline: 'v2' as const,
        aiStage: 'ai-stage-policy-v2.7' as const,
        risk: 'risk-policy-v2.4' as const,
    },
};

const profile = {
    username: 'target', fullName: 'Target', bio: 'bio', followersCount: 1, followingCount: 1, postsCount: 1,
    isPrivate: false, isVerified: false, profilePicUrl: 'https://cdninstagram.com/profile.jpg',
    latestPosts: [{ id: 'post1', shortCode: 'post1', type: 'image' as const, imageUrl: 'https://cdninstagram.com/post.jpg', likesCount: 0, commentsCount: 0, timestamp: '2026-07-27T00:00:00.000Z', taggedUsers: [], mentionedUsers: [] }],
};

const DEFAULT_AVATAR_JPEG_BASE64 = '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';

describe('analysis V2 replay capture', () => {
    it('permits a retained public no-media account only for the sealed legacy-secondary text-only capability', async () => {
        const sourceLineage = {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const, aiStage: 'ai-stage-policy-v2.10' as const,
                risk: 'risk-policy-v2.5' as const, scheduler: 'ai-scheduler-v1' as const,
            },
        };
        const noMedia = {
            ...profile, username: 'female_one', postsCount: 7,
            profilePicUrl: undefined, latestPosts: [],
        };
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'e'.repeat(64), sourceLineage, completed: true,
                }),
                loadReplaySource: async () => ({ profiles: [noMedia], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            evaluationPolicy: {
                capability: 'test-entitlement-standard-v210-risk-v25-scheduler-v1-to-ai-v211-legacy-secondary-account-text-only',
                aiStage: 'ai-stage-policy-v2.11',
            },
            legacySecondary: {
                requestId: '10000000-0000-4000-8000-000000000001', sourceFingerprint: 'f'.repeat(64), currentRevision: 0,
                originalFemaleRows: [{
                    candidateId: 'candidate:one', sortOrdinal: 1, instagramId: 'female_one', fullName: null,
                    profileImageUrl: null, bio: null, displayScore: 7, riskBand: 'normal', featuredRank: null,
                    recentMutualRank: null, analysisDepth: 'features', oneLineOverview: '기존 요약', highRiskNarrative: null,
                }],
                textOnly: { canonicalCounts: { male: 0, female: 1, unknown: 0 } },
            },
        });
        expect(bundle.profiles[0]).toMatchObject({ media: [], triageSelectionIds: [], coverage: { selectedCount: 0, normalizedCount: 0 } });
        expect(bundle.capture.legacySecondary?.textOnly).toEqual({ canonicalCounts: { male: 0, female: 1, unknown: 0 } });
    });

    it('caps text-only account media to the retained triage subset and never normalizes the feature remainder', async () => {
        const sourceLineage = {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const, aiStage: 'ai-stage-policy-v2.10' as const,
                risk: 'risk-policy-v2.5' as const, scheduler: 'ai-scheduler-v1' as const,
            },
        };
        const richProfile = {
            ...profile, username: 'female_one', postsCount: 8,
            latestPosts: Array.from({ length: 8 }, (_, index) => ({
                ...profile.latestPosts[0], id: `post-${index}`, shortCode: `post-${index}`,
                imageUrl: `https://cdninstagram.com/post-${index}.jpg`,
                timestamp: `2026-07-${String(27 - index).padStart(2, '0')}T00:00:00.000Z`,
            })),
        };
        const normalizeMedia = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'f'.repeat(64), sourceLineage, completed: true,
                }),
                loadReplaySource: async () => ({ profiles: [richProfile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia,
            evaluationPolicy: {
                capability: 'test-entitlement-standard-v210-risk-v25-scheduler-v1-to-ai-v211-legacy-secondary-account-text-only',
                aiStage: 'ai-stage-policy-v2.11',
            },
            legacySecondary: {
                requestId: '10000000-0000-4000-8000-000000000001', sourceFingerprint: 'f'.repeat(64), currentRevision: 0,
                originalFemaleRows: [{ candidateId: 'candidate:one', sortOrdinal: 1, instagramId: 'female_one', fullName: null, profileImageUrl: null, bio: null, displayScore: 7, riskBand: 'normal', featuredRank: null, recentMutualRank: null, analysisDepth: 'features', oneLineOverview: '기존 요약', highRiskNarrative: null }],
                textOnly: { canonicalCounts: { male: 0, female: 1, unknown: 0 } },
            },
        });
        const captured = bundle.profiles[0]!;
        expect(normalizeMedia).toHaveBeenCalledTimes(2);
        expect(captured.media).toHaveLength(2);
        expect(captured.coverage).toMatchObject({ selectedCount: 2, normalizedCount: 2, failures: [] });
        const retainedIds = captured.media.map(media => media.selectionId);
        expect(captured.triageSelectionIds).toEqual(retainedIds);
        expect(captured.featureSelectionIds).toEqual(retainedIds);
        expect(captured.resolverSelectionIds).toEqual(retainedIds);
        expect(captured.captions).toEqual([]);
    });

    it('requires an exact completed Standard V2 request and canonical current media selection with no missing JPEG', async () => {
        const normalize = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'a'.repeat(64),
                    sourceLineage: STANDARD_SOURCE_LINEAGE,
                    completed: true,
                }),
                loadReplaySource: async () => ({ profiles: [profile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: normalize,
            now: Date.parse('2026-07-27T00:00:00.000Z'),
        });
        expect(bundle.profiles[0]?.media.map(item => item.selectionId)).toEqual(expect.arrayContaining([
            expect.stringMatching(/^profile:/), expect.stringMatching(/^post:/),
        ]));
        expect(bundle.profiles[0]).toMatchObject({
            fullName: 'Target',
            hasProfileImage: true,
            bio: 'bio',
        });
        expect(normalize).toHaveBeenCalledTimes(2);
    });

    it('drops the known default avatar as image evidence while retaining feed media', async () => {
        const normalize = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const defaultAvatarProfile = {
            ...profile,
            profilePicUrl: `https://scontent.cdninstagram.com/v/t51.2885-19/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}?stp=dst-jpg_e0_s150x150_tt6`,
        };
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'b'.repeat(64), sourceLineage: STANDARD_SOURCE_LINEAGE, completed: true,
                }),
                loadReplaySource: async () => ({
                    profiles: [defaultAvatarProfile],
                    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
                    providerRuns: [],
                }),
            },
            normalizeMedia: normalize,
        });
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(bundle.profiles[0]).toMatchObject({
            hasProfileImage: false,
            media: [expect.objectContaining({ kind: 'feed', postId: 'post1' })],
            triageSelectionIds: [expect.stringMatching(/^post:/)],
        });
        expect(bundle.profiles[0]?.media.some(item => item.kind === 'profile')).toBe(false);
    });

    it('uses profilePicUrlHD when it differs from the standard profile image URL', async () => {
        const normalizedUrls: string[] = [];
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'c'.repeat(64), sourceLineage: STANDARD_SOURCE_LINEAGE, completed: true,
                }),
                loadReplaySource: async () => ({
                    profiles: [{
                        ...profile,
                        profilePicUrl: 'https://cdninstagram.com/profile-150.jpg',
                        profilePicUrlHD: 'https://cdninstagram.com/profile-320.jpg',
                    }],
                    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
                    providerRuns: [],
                }),
            },
            normalizeMedia: async media => {
                normalizedUrls.push(media.imageUrl);
                return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
        });
        expect(normalizedUrls).toContain('https://cdninstagram.com/profile-320.jpg');
        expect(normalizedUrls).not.toContain('https://cdninstagram.com/profile-150.jpg');
        expect(bundle.profiles[0]?.hasProfileImage).toBe(true);
    });

    it('captures an explicit v2.7-to-v2.9 evaluation intent without changing source lineage', async () => {
        const sourceLineage = {
            ...STANDARD_SOURCE_LINEAGE,
            policyVersions: {
                ...STANDARD_SOURCE_LINEAGE.policyVersions,
                scheduler: 'ai-scheduler-v1' as const,
            },
        };
        const evaluationPolicy = {
            capability: 'standard-v27-v28-risk-v24-scheduler-v1-to-ai-v29' as const,
            aiStage: 'ai-stage-policy-v2.9' as const,
        };
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'c'.repeat(64),
                    sourceLineage,
                    completed: true,
                }),
                loadReplaySource: async () => ({
                    profiles: [profile],
                    evidence: {
                        relationship: [],
                        targetInteractions: [],
                        reverseInteractions: [],
                    },
                    providerRuns: [],
                }),
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            evaluationPolicy,
        });

        expect(bundle.capture).toEqual({
            requestFingerprint: 'c'.repeat(64),
            sourceLineage,
            evaluationPolicy,
        });
    });

    it('rejects an incomplete cross-policy source before loading provider evidence', async () => {
        const loadReplaySource = vi.fn();
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'd'.repeat(64),
                    sourceLineage: STANDARD_SOURCE_LINEAGE,
                    completed: true,
                }),
                loadReplaySource,
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            evaluationPolicy: {
                capability: 'standard-v27-v28-risk-v24-scheduler-v1-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
        })).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE',
        );
        expect(loadReplaySource).not.toHaveBeenCalled();
    });

    it('keeps 8-post carousel selection, caption evidence, and private-name inputs in parity', async () => {
        const publicProfile = {
            ...profile,
            username: 'public',
            postsCount: 8,
            latestPosts: Array.from({ length: 8 }, (_, index) => index === 0
                ? {
                    id: 'carousel', shortCode: 'carous1', type: 'carousel' as const,
                    imageUrl: 'https://cdninstagram.com/carousel.jpg', likesCount: 1,
                    commentsCount: 0, timestamp: '2026-07-27T00:00:00.000Z',
                    caption: 'parent carousel caption', taggedUsers: [], mentionedUsers: [],
                    declaredMediaCount: 5, childrenComplete: true,
                    mediaItems: Array.from({ length: 5 }, (_value, mediaIndex) => ({
                        id: `child-${mediaIndex}`, type: 'image' as const,
                        imageUrl: `https://cdninstagram.com/child-${mediaIndex}.jpg`,
                        caption: mediaIndex === 2 ? 'middle child caption' : undefined,
                    })),
                }
                : {
                    id: `post-${index}`, shortCode: `post00${index}`, type: 'image' as const,
                    imageUrl: `https://cdninstagram.com/post-${index}.jpg`, likesCount: 1,
                    commentsCount: 0, timestamp: `2026-07-${String(27 - index).padStart(2, '0')}T00:00:00.000Z`,
                    caption: `caption ${index}`, taggedUsers: [], mentionedUsers: [],
                }),
        };
        const privateProfile = {
            username: 'private', fullName: 'Private Name', followersCount: 0,
            followingCount: 0, postsCount: 0, isPrivate: true, isVerified: false,
        };
        const result = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'b'.repeat(64),
                    sourceLineage: STANDARD_SOURCE_LINEAGE,
                    completed: true,
                }),
                loadReplaySource: async () => ({ profiles: [publicProfile, privateProfile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            now: Date.parse('2026-07-27T00:00:00.000Z'),
        });

        expect(result.profiles[0]?.featureSelectionIds).toEqual(result.profiles[0]?.media.map(item => item.selectionId));
        expect(result.profiles[0]?.resolverSelectionIds).toEqual(result.profiles[0]?.featureSelectionIds);
        expect(result.profiles[0]?.captions).toEqual(expect.arrayContaining([
            expect.objectContaining({ text: 'middle child caption' }),
            expect.objectContaining({ text: 'parent carousel caption' }),
        ]));
        expect(result.profiles[0]?.coverage).toMatchObject({ selectedCount: result.profiles[0]?.media.length, normalizedCount: result.profiles[0]?.media.length, failures: [] });
        expect(result.profiles[1]).toMatchObject({
            isPrivate: true, username: 'private', fullName: 'Private Name',
            media: [], triageSelectionIds: [], featureSelectionIds: [], captions: [],
        });
    });

    it('fails closed rather than silently downgrading incomplete media or an ineligible request', async () => {
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'a'.repeat(64),
                    sourceLineage: {
                        selectedPlanId: 'plus',
                        policyVersions: {
                            pipeline: 'v2',
                            aiStage: 'ai-stage-policy-v2.7',
                            risk: 'risk-policy-v2.4',
                        },
                    } as never,
                    completed: true,
                }),
                loadReplaySource: async () => { throw new Error('must not load'); },
            }, normalizeMedia: async () => Buffer.alloc(0),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_REQUEST_INELIGIBLE');
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: 'a'.repeat(64),
                    sourceLineage: STANDARD_SOURCE_LINEAGE,
                    completed: true,
                }),
                loadReplaySource: async () => ({ profiles: [profile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            }, normalizeMedia: async () => Buffer.alloc(0),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
    });

    it('records only production-usable partial media coverage for a v2.7 source', async () => {
        const richProfile = {
            ...profile,
            postsCount: 4,
            latestPosts: Array.from({ length: 4 }, (_, index) => ({
                ...profile.latestPosts[0],
                id: `post-${index}`,
                shortCode: `post-${index}`,
                imageUrl: `https://cdninstagram.com/post-${index}.jpg`,
            })),
        };
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({ requestFingerprint: 'e'.repeat(64), sourceLineage: STANDARD_SOURCE_LINEAGE, completed: true }),
                loadReplaySource: async () => ({ profiles: [richProfile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: async media => {
                if (media.selectionId.includes('post-3')) {
                    throw new AnalysisImagePreparationError('source_missing', 'permanent');
                }
                return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
        });

        const captured = bundle.profiles[0]!;
        expect(captured.coverage).toMatchObject({
            selectedCount: 5,
            normalizedCount: 4,
            failures: [{ reason: 'source_missing', disposition: 'permanent' }],
        });
        expect(captured.featureSelectionIds).toEqual(captured.media.map(media => media.selectionId));
        expect(captured.triageSelectionIds.every(id => captured.media.some(media => media.selectionId === id))).toBe(true);
    });

    it('rejects when the canonical triage stage falls below production media coverage', async () => {
        const noAvatar = {
            ...profile,
            profilePicUrl: undefined,
            postsCount: 8,
            latestPosts: Array.from({ length: 8 }, (_, index) => ({
                ...profile.latestPosts[0], id: `p${index}`, shortCode: `p${index}`,
                imageUrl: `https://cdninstagram.com/p${index}.jpg`,
            })),
        };
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({ requestFingerprint: 'f'.repeat(64), sourceLineage: STANDARD_SOURCE_LINEAGE, completed: true }),
                loadReplaySource: async () => ({ profiles: [noAvatar], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: async media => {
                if (media.selectionId.includes('p0')) throw new AnalysisImagePreparationError('source_missing', 'permanent');
                return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
    });

    it('uses frozen v2.8 carousel diversity rather than the legacy v2.7 selection', async () => {
        const multiCarousel = {
            ...profile, profilePicUrl: undefined, postsCount: 3,
            latestPosts: Array.from({ length: 3 }, (_, index) => ({
                ...profile.latestPosts[0], id: `carousel-${index}`, shortCode: `carousel-${index}`,
                type: 'carousel' as const, declaredMediaCount: 3, childrenComplete: true,
                mediaItems: Array.from({ length: 3 }, (_child, child) => ({
                    id: `${index}-${child}`, type: 'image' as const,
                    imageUrl: `https://cdninstagram.com/${index}-${child}.jpg`,
                })),
            })),
        };
        const capture = (sourceLineage: ReplaySourceLineage) => captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({ requestFingerprint: '1'.repeat(64), sourceLineage, completed: true }),
                loadReplaySource: async () => ({ profiles: [multiCarousel], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            }, normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        });
        const legacy = await capture(STANDARD_SOURCE_LINEAGE);
        const v28 = await capture({ selectedPlanId: 'standard', policyVersions: {
            pipeline: 'v2', aiStage: 'ai-stage-policy-v2.8', risk: 'risk-policy-v2.4', scheduler: 'ai-scheduler-v1',
        } });
        expect(legacy.profiles[0]?.featureSelectionIds).toHaveLength(5);
        expect(v28.profiles[0]?.featureSelectionIds).toHaveLength(9);
    });

    it('uses first and last carousel children for concierge candidate feature media', async () => {
        const candidate = {
            ...profile,
            username: 'candidate',
            profilePicUrl: undefined,
            postsCount: 3,
            latestPosts: Array.from({ length: 3 }, (_, index) => ({
                ...profile.latestPosts[0],
                id: `carousel-${index}`,
                shortCode: `carousel-${index}`,
                type: 'carousel' as const,
                declaredMediaCount: 3,
                childrenComplete: true,
                mediaItems: Array.from({ length: 3 }, (_child, child) => ({
                    id: `${index}-${child}`,
                    type: 'image' as const,
                    imageUrl: `https://cdninstagram.com/${index}-${child}.jpg`,
                })),
            })),
        };
        const sourceLineage = {
            selectedPlanId: 'basic' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                aiStage: 'ai-stage-policy-v2.11' as const,
                risk: 'risk-policy-v2.5' as const,
                scheduler: 'ai-scheduler-v1' as const,
            },
        };
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'candidate' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: '2'.repeat(64),
                    sourceLineage,
                    completed: true,
                }),
                loadReplaySource: async () => ({
                    profiles: [candidate],
                    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
                    providerRuns: [],
                }),
            },
            evaluationPolicy: {
                capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
                aiStage: 'ai-stage-policy-v2.11',
            },
            normalizeMedia: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        });

        expect(bundle.profiles[0]?.featureSelectionIds).toEqual([
            'post:carousel-0:media:0:0-0',
            'post:carousel-1:media:0:1-0',
            'post:carousel-2:media:0:2-0',
            'post:carousel-0:media:2:0-2',
            'post:carousel-1:media:2:1-2',
            'post:carousel-2:media:2:2-2',
        ]);
        expect(bundle.profiles[0]?.featureSelectionIds).toHaveLength(6);
    });

    it('captures a mixed concierge batch that survives replay validation', async () => {
        const sourceLineage = {
            selectedPlanId: 'basic' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                aiStage: 'ai-stage-policy-v2.11' as const,
                risk: 'risk-policy-v2.5' as const,
                scheduler: 'ai-scheduler-v1' as const,
            },
        };
        const evaluationPolicy = {
            capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
            aiStage: 'ai-stage-policy-v2.11' as const,
        };
        const carousel = {
            id: 'carousel', shortCode: 'carousel', type: 'carousel' as const,
            imageUrl: 'https://cdninstagram.com/carousel.jpg', likesCount: 1,
            commentsCount: 0, timestamp: '2026-07-27T00:00:00.000Z',
            taggedUsers: [], mentionedUsers: [], declaredMediaCount: 2,
            childrenComplete: true,
            mediaItems: [0, 1].map(index => ({
                id: `child-${index}`, type: 'image' as const,
                imageUrl: `https://cdninstagram.com/child-${index}.jpg`,
            })),
        };
        const profiles = [
            {
                ...profile,
                username: 'default_avatar',
                fullName: '기본 아바타',
                profilePicUrl: `https://scontent.cdninstagram.com/v/t51.2885-19/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}?stp=dst-jpg_e0_s150x150_tt6`,
                profilePicUrlHD: 'https://cdninstagram.com/default-avatar-hd.jpg',
                postsCount: 1,
                latestPosts: [carousel],
            },
            {
                ...profile,
                username: 'zero_posts',
                fullName: '게시물 없음',
                profilePicUrl: undefined,
                profilePicUrlHD: undefined,
                postsCount: 0,
                latestPosts: [],
            },
            {
                ...profile,
                username: 'normal_candidate',
                fullName: '일반 후보',
                profilePicUrl: 'https://cdninstagram.com/normal.jpg',
                profilePicUrlHD: 'https://cdninstagram.com/normal-hd.jpg',
                postsCount: 1,
                latestPosts: [{ ...carousel, id: 'normal-post', shortCode: 'normal-post' }],
            },
        ];
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: '3'.repeat(64), sourceLineage, completed: true,
                }),
                loadReplaySource: async () => ({
                    profiles,
                    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
                    providerRuns: [],
                }),
            },
            evaluationPolicy,
            normalizeMedia: async media => media.imageUrl.includes('default-avatar-hd')
                ? Buffer.from(DEFAULT_AVATAR_JPEG_BASE64, 'base64')
                : Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        });
        expect(bundle.profiles[0]).toMatchObject({
            hasProfileImage: false,
            media: [
                expect.objectContaining({ selectionId: 'post:carousel:media:0:child-0' }),
                expect.objectContaining({ selectionId: 'post:carousel:media:1:child-1' }),
            ],
            coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
        });
        expect(bundle.profiles[1]).toMatchObject({
            media: [], triageSelectionIds: [], featureSelectionIds: [],
            coverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
        });
        expect(bundle.profiles[2]?.featureSelectionIds).toEqual([
            'profile:normal_candidate',
            'post:normal-post:media:0:child-0',
            'post:normal-post:media:1:child-1',
        ]);

        await expect(runAnalysisV2AiReplay({
            bundle,
            mode: 'dry-run',
            evaluationPolicy,
        })).resolves.toBeDefined();
    });
});
