import { describe, expect, it, vi } from 'vitest';
import { captureAnalysisV2ReplayBundle } from './replay-capture';
import { AnalysisImagePreparationError } from '@/lib/services/ai/image-preprocessing';
import type { ReplaySourceLineage } from './replay-source-lineage';

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
});
