import { describe, expect, it } from 'vitest';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import { buildRetainedBidirectionalNarrativeInput } from './concierge-retained-bidirectional-evidence';

const target = {
    username: 'target.account', fullName: 'Target Name', bio: '기록',
    followersCount: 1, followingCount: 1, postsCount: 1,
    isPrivate: false, isVerified: false, latestPosts: [],
};
const candidate = {
    username: 'candidate.account', fullName: 'Candidate Name', bio: '여행 기록',
    followersCount: 1, followingCount: 1, postsCount: 1,
    isPrivate: false, isVerified: false, latestPosts: [],
};
const feature = {
    features: {
        gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
        appearanceGrade: 4, exposureScore: 2, businessClassification: 'personal',
        businessConfidence: 'high', accountContext: 'personal', marriageEvidence: 'none',
        partnerEvidence: 'none', partnerExclusionContext: 'none',
        evidenceSelectionIds: { gender: [], appearance: [], exposure: [], business: [], accountContext: [], marriagePartner: [] },
        oneLineOverview: '합성 테스트 프로필입니다.',
    },
    finalGenderDecision: 'verified_female', analyzedSelectionIds: [],
} as FeatureAnalysisResult;

function retainedFixture() {
    return {
        target: {
            profile: target,
            selectedPostEvidence: [{
                postId: 'target-post', selectionId: 'selection:target:1',
                taggedUsers: ['candidate.account'], mentionedUsers: ['candidate.account'],
            }],
        },
        candidate: {
            profile: candidate,
            selectedPostEvidence: [{
                postId: 'candidate-post', selectionId: 'selection:candidate:1',
                taggedUsers: ['target.account'], mentionedUsers: ['target.account'],
            }],
        },
        feature,
        candidateToTargetInteractions: [
            { candidateUsername: 'candidate.account', postId: 'target-post', signal: 'female_target_like' as const, sourceInteractionId: 'like:1' },
            { candidateUsername: 'candidate.account', postId: 'target-post', signal: 'female_target_comment' as const, sourceInteractionId: 'comment:1', content: '좋은 기록이에요' },
        ],
        targetToCandidateLike: { status: 'observed' as const, evidenceRefIds: ['reverse-like:1'] as const },
    };
}

describe('buildRetainedBidirectionalNarrativeInput', () => {
    it('maps every retained direction without inferring target-to-candidate comments', () => {
        const result = buildRetainedBidirectionalNarrativeInput(retainedFixture());

        expect(result.interactions.candidateToTargetLike.status).toBe('observed');
        expect(result.interactions.candidateToTargetComment.status).toBe('observed');
        expect(result.interactions.targetToCandidateLike).toEqual({ status: 'observed', evidenceRefIds: ['reverse-like:1'] });
        expect(result.interactions.candidateToTargetTag.status).toBe('observed');
        expect(result.interactions.targetToCandidateTag.status).toBe('observed');
        expect(result.interactions.candidateToTargetMention.status).toBe('observed');
        expect(result.interactions.targetToCandidateMention.status).toBe('observed');
        expect(result.interactions.targetToCandidateComment).toEqual({ status: 'not_collected', evidenceRefIds: [] });
    });

    it('does not convert missing reverse evidence into absence', () => {
        const result = buildRetainedBidirectionalNarrativeInput({
            ...retainedFixture(),
            targetToCandidateLike: { status: 'not_collected', evidenceRefIds: [] },
        });
        expect(result.interactions.targetToCandidateLike).toEqual({ status: 'not_collected', evidenceRefIds: [] });
    });

    it('passes a validated observed reverse-like observation through unchanged', () => {
        const reverse = { status: 'observed' as const, evidenceRefIds: ['opaque:reverse:1', 'opaque:reverse:2'] as const };
        const result = buildRetainedBidirectionalNarrativeInput({ ...retainedFixture(), targetToCandidateLike: reverse });
        expect(result.interactions.targetToCandidateLike).toEqual(reverse);
    });

    it('rejects contradictory retained observation status and refs', () => {
        expect(() => buildRetainedBidirectionalNarrativeInput({
            ...retainedFixture(),
            targetToCandidateLike: { status: 'not_collected', evidenceRefIds: ['raw-ref'] } as never,
        })).toThrow('FIRST_PAYMENT_CONCIERGE_RETAINED_OBSERVATION_INVALID');
    });

    it('caps sanitized comments at eight and keeps opaque refs distinct', () => {
        const rows = Array.from({ length: 10 }, (_, index) => ({
            candidateUsername: 'candidate.account', postId: `target-post-${index % 2}`,
            signal: 'female_target_comment' as const, sourceInteractionId: `comment:${index}`,
            content: index === 0 ? ' <b>정돈된</b>   댓글\u0000 ' : `댓글 ${index}`,
        }));
        const result = buildRetainedBidirectionalNarrativeInput({
            ...retainedFixture(), candidateToTargetInteractions: rows,
        });
        expect(result.interactions.comments).toHaveLength(8);
        expect(result.interactions.candidateToTargetComment.evidenceRefIds).toHaveLength(8);
        expect(new Set(result.interactions.candidateToTargetComment.evidenceRefIds).size).toBe(8);
        expect(result.interactions.comments[0]?.text).toBe('정돈된 댓글');
    });

    it('rejects missing canonical public names', () => {
        expect(() => buildRetainedBidirectionalNarrativeInput({
            ...retainedFixture(), target: { ...retainedFixture().target, profile: { ...target, fullName: undefined } },
        })).toThrow('FIRST_PAYMENT_CONCIERGE_CANONICAL_NAME_MISSING');
    });
});
