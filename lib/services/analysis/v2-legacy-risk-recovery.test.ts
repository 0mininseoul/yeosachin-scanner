import { describe, expect, it } from 'vitest';
import { calculateLegacyV23FinalScores } from './v2-legacy-risk-recovery';

describe('v2.3 legacy recovery scorer', () => {
    it('preserves the origin/main v2.3 directionless weights and three-point replay bound', () => {
        const [candidate] = calculateLegacyV23FinalScores({
            preliminary: [{
                candidateId: 'legacy:one', username: 'legacy.one',
                appearanceGrade: 4, exposureScore: 2, accountContext: 'personal',
                hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
                uniqueTargetPostsLikedByCandidate: 4, boundedCandidateCommentsOnTarget: 12,
                hasTagOrCaptionMention: true, recentFemaleMutualRank: 1,
                recentMutualBadgeRank: 1, preScore: 0, verificationShortlistRank: 1,
            }],
            observedReverseLikeCandidateIds: new Set(),
            notCollectedCandidateIds: new Set(['legacy:one']),
        });
        expect(candidate?.risk.policyVersion).toBe('risk-policy-v2.3');
        expect(candidate?.risk.components).toEqual({
            candidateToTargetLikes: 20,
            candidateToTargetComments: 26,
            targetToCandidateLike: 0,
            tagOrCaptionMention: 14,
            recentMutual: 17,
            appearanceExposure: 13.333333333333334,
        });
        expect(candidate?.risk.preScore).toBe(90.33333333333333);
        expect(candidate?.risk.possibleUpperBound).toBe(93.33333333333333);
    });

    it('retains v2.3 reverse=3 and caution featured limit=15', () => {
        const preliminary = Array.from({ length: 20 }, (_, index) => ({
            candidateId: `legacy:${index}`, username: `legacy.${index}`,
            appearanceGrade: 1 as const, exposureScore: 0, accountContext: 'personal' as const,
            hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
            uniqueTargetPostsLikedByCandidate: index < 18 ? 4 : 0,
            boundedCandidateCommentsOnTarget: index < 3 ? 12 : index < 18 ? 6 : 0,
            hasTagOrCaptionMention: index < 18, recentFemaleMutualRank: null,
            recentMutualBadgeRank: null, preScore: 0, verificationShortlistRank: index < 10 ? index + 1 : null,
        }));
        const final = calculateLegacyV23FinalScores({
            preliminary, observedReverseLikeCandidateIds: new Set(['legacy:0']),
        });
        expect(final.find(row => row.candidateId === 'legacy:0')?.risk.components.targetToCandidateLike)
            .toBe(3);
        expect(final.filter(row => row.riskBand === 'caution' && row.featuredRank !== null)).toHaveLength(15);
    });
});
