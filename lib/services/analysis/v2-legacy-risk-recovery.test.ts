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

    it('excludes every strong-partner account from v2.3 relative eligibility, even below the cap', () => {
        const base = (candidateId: string, strong = false) => ({
            candidateId, username: candidateId.replace(':', '.'),
            appearanceGrade: 1 as const, exposureScore: 0, accountContext: 'personal' as const,
            hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: strong,
            uniqueTargetPostsLikedByCandidate: 0, boundedCandidateCommentsOnTarget: 0,
            hasTagOrCaptionMention: false, recentFemaleMutualRank: null,
            recentMutualBadgeRank: null, preScore: 0, verificationShortlistRank: null,
        });
        const final = calculateLegacyV23FinalScores({
            preliminary: [base('strong:low', true), base('eligible:one'), base('eligible:two')],
            observedReverseLikeCandidateIds: new Set(),
        });
        const strong = final.find(row => row.candidateId === 'strong:low')!;
        expect(strong.risk.publicScore).toBe(1);
        expect(strong.riskBand).toBe('normal');
        expect(strong.relativeTierApplied).toBe(false);
        expect(final.filter(row => row.relativeTierApplied)).toHaveLength(0);
    });

    it('assigns v2.3 relative-watch ranks to the two best non-featured candidates at 20 rows', () => {
        const final = calculateLegacyV23FinalScores({
            preliminary: Array.from({ length: 20 }, (_, index) => ({
                candidateId: `watch:${String(index).padStart(2, '0')}`,
                username: `watch.${index}`, appearanceGrade: 1 as const,
                exposureScore: 0, accountContext: 'personal' as const,
                hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
                uniqueTargetPostsLikedByCandidate: index < 18 ? 4 : 0,
                boundedCandidateCommentsOnTarget: index < 3 ? 12 : index < 18 ? 6 : 0,
                hasTagOrCaptionMention: index < 18, recentFemaleMutualRank: null,
                recentMutualBadgeRank: null, preScore: 0,
                verificationShortlistRank: index < 10 ? index + 1 : null,
            })),
            observedReverseLikeCandidateIds: new Set(),
        });
        expect(final.filter(row => row.relativeWatchRank !== null).map(row => ({
            candidateId: row.candidateId, rank: row.relativeWatchRank,
        }))).toEqual([
            { candidateId: 'watch:16', rank: 1 },
            { candidateId: 'watch:17', rank: 2 },
        ]);
    });
});
