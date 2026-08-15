import { describe, expect, it } from 'vitest';
import {
    createFirstPaymentConciergeHighRiskNarrativeInput,
    firstPaymentConciergeCheckpointProfile,
    firstPaymentConciergePublicationPayloadSchema,
    firstPaymentConciergeSafeFailureCode,
} from './first-payment-concierge';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';

function payload() {
    return {
        schemaVersion: 1 as const,
        descriptorHash: 'a'.repeat(64),
        evidenceHash: 'b'.repeat(64),
        semanticInputFingerprint: 'c'.repeat(64),
        targetFullName: null,
        counts: {
            followersDeclared: 391,
            followersCollected: 390 as const,
            followingDeclared: 256,
            followingCollected: 256 as const,
            detectedMutuals: 182 as const,
            publicMutuals: 134 as const,
            privateMutuals: 48 as const,
            screenedMutuals: 134 as const,
            notScreenedMutuals: 0 as const,
            fetchUnavailableCount: 5 as const,
            mediaUnavailableCount: 2,
            analysisUnavailableCount: 3,
            male: 80,
            female: 0,
            unknown: 54,
        },
        femaleRows: [] as unknown[],
        privateRows: Array.from({ length: 48 }, (_, index) => ({
            candidateId: `candidate:private:${index}`,
            sortOrdinal: index + 1,
            instagramId: `private${index}`,
            fullName: null,
            profileImageUrl: null,
        })),
    };
}

describe('firstPaymentConciergePublicationPayloadSchema', () => {
    it('accepts only the exact first-payment coverage envelope', () => {
        expect(firstPaymentConciergePublicationPayloadSchema.parse(payload()).counts)
            .toMatchObject({
                followersCollected: 390,
                followingCollected: 256,
                detectedMutuals: 182,
                publicMutuals: 134,
                privateMutuals: 48,
                screenedMutuals: 134,
                notScreenedMutuals: 0,
                fetchUnavailableCount: 5,
            });
    });

    it('rejects gender totals that do not cover every screened public account', () => {
        const value = payload();
        value.counts.unknown = 53;
        expect(firstPaymentConciergePublicationPayloadSchema.safeParse(value).success)
            .toBe(false);
    });

    it('rejects identities reused across public and private result rows', () => {
        const value = payload();
        value.counts.female = 1;
        value.counts.male = 79;
        value.femaleRows = [{
            candidateId: value.privateRows[0]!.candidateId,
            sortOrdinal: 1,
            instagramId: 'female.one',
            fullName: null,
            profileImageUrl: null,
            bio: null,
            displayScore: 3.1,
            riskBand: 'normal',
            featuredRank: null,
            recentMutualRank: null,
            analysisDepth: 'features',
            oneLineOverview: '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
            narrativeLineOne: null,
            narrativeLineTwo: null,
        }];
        expect(firstPaymentConciergePublicationPayloadSchema.safeParse(value).success)
            .toBe(false);
    });
});

describe('firstPaymentConciergeSafeFailureCode', () => {
    it('retains only a leading machine code from a detailed provider error', () => {
        expect(firstPaymentConciergeSafeFailureCode(
            new Error('ANALYSIS_IMAGE_PREPARATION_TIMEOUT: remote detail'),
        )).toBe('ANALYSIS_IMAGE_PREPARATION_TIMEOUT');
    });

    it('does not expose unclassified error messages', () => {
        expect(firstPaymentConciergeSafeFailureCode(
            new Error('sensitive lower-case detail'),
        )).toBe('FIRST_PAYMENT_CONCIERGE_UNCLASSIFIED_FAILURE');
    });
});

describe('firstPaymentConciergeCheckpointProfile', () => {
    it('uses the production eight-post checkpoint boundary', () => {
        const latestPosts = Array.from({ length: 10 }, (_, index) => ({
            id: `post-${index}`,
            shortCode: `short-${index}`,
            imageUrl: 'https://example.com/post.jpg',
            type: 'image' as const,
            likesCount: 0,
            commentsCount: 0,
            timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            taggedUsers: [],
            mentionedUsers: [],
        }));
        const checkpoint = firstPaymentConciergeCheckpointProfile({
            username: 'candidate',
            followersCount: 1,
            followingCount: 1,
            postsCount: 10,
            isPrivate: false,
            isVerified: false,
            latestPosts,
        });

        expect(checkpoint.latestPosts).toHaveLength(8);
        expect(checkpoint.latestPosts?.[0]?.id).toBe('post-9');
    });
});

describe('createFirstPaymentConciergeHighRiskNarrativeInput', () => {
    const target = {
        username: 'target.user',
        fullName: '김준호',
        followersCount: 1,
        followingCount: 1,
        postsCount: 1,
        isPrivate: false,
        isVerified: false,
        latestPosts: [],
    };
    const candidate = {
        username: 'candidate.user',
        fullName: '박민지',
        bio: '여행과 공연 기록',
        followersCount: 1,
        followingCount: 1,
        postsCount: 1,
        isPrivate: false,
        isVerified: false,
        latestPosts: [{
            id: 'candidate-post',
            shortCode: 'Candidate1',
            imageUrl: 'https://example.com/post.jpg',
            type: 'image' as const,
            likesCount: 0,
            commentsCount: 0,
            timestamp: '2026-01-01T00:00:00.000Z',
            taggedUsers: ['target.user'],
            mentionedUsers: ['target.user'],
        }],
    };
    const capturedProfile = {
        ordinal: 1,
        isPrivate: false,
        username: 'candidate.user',
        fullName: '박민지',
        hasProfileImage: true,
        bio: '여행과 공연 기록',
        media: [{
            selectionId: 'post:candidate:1',
            kind: 'feed' as const,
            postId: 'candidate-post',
            jpegBase64: 'aGVsbG8=',
        }],
        triageSelectionIds: ['post:candidate:1'],
        featureSelectionIds: ['post:candidate:1'],
        resolverSelectionIds: ['post:candidate:1'],
        captions: [{
            evidenceRefId: 'caption:candidate:1',
            selectionId: 'post:candidate:1',
            text: '공연 기록',
        }],
        coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
    } as Parameters<typeof createFirstPaymentConciergeHighRiskNarrativeInput>[0]['capturedProfile'];
    const feature = {
        features: {
            gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
            appearanceGrade: 4, exposureScore: 2,
            businessClassification: 'personal', businessConfidence: 'high',
            accountContext: 'personal', marriageEvidence: 'none', partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                gender: ['post:candidate:1'], appearance: ['post:candidate:1'],
                exposure: ['post:candidate:1'], business: [], accountContext: [], marriagePartner: [],
            },
            oneLineOverview: '여행과 공연 기록이 함께 이어져 취향의 결이 또렷하게 남는 계정입니다.',
        },
        finalGenderDecision: 'verified_female',
        analyzedSelectionIds: ['post:candidate:1'],
    } as FeatureAnalysisResult;

    it('uses canonical names and only retained interaction, feed, comment, and appearance evidence', () => {
        const input = createFirstPaymentConciergeHighRiskNarrativeInput({
            targetProfile: target,
            candidateProfile: candidate,
            capturedProfile,
            feature,
            interactions: [{
                candidateUsername: 'candidate.user',
                postId: 'target-post',
                signal: 'female_target_like',
                sourceInteractionId: 'like-1',
            }, {
                candidateUsername: 'candidate.user',
                postId: 'target-post',
                signal: 'female_target_comment',
                sourceInteractionId: 'comment-1',
                content: '공연 너무 좋네요',
            }],
        });

        expect(input.publicSubjects).toEqual({ targetFullName: '김준호', candidateFullName: '박민지' });
        expect(input.appearance.isReliable).toBe(true);
        expect(input.interactions.candidateToTargetLike.status).toBe('observed');
        expect(input.interactions.candidateToTargetComment.status).toBe('observed');
        expect(input.interactions.candidateToTargetTag.status).toBe('observed');
        expect(input.interactions.candidateToTargetMention.status).toBe('observed');
        expect(input.interactions.targetToCandidateLike.status).toBe('not_collected');
        expect(input.interactions.comments[0]?.text).toBe('공연 너무 좋네요');
    });

    it('rejects a high-risk narrative when either canonical full name is absent', () => {
        expect(() => createFirstPaymentConciergeHighRiskNarrativeInput({
            targetProfile: { ...target, fullName: undefined },
            candidateProfile: candidate,
            capturedProfile,
            feature,
            interactions: [],
        })).toThrow('FIRST_PAYMENT_CONCIERGE_CANONICAL_NAME_MISSING');
    });
});
