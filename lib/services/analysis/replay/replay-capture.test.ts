import { describe, expect, it, vi } from 'vitest';
import { captureAnalysisV2ReplayBundle } from './replay-capture';

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
});
